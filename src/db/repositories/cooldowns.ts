import { execute, queryAll, queryOne, type Database } from '../client.js';
import type { DomainCooldownRow } from '../types.js';
import { normalizeDomain } from '../../lib/domain.js';
import { nowIso } from '../../lib/time.js';

/**
 * Backing off from a storefront that refused us.
 *
 * The rule this enforces: a refusal is answered with silence, not with another
 * request. Every step that touches a storefront asks `cooldownFor` first, so a
 * shop behind a bot wall is left alone until the wait expires — `--force`
 * included, because forcing is what caused the damage in the first place.
 */

export type RefusalReason = 'rate_limited' | 'bot_challenge' | 'forbidden' | 'manual';

/**
 * First wait after a refusal. Measured, not guessed: Cloudflare let the same
 * three storefronts back in after roughly an hour.
 */
const BASE_COOLDOWN_MS = 60 * 60 * 1000;
/** Doubling stops here; beyond a day the shop is a problem for a human to look at. */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A `Retry-After` far in the future is a misconfiguration, not an instruction. */
const MAX_RETRY_AFTER_MS = MAX_COOLDOWN_MS;

export function canonicalDomain(input: string): string {
  return normalizeDomain(input)?.domain ?? input.trim().toLowerCase();
}

export interface Cooldown {
  domain: string;
  until: Date;
  reason: RefusalReason;
  strikes: number;
  msRemaining: number;
}

/** The active cooldown for a domain, or null when it may be visited. */
export function cooldownFor(domain: string, db?: Database, now = new Date()): Cooldown | null {
  const key = canonicalDomain(domain);
  const row = queryOne<DomainCooldownRow>(
    'SELECT * FROM domain_cooldowns WHERE domain = ?',
    [key],
    db,
  );
  if (!row) return null;

  const until = new Date(row.blocked_until);
  const msRemaining = until.getTime() - now.getTime();
  if (msRemaining <= 0) return null;

  return {
    domain: key,
    until,
    reason: row.reason as RefusalReason,
    strikes: row.strikes,
    msRemaining,
  };
}

export interface RefusalInput {
  reason: RefusalReason;
  status?: number | null;
  /** Seconds from a `Retry-After` header, when the site said how long to wait. */
  retryAfterSeconds?: number | null;
}

/**
 * Records a refusal and returns the wait it produced.
 *
 * `Retry-After` wins when the site sent one — being told how long to wait and
 * then guessing something shorter is the one behaviour guaranteed to make things
 * worse. Otherwise the wait doubles per consecutive refusal.
 */
export function noteRefusal(
  domain: string,
  input: RefusalInput,
  db?: Database,
  now = new Date(),
): Cooldown {
  const key = canonicalDomain(domain);
  const existing = queryOne<DomainCooldownRow>(
    'SELECT * FROM domain_cooldowns WHERE domain = ?',
    [key],
    db,
  );

  // Strikes only accumulate while a cooldown is still standing; a shop that let
  // us back in and then refused again starts over.
  const stillCooling = existing !== undefined && new Date(existing.blocked_until) > now;
  const strikes = stillCooling ? existing.strikes + 1 : 1;

  const retryAfterMs =
    input.retryAfterSeconds !== undefined && input.retryAfterSeconds !== null
      ? Math.min(Math.max(input.retryAfterSeconds, 0) * 1000, MAX_RETRY_AFTER_MS)
      : null;
  const backoffMs = Math.min(BASE_COOLDOWN_MS * 2 ** (strikes - 1), MAX_COOLDOWN_MS);
  const waitMs = Math.max(retryAfterMs ?? 0, backoffMs);
  const until = new Date(now.getTime() + waitMs);

  execute(
    `INSERT INTO domain_cooldowns (domain, blocked_until, reason, strikes, last_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (domain) DO UPDATE SET
       blocked_until = excluded.blocked_until,
       reason        = excluded.reason,
       strikes       = excluded.strikes,
       last_status   = excluded.last_status,
       updated_at    = excluded.updated_at`,
    [key, until.toISOString(), input.reason, strikes, input.status ?? null, nowIso()],
    db,
  );

  return { domain: key, until, reason: input.reason, strikes, msRemaining: waitMs };
}

/** Clears the cooldown after the storefront served us normally again. */
export function noteSuccess(domain: string, db?: Database): void {
  execute('DELETE FROM domain_cooldowns WHERE domain = ?', [canonicalDomain(domain)], db);
}

export function listCooldowns(db?: Database, now = new Date()): DomainCooldownRow[] {
  return queryAll<DomainCooldownRow>(
    'SELECT * FROM domain_cooldowns WHERE blocked_until > ? ORDER BY blocked_until',
    [now.toISOString()],
    db,
  );
}

/** `Retry-After` in seconds, whether the header carried seconds or a date. */
export function parseRetryAfter(
  header: string | null | undefined,
  now = new Date(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - now.getTime()) / 1000));
}
