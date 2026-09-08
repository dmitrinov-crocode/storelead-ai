import type { Page, Response } from 'playwright';
import { silentLogger, type Logger } from '../lib/logger.js';

/**
 * What stands between the audit and the page (task 2-07).
 *
 * Two different problems share this module because both are "the browser is not
 * showing me the shop":
 *   - bot protection, which invalidates the whole audit and must be flagged
 *     rather than reported as a broken storefront;
 *   - cookie and geo banners, which are legitimate but hide the page from
 *     screenshots and from every visual check, so we try to dismiss them.
 */

export interface BotProtectionSignals {
  status: number | null;
  title: string;
  bodyText: string;
  /** Lower-cased header names, as Playwright reports them. */
  headers: Record<string, string>;
  /** A captcha/challenge iframe is present (Turnstile, hCaptcha, reCAPTCHA). */
  hasChallengeFrame: boolean;
}

export interface BotProtectionVerdict {
  blocked: boolean;
  vendor: string | null;
  /** The exact signal that decided it, kept as evidence. */
  signal: string | null;
}

/** A challenge page is nearly empty; a real shop with a captcha widget is not. */
const CHALLENGE_BODY_LIMIT = 1500;

/**
 * Phrases interstitials use while they decide whether we are human. Kept
 * separate from the vendor rules because the same wording turns up unbranded.
 */
const CHALLENGE_WORDING =
  /verifying (your connection|you are human)|checking if the site connection is secure|one moment,? please|please wait while we verify/i;

interface VendorRule {
  vendor: string;
  matches: (s: BotProtectionSignals) => string | null;
}

const VENDOR_RULES: VendorRule[] = [
  {
    vendor: 'cloudflare',
    matches: (s) => {
      if (/just a moment|checking your browser|attention required/i.test(s.title)) {
        return `title: ${s.title}`;
      }
      if (/enable javascript and cookies to continue/i.test(s.bodyText)) {
        return 'body: "Enable JavaScript and cookies to continue"';
      }
      if (s.headers['cf-mitigated'] === 'challenge') return 'header: cf-mitigated=challenge';
      return null;
    },
  },
  {
    vendor: 'datadome',
    matches: (s) =>
      s.headers['x-datadome'] || /datadome/i.test(s.bodyText) ? 'DataDome interstitial' : null,
  },
  {
    vendor: 'imperva',
    matches: (s) =>
      /incapsula incident id|pardon our interruption/i.test(`${s.title} ${s.bodyText}`)
        ? 'Imperva/Incapsula block page'
        : null,
  },
  {
    vendor: 'perimeterx',
    matches: (s) =>
      /please verify you are a human|press & hold/i.test(s.bodyText)
        ? 'PerimeterX human-verification page'
        : null,
  },
  {
    vendor: 'aws-waf',
    matches: (s) => (/awswaf|aws waf/i.test(s.bodyText) ? 'AWS WAF challenge' : null),
  },
  {
    vendor: 'captcha',
    matches: (s) =>
      s.hasChallengeFrame && s.bodyText.trim().length < CHALLENGE_BODY_LIMIT
        ? 'captcha challenge on an otherwise empty page'
        : null,
  },
  {
    // Wording seen on real challenge pages, vendor unnamed: gatta.pl answers
    // 429 with `<title>Verifying your connection...</title>` and no vendor
    // marker anywhere in the page (checked 2026-09-01, task 2-24).
    vendor: 'unknown',
    matches: (s) =>
      CHALLENGE_WORDING.test(`${s.title} ${s.bodyText}`)
        ? `challenge page: ${s.title || s.bodyText.slice(0, 60)}`
        : null,
  },
  {
    vendor: 'unknown',
    matches: (s) =>
      (s.status === 403 || s.status === 429) &&
      /access denied|forbidden|unusual traffic|blocked/i.test(`${s.title} ${s.bodyText}`)
        ? `HTTP ${s.status} with a block page`
        : null,
  },
  {
    /**
     * Last resort: the two statuses a bot wall answers with, on a page too small
     * to be a storefront. A real shop that happens to return 429 has a full page
     * of markup behind it; a challenge has a spinner and a sentence.
     */
    vendor: 'unknown',
    matches: (s) =>
      (s.status === 403 || s.status === 429) && s.bodyText.trim().length < CHALLENGE_BODY_LIMIT
        ? `HTTP ${s.status} with a near-empty page (${s.bodyText.trim().length} chars)`
        : null,
  },
];

