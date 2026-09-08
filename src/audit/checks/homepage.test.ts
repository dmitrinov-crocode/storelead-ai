import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../browser.js';
import { html } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import type { ConsentResult } from '../protection.js';
import {
  checkHeaderFooter,
  checkNavigation,
  checkOverlays,
  checkSearch,
  MIN_NAV_LINKS,
  POLICY_LINK_TEXT,
  runHomepageChecks,
} from './homepage.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

const FULL_HEADER = `
<header>
  <nav>
    <a href="/collections/buty">Buty</a>
    <a href="/collections/kurtki">Kurtki</a>
    <a href="/pages/o-nas">O nas</a>
  </nav>
  <form action="/search"><input type="search" name="q"></form>
</header>`;

const FULL_FOOTER = `
<footer>
  <a href="/policies/regulamin">Regulamin</a>
  <a href="/pages/kontakt">Kontakt</a>
</footer>`;

test('a complete homepage raises nothing', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { body: html(`${FULL_HEADER}<main>Witamy</main>${FULL_FOOTER}`) },
  });
  try {
    assert.deepEqual(await checkNavigation(fixture.ctx), []);
    assert.deepEqual(await checkSearch(fixture.ctx), []);
    assert.deepEqual(await checkHeaderFooter(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

test('a menu with too few links is a finding', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { body: html('<nav><a href="/">Start</a></nav>') },
  });
  try {
    const issues = await checkNavigation(fixture.ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.title, 'No usable navigation menu');
    assert.match(issues[0]!.evidence[0]!.actual!, /1 links/);
    assert.match(issues[0]!.evidence[0]!.expected!, new RegExp(String(MIN_NAV_LINKS)));
  } finally {
    await fixture.close();
  }
});

test('hidden links do not count as navigation', async () => {
  const fixture = await openFixturePage(browser, {
    '/': {
      body: html(`<nav style="display:none">
        <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a></nav>`),
    },
  });
  try {
    const issues = await checkNavigation(fixture.ctx);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.detail!, /exists but shows almost no links/);
  } finally {
    await fixture.close();
  }
});

