import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import {
  chromeUserAgent,
  contextOptions,
  createContext,
  DESKTOP_VIEWPORT,
  launchBrowser,
  localeFor,
  MOBILE_VIEWPORT,
} from './browser.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

test('chromeUserAgent reports stable Chrome, never HeadlessChrome', () => {
  const ua = chromeUserAgent('141.0.7390.37', 'darwin');
  assert.match(ua, /Chrome\/141\.0\.0\.0 Safari\/537\.36$/);
  assert.match(ua, /Macintosh; Intel Mac OS X/);
  assert.doesNotMatch(ua, /Headless/);
});

test('chromeUserAgent switches the platform token', () => {
  assert.match(chromeUserAgent('140.0.0.0', 'win32'), /Windows NT 10\.0; Win64; x64/);
  assert.match(chromeUserAgent('140.0.0.0', 'linux'), /X11; Linux x86_64/);
});

test('localeFor maps the target market and falls back for unknown countries', () => {
  assert.deepEqual(localeFor('pl'), { locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
  assert.deepEqual(localeFor('ZZ'), { locale: 'en-US', timezoneId: 'UTC' });
});

test('context options block service workers and keep HTTPS errors visible', () => {
  const options = contextOptions('desktop', '141.0.0.0', { country: 'PL' });
  assert.equal(options.serviceWorkers, 'block');
  assert.equal(options.ignoreHTTPSErrors, false);
  assert.equal(options.locale, 'pl-PL');
});

test('overrides win over the profile defaults', () => {
  const options = contextOptions('desktop', '141.0.0.0', {
    overrides: { viewport: { width: 800, height: 600 } },
  });
  assert.deepEqual(options.viewport, { width: 800, height: 600 });
});

test('desktop profile is 1440x900, non-touch, with a non-headless user agent', async () => {
  const context = await createContext(browser, 'desktop');
  const page = await context.newPage();
  try {
    const seen = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      ua: navigator.userAgent,
    }));
    assert.equal(seen.width, DESKTOP_VIEWPORT.width);
    assert.equal(seen.height, DESKTOP_VIEWPORT.height);
    assert.equal(seen.dpr, 1);
    assert.equal(seen.maxTouchPoints, 0);
    assert.doesNotMatch(seen.ua, /Headless/);
  } finally {
    await context.close();
  }
});

test('mobile profile emulates an iPhone 13: touch, DPR 3, mobile viewport', async () => {
  const context = await createContext(browser, 'mobile');
  const page = await context.newPage();
  try {
    // innerWidth on a page without a viewport meta tag is the 980px fallback
    // layout viewport, so the emulated device size is read from the context.
    assert.deepEqual(page.viewportSize(), MOBILE_VIEWPORT);
    assert.equal(MOBILE_VIEWPORT.width, 390);
    const seen = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      ua: navigator.userAgent,
    }));
    assert.equal(seen.dpr, 3);
    assert.ok(seen.maxTouchPoints > 0, 'mobile context must expose touch points');
    assert.match(seen.ua, /iPhone/);
  } finally {
    await context.close();
  }
});

test('contexts are independent: closing one leaves the browser usable', async () => {
  const first = await createContext(browser, 'desktop');
  await first.close();
  const second = await createContext(browser, 'mobile');
  assert.equal(browser.contexts().includes(second), true);
  await second.close();
});
