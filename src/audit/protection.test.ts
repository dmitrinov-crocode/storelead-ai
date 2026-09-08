import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page, Response } from 'playwright';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import { html, startFixtureServer } from './testing/fixtureServer.js';
import {
  classifyBotProtection,
  CONSENT_BUTTON_TEXT,
  detectBotProtection,
  detectConsentBanner,
  dismissConsentBanner,
  findBlockingOverlays,
  type BotProtectionSignals,
} from './protection.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

function signals(overrides: Partial<BotProtectionSignals> = {}): BotProtectionSignals {
  return {
    status: 200,
    title: 'Sklep',
    bodyText: 'Witamy w naszym sklepie',
    headers: {},
    hasChallengeFrame: false,
    ...overrides,
  };
}

test('recognises an unbranded challenge page by its wording', () => {
  // gatta.pl, checked 2026-09-01: HTTP 429, this exact title, no vendor marker.
  const verdict = classifyBotProtection({
    status: 429,
    title: 'Verifying your connection...',
    bodyText: 'Please wait while we check your browser.',
    headers: {},
    hasChallengeFrame: false,
  });

  assert.equal(verdict.blocked, true);
  assert.match(verdict.signal ?? '', /Verifying your connection/);
});

test('treats a near-empty 429 as a bot wall even with no recognisable wording', () => {
  const verdict = classifyBotProtection({
    status: 429,
    title: '',
    bodyText: 'Retry later',
    headers: {},
    hasChallengeFrame: false,
  });

  assert.equal(verdict.blocked, true);
  assert.match(verdict.signal ?? '', /HTTP 429 with a near-empty page/);
});

test('a real shop that answers 429 with a full page is not called blocked', () => {
  const verdict = classifyBotProtection({
    status: 429,
    title: 'Sklep z bielizną — GATTA',
    bodyText: 'x'.repeat(4000),
    headers: {},
    hasChallengeFrame: false,
  });

  assert.equal(verdict.blocked, false);
});

test('a normal storefront is not flagged', () => {
  assert.deepEqual(classifyBotProtection(signals()), {
    blocked: false,
    vendor: null,
    signal: null,
  });
});

test('a Cloudflare interstitial is recognised by title and by header', () => {
  assert.equal(classifyBotProtection(signals({ title: 'Just a moment...' })).vendor, 'cloudflare');
  assert.equal(
    classifyBotProtection(signals({ headers: { 'cf-mitigated': 'challenge' } })).vendor,
    'cloudflare',
  );
  assert.match(
    classifyBotProtection(signals({ title: 'Just a moment...' })).signal!,
    /Just a moment/,
  );
});

test('other vendors are recognised by their own block pages', () => {
  assert.equal(
    classifyBotProtection(signals({ headers: { 'x-datadome': 'protected' } })).vendor,
    'datadome',
  );
  assert.equal(
    classifyBotProtection(signals({ bodyText: 'Request unsuccessful. Incapsula incident ID 1-2' }))
      .vendor,
    'imperva',
  );
  assert.equal(
    classifyBotProtection(signals({ bodyText: 'Please verify you are a human' })).vendor,
    'perimeterx',
  );
  assert.equal(
    classifyBotProtection(signals({ status: 403, title: 'Access Denied' })).vendor,
    'unknown',
  );
});

test('a captcha widget on a full page is not a block', () => {
  const shop = signals({ hasChallengeFrame: true, bodyText: 'x'.repeat(4000) });
  assert.equal(classifyBotProtection(shop).blocked, false);

  const challenge = signals({ hasChallengeFrame: true, bodyText: 'Verify' });
  assert.equal(classifyBotProtection(challenge).vendor, 'captcha');
});

test('consent button text matches Polish and English wording, not arbitrary buttons', () => {
  for (const label of ['Akceptuję', 'Zaakceptuj wszystkie', 'Zgadzam się', 'Accept all cookies']) {
    assert.match(label, CONSENT_BUTTON_TEXT, label);
  }
  for (const label of ['Dodaj do koszyka', 'Checkout', 'Accept our terms and conditions']) {
    assert.doesNotMatch(label, CONSENT_BUTTON_TEXT, label);
  }
});

