import { CheckSuite } from '../checkRunner.js';
import { createIssue, type Issue } from '../issues.js';
import { findBlockingOverlays, type ConsentResult } from '../protection.js';
import {
  checkBrokenImages,
  checkFailedResources,
  checkJavaScriptErrors,
  checkLoadTime,
} from './shared.js';
import type { CheckContext } from './context.js';

/**
 * Homepage checks (task 2-10).
 *
 * Beyond the shared technical checks, the homepage carries the things a shopper
 * needs in the first five seconds: a menu they can open, a way to search, a
 * header and a footer, and a view that is not buried under popups.
 */

/** Fewer links than this is a menu that does not navigate anywhere. */
export const MIN_NAV_LINKS = 3;
/** An overlay covering more than this after consent is an intrusive interstitial. */
export const INTRUSIVE_COVERAGE = 0.4;

const MOBILE_MENU_SELECTORS = [
  'button[aria-label*="menu" i]',
  'button[aria-label*="nawigacj" i]',
  'button[aria-controls*="menu" i]',
  'summary[aria-label*="menu" i]',
  '[data-menu-toggle]',
  '.header__icon--menu',
  'button.js-mobile-nav-toggle',
].join(', ');

interface NavigationFacts {
  visibleLinks: number;
  samples: string[];
  hasNavElement: boolean;
}

async function readNavigation(ctx: CheckContext): Promise<NavigationFacts> {
  return ctx.page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll('nav a[href], [role="navigation"] a[href], header a[href]'),
    );
    const samples: string[] = [];
    let visibleLinks = 0;
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      const style = window.getComputedStyle(anchor);
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      visibleLinks += 1;
      if (samples.length < 5) samples.push((anchor.textContent ?? '').trim().slice(0, 40));
    }
    return {
      visibleLinks,
      samples,
      hasNavElement: document.querySelector('nav, [role="navigation"]') !== null,
    };
  });
}

/**
 * On desktop the menu must simply be there. On mobile it is usually behind a
 * toggle, so the check clicks it: a hamburger that opens nothing is a shop
 * whose whole catalogue is unreachable from a phone.
 */
export async function checkNavigation(ctx: CheckContext): Promise<Issue[]> {
  const before = await readNavigation(ctx);
  if (before.visibleLinks >= MIN_NAV_LINKS) return [];

  if (ctx.viewport === 'mobile') {
    const toggle = ctx.page.locator(MOBILE_MENU_SELECTORS).first();
    const hasToggle = await toggle.isVisible({ timeout: 500 }).catch(() => false);
    if (hasToggle) {
      await toggle.click({ timeout: 3000 }).catch(() => undefined);
      await ctx.page.waitForTimeout(400);
      const after = await readNavigation(ctx);
      if (after.visibleLinks >= MIN_NAV_LINKS) return [];
      return [
        createIssue({
          page: ctx.target,
          category: 'ux',
          severity: 'CRITICAL',
          title: 'Mobile menu does not open',
          detail: 'The menu button is present but opening it reveals no navigation links',
          evidence: {
            url: ctx.url,
            viewport: 'mobile',
            selector: MOBILE_MENU_SELECTORS.split(', ')[0] ?? 'menu toggle',
            expected: `at least ${MIN_NAV_LINKS} links`,
            actual: `${after.visibleLinks} links`,
          },
        }),
      ];
    }
  }

  return [
    createIssue({
      page: ctx.target,
      category: 'ux',
      severity: 'MAJOR',
      title: 'No usable navigation menu',
      detail: before.hasNavElement
        ? 'A navigation element exists but shows almost no links'
        : 'The page has no navigation element',
      evidence: {
        url: ctx.url,
        viewport: ctx.viewport,
        expected: `at least ${MIN_NAV_LINKS} visible links`,
        actual: `${before.visibleLinks} links${before.samples.length ? `: ${before.samples.join(', ')}` : ''}`,
      },
    }),
  ];
}

export async function checkSearch(ctx: CheckContext): Promise<Issue[]> {
  const found = await ctx.page.evaluate(
    () =>
      document.querySelector(
        'input[type="search"], input[name="q"], form[action*="/search"], a[href*="/search"], [role="search"]',
      ) !== null,
  );
  if (found) return [];

  return [
    createIssue({
      page: ctx.target,
      category: 'cro',
      severity: 'MAJOR',
      title: 'No product search',
      detail: 'Visitors who know what they want have no way to look for it',
      evidence: {
        url: ctx.url,
        viewport: ctx.viewport,
        expected: 'a search field or /search link',
      },
    }),
  ];
}

