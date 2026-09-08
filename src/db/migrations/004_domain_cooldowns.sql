-- Per-domain backoff after a storefront refuses us.
--
-- The audit already detects a bot wall and records the store as BLOCKED, but
-- nothing stopped the next run — or `--force` — from going straight back. That
-- is how one `--force` over ten stores lost access to all ten at once: every
-- refusal was answered with another request.
--
-- Measured on the real segment (2026-09-02): Cloudflare let the same three
-- storefronts back in after roughly an hour, so the wait starts at an hour and
-- doubles while the refusals keep coming, rather than being a flat day.

CREATE TABLE domain_cooldowns (
  domain        TEXT PRIMARY KEY,
  -- No request may be made to this domain before this moment.
  blocked_until TEXT    NOT NULL,
  -- 'rate_limited' (429) | 'bot_challenge' | 'forbidden' (403) | 'manual'
  reason        TEXT    NOT NULL,
  -- Consecutive refusals; each one doubles the wait. Reset by a success.
  strikes       INTEGER NOT NULL DEFAULT 1,
  last_status   INTEGER,
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_cooldowns_until ON domain_cooldowns (blocked_until);
