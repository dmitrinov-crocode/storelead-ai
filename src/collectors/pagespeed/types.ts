/**
 * The slice of the PageSpeed Insights v5 response we actually read (task 2-19).
 *
 * A full response is 500 KB–1 MB of Lighthouse audit detail; typing it whole
 * would be noise. Everything here is optional because PSI omits entire branches
 * on a failed analysis — `lighthouseResult.categories` is simply absent when the
 * page could not be loaded, and `loadingExperience` is absent for any origin
 * without enough CrUX traffic, which is most stores in our target segment.
 */

export type PagespeedStrategy = 'mobile' | 'desktop';

export const STRATEGIES: readonly PagespeedStrategy[] = ['mobile', 'desktop'];

/** Lighthouse category ids, in the order we report them. */
export const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;

export interface LighthouseAudit {
  id?: string;
  title?: string;
  /** 0..1, or null when Lighthouse could not score the audit. */
  score?: number | null;
  /** 'numeric' | 'binary' | 'informative' | 'notApplicable' | 'error' | 'manual' */
  scoreDisplayMode?: string;
  numericValue?: number;
  numericUnit?: string;
  displayValue?: string;
}

export interface LighthouseCategory {
  id?: string;
  title?: string;
  /** 0..1, or null when the category could not be computed. */
  score?: number | null;
}

export interface LighthouseResult {
  requestedUrl?: string;
  finalUrl?: string;
  /** Lighthouse 10+ name for `finalUrl`. */
  finalDisplayedUrl?: string;
  lighthouseVersion?: string;
  fetchTime?: string;
  configSettings?: { formFactor?: string; locale?: string };
  runWarnings?: string[];
  /** Present only when the run failed, e.g. ERRORED_DOCUMENT_REQUEST, NO_FCP, DNS_FAILURE. */
  runtimeError?: { code?: string; message?: string };
  audits?: Record<string, LighthouseAudit | undefined>;
  categories?: Record<string, LighthouseCategory | undefined>;
}

/** One CrUX field metric. `percentile` is the 75th percentile for the metric's own unit. */
export interface CruxMetric {
  percentile?: number;
  category?: string;
}

export interface LoadingExperience {
  id?: string;
  metrics?: Record<string, CruxMetric | undefined>;
  overall_category?: string;
}

/** Google's error envelope, returned with a non-2xx status. */
export interface GoogleApiError {
  code?: number;
  message?: string;
  status?: string;
  errors?: { message?: string; domain?: string; reason?: string }[];
}

export interface PagespeedResponse {
  id?: string;
  analysisUTCTimestamp?: string;
  lighthouseResult?: LighthouseResult;
  /** Field data for this exact URL. Absent when CrUX has no sample for it. */
  loadingExperience?: LoadingExperience;
  /** Field data for the whole origin — broader, so present more often. */
  originLoadingExperience?: LoadingExperience;
  error?: GoogleApiError;
}
