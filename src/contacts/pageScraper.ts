import type { Page } from 'playwright';
import { parseRetryAfter } from '../db/repositories/cooldowns.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import { ALLOW_ALL, parseRobots, type RobotsRules } from './robots.js';
import type { AuditSession } from '../audit/session.js';

/**
 * Fetching the pages that carry a merchant's own contact details (task 4-01).
 *
 * Two sources are combined, cheapest first. The footer is authoritative — it is
 * where a shop actually links its About, Contact and policy pages, whatever the
 * slugs are — so the homepage is loaded once and its footer links classified.
 * Only the kinds the footer did not name are then guessed from a candidate list.
 * Guessing every slug would cost ~20 requests per store against shops we are not
 * customers of; the whole scrape is capped instead (task 7-06).
 *
 * Polish slugs are first-class here: the target segment is PL (`TARGET_COUNTRY`),
 * and `/kontakt`, `/o-nas`, `/regulamin` are what those shops actually use.
 *
 * Extraction of the details themselves is task 4-02 — this module only decides
 * which URLs are worth reading and returns what they served.
 */

export type ContactPageKind = 'home' | 'contact' | 'about' | 'privacy' | 'terms';

/** How the URL was found. A footer link is a stronger signal than a lucky guess. */
export type ContactPageSource = 'homepage' | 'footer' | 'guess';

export interface ScrapedPage {
  kind: ContactPageKind;
  url: string;
  status: number;
  source: ContactPageSource;
  /** Rendered markup: obfuscated addresses often survive only in attributes. */
  html: string;
  /** Visible text, whitespace collapsed. */
  text: string;
  /** `mailto:` targets, decoded — the least ambiguous evidence a page offers. */
  mailtos: string[];
}

export interface ScrapeResult {
  pages: ScrapedPage[];
  /** URLs left alone because robots.txt disallowed them. */
  disallowed: string[];
  /** Status of the homepage: 0 when it never answered. Drives the backoff. */
  homepageStatus: number;
  /** Seconds the homepage asked us to wait, when it said so. */
  retryAfterSeconds: number | null;
  /** Navigations performed, including misses. Bounded by `maxRequests`. */
  requests: number;
  /** Human-readable trace of what was tried, for the step log. */
  notes: string[];
}

/** Every kind except the homepage, which is always scraped and never guessed. */
type LinkedPageKind = Exclude<ContactPageKind, 'home'>;

/**
 * Priority order, and it is deliberate: Contact and About carry names and roles
 * (tasks 4-02, 4-04), while the policy pages are the fallback — an EU shop is
 * legally obliged to name an entity and a contact address there, so they pay off
 * exactly on the shops that hide everything else. The cap therefore drops Terms
 * first and Contact last.
 */
const KIND_ORDER: readonly LinkedPageKind[] = ['contact', 'about', 'privacy', 'terms'];

/** Slugs tried when the footer named no page of that kind. Shopify shapes first. */
const GUESS_PATHS: Record<LinkedPageKind, readonly string[]> = {
  contact: ['/pages/contact', '/pages/kontakt', '/pages/contact-us', '/contact', '/kontakt'],
  about: ['/pages/about', '/pages/o-nas', '/pages/about-us', '/about', '/o-nas'],
  privacy: [
    '/policies/privacy-policy',
    '/pages/privacy-policy',
    '/pages/polityka-prywatnosci',
    '/polityka-prywatnosci',
  ],
  terms: [
    '/policies/terms-of-service',
    '/pages/terms-of-service',
    '/pages/regulamin',
    '/regulamin',
  ],
};

/** Matched against the URL path. */
const PATH_PATTERNS: Record<LinkedPageKind, RegExp> = {
  contact: /(^|\/)(contact|contact-us|kontakt|skontaktuj[a-z-]*)(\.[a-z]+)?$/i,
  about: /(^|\/)(about|about-us|our-story|o-nas|o-firmie|kim-jestesmy)(\.[a-z]+)?$/i,
  privacy: /(^|\/)(privacy[a-z-]*|polityka-prywatnosci|prywatnosc)(\.[a-z]+)?$/i,
  terms: /(^|\/)(terms[a-z-]*|tos|regulamin)(\.[a-z]+)?$/i,
};

/** Matched against the anchor text, for shops whose slugs say nothing (`/pages/p1`). */
const TEXT_PATTERNS: Record<LinkedPageKind, RegExp> = {
  contact: /\b(contact|kontakt|skontaktuj)/i,
  about: /\b(about|o nas|onas|our story|kim jesteśmy|kim jestesmy|nasza historia)/i,
  privacy: /\b(privacy|prywatnoś|prywatnos)/i,
  terms: /\b(terms|regulamin|warunki)/i,
};

/**
 * A page that answered 200 but says "not found" anyway. Themes do this for
 * guessed slugs, and a 404 body read as an About page would poison 4-02.
 * Only short bodies are judged: a real policy page may well contain the phrase.
 */
