import { getConfig } from '../../config/index.js';
import { listContacts, saveContacts } from '../../db/repositories/contacts.js';
import { cooldownFor, noteRefusal, noteSuccess } from '../../db/repositories/cooldowns.js';
import { AuditPool } from '../../audit/pool.js';
import { createOpenAiClient, type AiClient } from '../../ai/client.js';
import { createOpenAiWebSearch } from '../../collectors/websearch/openai.js';
import { SearchBudget, type WebSearchProvider } from '../../collectors/websearch/provider.js';
import { readAboutPages } from '../../contacts/aboutAgent.js';
import { collectStoreContacts, type StoreContacts } from '../../contacts/collect.js';
import { scrapeContactPages } from '../../contacts/pageScraper.js';
import { buildContactCandidates } from '../../contacts/ranking.js';
import { searchStoreContacts } from '../../contacts/webSearch.js';
import type { SerpPerson } from '../../contacts/serp.js';
import type { LinkedInTarget } from '../../contacts/social.js';
import type { Logger } from '../../lib/logger.js';
import type { StoreRow } from '../../db/types.js';
import { StepError } from '../retry.js';
import type { PipelineStep } from '../types.js';

/**
 * The contact search step (Epic 4).
 *
 * Three sources, in this order. First the shop's own pages — `/about`,
 * `/contact`, the footer and the policies — read by the heuristics of 4-04,
 * because a merchant who introduces themselves is the strongest evidence there
 * is. Then, when those named nobody, the same pages read by a model (the other
 * half of 4-04): the text is already downloaded, so it costs one call and no
 * request to the shop. Only then the web search of 4-05…4-07.
 *
 * The order is also the spending rule: search costs money per store, the scrape
 * does not, and a shop that already named its founder is not worth searching for.
 *
 * Web search is the one thing that still works when the storefront does not. Of
 * the twelve shops in the 2026-09-02 integration run, five answered 429 on the
 * homepage and the step reported "no contacts published" for all of them — a
 * shop we never reached, filed as a shop with nothing to find. Those are now the
 * cases the search is most useful for: it touches LinkedIn's search results, not
 * the merchant, so a cooling-off storefront costs it nothing.
 *
 * The browser comes from the same pool as the audit: one Chromium for the whole
 * run, and the politeness delay of 7-06 applies through `AuditSession`.
 */

/** Statuses that mean "not now" rather than "no such page". */
function isRefusal(status: number): boolean {
  return status === 429 || status === 403 || status === 503;
}

/** What one store's web search produced, plus what it cost, for `step_logs`. */
interface SearchOutcome {
  people: SerpPerson[];
  company: LinkedInTarget | null;
  meta: Record<string, unknown>;
}

/** What a storefront we never reached offered: nothing. */
const EMPTY_CONTACTS: StoreContacts = {
  personalEmails: [],
  linkedin: [],
  genericEmails: [],
  people: [],
  empty: true,
};

export interface ContactSearchStepOptions {
  pool?: AuditPool;
  /** Ceiling on page loads per store, homepage included. */
  maxRequests?: number;
  /** Overrides the identified user agent; tests use it to skip robots.txt. */
  userAgent?: string;
  respectRobots?: boolean;
  timeoutMs?: number;
  /**
   * Model client for the About reader (task 4-04). Defaults to OpenAI;
   * `null` turns the reading off, which is how tests stay offline.
   */
  aiClient?: AiClient | null;
  /**
   * Web search provider (task 4-05). Defaults to OpenAI when enabled in the
   * config; `null` turns the search off for this step regardless of the config,
   * which is how tests keep themselves offline.
   */
  webSearch?: WebSearchProvider | null;
  /** Queries per store. Defaults to the config; 0 disables the search. */
  maxQueriesPerStore?: number;
  /** Billable searches for the whole run. Defaults to the config. */
  maxSearchesPerRun?: number;
}

