import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../browser.js';
import { html } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import {
  isPlatformNoise,
  checkBrokenImages,
  checkFailedResources,
  checkJavaScriptErrors,
  checkLoadTime,
  SLOW_LOAD_MS,
} from './shared.js';
import { escalateForPage } from './context.js';
import type { CheckContext } from './context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('a defect close to the money is graded higher', () => {
  assert.equal(escalateForPage('MINOR', 'homepage'), 'MINOR');
  assert.equal(escalateForPage('MAJOR', 'collection'), 'MAJOR');
  assert.equal(escalateForPage('MINOR', 'cart'), 'MAJOR');
  assert.equal(escalateForPage('MAJOR', 'checkout'), 'CRITICAL');
});

test('uncaught exceptions and console errors are reported separately', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { body: html('<script>console.error("cart api down"); null.boom()</script>') },
  });
  try {
    const issues = checkJavaScriptErrors(fixture.ctx);
    assert.deepEqual(
      issues.map((i) => [i.title, i.severity]),
      [
        ['JavaScript errors break the page', 'MAJOR'],
        ['Scripts log errors to the console', 'MINOR'],
      ],
    );
    assert.match(issues[0]!.evidence[0]!.text!, /TypeError/);
    assert.match(issues[1]!.evidence[0]!.text!, /cart api down/);
  } finally {
    await fixture.close();
  }
});

test('the same errors on checkout are graded harder', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: html('<script>null.boom()</script>') } },
    { target: 'checkout' },
  );
  try {
    assert.equal(checkJavaScriptErrors(fixture.ctx)[0]!.severity, 'CRITICAL');
  } finally {
    await fixture.close();
  }
});

test('a clean page produces no technical issues', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { body: html('<img src="/ok.png" alt="ok">') },
    '/ok.png': { contentType: 'image/png', body: PNG },
  });
  try {
    assert.deepEqual(checkJavaScriptErrors(fixture.ctx), []);
    assert.deepEqual(checkFailedResources(fixture.ctx), []);
    assert.deepEqual(await checkBrokenImages(fixture.ctx), []);
    assert.deepEqual(checkLoadTime(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

test('blocking resources are separated from cosmetic ones', async () => {
  const fixture = await openFixturePage(browser, {
    '/': {
      body: html(
        '<script src="/app.js"></script><link rel="stylesheet" href="/theme.css"><img src="/x.png">',
      ),
    },
    '/app.js': { status: 500, contentType: 'application/javascript', body: 'boom' },
    '/theme.css': { status: 404, contentType: 'text/css', body: '' },
  });
  try {
    const issues = checkFailedResources(fixture.ctx);
    const blocking = issues.find((i) => i.title === 'Scripts or styles fail to load')!;
    const other = issues.find((i) => i.title === 'Some resources return errors')!;

    assert.equal(blocking.severity, 'MAJOR');
    assert.equal(blocking.evidence.length, 2);
    assert.deepEqual(
      other.evidence.map((e) => e.status),
      [404],
    );
    assert.equal(other.severity, 'MINOR');
  } finally {
    await fixture.close();
  }
});

test('the page own status is not reported as a failed sub-resource', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { status: 404, body: html('<p>Nie ma</p>') },
  });
  try {
    assert.deepEqual(checkFailedResources(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

test('broken images are reported with a selector and the alt text', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: html('<img id="hero" src="/missing.png" alt="Baner">') } },
    { settleMs: 300 },
  );
  try {
    const issues = await checkBrokenImages(fixture.ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.category, 'ux');
    assert.equal(issues[0]!.evidence[0]!.selector, '#hero');
    assert.equal(issues[0]!.evidence[0]!.text, 'Baner');
    assert.equal(issues[0]!.evidence[0]!.viewport, 'desktop');
  } finally {
    await fixture.close();
  }
});

test('a slow page is a performance finding', () => {
  const ctx = {
    url: 'https://sklep.pl',
    target: 'homepage',
    viewport: 'desktop',
    navigationMs: SLOW_LOAD_MS + 2500,
  } as CheckContext;
  const issues = checkLoadTime(ctx);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.category, 'performance');
  assert.equal(issues[0]!.evidence[0]!.actual, '10.5s');
});

test('a Shopify internal endpoint answering 401 is not a failed resource', () => {
  // Every Shopify storefront without private access tokens returns 401 here;
  // it appeared on both stores of the 2-24 run and is not a defect.
  assert.equal(isPlatformNoise('https://sklep.pl/sf_private_access_tokens'), true);
  assert.equal(isPlatformNoise('https://sklep.pl/.well-known/shopify/monorail/unstable'), true);
  assert.equal(isPlatformNoise('https://sklep.pl/assets/theme.js'), false);
});