async function withPage<T>(
  body: string,
  fn: (ctx: { page: Page; response: Response | null }) => Promise<T>,
  routeOverrides: Parameters<typeof startFixtureServer>[0] = {},
): Promise<T> {
  const server = await startFixtureServer({ '/': { body }, ...routeOverrides });
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });
  try {
    const page = await session.newPage('desktop');
    const result = await session.goto(page, `${server.url}/`, { waitUntil: 'load' });
    return await fn({ page, response: result.response });
  } finally {
    await session.close();
    await server.close();
  }
}

test('detects a real Cloudflare-style challenge served from a live page', async () => {
  const verdict = await withPage(
    html('<h1>Just a moment...</h1><p>Enable JavaScript and cookies to continue</p>'),
    ({ page, response }) => detectBotProtection(page, response),
  );
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.vendor, 'cloudflare');
});

test('a working shop page is not flagged as blocked', async () => {
  const verdict = await withPage(
    html('<h1>Sklep</h1><p>Nasze produkty</p>'),
    ({ page, response }) => detectBotProtection(page, response),
  );
  assert.equal(verdict.blocked, false);
});

const COOKIEBOT_BANNER = `
<div id="cookie-bar" style="position:fixed;bottom:0;left:0;width:100%;height:200px;z-index:99">
  <p>Używamy plików cookies.</p>
  <button id="onetrust-accept-btn-handler" onclick="document.getElementById('cookie-bar').remove()">
    Akceptuję
  </button>
</div>`;

test('dismisses a banner by a known platform selector', async () => {
  const result = await withPage(html(`<h1>Sklep</h1>${COOKIEBOT_BANNER}`), ({ page }) =>
    dismissConsentBanner(page),
  );
  assert.deepEqual(result, {
    found: true,
    dismissed: true,
    detected: true,
    matchedBy: '#onetrust-accept-btn-handler',
  });
});

test('falls back to matching the button text', async () => {
  const banner = `
    <div class="rodo" style="position:fixed;bottom:0;width:100%;height:150px;z-index:50">
      <button onclick="document.querySelector('.rodo').remove()">Zgadzam się</button>
    </div>`;
  const result = await withPage(html(`<h1>Sklep</h1>${banner}`), ({ page }) =>
    dismissConsentBanner(page),
  );
  assert.equal(result.found, true);
  assert.equal(result.dismissed, true);
  assert.equal(result.matchedBy, 'text match');
});

test('a banner whose button does nothing is reported as found but not dismissed', async () => {
  const banner = `
    <div class="rodo" style="position:fixed;bottom:0;width:100%;height:150px;z-index:50">
      <button>Akceptuję</button>
    </div>`;
  const result = await withPage(html(`<h1>Sklep</h1>${banner}`), ({ page }) =>
    dismissConsentBanner(page),
  );
  assert.equal(result.found, true);
  assert.equal(result.dismissed, false);
});

test('a page without a banner reports nothing found', async () => {
  const result = await withPage(
    html('<h1>Sklep</h1><button>Dodaj do koszyka</button>'),
    ({ page }) => dismissConsentBanner(page),
  );
  assert.deepEqual(result, { found: false, dismissed: false, detected: false, matchedBy: null });
});

test('finds an overlay that still covers the page, ignoring an ordinary sticky header', async () => {
  const overlays = await withPage(
    html(`
      <header style="position:fixed;top:0;left:0;width:100%;height:60px;z-index:1">Menu</header>
      <div id="newsletter" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:999">
        Zapisz się do newslettera
      </div>
      <main style="height:2000px">tresc</main>`),
    ({ page }) => findBlockingOverlays(page),
  );

  assert.equal(overlays.length, 1);
  assert.equal(overlays[0]!.selector, '#newsletter');
  assert.ok(overlays[0]!.coverage > 0.9);
  assert.match(overlays[0]!.text, /newsletter/);
});