export function createContactSearchStep(options: ContactSearchStepOptions = {}): PipelineStep {
  // Unlike the audit, this scrape says who it is. The audit keeps a browser
  // user agent because it must see what a shopper sees; nothing here needs that
  // fidelity, so the polite option costs nothing (task 7-06).
  const userAgent = options.userAgent ?? getConfig().crawler.userAgent;
  const pool =
    options.pool ??
    new AuditPool({
      concurrency: getConfig().pipeline.storeConcurrency,
      session: { contextOverrides: { userAgent } },
    });

  // Built lazily: a run whose shops all name somebody never constructs a client.
  let reader: AiClient | null | undefined = options.aiClient;
  const aboutReader = (): AiClient | null => {
    if (reader !== undefined) return reader;
    reader = createOpenAiClient();
    return reader;
  };

  const searchConfig = getConfig().webSearch;
  const maxQueries = options.maxQueriesPerStore ?? searchConfig.maxQueriesPerStore;
  // The budget is created once per step and therefore lives for the whole run,
  // which is the only scope at which a stop-loss means anything.
  const budget = new SearchBudget({
    maxSearches: options.maxSearchesPerRun ?? searchConfig.maxSearchesPerRun,
  });

  // Constructed lazily so a run whose stores all publish contacts never builds a
  // client, and a missing key is only a problem for a run that would have searched.
  let provider: WebSearchProvider | null | undefined = options.webSearch;
  const webSearch = (): WebSearchProvider | null => {
    if (provider !== undefined) return provider;
    provider = searchConfig.enabled ? createOpenAiWebSearch() : null;
    return provider;
  };

  /**
   * The search of 4-05…4-07, run only when the storefront named nobody.
   *
   * Failures are swallowed on purpose: the search is a supplement, and losing the
   * addresses the scrape did find because a search call timed out would be a
   * worse outcome than having no LinkedIn profile.
   */
  const runWebSearch = async (
    store: StoreRow,
    contacts: StoreContacts | null,
    logger: Logger,
  ): Promise<SearchOutcome> => {
    const none: SearchOutcome = { people: [], company: null, meta: {} };
    if (maxQueries <= 0) return none;
    if (contacts && contacts.people.length > 0) return none;

    const searcher = webSearch();
    if (!searcher) return none;

    try {
      const found = await searchStoreContacts(
        { domain: store.domain, name: store.name, country: store.country },
        { provider: searcher, budget, maxQueries, logger },
      );
      return {
        people: found.people,
        company: found.company,
        meta: {
          searchQueries: found.queries,
          ...(found.company ? { searchCompany: found.company.url } : {}),
          searchHits: found.hits,
          searchDropped: found.dropped,
          searchProvider: found.provider,
          searchTokensIn: found.tokensIn,
          searchTokensOut: found.tokensOut,
          searchDurationMs: found.durationMs,
          ...(found.stoppedBecause ? { searchStopped: found.stoppedBecause } : {}),
        },
      };
    } catch (error) {
      logger.warn({ err: error }, 'web search for contacts failed; keeping what the scrape found');
      return none;
    }
  };

  return {
    name: 'contact_search',
    scope: 'store',
    // A shop that hides its contacts must not take the run down with it.
    softFail: true,
    attempts: 1,
    timeoutMs: options.timeoutMs ?? 120_000,

    isSatisfied: (ctx) => {
      if (!ctx.store) return false;
      return listContacts(ctx.store.id, ctx.db).length > 0;
    },

    run: async (ctx) => {
      const store = ctx.store;
      if (!store)
        throw new StepError('contact_search is a store-scoped step', { retryable: false });

      // A storefront that refused us is left alone until the wait expires —
      // `--force` included, since forcing is what burned the access last time.
      const cooling = cooldownFor(store.domain, ctx.db);
      if (cooling) {
        const minutes = Math.ceil(cooling.msRemaining / 60_000);
        ctx.logger.info({ until: cooling.until.toISOString(), minutes }, 'domain is cooling down');
        return {
          status: 'SKIPPED',
          meta: {
            reason: `domain is cooling down after ${cooling.reason}`,
            until: cooling.until.toISOString(),
            minutes,
          },
        };
      }

      const [outcome] = await pool.map([store], async (target, session) => {
        const scrape = await scrapeContactPages(session, target.url, {
          logger: ctx.logger,
          userAgent,
          ...(options.respectRobots === undefined ? {} : { respectRobots: options.respectRobots }),
          ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
        });
        const contacts = collectStoreContacts(scrape.pages, target.domain);
        return { scrape, contacts };
      });

      if (!outcome || !outcome.ok) {
        throw new StepError(outcome?.error.message ?? 'contact search produced no result');
      }

      const { scrape, contacts } = outcome.value;

      if (scrape.pages.length === 0 && isRefusal(scrape.homepageStatus)) {
        const cooldown = noteRefusal(
          store.domain,
          {
            reason: scrape.homepageStatus === 429 ? 'rate_limited' : 'forbidden',
            status: scrape.homepageStatus,
            retryAfterSeconds: scrape.retryAfterSeconds,
          },
          ctx.db,
        );
        ctx.logger.warn(
          { status: scrape.homepageStatus, until: cooldown.until.toISOString() },
          'storefront refused us; backing off',
        );

        // The shop is unreachable, not contactless. The search reads LinkedIn's
        // results, so it costs the cooling storefront nothing — and this is the
        // case it was added for.
        const searched = await runWebSearch(store, null, ctx.logger);
        const refusalMeta = {
          reason: `storefront answered ${scrape.homepageStatus}`,
          backoffUntil: cooldown.until.toISOString(),
          strikes: cooldown.strikes,
          ...searched.meta,
        };

        if (searched.people.length === 0 && searched.company === null) {
          return { status: 'SKIPPED', meta: refusalMeta };
        }

        const saved = saveContacts(
          store.id,
          buildContactCandidates(EMPTY_CONTACTS, store.domain, searched.people, searched.company),
          ctx.db,
        );
        return {
          status: 'OK',
          meta: { ...refusalMeta, serpPeople: searched.people.length, ...saved },
        };
      }

      // It answered normally, so any earlier cooldown is over.
      if (scrape.pages.length > 0) noteSuccess(store.domain, ctx.db);

      // The model reads the same pages the heuristics just failed on. It runs
      // before the web search because the text is already here: one call, and
      // not a single extra request to a shop that may be rate-limiting us.
      const readMeta: Record<string, unknown> = {};
      if (contacts.people.length === 0 && scrape.pages.length > 0) {
        const client = aboutReader();
        if (client) {
          try {
            const reading = await readAboutPages({
              client,
              pages: scrape.pages,
              storeDomain: store.domain,
              logger: ctx.logger,
              signal: ctx.signal,
            });
            contacts.people = reading.people;
            Object.assign(readMeta, {
              aboutPeople: reading.people.length,
              aboutUngrounded: reading.ungrounded.length,
              aboutRejected: reading.rejected.length,
              aboutTokensIn: reading.usage?.tokensIn ?? null,
              aboutTokensOut: reading.usage?.tokensOut ?? null,
            });
          } catch (error) {
            // A supplement that failed must not lose the addresses already found.
            ctx.logger.warn({ err: error }, 'the about reader failed; keeping the scrape');
          }
        }
      }

      // Only when nobody has been named yet — a person on the shop's own page is
      // better evidence than anything a search can return, and paying for a
      // search after finding one buys nothing.
      const searched = await runWebSearch(store, contacts, ctx.logger);

      const nothingFound =
        contacts.people.length === 0 &&
        contacts.personalEmails.length === 0 &&
        contacts.genericEmails.length === 0 &&
        contacts.linkedin.length === 0;

      if (nothingFound && searched.people.length === 0 && searched.company === null) {
        // Two very different outcomes end up here, and conflating them hides the
        // second: a shop that published nothing, and a shop we never reached.
        // Bot protection makes the latter common in this segment (see 2-24).
        const reason =
          scrape.pages.length === 0
            ? 'storefront could not be loaded'
            : 'storefront published no contact';

        ctx.logger.info({ requests: scrape.requests, notes: scrape.notes, reason }, reason);
        return {
          status: 'SKIPPED',
          // The reading counts belong here most of all: when nobody was found,
          // "the model named two people and neither was on the page" is the
          // answer to why, and it is invisible without them.
          meta: {
            requests: scrape.requests,
            reason,
            notes: scrape.notes,
            ...readMeta,
            ...searched.meta,
          },
        };
      }

      const candidates = buildContactCandidates(
        contacts,
        store.domain,
        searched.people,
        searched.company,
      );
      const saved = saveContacts(store.id, candidates, ctx.db);

      return {
        status: 'OK',
        meta: {
          requests: scrape.requests,
          pages: scrape.pages.length,
          disallowed: scrape.disallowed.length,
          people: contacts.people.length,
          personalEmails: contacts.personalEmails.length,
          genericEmails: contacts.genericEmails.length,
          linkedin: contacts.linkedin.length,
          ...readMeta,
          serpPeople: searched.people.length,
          ...searched.meta,
          ...saved,
        },
      };
    },

    teardown: () => pool.close(),
  };
}
