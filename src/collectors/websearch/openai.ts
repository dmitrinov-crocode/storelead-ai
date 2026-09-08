import OpenAI from 'openai';
import { getConfig, requireKey } from '../../config/index.js';
import { toStepError } from '../../ai/client.js';
import { silentLogger } from '../../lib/logger.js';
import {
  urlKey,
  type WebSearchHit,
  type WebSearchProvider,
  type WebSearchQuery,
  type WebSearchResult,
} from './provider.js';

/**
 * Web search through OpenAI's `web_search` tool (task 4-05).
 *
 * Chosen over Serper and Exa for one reason that has nothing to do with quality:
 * the key is already in `.env`, so the provider costs no new account, no new
 * secret and no new failure mode. At roughly $10 per thousand searches, the two
 * hundred–odd queries a batch of a hundred shops needs costs about two dollars.
 *
 * The tool also takes `filters.allowed_domains`, which is the parameter-shaped
 * domain restriction that made Exa attractive — `site:linkedin.com/in` as a
 * condition the API enforces rather than a string in the query that a ranker may
 * drop. Path prefixes are not expressible there, so the `/in/` half stays in the
 * query text and is re-checked in code by 4-07, which only accepts profile URLs.
 *
 * ## Why the answer is filtered before it is returned
 *
 * A model asked to report search results can report a plausible URL it never
 * visited, and a fabricated LinkedIn profile reaching an outreach email is the
 * worst failure this project has. So the reply is not trusted on its own: the
 * response also carries what the search actually touched — `action.sources` from
 * the tool call, and the `url_citation` annotations of the message — and any hit
 * whose URL is not in that set is dropped and counted. Where a citation covers a
 * URL, its title replaces the model's, because that title came from the web page
 * rather than from the model. This is the grounding guard of 3-05, applied to a
 * different kind of output.
 */

export const OPENAI_WEB_SEARCH_PROVIDER = 'openai_web_search';

const SYSTEM_PROMPT = `You are a search runner, not an analyst.

Run the query you are given with the web_search tool and report the results verbatim. For each
result return its URL exactly as the search returned it, its page title, and the snippet the search
showed.

Rules:
1. Report only pages the search actually returned. Never construct, guess or complete a URL.
2. Do not summarise, merge or rank. One entry per result.
3. Copy titles and snippets as they appear. Do not translate or tidy them.
4. If the search returned nothing usable, return an empty list. An empty list is a valid answer and
   is much better than a plausible one.`;

const HITS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      description: 'The search results, in the order the search returned them.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title', 'snippet'],
        properties: {
          url: { type: 'string', description: 'The result URL, exactly as returned.' },
          title: { type: ['string', 'null'], description: 'The page title, copied verbatim.' },
          snippet: {
            type: ['string', 'null'],
            description: 'The snippet the search displayed, copied verbatim.',
          },
        },
      },
    },
  },
};

export interface OpenAiWebSearchOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  projectId?: string | undefined;
  /**
   * How much of the context window the tool may spend on search. `low` is the
   * default here rather than `medium`: we want a SERP read off, not a researched
   * answer, and the cheaper setting returns the same links.
   */
  contextSize?: 'low' | 'medium' | 'high' | undefined;
  /** Injected by tests; the real one is constructed from the config. */
  client?: OpenAI | undefined;
}