test('a working mobile hamburger is accepted', async () => {
  const fixture = await openFixturePage(
    browser,
    {
      '/': {
        body: html(`
          <header>
            <button aria-label="Menu" onclick="document.getElementById('m').style.display='block'">≡</button>
            <nav id="m" style="display:none">
              <a href="/a">Buty</a><a href="/b">Kurtki</a><a href="/c">Wyprzedaż</a>
            </nav>
          </header>`),
      },
    },
    { viewport: 'mobile' },
  );
  try {
    assert.deepEqual(await checkNavigation(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

test('a hamburger that opens nothing is critical', async () => {
  const fixture = await openFixturePage(
    browser,
    {
      '/': {
        body: html(`
          <header>
            <button aria-label="Menu">≡</button>
            <nav id="m" style="display:none"><a href="/a">Buty</a><a href="/b">Kurtki</a><a href="/c">Sale</a></nav>
          </header>`),
      },
    },
    { viewport: 'mobile' },
  );
  try {
    const issues = await checkNavigation(fixture.ctx);
    assert.equal(issues[0]!.severity, 'CRITICAL');
    assert.equal(issues[0]!.title, 'Mobile menu does not open');
    assert.equal(issues[0]!.evidence[0]!.viewport, 'mobile');
  } finally {
    await fixture.close();
  }
});

test('search is detected in any of its usual shapes', async () => {
  for (const markup of [
    '<input type="search">',
    '<input name="q">',
    '<form action="/search"></form>',
    '<a href="/search">Szukaj</a>',
    '<div role="search"></div>',
  ]) {
    const fixture = await openFixturePage(browser, { '/': { body: html(markup) } });
    try {
      assert.deepEqual(await checkSearch(fixture.ctx), [], markup);
    } finally {
      await fixture.close();
    }
  }
});

test('a shop without search is a CRO finding', async () => {
  const fixture = await openFixturePage(browser, { '/': { body: html('<main>Sklep</main>') } });
  try {
    const issues = await checkSearch(fixture.ctx);
    assert.equal(issues[0]!.category, 'cro');
    assert.equal(issues[0]!.severity, 'MAJOR');
  } finally {
    await fixture.close();
  }
});

test('policy link text covers the Polish wording', () => {
  for (const label of ['Regulamin', 'Polityka prywatności', 'Kontakt', 'Zwroty i reklamacje']) {
    assert.match(label, POLICY_LINK_TEXT, label);
  }
  assert.doesNotMatch('Instagram', POLICY_LINK_TEXT);
});

test('a missing header, footer and policy links are each reported', async () => {
  const noFooter = await openFixturePage(browser, { '/': { body: html('<main>Sklep</main>') } });
  try {
    assert.deepEqual(
      (await checkHeaderFooter(noFooter.ctx)).map((i) => i.title),
      ['No page header', 'No page footer'],
    );
  } finally {
    await noFooter.close();
  }

  const emptyFooter = await openFixturePage(browser, {
    '/': { body: html(`${FULL_HEADER}<footer><a href="/instagram">Instagram</a></footer>`) },
  });
  try {
    const issues = await checkHeaderFooter(emptyFooter.ctx);
    assert.deepEqual(
      issues.map((i) => i.title),
      ['Footer has no policy or contact links'],
    );
    assert.match(issues[0]!.evidence[0]!.actual!, /Instagram/);
  } finally {
    await emptyFooter.close();
  }
});

const consent = (overrides: Partial<ConsentResult> = {}): ConsentResult => ({
  found: true,
  dismissed: true,
  detected: true,
  matchedBy: '#accept',
  ...overrides,
});

test('a banner that will not close is reported', async () => {
  const fixture = await openFixturePage(browser, { '/': { body: html('<main>Sklep</main>') } });
  try {
    const issues = await checkOverlays(fixture.ctx, consent({ dismissed: false }));
    assert.equal(issues[0]!.title, 'Cookie banner cannot be dismissed');
    assert.equal(issues[0]!.severity, 'MAJOR');
  } finally {
    await fixture.close();
  }
});

test('no consent banner at all is a compliance finding', async () => {
  const fixture = await openFixturePage(browser, { '/': { body: html('<main>Sklep</main>') } });
  try {
    const issues = await checkOverlays(
      fixture.ctx,
      consent({ found: false, dismissed: false, detected: false }),
    );
    assert.deepEqual(
      issues.map((i) => i.title),
      ['No cookie consent banner'],
    );
  } finally {
    await fixture.close();
  }
});

test('a banner we could not click is not called a missing banner', async () => {
  // Task 2-24: an unknown consent platform, or one that arrives late, used to
  // be reported as the shop asking for no consent at all.
  const fixture = await openFixturePage(browser, { '/': { body: html('<main>Sklep</main>') } });
  try {
    const issues = await checkOverlays(
      fixture.ctx,
      consent({ found: false, dismissed: false, detected: true }),
    );
    assert.deepEqual(issues, []);
  } finally {
    await fixture.close();
  }
});

test('a popup left over the page is graded harder on mobile', async () => {
  const popup = html(`
    <main style="height:2000px">Sklep</main>
    <div id="newsletter" style="position:fixed;inset:0;z-index:900;background:#fff">Newsletter</div>`);

  const desktop = await openFixturePage(browser, { '/': { body: popup } });
  try {
    const issues = await checkOverlays(desktop.ctx, consent());
    const popupIssue = issues.find((i) => i.title === 'A popup covers the page')!;
    assert.equal(popupIssue.severity, 'MINOR');
    assert.equal(popupIssue.evidence[0]!.selector, '#newsletter');
    assert.match(popupIssue.evidence[0]!.actual!, /% of the viewport/);
  } finally {
    await desktop.close();
  }

  const mobile = await openFixturePage(browser, { '/': { body: popup } }, { viewport: 'mobile' });
  try {
    const issues = await checkOverlays(mobile.ctx, consent());
    assert.equal(issues.find((i) => i.title === 'A popup covers the page')!.severity, 'MAJOR');
  } finally {
    await mobile.close();
  }
});

test('the suite runs every check and survives a broken one', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { body: html('<main>Sklep</main><script>null.boom()</script>') },
  });
  try {
    await fixture.ctx.page.close(); // every DOM check now throws
    const suite = await runHomepageChecks(fixture.ctx, { consent: consent() });

    assert.deepEqual(
      suite.outcomes.map((o) => o.name),
      [
        'homepage.load_time',
        'homepage.js_errors',
        'homepage.failed_resources',
        'homepage.images',
        'homepage.navigation',
        'homepage.search',
        'homepage.header_footer',
        'homepage.overlays',
      ],
    );
    assert.equal(suite.partial, true);
    // The observation-based checks do not touch the DOM, so they still report.
    assert.ok(suite.issues.some((i) => i.title === 'JavaScript errors break the page'));
  } finally {
    await fixture.close();
  }
});

test('the suite of a healthy homepage is clean', async () => {
  const fixture = await openFixturePage(browser, {
    '/': { body: html(`${FULL_HEADER}<main>Witamy</main>${FULL_FOOTER}`) },
  });
  try {
    const suite = await runHomepageChecks(fixture.ctx, { consent: consent() });
    assert.equal(suite.partial, false);
    assert.deepEqual(suite.issues, []);
  } finally {
    await fixture.close();
  }
});
