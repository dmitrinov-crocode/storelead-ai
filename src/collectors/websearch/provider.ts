import type { Logger } from '../../lib/logger.js';

/**
 * The web-search adapter of task 4-05.
 *
 * The plan asks for one interface so the provider can be swapped, and the reason
 * is not hypothetical: the three candidates price and rank very differently.
 * Serper returns a raw Google SERP and charges per credit; Exa filters by domain
 * as an API condition and renews a free tier monthly; OpenAI's `web_search` tool
 * costs about $10 per thousand calls and needs no account we do not already have.
 * We start on OpenAI, and everything downstream — the query templates of 4-06 and
 * the LinkedIn parsing of 4-07 — is written against this interface, not against
 * OpenAI, so switching later costs one file.
 *
 * The shape is the least common denominator of the three: a query, an optional
 * domain restriction, and a list of hits with url / title / snippet. It is
 * deliberately *not* "ask the model who the founder is". A provider returns what
 * a search engine returned; deciding what that means about a person is the job of
 * `contacts/serp.ts`, in code, where it can be tested without a network call and
 * cannot invent anybody.
 */

export interface WebSearchQuery {
  /** The query string, written as a search engine would receive it. */
  query: string;
  /**
   * Restrict results to these registrable domains, subdomains included.
   *
   * A provider that supports this as a parameter must pass it as a parameter
   * rather than folding it into the query as `site:`. The two are not equivalent:
   * `site:` is a string a ranker may quietly ignore, a filter is a condition.
   */
  allowedDomains?: readonly string[] | undefined;
  /** How many hits are useful. A provider may return fewer, never more. */
  maxResults?: number | undefined;
  /** Two-letter country the shop sells in, used to bias the locale. */
  country?: string | undefined;
}

export interface WebSearchHit {
  /** Absolute URL, as the provider reported it. */
  url: string;
  title: string | null;
  snippet: string | null;
}

export interface WebSearchUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  /** The model that ran the search, for providers that use one. */
  model: string | null;
  /** Billable searches this call cost — what the spend estimate is built from. */
  searches: number;
}

export interface WebSearchResult {
  provider: string;
  query: string;
  hits: WebSearchHit[];
  /**
   * Hits the provider offered but could not evidence, and which were therefore
   * dropped. Non-zero is worth logging: on the OpenAI provider it counts URLs the
   * model named without the search having visited them.
   */
  dropped: number;
  usage: WebSearchUsage | null;
}

export interface WebSearchOptions {
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
}

export interface WebSearchProvider {
  /** Recorded next to results so a row can be traced back to who found it. */
  readonly name: string;
  search: (query: WebSearchQuery, options?: WebSearchOptions) => Promise<WebSearchResult>;
}

/**
 * Sites that serve one page under many country subdomains, listed by name.
 *
 * LinkedIn is the only one that matters here and the only one we assert this
 * about. A generic "strip any two-letter label" rule would also collapse
 * `de.` and `en.wikipedia.org`, which really are different pages; naming the
 * host keeps the tolerance exactly as wide as the evidence for it.
 */
const LOCALE_SUBDOMAIN_HOSTS: readonly string[] = ['linkedin.com'];

/** `pl.linkedin.com` and `www.linkedin.com` are both `linkedin.com`. */
function canonicalHost(hostname: string): string {
  const bare = hostname.toLowerCase().replace(/^www\./, '');
  for (const host of LOCALE_SUBDOMAIN_HOSTS) {
    if (bare === host || bare.endsWith(`.${host}`)) return host;
  }
  return bare;
}

/**
 * Comparison key for a URL, used to decide whether two spellings name the same
 * page: canonical host, path without its trailing slash, and nothing else.
 *
 * Two reductions, both forced by real LinkedIn URLs, and getting either wrong
 * silently empties the feature rather than breaking it.
 *
 *   - **The query string goes.** LinkedIn appends `?originalSubdomain=pl` and
 *     tracking parameters, so the URL a model quotes and the URL the search
 *     visited are routinely the same page with different tails.
 *   - **The country subdomain goes**, for the hosts named above. A Polish
 *     profile comes back as `pl.linkedin.com/in/anna-kowalska` from the search
 *     and `www.linkedin.com/in/anna-kowalska` from the citation. Keyed strictly,
 *     every Polish hit would fail its own grounding check and be thrown away.
 */
export function urlKey(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const path = parsed.pathname.replace(/\/+$/, '');
  return `${canonicalHost(parsed.hostname)}${path.toLowerCase()}`;
}

/**
 * Spend control for web search, in the shape `PagespeedQuota` established.
 *
 * The ceiling is our budget, not the provider's limit. One `--force` over a
 * hundred stores at two queries each is two hundred billable searches, and the
 * only thing standing between that and the bill is this counter.
 */
export class SearchBudget {
  private readonly maxSearches: number;
  private spent = 0;

  constructor(options: { maxSearches: number }) {
    if (options.maxSearches < 0) throw new Error('maxSearches must be >= 0');
    this.maxSearches = options.maxSearches;
  }

  get remaining(): number {
    return Math.max(0, this.maxSearches - this.spent);
  }

  get used(): number {
    return this.spent;
  }

  /** Human-readable reason for a skip, or null while searches are still allowed. */
  get reason(): string | null {
    return this.remaining === 0 ? `web search budget spent (${this.maxSearches} per run)` : null;
  }

  /** Claims one search. False means the caller must skip rather than call. */
  reserve(): boolean {
    if (this.remaining === 0) return false;
    this.spent += 1;
    return true;
  }
}
