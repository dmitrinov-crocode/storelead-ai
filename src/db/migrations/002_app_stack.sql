-- Task 2-23: the derived view of a store's app stack.
--
-- The raw apps stay in `store_apps`; this table holds the verdict, so the
-- dashboard can read it without importing the pipeline's analysis code — the
-- same reason `theme_info` carries the theme verdict rather than recomputing it.

CREATE TABLE app_stack (
  store_id       INTEGER PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
  total          INTEGER NOT NULL,          -- apps we hold names for
  reported_count INTEGER,                   -- what StoreLeads counted
  size           TEXT,                      -- low | medium | high | very_high
  groups_json    TEXT    NOT NULL,          -- {"marketing":6,"reviews":2,...}
  other_json     TEXT,                      -- categories that fell outside the nine groups
  uncategorised  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
