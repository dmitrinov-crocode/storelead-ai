import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import { html, startFixtureServer } from './testing/fixtureServer.js';
import {
  attachPageCollectors,
  collectBrokenImages,
  cssSelector,
  isIgnorableConsoleError,
  MAX_RECORDS,
} from './pageCollector.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

/** One-pixel PNG, so a working image can be told apart from a broken one. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function withPage<T>(
  routes: Parameters<typeof startFixtureServer>[0],
  path: string,
  fn: (ctx: {
    collector: ReturnType<typeof attachPageCollectors>;
    page: Page;
    url: string;
  }) => Promise<T>,
): Promise<T> {
  const server = await startFixtureServer(routes);
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });
  try {
    const page = await session.newPage('desktop');
    const collector = attachPageCollectors(page);
    await session.goto(page, `${server.url}${path}`, { waitUntil: 'load' });
    return await fn({ collector, page, url: server.url });
  } finally {
    await session.close();
    await server.close();
  }
}

test('records console errors with their source location', async () => {
  const observations = await withPage(
    { '/': { body: html('<script>console.error("checkout widget missing")</script>') } },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(100);
      collector.stop();
      return collector.observations;
    },
  );

  assert.equal(observations.consoleErrors.length, 1);
  assert.equal(observations.consoleErrors[0]!.kind, 'console');
  assert.match(observations.consoleErrors[0]!.text, /checkout widget missing/);
});

test('records uncaught exceptions separately from console.error', async () => {
  const observations = await withPage(
    { '/': { body: html('<script>null.foo()</script>') } },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(100);
      collector.stop();
      return collector.observations;
    },
  );

  const exceptions = observations.consoleErrors.filter((e) => e.kind === 'exception');
  assert.equal(exceptions.length, 1);
  assert.match(exceptions[0]!.text, /TypeError/);
});

test('collapses a repeated error into one record with a count', async () => {
  const observations = await withPage(
    {
      '/': {
        body: html('<script>for (let i = 0; i < 5; i++) console.error("same problem")</script>'),
      },
    },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(100);
      collector.stop();
      return collector.observations;
    },
  );

  assert.equal(observations.consoleErrors.length, 1);
  assert.equal(observations.consoleErrors[0]!.count, 5);
});

test('records HTTP errors on sub-resources with status and resource type', async () => {
  const observations = await withPage(
    {
      '/': { body: html('<img src="/missing.png"><script src="/gone.js"></script>') },
      '/gone.js': { status: 500, contentType: 'application/javascript', body: 'boom' },
    },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(200);
      collector.stop();
      return collector.observations;
    },
  );

  const statuses = observations.httpErrors.map((e) => [e.status, e.resourceType]).sort();
  assert.deepEqual(statuses, [
    [404, 'image'],
    [500, 'script'],
  ]);
  assert.ok(observations.requestCount >= 3);
});

test('records requests the network stack refused outright', async () => {
  const observations = await withPage(
    { '/': { body: html('<img src="http://127.0.0.1:1/never.png">') } },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(300);
      collector.stop();
      return collector.observations;
    },
  );

  assert.equal(observations.failedRequests.length, 1);
  assert.equal(observations.failedRequests[0]!.resourceType, 'image');
  assert.match(observations.failedRequests[0]!.errorText, /^net::ERR_/);
});

test('a clean page produces no findings', async () => {
  const observations = await withPage(
    {
      '/': { body: html('<img src="/ok.png" alt="ok">') },
      '/ok.png': { contentType: 'image/png', body: PNG },
    },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(150);
      collector.stop();
      return collector.observations;
    },
  );

  assert.deepEqual(observations.consoleErrors, []);
  assert.deepEqual(observations.httpErrors, []);
  assert.deepEqual(observations.failedRequests, []);
  assert.equal(observations.truncated, false);
});

test('stop() detaches the listeners', async () => {
  const observations = await withPage(
    { '/': { body: html('<div id="app"></div>') } },
    '/',
    async ({ collector, page }) => {
      collector.stop();
      collector.stop(); // idempotent
      await page.evaluate(() => console.error('after stop'));
      await page.waitForTimeout(100);
      return collector.observations;
    },
  );

  assert.deepEqual(observations.consoleErrors, []);
});

test('collectBrokenImages ignores a failed tracking beacon', async () => {
  const broken = await withPage(
    {
      '/': {
        body: html(
          '<div class="grid"><img src="/missing.png" alt="product"></div>' +
            // A Bing UET beacon: 1x1, no alt, nobody was meant to see it.
            '<img id="batBeacon123" width="1" height="1" src="/beacon.gif">',
        ),
      },
    },
    '/',
    async ({ page }) => {
      await page.waitForTimeout(300);
      return collectBrokenImages(page);
    },
  );

  assert.deepEqual(
    broken.map((b) => b.alt),
    ['product'],
  );
});

test('collectBrokenImages finds images the browser could not paint', async () => {
  const broken = await withPage(
    {
      '/': {
        body: html(
          '<img id="hero" src="/ok.png" alt="hero">' +
            '<div class="grid card"><img src="/missing.png" alt="product"></div>' +
            '<img src="/not-an-image.png" alt="corrupt">',
        ),
      },
      '/ok.png': { contentType: 'image/png', body: PNG },
      // 200 OK, but the bytes are not an image: only the DOM knows this failed.
      '/not-an-image.png': { contentType: 'image/png', body: 'definitely not a png' },
    },
    '/',
    async ({ page }) => {
      await page.waitForTimeout(300);
      return collectBrokenImages(page);
    },
  );

  const alts = broken.map((b) => b.alt).sort();
  assert.deepEqual(alts, ['corrupt', 'product']);
  const product = broken.find((b) => b.alt === 'product')!;
  assert.match(product.src, /missing\.png$/);
  assert.match(product.selector, /^img/);
});

test('ignores third-party noise that says nothing about the storefront', () => {
  assert.equal(isIgnorableConsoleError('Failed to load resource: favicon.ico'), true);
  assert.equal(
    isIgnorableConsoleError('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT'),
    true,
  );
  assert.equal(isIgnorableConsoleError('Uncaught TypeError: cart is undefined'), false);
});

test('MAX_RECORDS caps the lists and flags truncation', async () => {
  const observations = await withPage(
    {
      '/': {
        body: html(
          `<script>for (let i = 0; i < ${MAX_RECORDS + 20}; i++) console.error('error ' + i)</script>`,
        ),
      },
    },
    '/',
    async ({ collector, page }) => {
      await page.waitForTimeout(300);
      collector.stop();
      return collector.observations;
    },
  );

  assert.equal(observations.consoleErrors.length, MAX_RECORDS);
  assert.equal(observations.truncated, true);
});

test('cssSelector prefers an id, then classes, then position', () => {
  assert.equal(cssSelector({ tag: 'img', id: 'hero', classes: ['a'], nthChild: 2 }), '#hero');
  assert.equal(
    cssSelector({ tag: 'img', id: null, classes: ['card', 'lazy', 'extra'], nthChild: 3 }),
    'img.card.lazy:nth-child(3)',
  );
  assert.equal(cssSelector({ tag: 'div', id: null, classes: [], nthChild: 0 }), 'div');
});
