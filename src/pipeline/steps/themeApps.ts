import { analyzeApps } from '../../analysis/apps.js';
import type { AppStackAnalysis } from '../../analysis/apps.js';
import { analyzeTheme } from '../../analysis/theme.js';
import type { ThemeAnalysis } from '../../analysis/theme.js';
import { loadThemeCatalog } from '../../analysis/themeCatalog.js';
import type { ThemeCatalog } from '../../analysis/themeCatalog.js';
import {
  listStoreApps,
  saveAppStack,
  saveThemeAnalysis,
} from '../../db/repositories/storeFacts.js';
import { StepError } from '../retry.js';
import type { PipelineStep } from '../types.js';

/**
 * The theme / apps step (tasks 2-21 and 2-23).
 *
 * Both halves are pure computation over facts `fetch_stores` already stored, so
 * the step makes no network call and deliberately has no `isSatisfied`: rerunning
 * it costs microseconds, and after the reference in `themeCatalog.json` is
 * refreshed (task 2-22) every store *should* be re-judged. The same holds for the
 * app grouping: it follows the mapping table, and the mapping changes without the
 * store changing.
 */

export interface ThemeAppsStepOptions {
  catalog?: ThemeCatalog;
  now?: () => Date;
}

export interface ThemeAppsStepMeta {
  theme: {
    name: string | null;
    architecture: string | null;
    freshness: string | null;
    versionGap: number | null;
    ageMonths: number | null;
    catalogued: boolean;
    reason: string;
  };
  apps: {
    total: number;
    reportedCount: number | null;
    size: string | null;
    groups: string[];
    uncategorised: number;
    reason: string;
  };
}

export function createThemeAppsStep(options: ThemeAppsStepOptions = {}): PipelineStep {
  const now = options.now ?? (() => new Date());

  return {
    name: 'theme_apps',
    scope: 'store',
    softFail: true,
    // Nothing here can fail transiently: it is arithmetic over rows we already hold.
    attempts: 1,
    timeoutMs: 30_000,

    // The only step whose work is synchronous, so the guard rejects rather than
    // throwing: `run` must always hand back a promise, never blow up in the caller.
    run: (ctx) => {
      const store = ctx.store;
      if (!store) {
        return Promise.reject(
          new StepError('theme_apps is a store-scoped step', { retryable: false }),
        );
      }

      const analysis: ThemeAnalysis = analyzeTheme(
        { name: store.theme_name, version: store.theme_version },
        { catalog: options.catalog ?? loadThemeCatalog(), now: now() },
      );

      saveThemeAnalysis(
        store.id,
        {
          name: analysis.name,
          currentVersion: analysis.currentVersion,
          latestVersion: analysis.latestVersion,
          versionGap: analysis.versionGap,
          releasedAt: analysis.releasedAt,
          ageMonths: analysis.ageMonths,
          architecture: analysis.architecture,
          freshness: analysis.freshness,
        },
        ctx.db,
      );

      const apps: AppStackAnalysis = analyzeApps(listStoreApps(store.id, ctx.db), {
        reportedCount: store.apps_count,
      });

      saveAppStack(
        store.id,
        {
          total: apps.total,
          reportedCount: apps.reportedCount,
          size: apps.size,
          byGroup: apps.byGroup,
          otherCategories: apps.otherCategories,
          uncategorised: apps.uncategorised,
        },
        ctx.db,
      );

      const meta: ThemeAppsStepMeta = {
        theme: {
          name: analysis.name,
          architecture: analysis.architecture,
          freshness: analysis.freshness,
          versionGap: analysis.versionGap,
          ageMonths: analysis.ageMonths,
          catalogued: analysis.catalogued,
          reason: analysis.reason,
        },
        apps: {
          total: apps.total,
          reportedCount: apps.reportedCount,
          size: apps.size,
          groups: apps.groupsPresent,
          uncategorised: apps.uncategorised,
          reason: apps.reason,
        },
      };

      // An uncatalogued theme is a gap in the reference, not a fact about the
      // store — the row is written either way, with nulls where we know nothing.
      // Apps carry their own weight: a store with apps produced a real verdict
      // even when its theme is unknown.
      const producedSomething = analysis.catalogued || apps.total > 0;
      return Promise.resolve({ status: producedSomething ? 'OK' : 'SKIPPED', meta });
    },
  };
}