/** Regulamin/polityka/kontakt — the links a Polish shop is expected to carry. */
export const POLICY_LINK_TEXT =
  /regulamin|polityka|prywatn|kontakt|dostaw|zwrot|reklamacj|privacy|terms|contact|shipping|returns/i;

export async function checkHeaderFooter(ctx: CheckContext): Promise<Issue[]> {
  const facts = await ctx.page.evaluate(() => {
    const footer = document.querySelector('footer, [role="contentinfo"], .site-footer');
    const links = footer
      ? Array.from(footer.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim())
      : [];
    return {
      hasHeader:
        document.querySelector('header, [role="banner"], .site-header, #shopify-section-header') !==
        null,
      hasFooter: footer !== null,
      footerLinks: links.slice(0, 40),
    };
  });

  const issues: Issue[] = [];
  if (!facts.hasHeader) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'ux',
        severity: 'MINOR',
        title: 'No page header',
        evidence: { url: ctx.url, viewport: ctx.viewport },
      }),
    );
  }
  if (!facts.hasFooter) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'ux',
        severity: 'MINOR',
        title: 'No page footer',
        evidence: { url: ctx.url, viewport: ctx.viewport },
      }),
    );
  } else if (!facts.footerLinks.some((text) => POLICY_LINK_TEXT.test(text))) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'ux',
        severity: 'MINOR',
        title: 'Footer has no policy or contact links',
        detail:
          'Shipping, returns, privacy and contact links are what buyers look for before paying',
        evidence: {
          url: ctx.url,
          expected: 'regulamin / polityka prywatności / kontakt',
          actual: facts.footerLinks.slice(0, 8).join(', ') || 'no links in the footer',
        },
      }),
    );
  }
  return issues;
}

/**
 * What is left covering the page after we tried to accept the consent banner
 * (task 2-07 does the trying). A banner that will not close and a newsletter
 * modal over the hero are the same problem to a visitor.
 */
export async function checkOverlays(ctx: CheckContext, consent: ConsentResult): Promise<Issue[]> {
  const issues: Issue[] = [];

  if (consent.found && !consent.dismissed) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'ux',
        severity: 'MAJOR',
        title: 'Cookie banner cannot be dismissed',
        detail: 'Clicking the accept button left the banner on screen',
        evidence: {
          url: ctx.url,
          viewport: ctx.viewport,
          ...(consent.matchedBy ? { selector: consent.matchedBy } : {}),
        },
      }),
    );
  }

  // `detected` covers the two ways a banner exists without us clicking it: it
  // arrived late, or it belongs to a platform whose button we do not know. Both
  // used to be reported as the shop asking for no consent at all (task 2-24).
  if (!consent.found && !consent.detected) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: 'MINOR',
        title: 'No cookie consent banner',
        detail: 'A shop selling to EU customers is expected to ask for consent before tracking',
        evidence: { url: ctx.url },
      }),
    );
  }

  const overlays = await findBlockingOverlays(ctx.page, INTRUSIVE_COVERAGE);
  if (overlays.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'cro',
        severity: ctx.viewport === 'mobile' ? 'MAJOR' : 'MINOR',
        title: 'A popup covers the page',
        detail: 'An overlay hides the content right after opening the page',
        evidence: overlays.map((o) => ({
          selector: o.selector,
          viewport: ctx.viewport,
          text: o.text,
          actual: `${Math.round(o.coverage * 100)}% of the viewport`,
        })),
      }),
    );
  }

  return issues;
}

export interface HomepageCheckOptions {
  consent?: ConsentResult;
  suite?: CheckSuite;
}

/** Runs every homepage check in isolation (task 2-06) and returns the suite. */
export async function runHomepageChecks(
  ctx: CheckContext,
  options: HomepageCheckOptions = {},
): Promise<CheckSuite> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });

  await suite.run('homepage.load_time', () => Promise.resolve(checkLoadTime(ctx)));
  await suite.run('homepage.js_errors', () => Promise.resolve(checkJavaScriptErrors(ctx)));
  await suite.run('homepage.failed_resources', () => Promise.resolve(checkFailedResources(ctx)));
  await suite.run('homepage.images', () => checkBrokenImages(ctx));
  await suite.run('homepage.navigation', () => checkNavigation(ctx));
  await suite.run('homepage.search', () => checkSearch(ctx));
  await suite.run('homepage.header_footer', () => checkHeaderFooter(ctx));
  if (options.consent) {
    const consent = options.consent;
    await suite.run('homepage.overlays', () => checkOverlays(ctx, consent));
  }

  return suite;
}
