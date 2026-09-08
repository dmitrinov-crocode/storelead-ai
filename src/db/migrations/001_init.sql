-- Schema v1 — task 0-06.
-- Conventions:
--   * timestamps are ISO-8601 UTC strings (SQLite has no native date type)
--   * JSON blobs are stored as TEXT and validated in the repository layer
--   * every fact an AI agent may cite lives in a row with a stable id (task 3-05)

-- ---------------------------------------------------------------- runs

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT    NOT NULL DEFAULT 'PENDING',
  country      TEXT    NOT NULL,
  batch_size   INTEGER NOT NULL,
  started_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  error        TEXT,
  notes        TEXT
);

CREATE INDEX idx_runs_status ON runs (status);

-- ---------------------------------------------------------------- stores

CREATE TABLE stores (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  -- normalised domain (lowercase, no scheme/www/path) — the dedupe key (task 1-05)
  domain             TEXT    NOT NULL UNIQUE,
  url                TEXT    NOT NULL,
  name               TEXT,
  country            TEXT,
  platform           TEXT,

  -- business facts from StoreLeads (section 3H of the plan)
  rank               INTEGER,
  revenue_estimate   INTEGER,
  traffic_estimate   INTEGER,
  growth_rate        REAL,
  products_count     INTEGER,
  apps_count         INTEGER,
  theme_name         TEXT,
  theme_version      TEXT,

  status             TEXT    NOT NULL DEFAULT 'NEW',
  status_reason      TEXT,
  first_seen_run_id  INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_stores_status ON stores (status);
CREATE INDEX idx_stores_rank ON stores (rank);

-- Which stores a given run touched, and where each one stopped.
CREATE TABLE run_stores (
  run_id     INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  store_id   INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  added_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (run_id, store_id)
);

-- Raw StoreLeads payload, kept so analysis can be re-run without re-billing the API (task 1-08).
CREATE TABLE store_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  source      TEXT    NOT NULL DEFAULT 'storeleads',
  payload     TEXT    NOT NULL,
  fetched_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_store_snapshots_store ON store_snapshots (store_id);

-- Batch cursor so "the next 10 stores" resumes where the last run stopped (task 1-04).
CREATE TABLE fetch_cursors (
  key         TEXT PRIMARY KEY,
  offset_val  INTEGER NOT NULL DEFAULT 0,
  last_rank   INTEGER,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------- audit

CREATE TABLE audits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  run_id       INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  status       TEXT    NOT NULL DEFAULT 'PENDING',
  -- set when the storefront served a bot challenge instead of the page (task 2-07)
  blocked      INTEGER NOT NULL DEFAULT 0,
  pages_json   TEXT,
  seo_json     TEXT,
  error        TEXT,
  started_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT
);

CREATE INDEX idx_audits_store ON audits (store_id);

CREATE TABLE audit_issues (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id       INTEGER NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  store_id       INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  page           TEXT    NOT NULL,   -- homepage | collection | product | cart | checkout
  category       TEXT    NOT NULL,   -- technical | performance | ux | cro | seo
  severity       TEXT    NOT NULL,   -- CRITICAL | MAJOR | MINOR
  title          TEXT    NOT NULL,
  detail         TEXT,
  -- how the issue was established: selector, console message, HTTP status, screenshot id
  evidence_json  TEXT,
  -- 'playwright' | 'pagespeed' | 'ai' — an AI issue must reference a collected fact
  source         TEXT    NOT NULL DEFAULT 'playwright',
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_audit_issues_audit ON audit_issues (audit_id);
CREATE INDEX idx_audit_issues_severity ON audit_issues (store_id, severity);

CREATE TABLE screenshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  audit_id    INTEGER REFERENCES audits (id) ON DELETE CASCADE,
  page        TEXT    NOT NULL,
  viewport    TEXT    NOT NULL,   -- desktop | mobile
  path        TEXT    NOT NULL,   -- relative to SCREENSHOTS_DIR
  width       INTEGER,
  height      INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_screenshots_store ON screenshots (store_id);

CREATE TABLE pagespeed_results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  strategy        TEXT    NOT NULL,   -- mobile | desktop
  performance     INTEGER,
  accessibility   INTEGER,
  best_practices  INTEGER,
  seo             INTEGER,
  fcp_ms          REAL,
  lcp_ms          REAL,
  cls             REAL,
  inp_ms          REAL,
  ttfb_ms         REAL,
  speed_index_ms  REAL,
  raw_json        TEXT,
  fetched_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, strategy)
);

CREATE TABLE theme_info (
  store_id         INTEGER PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
  name             TEXT,
  current_version  TEXT,
  latest_version   TEXT,
  version_gap      INTEGER,
  released_at      TEXT,
  age_months       INTEGER,
  architecture     TEXT,   -- vintage | os2 | theme_blocks | custom
  freshness        TEXT,   -- fresh | slightly_outdated | outdated | very_outdated | severely_outdated
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE store_apps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  category    TEXT,   -- StoreLeads' own category string, e.g. 'email marketing';
                      -- grouped into nine buckets by src/analysis/apps.ts (task 2-23)
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, name)
);

-- ---------------------------------------------------------------- AI

CREATE TABLE ai_analyses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  run_id          INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  agent           TEXT    NOT NULL,   -- store_analyst | lead_classifier
  prompt_version  TEXT    NOT NULL,   -- so two runs can be compared (task 3-10)
  input_json      TEXT,
  output_json     TEXT,
  category        TEXT,
  lead_score      INTEGER,
  priority        TEXT,
  reason          TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  duration_ms     INTEGER,
  status          TEXT    NOT NULL DEFAULT 'OK',
  error           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_ai_analyses_store ON ai_analyses (store_id, agent);

-- ---------------------------------------------------------------- contacts

CREATE TABLE contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name         TEXT,
  role         TEXT,
  email        TEXT,
  linkedin_url TEXT,
  -- 'about_page' | 'footer' | 'web_search' | 'linkedin_serp' | 'generic_email'
  source       TEXT    NOT NULL,
  source_url   TEXT,
  confidence   REAL    NOT NULL DEFAULT 0,
  is_generic   INTEGER NOT NULL DEFAULT 0,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_contacts_store ON contacts (store_id);
CREATE UNIQUE INDEX idx_contacts_unique_email ON contacts (store_id, email) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------- outreach

CREATE TABLE emails (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        INTEGER NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  contact_id      INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
  run_id          INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  subject         TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  word_count      INTEGER,
  category        TEXT,
  prompt_version  TEXT,
  -- DRAFT | QC_FAILED | READY | APPROVED | SKIPPED
  status          TEXT    NOT NULL DEFAULT 'DRAFT',
  qc_json         TEXT,
  qc_passed       INTEGER,
  similarity      REAL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, version)
);

CREATE INDEX idx_emails_status ON emails (status);

-- ---------------------------------------------------------------- observability

CREATE TABLE step_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  store_id     INTEGER REFERENCES stores (id) ON DELETE CASCADE,
  step         TEXT    NOT NULL,
  status       TEXT    NOT NULL,   -- RUNNING | OK | FAILED | SKIPPED
  attempt      INTEGER NOT NULL DEFAULT 1,
  started_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  duration_ms  INTEGER,
  error        TEXT,
  meta_json    TEXT
);

CREATE INDEX idx_step_logs_run ON step_logs (run_id, step);
CREATE INDEX idx_step_logs_store ON step_logs (store_id, step);
