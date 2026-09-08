import { chromium, devices } from 'playwright';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { getConfig } from '../config/index.js';

/**
 * Browser setup for the technical audit (task 2-01).
 *
 * Two context profiles are audited for every store, because a large share of the
 * problems we look for (horizontal scroll, tap targets, sticky headers eating the
 * viewport) only exist on one of them.
 */

export const VIEWPORT_PROFILES = ['desktop', 'mobile'] as const;
export type ViewportProfile = (typeof VIEWPORT_PROFILES)[number];

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

/** Playwright ships the iPhone 13 descriptor; taking it keeps DPR/touch honest. */
const IPHONE_13 = devices['iPhone 13'];

/** 390x664, not 390x844: the descriptor already subtracts Safari's chrome. */
export const MOBILE_VIEWPORT = IPHONE_13.viewport;

/**
 * Locale and timezone matter: storefronts geo-redirect, show a different currency
 * and pop a different cookie banner per region. We audit the market the pipeline
 * targets, not whatever the host machine happens to be set to.
 */
const LOCALES: Record<string, { locale: string; timezoneId: string }> = {
  PL: { locale: 'pl-PL', timezoneId: 'Europe/Warsaw' },
};

export function localeFor(countryCode: string): { locale: string; timezoneId: string } {
  return LOCALES[countryCode.toUpperCase()] ?? { locale: 'en-US', timezoneId: 'UTC' };
}

/**
 * Headless Chromium advertises itself as `HeadlessChrome`, which some storefronts
 * (and most WAFs) treat as a bot. We send the matching stable-Chrome string for the
 * browser we actually run, rather than a made-up version that would not match the
 * client hints Chromium sends alongside it.
 */
export function chromeUserAgent(browserVersion: string, platform: NodeJS.Platform): string {
  const major = browserVersion.split('.')[0] || '140';
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export interface LaunchAuditBrowserOptions {
  headless?: boolean;
  /** Slows every action down; only useful when watching a run by hand. */
  slowMo?: number;
}

export function launchBrowser(options: LaunchAuditBrowserOptions = {}): Promise<Browser> {
  return chromium.launch({
    headless: options.headless ?? true,
    ...(options.slowMo === undefined ? {} : { slowMo: options.slowMo }),
    args: [
      // Drops `navigator.webdriver`, the cheapest bot signal to trip over.
      '--disable-blink-features=AutomationControlled',
      // Small /dev/shm in containers crashes tabs on image-heavy storefronts.
      '--disable-dev-shm-usage',
    ],
  });
}

export interface AuditContextOptions {
  /** Two-letter country whose locale/timezone the context should present. */
  country?: string;
  /** Merged last; used by tests and by one-off debugging. */
  overrides?: BrowserContextOptions;
}

export function contextOptions(
  profile: ViewportProfile,
  browserVersion: string,
  options: AuditContextOptions = {},
): BrowserContextOptions {
  const country = options.country ?? getConfig().pipeline.targetCountry;
  const { locale, timezoneId } = localeFor(country);

  const base: BrowserContextOptions = {
    locale,
    timezoneId,
    // Service workers serve stale pages and swallow network events we need to see.
    serviceWorkers: 'block',
    // Keeps screenshots of the same page comparable between runs.
    reducedMotion: 'reduce',
    // A certificate problem is a finding, not something to silently accept.
    ignoreHTTPSErrors: false,
  };

  const perProfile: BrowserContextOptions =
    profile === 'mobile'
      ? {
          viewport: IPHONE_13.viewport,
          deviceScaleFactor: IPHONE_13.deviceScaleFactor,
          isMobile: IPHONE_13.isMobile,
          hasTouch: IPHONE_13.hasTouch,
          userAgent: IPHONE_13.userAgent,
        }
      : {
          viewport: { ...DESKTOP_VIEWPORT },
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          userAgent: chromeUserAgent(browserVersion, process.platform),
        };

  return { ...base, ...perProfile, ...options.overrides };
}

export function createContext(
  browser: Browser,
  profile: ViewportProfile,
  options: AuditContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext(contextOptions(profile, browser.version(), options));
}
