import type { Page } from 'playwright';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { createIssue, type Issue } from './issues.js';
import type { AuditSession } from './session.js';
import type { CheckContext } from './checks/context.js';

/**
 * Broken link checking (task 2-15).
 *
 * Depth one: every link the homepage and its menu offer, deduplicated by URL and
 * probed with HEAD (falling back to GET for servers that reject HEAD). Every
 * probe goes through the session's politeness delay, so the crawl is bounded in
 * both breadth and rate.
 */

/** Hard cap on probes per store, so one shop cannot eat a whole run. */
export const MAX_LINKS = 30;
/** External links are checked too, but sparingly — they are someone else's server. */
export const MAX_EXTERNAL_LINKS = 10;

export interface PageLink {
  url: string;
  text: string;
  internal: boolean;
}

export interface BrokenLink extends PageLink {
  status: number | null;
  error: string | null;
}

export interface LinkCheckResult {
  checked: number;
  skipped: number;
  broken: BrokenLink[];
}

/**
 * Statuses that mean "you are a bot", not "this page is gone". Reporting them
 * as broken links would put a false claim in an outreach email.
 */
// 406 joins them after the 2-24 run: Shopify's customer_authentication/redirect
// answers 406 to our request and is perfectly reachable in a browser.
const BOT_STATUSES = new Set([401, 403, 405, 406, 429, 999]);

export function isBrokenStatus(status: number, internal: boolean): boolean {
  if (status < 400) return false;
  if (BOT_STATUSES.has(status)) return false;
  // A third-party server having a bad day is not the shop's defect.
  if (!internal && status >= 500) return false;
  return true;
}

/** Deduplicated, probe-worthy links, internal ones first. */
export function selectLinks(
  raw: readonly { url: string; text: string }[],
  origin: string,
  limits: { maxLinks?: number; maxExternal?: number } = {},
): { links: PageLink[]; skipped: number } {
  const maxLinks = limits.maxLinks ?? MAX_LINKS;
  const maxExternal = limits.maxExternal ?? MAX_EXTERNAL_LINKS;
  const originHost = new URL(origin).origin;

  const seen = new Set<string>();
  const internal: PageLink[] = [];
  const external: PageLink[] = [];
  let skipped = 0;

  for (const candidate of raw) {
    let url: URL;
    try {
      url = new URL(candidate.url, origin);
    } catch {
      skipped += 1;
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      skipped += 1; // mailto:, tel:, javascript:
      continue;
    }
    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);

    const link: PageLink = {
      url: key,
      text: candidate.text.trim().slice(0, 80),
      internal: url.origin === originHost,
    };
    (link.internal ? internal : external).push(link);
  }

  const eligible = internal.length + external.length;
  const links = [...internal, ...external.slice(0, maxExternal)].slice(0, maxLinks);
  // Everything not probed is "skipped": unusable schemes, duplicates, and the
  // tail the caps cut off.
  return { links, skipped: skipped + (eligible - links.length) };
}

export async function collectLinks(page: Page): Promise<{ url: string; text: string }[]> {
  return page
    .evaluate(() =>
      Array.from(document.links, (a) => ({
        url: a.href,
        text: (a.textContent ?? '').trim().slice(0, 80),
      })).slice(0, 300),
    )
    .catch(() => []);
}

async function probe(
  session: AuditSession,
  page: Page,
  link: PageLink,
): Promise<BrokenLink | null> {
  const request = page.context().request;
  const timeout = Math.min(session.pageTimeoutMs, 15_000);

  await session.throttle();
  try {
    let response = await request.head(link.url, { timeout, maxRedirects: 5 });
    // Plenty of servers answer HEAD with 405/501 and are perfectly healthy on GET.
    if (response.status() === 405 || response.status() === 501) {
      await session.throttle();
      response = await request.get(link.url, { timeout, maxRedirects: 5 });
    }
    const status = response.status();
    return isBrokenStatus(status, link.internal) ? { ...link, status, error: null } : null;
  } catch (error) {
    // A connection that cannot be made at all is broken regardless of origin.
    return { ...link, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface LinkCheckOptions {
  maxLinks?: number;
  maxExternal?: number;
  concurrency?: number;
}

export async function checkLinks(
  session: AuditSession,
  page: Page,
  origin: string,
  options: LinkCheckOptions = {},
): Promise<LinkCheckResult> {
  const { links, skipped } = selectLinks(await collectLinks(page), origin, options);
  const results = await mapWithConcurrency(links, options.concurrency ?? 4, (link) =>
    probe(session, page, link),
  );

  return {
    checked: links.length,
    skipped,
    broken: results.filter((r): r is BrokenLink => r !== null),
  };
}

export function gradeLinks(result: LinkCheckResult, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const internal = result.broken.filter((b) => b.internal);
  const external = result.broken.filter((b) => !b.internal);

  if (internal.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: 'MAJOR',
        title: 'Broken links on the site',
        detail: `${internal.length} of ${result.checked} checked links lead nowhere`,
        evidence: internal.map((link) => ({
          url: link.url,
          ...(link.status === null
            ? { text: link.error ?? 'no response' }
            : { status: link.status }),
          ...(link.text ? { selector: `a "${link.text}"` } : {}),
        })),
      }),
    );
  }

  if (external.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: 'MINOR',
        title: 'Links to external pages that no longer exist',
        detail: `${external.length} outbound link(s) are dead`,
        evidence: external.map((link) => ({
          url: link.url,
          ...(link.status === null
            ? { text: link.error ?? 'no response' }
            : { status: link.status }),
        })),
      }),
    );
  }

  return issues;
}