const NOT_FOUND_TEXT = /(404|page not found|not found|nie znaleziono|strona nie istnieje)/i;
const NOT_FOUND_MAX_CHARS = 400;

const DEFAULT_MAX_REQUESTS = 8;

export interface ScrapeOptions {
  logger?: Logger;
  /** Ceiling on navigations for one store, homepage included. */
  maxRequests?: number;
  /** Guesses attempted per kind before giving up on it. */
  maxGuessesPerKind?: number;
  /**
   * User agent this scrape identifies itself with. Since it names a crawler,
   * `robots.txt` applies and is fetched and obeyed. Omit only in tests.
   */
  userAgent?: string;
  /** Off only for tests that have no robots.txt to serve. */
  respectRobots?: boolean;
}

interface FooterCandidate {
  kind: LinkedPageKind;
  url: string;
}

/**
 * Classifies the links a shop offers into the page kinds worth reading.
 *
 * The path is trusted over the anchor text — `/policies/privacy-policy` labelled
 * "Legal" is still the privacy policy — and only same-origin links are kept: a
 * scrape must never wander off the store (the same rule as `discovery.ts`).
 */
export function classifyContactLinks(
  links: readonly { href: string; text: string }[],
  origin: string,
): FooterCandidate[] {
  const originHost = new URL(origin).origin;
  const seen = new Set<string>();
  const out: FooterCandidate[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href, origin);
    } catch {
      continue;
    }
    if (url.origin !== originHost) continue;
    if (!/^https?:$/.test(url.protocol)) continue;

    const clean = normalizeUrl(url);
    if (seen.has(clean)) continue;

    const kind = kindOf(url.pathname, link.text);
    if (!kind) continue;

    seen.add(clean);
    out.push({ kind, url: clean });
  }

  // Stable, priority-first order so the request cap cuts the least useful kinds.
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

function kindOf(pathname: string, text: string): LinkedPageKind | null {
  const path = pathname.replace(/\/+$/, '');
  for (const kind of KIND_ORDER) {
    if (PATH_PATTERNS[kind].test(path)) return kind;
  }
  const trimmed = text.trim();
  if (trimmed.length > 0 && trimmed.length <= 60) {
    for (const kind of KIND_ORDER) {
      if (TEXT_PATTERNS[kind].test(trimmed)) return kind;
    }
  }
  return null;
}