export function classifyBotProtection(signals: BotProtectionSignals): BotProtectionVerdict {
  for (const rule of VENDOR_RULES) {
    const signal = rule.matches(signals);
    if (signal) return { blocked: true, vendor: rule.vendor, signal };
  }
  return { blocked: false, vendor: null, signal: null };
}

/** Reads the signals off a live page and classifies them. */
export async function detectBotProtection(
  page: Page,
  response: Response | null,
): Promise<BotProtectionVerdict> {
  const headers = response ? await response.allHeaders() : {};
  const title = await page.title().catch(() => '');
  const bodyText = await page
    .evaluate(() => document.body?.innerText.slice(0, 4000) ?? '')
    .catch(() => '');
  const hasChallengeFrame = await page
    .locator(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"]',
    )
    .count()
    .then((n) => n > 0)
    .catch(() => false);

  return classifyBotProtection({
    status: response?.status() ?? null,
    title,
    bodyText,
    headers,
    hasChallengeFrame,
  });
}

/**
 * Accept buttons of the consent platforms actually seen on Shopify storefronts,
 * most specific first. CSS ids are tried before text so a mislabelled button on
 * a Polish shop cannot be confused with an unrelated "OK".
 */
export const CONSENT_BUTTON_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '.cky-btn-accept',
  '.cc-allow',
  '.cm-btn-success',
  'button[data-cookieconsent="accept"]',
  'button[aria-label*="accept" i][aria-label*="cookie" i]',
  'shopify-privacy-banner button[data-accept]',
  '.shopify-pc__banner__btn-accept',
];

/** Polish first: the pipeline targets PL shops, English is the fallback. */
/** `\p{L}` rather than `\w`: Polish endings (Akceptuję) are not ASCII. */
export const CONSENT_BUTTON_TEXT =
  /^(zaakceptuj wszystk\p{L}*|akceptuj\p{L}*|zgadzam się|zgoda|ok,? rozumiem|rozumiem|accept all( cookies)?|allow all|accept( cookies)?|i agree|got it)$/iu;

/**
 * How long a banner is given to appear. Consent platforms inject theirs from a
 * script, so at `load` there is routinely nothing to click yet: task 2-24 found
 * a shop reported as having no banner while the screenshot of the next page
 * showed one.
 */
export const CONSENT_APPEAR_TIMEOUT_MS = 3000;
const CONSENT_POLL_INTERVAL_MS = 250;

/**
 * Wording that marks a strip across the page as a consent banner rather than a
 * sticky header. Deliberately narrow: "privacy" alone appears in every footer.
 */
export const CONSENT_BANNER_TEXT = /cookie|ciasteczk|rodo\b|przetwarzamy dane|gdpr/iu;

export interface ConsentResult {
  found: boolean;
  dismissed: boolean;
  /**
   * A banner is on screen, whether or not we recognised a button on it. Without
   * this a shop using an unknown consent platform, or one whose banner arrives
   * late, would be accused of having no banner at all.
   */
  detected: boolean;
  /** What was clicked, kept so a failure to dismiss can be debugged. */
  matchedBy: string | null;
}

/**
 * Is a consent banner on screen? Asked only when no accept button matched, to
 * separate "this shop does not ask for consent" from "we do not know this
 * platform". Structural on purpose — a fixed, wide strip carrying cookie
 * wording and a control — so a footer link to a cookie policy cannot pass.
 */
export async function detectConsentBanner(page: Page): Promise<boolean> {
  return page
    .evaluate(
      (pattern) => {
        const wording = new RegExp(pattern.source, pattern.flags);
        const viewportArea = window.innerWidth * window.innerHeight;
        if (!viewportArea) return false;

        for (const el of Array.from(document.body.querySelectorAll('*'))) {
          const style = window.getComputedStyle(el);
          if (style.position !== 'fixed' && style.position !== 'sticky') continue;
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (Number(style.opacity) === 0) continue;
          const box = el.getBoundingClientRect();
          const shownWidth = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0);
          const shownHeight = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
          if (shownWidth <= 0 || shownHeight <= 0) continue;
          // A banner spans the page and takes a real bite out of it.
          if (shownWidth < window.innerWidth * 0.5) continue;
          if ((shownWidth * shownHeight) / viewportArea < 0.02) continue;
          const text = el instanceof HTMLElement ? el.innerText : (el.textContent ?? '');
          if (!wording.test(text)) continue;
          // A banner explains itself before it asks. A sticky footer carrying a
          // "Polityka cookies" link matches the wording but says nothing.
          if (text.trim().length < 40) continue;
          // And it offers something to press — a link to the policy is not that.
          if (
            !el.querySelector(
              'button, [role="button"], input[type="submit"], input[type="button"],' +
                ' a[class*="btn" i], a[class*="accept" i], a[class*="zgod" i]',
            )
          ) {
            continue;
          }
          return true;
        }
        return false;
      },
      {
        source: CONSENT_BANNER_TEXT.source,
        flags: CONSENT_BANNER_TEXT.flags,
      },
    )
    .catch(() => false);
}