test('a page with no overlay reports none', async () => {
  const overlays = await withPage(html('<main style="height:2000px">tresc</main>'), ({ page }) =>
    findBlockingOverlays(page),
  );
  assert.deepEqual(overlays, []);
});

test('a transparent full-screen wrapper is not counted as an overlay', async () => {
  // How Shopify's chat widget is built: a fixed box the size of the viewport,
  // click-through, with a small bubble in the corner (task 2-24).
  const overlays = await withPage(
    html(
      '<h1>Sklep</h1>' +
        '<shopify-chat style="position:fixed;inset:0;z-index:99;pointer-events:none">' +
        '<button style="position:absolute;right:16px;bottom:16px;width:48px;height:48px">chat</button>' +
        '</shopify-chat>',
    ),
    ({ page }) => findBlockingOverlays(page, 0.4),
  );

  assert.deepEqual(overlays, []);
});

test('a modal that really covers the page is still reported', async () => {
  const overlays = await withPage(
    html(
      '<h1>Sklep</h1>' +
        '<div id="newsletter" style="position:fixed;inset:0;z-index:99;background:#fff">' +
        'Zapisz się do newslettera</div>',
    ),
    ({ page }) => findBlockingOverlays(page, 0.4),
  );

  assert.equal(overlays.length, 1);
  assert.equal(overlays[0]!.selector, '#newsletter');
});

// Task 2-24: consent platforms inject their banner from a script, so a single
// look at load time reported "no consent banner" on shops that have one.

test('a banner injected after load is still found and accepted', async () => {
  const late = `
    <script>
      setTimeout(function () {
        var bar = document.createElement('div');
        bar.id = 'cookie-bar';
        bar.setAttribute('style', 'position:fixed;bottom:0;left:0;width:100%;height:200px;z-index:99');
        bar.innerHTML = '<p>Uzywamy plikow cookies.</p>' +
          '<button id="onetrust-accept-btn-handler">Akceptuje</button>';
        bar.querySelector('button').addEventListener('click', function () { bar.remove(); });
        document.body.appendChild(bar);
      }, 900);
    </script>`;
  const result = await withPage(html(`<h1>Sklep</h1>${late}`), ({ page }) =>
    dismissConsentBanner(page),
  );
  assert.equal(result.found, true, 'the banner appears 900ms after load');
  assert.equal(result.dismissed, true);
});

test('a banner from an unknown platform is detected even though nothing is clicked', async () => {
  const banner = `
    <div style="position:fixed;bottom:0;left:0;width:100%;height:180px;z-index:99">
      <p>Ta strona uzywa plikow cookies do celow statystycznych.</p>
      <button>Ustawienia zaawansowane</button>
    </div>`;
  const result = await withPage(html(`<h1>Sklep</h1>${banner}`), ({ page }) =>
    dismissConsentBanner(page, { appearTimeoutMs: 300 }),
  );
  assert.equal(result.found, false, 'no button we recognise');
  assert.equal(result.detected, true, 'but the shop plainly does ask for consent');
});

test('a footer link to the cookie policy is not a consent banner', async () => {
  const page = html(`<h1>Sklep</h1>
    <footer style="position:sticky;bottom:0;width:100%;height:60px">
      <a href="/polityka-cookies">Polityka cookies</a>
    </footer>`);
  assert.equal(await withPage(page, ({ page: p }) => detectConsentBanner(p)), false);
});

test('a sticky header is not a consent banner', async () => {
  const page = html(`<header style="position:sticky;top:0;width:100%;height:80px">
    <a href="/">Sklep</a><a href="/kontakt">Kontakt</a></header><h1>Buty</h1>`);
  assert.equal(await withPage(page, ({ page: p }) => detectConsentBanner(p)), false);
});
