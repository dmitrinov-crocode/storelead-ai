import type {
  AuditStatus,
  EmailStatus,
  RunStatus,
  StepStatus,
  StoreStatus,
} from '../pipeline/status.js';

/** Row shapes as they exist in SQLite: no Date objects, booleans are 0/1, JSON is TEXT. */

export interface RunRow {
  id: number;
  status: RunStatus;
  country: string;
  batch_size: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  notes: string | null;
}

export interface StoreRow {
  id: number;
  domain: string;
  url: string;
  name: string | null;
  country: string | null;
  platform: string | null;
  rank: number | null;
  revenue_estimate: number | null;
  traffic_estimate: number | null;
  growth_rate: number | null;
  products_count: number | null;
  apps_count: number | null;
  theme_name: string | null;
  theme_version: string | null;
  status: StoreStatus;
  status_reason: string | null;
  first_seen_run_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface StoreSnapshotRow {
  id: number;
  store_id: number;
  run_id: number | null;
  source: string;
  payload: string;
  fetched_at: string;
}

export interface FetchCursorRow {
  key: string;
  offset_val: number;
  last_rank: number | null;
  updated_at: string;
}

export interface AuditRow {
  id: number;
  store_id: number;
  run_id: number | null;
  status: AuditStatus;
  blocked: number;
  pages_json: string | null;
  seo_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export type IssueSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';
export type IssuePage = 'homepage' | 'collection' | 'product' | 'cart' | 'checkout' | 'site';
export type IssueCategory = 'technical' | 'performance' | 'ux' | 'cro' | 'seo';

export interface AuditIssueRow {
  id: number;
  audit_id: number;
  store_id: number;
  page: IssuePage;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  detail: string | null;
  evidence_json: string | null;
  source: string;
  created_at: string;
}

export interface ScreenshotRow {
  id: number;
  store_id: number;
  audit_id: number | null;
  page: IssuePage;
  viewport: 'desktop' | 'mobile';
  path: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface PagespeedRow {
  id: number;
  store_id: number;
  strategy: 'mobile' | 'desktop';
  performance: number | null;
  accessibility: number | null;
  best_practices: number | null;
  seo: number | null;
  fcp_ms: number | null;
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  ttfb_ms: number | null;
  speed_index_ms: number | null;
  raw_json: string | null;
  fetched_at: string;
}

export interface AppStackRow {
  store_id: number;
  total: number;
  reported_count: number | null;
  size: 'low' | 'medium' | 'high' | 'very_high' | null;
  groups_json: string;
  other_json: string | null;
  uncategorised: number;
  updated_at: string;
}

export interface ThemeInfoRow {
  store_id: number;
  name: string | null;
  current_version: string | null;
  latest_version: string | null;
  version_gap: number | null;
  released_at: string | null;
  age_months: number | null;
  architecture: string | null;
  freshness: string | null;
  updated_at: string;
}

export interface StoreAppRow {
  id: number;
  store_id: number;
  name: string;
  category: string | null;
  created_at: string;
}

export interface AiAnalysisRow {
  id: number;
  store_id: number;
  run_id: number | null;
  agent: 'store_analyst' | 'lead_classifier';
  prompt_version: string;
  input_json: string | null;
  output_json: string | null;
  category: string | null;
  lead_score: number | null;
  priority: string | null;
  reason: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_ms: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface ContactRow {
  id: number;
  store_id: number;
  name: string | null;
  role: string | null;
  email: string | null;
  linkedin_url: string | null;
  source: string;
  source_url: string | null;
  confidence: number;
  is_generic: number;
  is_primary: number;
  created_at: string;
}

export interface DomainCooldownRow {
  domain: string;
  blocked_until: string;
  reason: string;
  strikes: number;
  last_status: number | null;
  updated_at: string;
}

export interface ContactSuppressionRow {
  id: number;
  /** Exactly one of email / domain is set. */
  email: string | null;
  domain: string | null;
  reason: string;
  created_at: string;
}

export interface EmailRow {
  id: number;
  store_id: number;
  contact_id: number | null;
  run_id: number | null;
  version: number;
  subject: string;
  body: string;
  word_count: number | null;
  category: string | null;
  prompt_version: string | null;
  status: EmailStatus;
  qc_json: string | null;
  qc_passed: number | null;
  similarity: number | null;
  created_at: string;
}

export interface StepLogRow {
  id: number;
  run_id: number;
  store_id: number | null;
  step: string;
  status: StepStatus;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  meta_json: string | null;
}