/**
 * Tries to accept the consent banner. Accepting (rather than rejecting) is the
 * deliberate choice: it is the path a normal visitor takes, so the audit then
 * sees the same page, scripts and tracking as a real shopper does.
 */
export async function dismissConsentBanner(
  page: Page,
  options: { timeoutMs?: number; appearTimeoutMs?: number; logger?: Logger } = {},
): Promise<ConsentResult> {
  const timeout = options.timeoutMs ?? 3000;
  const appearTimeout = options.appearTimeoutMs ?? CONSENT_APPEAR_TIMEOUT_MS;
  const logger = options.logger ?? silentLogger();

  const candidates: { locator: ReturnType<Page['locator']>; label: string }[] = [
    ...CONSENT_BUTTON_SELECTORS.map((selector) => ({
      locator: page.locator(selector).first(),
      label: selector,
    })),
    {
      locator: page
        .locator('button, a[role="button"], [role="button"]')
        .filter({ hasText: CONSENT_BUTTON_TEXT })
        .first(),
      label: 'text match',
    },
  ];

  // Poll rather than look once: `isVisible` answers immediately, so a single
  // pass only ever sees banners that were already in the markup at load.
  const deadline = Date.now() + appearTimeout;
  for (;;) {
    for (const candidate of candidates) {
      try {
        if (!(await candidate.locator.isVisible())) continue;
        await candidate.locator.click({ timeout, noWaitAfter: true });
        // Banners animate out; give the DOM a moment before deciding.
        await page.waitForTimeout(300);
        const stillThere = await candidate.locator.isVisible().catch(() => false);
        logger.debug({ matchedBy: candidate.label, stillThere }, 'consent banner handled');
        return {
          found: true,
          dismissed: !stillThere,
          detected: true,
          matchedBy: candidate.label,
        };
      } catch {
        // A detached or covered button just means "not this one".
        continue;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(CONSENT_POLL_INTERVAL_MS);
  }

  const detected = await detectConsentBanner(page);
  logger.debug({ detected }, 'no consent button matched');
  return { found: false, dismissed: false, detected, matchedBy: null };
}

export interface OverlayInfo {
  selector: string;
  /** Share of the viewport the overlay covers, 0..1. */
  coverage: number;
  text: string;
}

/**
 * Fixed overlays still covering the page after the consent attempt — a banner
 * that cannot be dismissed, a newsletter modal, an age gate. Reported as a UX
 * finding by the page checks and used to explain a useless screenshot.
 */
export async function findBlockingOverlays(page: Page, minCoverage = 0.15): Promise<OverlayInfo[]> {
  const raw = await page.evaluate((limit) => {
    const out: { selector: string; coverage: number; text: string }[] = [];
    const viewport = window.innerWidth * window.innerHeight;
    if (!viewport) return out;

    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (out.length >= 5) break;
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (Number(style.opacity) === 0) continue;
      const box = el.getBoundingClientRect();
      const area =
        Math.max(0, Math.min(box.right, window.innerWidth) - Math.max(box.left, 0)) *
        Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0));
      const coverage = area / viewport;
      if (coverage < limit) continue;
      // Headers are fixed too, but they are part of the design, not an overlay.
      if (Number(style.zIndex) < 10 && box.top <= 0) continue;
      // A chat widget wraps a small bubble in a transparent full-screen box, so
      // its rectangle covers everything while nothing is actually hidden. What
      // separates a real interstitial is that clicking the middle of the screen
      // hits it (task 2-24: `shopify-chat` was reported as covering 100%).
      const centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      if (!centre || !(el === centre || el.contains(centre))) continue;
      const id = el.id ? `#${el.id}` : '';
      const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      out.push({
        selector: id || `${el.tagName.toLowerCase()}${cls.map((c) => `.${c}`).join('')}`,
        coverage: Math.round(coverage * 100) / 100,
        text: (el instanceof HTMLElement ? el.innerText : '').slice(0, 200),
      });
    }
    return out;
  }, minCoverage);

  return raw;
}
