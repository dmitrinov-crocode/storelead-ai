import { z } from 'zod';
import type { AiClient } from '../ai/client.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { looksLikePersonName, detectRole, type FoundPerson } from './people.js';
import type { ScrapedPage } from './pageScraper.js';

/**
 * The AI half of task 4-04: reading the people out of an About page.
 *
 * The heuristics next door need a *structural* signal — a JSON-LD `Person`, a
 * title beside the name, an introducing verb, an address that spells it. That
 * covers the shops that write "Sklep prowadzi Anna Kowalska, założycielka" and
 * misses the ones that write "Firma powstała, gdy Anna i Marek rzucili pracę" —
 * a founding story, obvious to a person, invisible to a regex.
 *
 * It also misses in the other direction, and that is why a model helps here
 * rather than just casting wider: `Salon Bmw Bawaria` reached a real letter as a
 * contact because it is two capitalised words after an introducing verb. A
 * reader knows it is a dealership. A regex cannot.
 *
 * ## What the model is and is not trusted with
 *
 * It is trusted to judge whether a sentence is about a person. It is not trusted
 * with the facts: every person it returns must come with the sentence that names
 * them, and that sentence must appear on the page, verbatim, with the name
 * inside it. A model that invents a founder has to invent a quote too, and the
 * quote is checked in code. Everything that fails the check is dropped and
 * logged — the same guard as 3-05, and the reason this is worth doing at all.
 */

export const ABOUT_AGENT = 'about_reader';
export const ABOUT_PROMPT_VERSION = '1';

export const aboutOutputSchema = z.object({
  people: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string(),
      quote: z.string().min(1),
    }),
  ),
});

export type AboutOutput = z.infer<typeof aboutOutputSchema>;

export const ABOUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['people'],
  properties: {
    people: {
      type: 'array',
      description: 'People the page names. Empty is a valid and common answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role'],
        properties: {
          name: { type: 'string', description: 'The person as the page writes them.' },
          role: {
            type: 'string',
            description: 'Their title, or an empty string when the page gives none.',
          },
          quote: {
            type: 'string',
            description: 'The sentence from the page that names them, copied exactly.',
          },
        },
      },
    },
  },
};

export const ABOUT_SYSTEM_PROMPT = `You read the "about us" page of an online shop and report the
people it names.

A person is a human being. These are not people, however they are written:

  - the shop, the brand, or a company — "Salon BMW Bawaria", "Ferax sp. z o.o.", "Sklep Anna"
  - a regulator, an authority or an office — "Prezes Urzędu Ochrony Danych Osobowych"
  - a role with nobody attached — "nasz zespół", "the team", "customer support"
  - a place, a product, or a section heading

Rules:

1. Report only people the page actually names. If it names nobody, return an empty list. That is a
   common and correct answer — most shops name nobody.
2. For each person, copy the sentence that names them from the page, exactly as it is written. Do
   not shorten, translate or tidy it. The sentence is checked against the page, and a person whose
   sentence is not found is discarded.
3. Give their title only if the page states one. If it does not, return an empty string — do not
   infer that somebody who founded the shop is its CEO.
4. Do not guess a surname, expand an initial, or complete a name the page leaves partial.`;

export interface ReadAboutOptions {
  client: AiClient;
  pages: readonly ScrapedPage[];
  storeDomain: string;
  /** Ceiling on the page text handed to the model, in characters. */
  maxChars?: number;
  logger?: Logger;
  signal?: AbortSignal | undefined;
}

export interface AboutReading {
  people: FoundPerson[];
  /** People the model named whose sentence was not on the page. */
  ungrounded: string[];
  /** People it named that no reader would call a person. */
  rejected: string[];
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number;
    model: string;
  } | null;
}

/** Pages worth reading. Policies name regulators, never merchants (see 4-04). */
const READABLE = new Set(['about', 'contact']);

const EMPTY: AboutReading = { people: [], ungrounded: [], rejected: [], usage: null };

/** Whitespace-insensitive containment: the model reflows what it copies. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function readAboutPages(options: ReadAboutOptions): Promise<AboutReading> {
  const logger = options.logger ?? silentLogger();
  const maxChars = options.maxChars ?? 6_000;

  const pages = options.pages.filter((page) => READABLE.has(page.kind) && page.text.trim() !== '');
  if (pages.length === 0) return EMPTY;

  const user = pages
    .map((page) => `--- ${page.kind} (${page.url}) ---\n${page.text.slice(0, maxChars)}`)
    .join('\n\n');

  const result = await options.client.complete({
    system: ABOUT_SYSTEM_PROMPT,
    user,
    schemaName: 'about_people',
    jsonSchema: ABOUT_JSON_SCHEMA,
    signal: options.signal,
  });

  let parsed: AboutOutput;
  try {
    parsed = aboutOutputSchema.parse(JSON.parse(result.text));
  } catch (error) {
    // An unreadable answer is a shop with nobody on its About page, not a failed
    // step: the heuristics already ran and the web search still can.
    logger.warn({ err: error }, 'the about reader did not answer in the schema');
    return EMPTY;
  }

  const haystack = collapse(pages.map((page) => page.text).join(' '));
  const people: FoundPerson[] = [];
  const ungrounded: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const person of parsed.people) {
    const name = person.name.trim();

    // The same shape rules the heuristics use: legal copy, the shop's own name
    // and anything that is not two or three capitalised words is still refused.
    if (!looksLikePersonName(name, options.storeDomain)) {
      rejected.push(name);
      continue;
    }

    // The quote is the whole guard. A model that invents a founder must invent
    // a sentence too, and the sentence is checked against the page.
    const quote = collapse(person.quote);
    if (quote === '' || !haystack.includes(quote) || !quote.includes(collapse(name))) {
      ungrounded.push(name);
      continue;
    }

    if (seen.has(collapse(name))) continue;
    seen.add(collapse(name));

    const stated = person.role.trim();
    const detected = stated === '' ? null : detectRole(stated);
    const page = pages.find((candidate) => collapse(candidate.text).includes(quote)) ?? pages[0]!;

    people.push({
      name,
      role: detected?.role ?? null,
      roleText: stated === '' ? null : stated,
      source: 'ai_about',
      pageKind: page.kind,
      pageUrl: page.url,
      evidence: person.quote.trim(),
      email: null,
    });
  }

  if (ungrounded.length > 0 || rejected.length > 0) {
    logger.warn({ ungrounded, rejected }, 'dropped people the about reader could not evidence');
  }

  return {
    people,
    ungrounded,
    rejected,
    usage: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      durationMs: result.durationMs,
      model: result.model,
    },
  };
}
