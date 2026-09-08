import type { PipelineStep } from '../types.js';
import { createAiAnalysisStep } from './aiAnalysis.js';
import { createAuditStep } from './audit.js';
import { createContactSearchStep } from './contactSearch.js';
import { createEmailGenerationStep } from './emailGeneration.js';
import { createFetchStoresStep } from './fetchStores.js';
import { createPagespeedStep } from './pagespeed.js';
import { createThemeAppsStep } from './themeApps.js';

/**
 * Step registry. Steps are added by the epics that own them:
 *   fetch_stores     — Epic 1 (StoreLeads)  [done]
 *   audit            — Epic 2 (Playwright) [done]
 *   pagespeed        — Epic 2 (PageSpeed Insights) [done]
 *   theme_apps       — Epic 2 (theme freshness done; apps in 2-23)
 *   ai_analysis      — Epic 3 (analyst, classifier, lead score; golden set in 3-12)
 *   contact_search   — Epic 4 (own pages and web search) [done]
 *   email_generation — Epic 5 (writer, QC, repetition; calibration in 5-09)
 *
 * The orchestrator sorts by STEP_ORDER, so registration order does not matter.
 */
export const STEPS: PipelineStep[] = [
  createFetchStoresStep(),
  createAuditStep(),
  createPagespeedStep(),
  createThemeAppsStep(),
  createAiAnalysisStep(),
  createContactSearchStep(),
  createEmailGenerationStep(),
];

export function getStep(name: string): PipelineStep | undefined {
  return STEPS.find((s) => s.name === name);
}