/** Query and fragment identify a view of a page, not another page. */
function normalizeUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '' ? '/' : path}`;
}

/** Anchors inside the footer, plus their text. Falls back to every link on the page. */
export async function footerLinks(page: Page): Promise<{ href: string; text: string }[]> {
  return page
    .evaluate(() => {
      const scopes = document.querySelectorAll(
        'footer, [role="contentinfo"], .site-footer, #shopify-section-footer, [class*="footer"]',
      );
      const roots: Element[] = scopes.length > 0 ? Array.from(scopes) : [document.body];
      const out: { href: string; text: string }[] = [];
      for (const root of roots) {
        for (const a of Array.from(root.querySelectorAll('a[href]')).slice(0, 200)) {
          const anchor = a as HTMLAnchorElement;
          out.push({ href: anchor.href, text: (anchor.textContent ?? '').trim().slice(0, 120) });
          if (out.length >= 400) return out;
        }
      }
      return out;
    })
    .catch(() => [] as { href: string; text: string }[]);
}

/** Markup, visible text and `mailto:` targets of the page as it currently stands. */
export async function readPage(
  page: Page,
): Promise<{ html: string; text: string; mailtos: string[] }> {
  return page
    .evaluate(() => {
      const mailtos: string[] = [];
      for (const a of Array.from(document.querySelectorAll('a[href^="mailto:" i]'))) {
        const href = (a as HTMLAnchorElement).getAttribute('href') ?? '';
        const address = href.slice(href.indexOf(':') + 1).split('?')[0] ?? '';
        let decoded = address;
        try {
          decoded = decodeURIComponent(address);
        } catch {
          // A malformed escape sequence is still worth keeping raw.
        }
        const trimmed = decoded.trim();
        if (trimmed && !mailtos.includes(trimmed)) mailtos.push(trimmed);
      }
      return {
        html: document.documentElement.outerHTML,
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        mailtos,
      };
    })
    .catch(() => ({ html: '', text: '', mailtos: [] }));
}

function looksMissing(status: number, text: string): boolean {
  if (status >= 400) return true;
  return text.length <= NOT_FOUND_MAX_CHARS && NOT_FOUND_TEXT.test(text);
}

/**
 * Loads the pages of a storefront that may name a human being.
 *
 * Never throws: a shop that refuses one URL still yields the pages that did
 * answer, and a shop that refuses the homepage yields an empty result with the
 * reason in `notes`. Every navigation goes through the session, so the politeness
 * delay applies to contact scraping exactly as it does to the audit.
 */
export async function scrapeContactPages(
  session: AuditSession,
  homepage: string,
  options: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const logger = options.logger ?? silentLogger();
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxGuesses = options.maxGuessesPerKind ?? 2;
  const result: ScrapeResult = {
    pages: [],
    disallowed: [],
    homepageStatus: 0,
    retryAfterSeconds: null,
    requests: 0,
    notes: [],
  };

  const origin = new URL(homepage).origin;
  const page = await session.newPage('desktop');
  const visited = new Set<string>();

  let robots: RobotsRules = ALLOW_ALL;
  /** Extra wait the site asked for, on top of our own politeness delay. */
  let crawlDelayGapMs = 0;

  const visit = async (
    url: string,
    kind: ContactPageKind,
    source: ContactPageSource,
  ): Promise<ScrapedPage | null> => {
    const clean = normalizeUrl(new URL(url));
    if (visited.has(clean) || result.requests >= maxRequests) return null;

    if (!robots.isAllowed(new URL(clean).pathname)) {
      visited.add(clean);
      result.disallowed.push(clean);
      result.notes.push(`${clean} is disallowed by robots.txt`);
      return null;
    }

    visited.add(clean);
    result.requests += 1;
    if (crawlDelayGapMs > 0) await sleep(crawlDelayGapMs);

    const visitResult = await session.goto(page, clean);
    if (visitResult.error) {
      result.notes.push(`${clean} did not load: ${visitResult.error.message}`);
      return null;
    }
    const status = visitResult.response?.status() ?? 0;
    if (kind === 'home') {
      result.homepageStatus = status;
      result.retryAfterSeconds = parseRetryAfter(visitResult.response?.headers()['retry-after']);
    }
    const content = await readPage(page);
    if (looksMissing(status, content.text)) {
      result.notes.push(`${clean} returned ${status || 'no response'} or a not-found body`);
      return null;
    }
    return { kind, url: clean, status, source, ...content };
  };

  try {
    if (options.respectRobots !== false) {
      robots = await loadRobots(session, page, origin, options.userAgent ?? '', result);
      const requested = (robots.crawlDelaySeconds ?? 0) * 1000;
      crawlDelayGapMs = Math.max(0, requested - session.requestDelayMs);
      if (crawlDelayGapMs > 0) {
        result.notes.push(`robots.txt asks for ${robots.crawlDelaySeconds}s between requests`);
      }
    }

    const home = await visit(homepage, 'home', 'homepage');
    if (!home) {
      result.notes.push('homepage unavailable, contact scraping skipped');
      return result;
    }
    result.pages.push(home);

    // The footer is read from the homepage we already have — no extra request.
    const candidates = classifyContactLinks(await footerLinks(page), origin);
    const found = new Set<ContactPageKind>();

    for (const candidate of candidates) {
      if (found.has(candidate.kind)) continue;
      const scraped = await visit(candidate.url, candidate.kind, 'footer');
      if (!scraped) continue;
      result.pages.push(scraped);
      found.add(candidate.kind);
    }

    for (const kind of KIND_ORDER) {
      if (found.has(kind)) continue;
      if (result.requests >= maxRequests) break;

      let attempts = 0;
      for (const path of GUESS_PATHS[kind]) {
        if (attempts >= maxGuesses || result.requests >= maxRequests) break;
        const before = result.requests;
        const scraped = await visit(`${origin}${path}`, kind, 'guess');
        // A URL already visited costs no request and no attempt.
        if (result.requests === before) continue;
        attempts += 1;
        if (!scraped) continue;
        result.pages.push(scraped);
        found.add(kind);
        break;
      }
      if (!found.has(kind)) result.notes.push(`no ${kind} page found`);
    }

    return result;
  } finally {
    logger.debug(
      {
        requests: result.requests,
        kinds: result.pages.map((p) => `${p.kind}:${p.source}`),
        notes: result.notes,
      },
      'contact page scrape finished',
    );
    await page.close().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads `robots.txt`. A file we cannot fetch is treated as permission, which is
 * the convention: a missing file means no restrictions, and an unreachable one
 * would otherwise stop the scrape on every shop whose server hiccuped.
 */
async function loadRobots(
  session: AuditSession,
  page: Page,
  origin: string,
  userAgent: string,
  result: ScrapeResult,
): Promise<RobotsRules> {
  const url = `${origin}/robots.txt`;
  result.requests += 1;
  const visit = await session.goto(page, url);
  if (visit.error) return ALLOW_ALL;

  const status = visit.response?.status() ?? 0;
  if (status < 200 || status >= 300) return ALLOW_ALL;

  const body = await visit.response?.text().catch(() => '');
  if (!body) return ALLOW_ALL;

  const rules = parseRobots(body, userAgent);
  result.notes.push('robots.txt read and applied');
  return rules;
}
