import type {
  WebSearchProvider,
  WebSearchResult,
  SearchBudget,
} from '../collectors/websearch/provider.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { brandName, buildContactQueries, type ContactQuery } from './queries.js';
import { extractSerpCompany, extractSerpPeople, type SerpPerson } from './serp.js';
import type { LinkedInTarget } from './social.js';

/**
 * Running the search templates of 4-06 for one shop and reading the results
 * with 4-07.
 *
 * This is the half of Epic 4 that costs money, so the spending rules are here
 * rather than scattered:
 *
 *   - **It runs only when the storefront named nobody.** Web search fills the
 *     gap the shop's own pages left; a merchant who already introduces the owner
 *     on `/o-nas` is not worth searching for.
 *   - **It stops as soon as it has a titled person.** The second query exists
 *     for the shops the first one misses, and paying for it after the first
 *     succeeded is paying twice for the same contact.
 *   - **It runs only the templates 4-07 can read.** The open-web template is
 *     returned by 4-06 and stays unrun for now: nothing downstream extracts a
 *     person from a press article yet, so spending a search on one would buy a
 *     result no code reads.
 *   - **A run-wide budget bounds the total.** One `--force` over a large batch
 *     is what turns a three-dollar feature into a bill.
 */

/** The templates whose hits `serp.ts` can turn into a person. */
const READABLE_KINDS: ReadonlySet<ContactQuery['kind']> = new Set<ContactQuery['kind']>([
  'linkedin_profile',
  'linkedin_company',
]);

export interface SearchTarget {
  domain: string;
  name?: string | null;
  country?: string | null;
}

export interface StoreSearchOptions {
  provider: WebSearchProvider;
  /** Shared across the run; omitted means unbounded, which only tests want. */
  budget?: SearchBudget | undefined;
  /** Ceiling per store, applied before the budget. */
  maxQueries?: number | undefined;
  logger?: Logger | undefined;
  signal?: AbortSignal | undefined;
}

export interface StoreSearchResult {
  people: SerpPerson[];
  /** The shop's own LinkedIn page, when the search returned it. */
  company: LinkedInTarget | null;
  /** Queries actually sent — what the store cost. */
  queries: number;
  /** Hits the provider returned, before 4-07 refused any. */
  hits: number;
  /** Hits the provider itself could not evidence (see the OpenAI adapter). */
  dropped: number;
  provider: string;
  searches: number;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  /** Set when the search stopped early; null when every planned query ran. */
  stoppedBecause: string | null;
}

export async function searchStoreContacts(
  target: SearchTarget,
  options: StoreSearchOptions,
): Promise<StoreSearchResult> {
  const logger = options.logger ?? silentLogger();
  const brand = brandName(target);
  const planned = buildContactQueries(target)
    .filter((query) => READABLE_KINDS.has(query.kind))
    .slice(0, options.maxQueries ?? 2);

  const result: StoreSearchResult = {
    people: [],
    company: null,
    queries: 0,
    hits: 0,
    dropped: 0,
    provider: options.provider.name,
    searches: 0,
    tokensIn: null,
    tokensOut: null,
    durationMs: 0,
    stoppedBecause: null,
  };

  const found = new Map<string, SerpPerson>();

  for (const query of planned) {
    if (options.budget && !options.budget.reserve()) {
      result.stoppedBecause = options.budget.reason;
      logger.warn({ domain: target.domain }, 'web search budget spent; stopping');
      break;
    }

    let response: WebSearchResult;
    try {
      response = await options.provider.search(
        {
          query: query.query,
          maxResults: query.maxResults,
          ...(query.allowedDomains ? { allowedDomains: query.allowedDomains } : {}),
          ...(target.country ? { country: target.country } : {}),
        },
        { logger, ...(options.signal ? { signal: options.signal } : {}) },
      );
    } catch (error) {
      // One failed query must not lose the ones that already worked: the step
      // this runs in is soft-fail, and a partial contact beats none.
      result.stoppedBecause = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, query: query.query }, 'web search query failed');
      break;
    }

    result.queries += 1;
    result.hits += response.hits.length;
    result.dropped += response.dropped;
    if (response.usage) {
      result.searches += response.usage.searches;
      result.durationMs += response.usage.durationMs;
      result.tokensIn = add(result.tokensIn, response.usage.tokensIn);
      result.tokensOut = add(result.tokensOut, response.usage.tokensOut);
    }

    const readOptions = { storeDomain: target.domain, brand, query: query.query };
    for (const person of extractSerpPeople(response.hits, readOptions)) {
      if (!found.has(person.slug)) found.set(person.slug, person);
    }
    // Kept even when a person is found: the two answer different questions —
    // who to write to, and what to look at before writing.
    result.company ??= extractSerpCompany(response.hits, readOptions);

    if ([...found.values()].some((person) => person.role !== null)) {
      result.stoppedBecause = 'a titled person was found';
      break;
    }
  }

  result.people = [...found.values()];
  logger.info(
    {
      domain: target.domain,
      queries: result.queries,
      hits: result.hits,
      dropped: result.dropped,
      people: result.people.length,
      company: result.company?.url ?? null,
    },
    'web search for contacts finished',
  );
  return result;
}

/** Token counts are nullable per provider; a null plus a number is the number. */
function add(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}