export function createOpenAiWebSearch(options: OpenAiWebSearchOptions = {}): WebSearchProvider {
  const config = getConfig();
  const model = options.model ?? config.webSearch.model;
  const contextSize = options.contextSize ?? 'low';

  // Built lazily, like the AI client: importing this module must not demand a key
  // from a process that only wanted to read the config.
  let client = options.client;
  const openai = (): OpenAI => {
    client ??= new OpenAI({
      apiKey: options.apiKey ?? requireKey('ai'),
      ...((options.projectId ?? config.ai.projectId)
        ? { project: options.projectId ?? config.ai.projectId }
        : {}),
    });
    return client;
  };

  return {
    name: OPENAI_WEB_SEARCH_PROVIDER,
    search: async (query, searchOptions = {}) => {
      const logger = searchOptions.logger ?? silentLogger();
      const startedAt = Date.now();

      let response: OpenAI.Responses.Response;
      try {
        response = await openai().responses.create(
          {
            model,
            instructions: SYSTEM_PROMPT,
            input: [{ role: 'user', content: buildUserPrompt(query) }],
            tools: [
              {
                type: 'web_search',
                search_context_size: contextSize,
                ...(query.allowedDomains && query.allowedDomains.length > 0
                  ? { filters: { allowed_domains: [...query.allowedDomains] } }
                  : {}),
                ...(query.country ? { user_location: userLocation(query.country) } : {}),
              },
            ],
            // Without this the tool call reports only that it searched, not what
            // it reached, and the grounding set would be citations alone.
            include: ['web_search_call.action.sources'],
            text: {
              format: {
                type: 'json_schema',
                name: 'web_search_hits',
                schema: HITS_SCHEMA,
                strict: true,
              },
            },
          },
          searchOptions.signal ? { signal: searchOptions.signal } : {},
        );
      } catch (error) {
        throw toStepError(error);
      }

      const grounding = collectGrounding(response);
      const claimed = parseHits(response.output_text);
      const hits: WebSearchHit[] = [];
      let dropped = 0;

      for (const hit of claimed) {
        const key = urlKey(hit.url);
        if (key === null || !grounding.urls.has(key)) {
          dropped += 1;
          continue;
        }
        if (hits.some((existing) => urlKey(existing.url) === key)) continue;
        hits.push({
          url: hit.url,
          // The citation title came off the page; the model's was retyped.
          title: grounding.titles.get(key) ?? hit.title,
          snippet: hit.snippet,
        });
        if (query.maxResults !== undefined && hits.length >= query.maxResults) break;
      }

      if (dropped > 0) {
        logger.warn(
          { query: query.query, dropped, kept: hits.length },
          'dropped search hits the model named but the search never reached',
        );
      }

      const result: WebSearchResult = {
        provider: OPENAI_WEB_SEARCH_PROVIDER,
        query: query.query,
        hits,
        dropped,
        usage: {
          tokensIn: response.usage?.input_tokens ?? null,
          tokensOut: response.usage?.output_tokens ?? null,
          durationMs: Date.now() - startedAt,
          model: response.model ?? model,
          searches: grounding.searches,
        },
      };
      return result;
    },
  };
}

function userLocation(country: string): { type: 'approximate'; country: string } {
  return { type: 'approximate', country: country.toUpperCase() };
}

function buildUserPrompt(query: WebSearchQuery): string {
  const lines = [`Search for: ${query.query}`];
  if (query.allowedDomains && query.allowedDomains.length > 0) {
    lines.push(`Results are restricted to: ${query.allowedDomains.join(', ')}`);
  }
  if (query.maxResults !== undefined) {
    lines.push(`Report at most ${query.maxResults} results.`);
  }
  return lines.join('\n');
}

interface Grounding {
  /** `urlKey` of every page the search reported reaching. */
  urls: Set<string>;
  /** Titles taken from citations, keyed the same way. */
  titles: Map<string, string>;
  /** How many searches the tool actually ran — what the call is billed for. */
  searches: number;
}

/**
 * What the response proves the search reached, as opposed to what it says.
 *
 * Two independent places carry it. `web_search_call.action.sources` lists the
 * URLs the tool visited, and is the broader of the two. The message annotations
 * list what the answer cited, and are the only place a page's real title appears.
 */
export function collectGrounding(response: OpenAI.Responses.Response): Grounding {
  const urls = new Set<string>();
  const titles = new Map<string, string>();
  let searches = 0;

  for (const item of response.output ?? []) {
    if (item.type === 'web_search_call') {
      if (item.action.type === 'search') {
        searches += Math.max(1, item.action.queries?.length ?? 1);
        for (const source of item.action.sources ?? []) {
          const key = urlKey(source.url);
          if (key !== null) urls.add(key);
        }
      } else if (item.action.type === 'open_page' && item.action.url) {
        const key = urlKey(item.action.url);
        if (key !== null) urls.add(key);
      }
      continue;
    }

    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type !== 'output_text') continue;
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== 'url_citation') continue;
        const key = urlKey(annotation.url);
        if (key === null) continue;
        urls.add(key);
        if (annotation.title) titles.set(key, annotation.title);
      }
    }
  }

  return { urls, titles, searches };
}

interface ClaimedHit {
  url: string;
  title: string | null;
  snippet: string | null;
}

/**
 * The model's list of results.
 *
 * A malformed answer returns nothing rather than throwing: a search that came
 * back unreadable is a store with no LinkedIn hit, not a failed pipeline step,
 * and everything it could have produced is dropped by the grounding filter
 * anyway.
 */
function parseHits(text: string): ClaimedHit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof payload !== 'object' || payload === null) return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const out: ClaimedHit[] = [];
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['url'] !== 'string' || row['url'].trim() === '') continue;
    out.push({
      url: row['url'].trim(),
      title:
        typeof row['title'] === 'string' && row['title'].trim() !== '' ? row['title'].trim() : null,
      snippet:
        typeof row['snippet'] === 'string' && row['snippet'].trim() !== ''
          ? row['snippet'].trim()
          : null,
    });
  }
  return out;
}
