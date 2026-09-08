import { getConfig, requireKey } from '../../config/index.js';
import { transaction } from '../../db/client.js';
import { cursorKey, getCursor, saveCursor } from '../../db/repositories/cursors.js';
import { attachStoreToRun, getRun } from '../../db/repositories/runs.js';
import { saveStoreApps, saveThemeInfo } from '../../db/repositories/storeFacts.js';
import { saveSnapshot, upsertStore } from '../../db/repositories/stores.js';
import { MAX_PAGE_SIZE, StoreLeadsClient } from '../../collectors/storeleads/client.js';
import type { ListDomainsParams } from '../../collectors/storeleads/client.js';
import { mapDomain } from '../../collectors/storeleads/mapper.js';
import type { StoreLeadsListResponse } from '../../collectors/storeleads/types.js';
import { StepError } from '../retry.js';
import type { PipelineStep, StepContext } from '../types.js';

/** Only the part of the client this step needs, so tests can supply a stub. */
export interface DomainSource {
  listDomains(params: ListDomainsParams): Promise<StoreLeadsListResponse>;
}

export interface FetchStoresOptions {
  client?: DomainSource;
  /**
   * Batch target: how many *new* stores to attach to the run.
   * Defaults to the run's own `batch_size`, which is what `--limit` sets.
   */
  batchSize?: number;
  country?: string;
  /** Restricts to one ecommerce platform. Pass '' to fetch every platform. */
  platform?: string;
  pageSize?: number;
  /** Stops a run that would otherwise page forever through duplicates. */
  maxPages?: number;
}

export interface FetchStoresResult {
  created: number;
  duplicates: number;
  unusable: number;
  pagesFetched: number;
  cursorBefore: number;
  cursorAfter: number;
  exhausted: boolean;
}

/**
 * Pulls the next batch of stores from StoreLeads (tasks 1-03, 1-04, 1-06, 1-08).
 *
 * "The next 10" means ten stores we have never seen: duplicates are skipped and
 * paging continues, and the cursor records how many API rows were consumed so a
 * later run resumes exactly where this one stopped.
 */
export async function fetchStores(
  ctx: Pick<StepContext, 'runId' | 'db' | 'logger'>,
  options: FetchStoresOptions = {},
): Promise<FetchStoresResult> {
  const config = getConfig();
  const country = (options.country ?? config.pipeline.targetCountry).toUpperCase();
  const platform = options.platform ?? config.pipeline.targetPlatform;
  const batchSize =
    options.batchSize ?? getRun(ctx.runId, ctx.db)?.batch_size ?? config.pipeline.batchSize;
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const maxPages = options.maxPages ?? 20;
  const client = options.client ?? defaultClient();

  const key = cursorKey('storeleads', country);
  const cursorBefore = getCursor(key, ctx.db).offset_val;

  let consumed = cursorBefore;
  let created = 0;
  let duplicates = 0;
  let unusable = 0;
  let pagesFetched = 0;
  let exhausted = false;
  let lastRank: number | null = getCursor(key, ctx.db).last_rank;

  while (created < batchSize && pagesFetched < maxPages) {
    const page = Math.floor(consumed / pageSize);
    const skipWithinPage = consumed % pageSize;

    const response = await client.listDomains({
      country,
      page,
      pageSize,
      ...(platform ? { platform } : {}),
    });
    pagesFetched += 1;

    const domains = response.domains ?? [];
    if (domains.length === 0) {
      exhausted = true;
      break;
    }

    assertFilterApplied(domains, country, platform);

    for (const raw of domains.slice(skipWithinPage)) {
      consumed += 1;

      const mapped = mapDomain(raw, { runId: ctx.runId });
      if (!mapped) {
        unusable += 1;
        continue;
      }

      // One transaction per store: a failure mid-store leaves no partial rows.
      const wasCreated = transaction(() => {
        const { store, created: isNew } = upsertStore(mapped.store, ctx.db);
        if (!isNew) return false;

        attachStoreToRun(ctx.runId, store.id, ctx.db);
        saveSnapshot(store.id, ctx.runId, raw, 'storeleads', ctx.db);
        saveStoreApps(store.id, mapped.apps, ctx.db);
        saveThemeInfo(
          store.id,
          { name: mapped.theme.name, currentVersion: mapped.theme.version },
          ctx.db,
        );
        return true;
      }, ctx.db);

      if (wasCreated) {
        created += 1;
        lastRank = mapped.store.rank ?? lastRank;
      } else {
        duplicates += 1;
      }

      if (created >= batchSize) break;
    }

    // A short page means there is nothing left behind it.
    if (domains.length < pageSize) {
      exhausted = true;
      break;
    }
  }

  saveCursor(key, consumed, lastRank, ctx.db);

  const result: FetchStoresResult = {
    created,
    duplicates,
    unusable,
    pagesFetched,
    cursorBefore,
    cursorAfter: consumed,
    exhausted,
  };
  ctx.logger.info({ ...result, country }, 'fetched stores from StoreLeads');
  return result;
}

/**
 * StoreLeads ignores unknown filter keys instead of rejecting them, answering 200
 * with the whole unfiltered index. Without this check a renamed parameter would
 * quietly fill the database with stores from the wrong country.
 */
export function assertFilterApplied(
  domains: readonly { country_code?: string | null; platform?: string | null }[],
  country: string,
  platform: string,
): void {
  const checkable = domains.filter((d) => typeof d.country_code === 'string');
  const wrongCountry = checkable.filter((d) => d.country_code!.toUpperCase() !== country).length;
  // Tolerate the odd mislabelled row; a broken filter shows up as nearly all of them.
  if (checkable.length > 0 && wrongCountry / checkable.length > 0.5) {
    throw new StepError(
      `StoreLeads country filter did not apply: ${wrongCountry}/${checkable.length} ` +
        `results are not ${country}. Check FILTER_KEYS in collectors/storeleads/client.ts`,
      { retryable: false },
    );
  }

  if (!platform) return;
  const withPlatform = domains.filter((d) => typeof d.platform === 'string');
  const wrongPlatform = withPlatform.filter(
    (d) => d.platform!.toLowerCase() !== platform.toLowerCase(),
  ).length;
  if (withPlatform.length > 0 && wrongPlatform / withPlatform.length > 0.5) {
    throw new StepError(
      `StoreLeads platform filter did not apply: ${wrongPlatform}/${withPlatform.length} ` +
        `results are not ${platform}. Check FILTER_KEYS in collectors/storeleads/client.ts`,
      { retryable: false },
    );
  }
}

function defaultClient(): DomainSource {
  const config = getConfig();
  return new StoreLeadsClient({
    apiKey: requireKey('storeleads'),
    baseUrl: config.storeleads.apiUrl,
  });
}

export function createFetchStoresStep(options: FetchStoresOptions = {}): PipelineStep {
  return {
    name: 'fetch_stores',
    scope: 'run',
    // Fetching is the entry point: if it fails there is nothing to run on.
    softFail: false,
    attempts: 2,
    timeoutMs: 120_000,
    run: async (ctx) => {
      const result = await fetchStores(ctx, options);
      if (result.created === 0 && !result.exhausted) {
        throw new StepError(
          `StoreLeads returned no new stores after ${result.pagesFetched} page(s) ` +
            `(${result.duplicates} duplicates, ${result.unusable} unusable)`,
          { retryable: false },
        );
      }
      return { status: 'OK', meta: result };
    },
  };
}
