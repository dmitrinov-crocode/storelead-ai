import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { silentLogger } from '../../lib/logger.js';
import { launchBrowser } from '../browser.js';
import { AuditSession } from '../session.js';
import { html, startFixtureServer } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import {
  ALT_COVERAGE_MIN,
  blocksEverything,
  DESCRIPTION_MIN,
  gradePageSeo,
  gradeSiteSeo,
  readSeo,
  readSiteSeo,
  runSeoChecks,
  TITLE_MAX,
  type SeoFacts,
  type SiteSeoFacts,
} from './seo.js';
import type { CheckContext } from './context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

const GOOD_HEAD = `
  <title>Buty skórzane ręcznie szyte — Sklep Kowalski</title>
  <meta name="description" content="Ręcznie szyte buty skórzane z polskiej pracowni. Wysyłka w 24 godziny, zwrot do 30 dni.">
  <link rel="canonical" href="https://sklep.pl/products/buty">
  <meta property="og:title" content="Buty skórzane">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"Buty","offers":{"@type":"Offer","price":"349.00"}}
  </script>`;

async function seoFor(body: string, head = '', target: CheckContext['target'] = 'product') {
  const fixture = await openFixturePage(browser, { '/': { body: html(body, head) } }, { target });
  try {
    return { facts: await readSeo(fixture.ctx.page), ctx: fixture.ctx };
  } finally {
    await fixture.close();
  }
}

test('reads every tag a search engine looks at', async () => {
  const { facts } = await seoFor('<h1>Buty skórzane</h1><img src="/a.png" alt="But">', GOOD_HEAD);
  assert.match(facts.title!, /Buty skórzane/);
  assert.ok(facts.descriptionLength > DESCRIPTION_MIN);
  assert.equal(facts.h1Count, 1);
  assert.equal(facts.h1Text, 'Buty skórzane');
  assert.equal(facts.canonical, 'https://sklep.pl/products/buty');
  assert.equal(facts.noindex, false);
  assert.equal(facts.lang, 'pl');
  assert.equal(facts.openGraph, true);
  assert.deepEqual(facts.schemaTypes, ['Product']);
  assert.deepEqual([facts.images, facts.imagesWithAlt], [1, 1]);
});

test('a noindex tag is read off the page', async () => {
  const { facts } = await seoFor('<h1>x</h1>', '<meta name="robots" content="noindex, nofollow">');
  assert.equal(facts.noindex, true);
  assert.equal(facts.robotsMeta, 'noindex, nofollow');
});

test('structured data is read out of @graph and arrays, and bad JSON is survived', async () => {
  const { facts } = await seoFor(
    '<h1>x</h1>',
    `<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["Product","Thing"]}]}</script>
     <script type="application/ld+json">{ this is not json </script>`,
  );
  assert.deepEqual(facts.schemaTypes.sort(), ['Organization', 'Product', 'Thing']);
});

test('an empty alt is correct markup and counts as covered', async () => {
  const { facts } = await seoFor('<img src="/a.png" alt=""><img src="/b.png">');
  assert.deepEqual([facts.images, facts.imagesWithAlt], [2, 1]);
});

test('a complete product page raises no SEO issues', async () => {
  const { facts, ctx } = await seoFor(
    '<h1>Buty skórzane</h1><img src="/a.png" alt="But">',
    GOOD_HEAD,
  );
  assert.deepEqual(gradePageSeo(facts, ctx), []);
});

const ctxStub = { url: 'https://sklep.pl/products/but', target: 'product' } as CheckContext;

const baseFacts = (overrides: Partial<SeoFacts> = {}): SeoFacts => ({
  title: 'Buty skórzane ręcznie szyte — Sklep',
  titleLength: 34,
  description: 'x'.repeat(120),
  descriptionLength: 120,
  h1Count: 1,
  h1Text: 'Buty',
  canonical: 'https://sklep.pl/products/but',
  robotsMeta: null,
  noindex: false,
  lang: 'pl',
  openGraph: true,
  schemaTypes: ['Product'],
  images: 4,
  imagesWithAlt: 4,
  ...overrides,
});

test('noindex is the most serious SEO finding there is', () => {
  const issues = gradePageSeo(baseFacts({ noindex: true, robotsMeta: 'noindex' }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Page is excluded from search engines', 'CRITICAL']],
  );
  assert.equal(issues[0]!.category, 'seo');
});

test('a missing tag is major, a badly sized one is minor', () => {
  assert.deepEqual(
    gradePageSeo(baseFacts({ title: null, titleLength: 0 }), ctxStub).map((i) => [
      i.title,
      i.severity,
    ]),
    [['Page has no title tag', 'MAJOR']],
  );
  assert.deepEqual(
    gradePageSeo(baseFacts({ titleLength: TITLE_MAX + 20 }), ctxStub).map((i) => [
      i.title,
      i.severity,
    ]),
    [['Page title is the wrong length', 'MINOR']],
  );
  assert.deepEqual(
    gradePageSeo(baseFacts({ description: null, descriptionLength: 0 }), ctxStub).map(
      (i) => i.title,
    ),
    ['Page has no meta description'],
  );
});

test('headings: none is major, several are minor', () => {
  assert.deepEqual(
    gradePageSeo(baseFacts({ h1Count: 0, h1Text: null }), ctxStub).map((i) => [
      i.title,
      i.severity,
    ]),
    [['Page has no H1 heading', 'MAJOR']],
  );
  assert.deepEqual(
    gradePageSeo(baseFacts({ h1Count: 3 }), ctxStub).map((i) => [i.title, i.severity]),
    [['Page has more than one H1', 'MINOR']],
  );
});

test('a product page without Product schema is a major finding', () => {
  const issues = gradePageSeo(baseFacts({ schemaTypes: ['Organization'] }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Product page has no Product structured data', 'MAJOR']],
  );
  assert.equal(issues[0]!.evidence[0]!.actual, 'Organization');

  const homepage = { ...ctxStub, target: 'homepage' } as CheckContext;
  assert.deepEqual(
    gradePageSeo(baseFacts({ schemaTypes: [] }), homepage),
    [],
    'only the product page is expected to carry Product schema',
  );
});

test('alt text is judged as a share of the images', () => {
  assert.deepEqual(gradePageSeo(baseFacts({ images: 10, imagesWithAlt: 8 }), ctxStub), []);

  const issues = gradePageSeo(baseFacts({ images: 10, imagesWithAlt: 2 }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Images have no alt text', 'MINOR']],
  );
  assert.equal(issues[0]!.evidence[0]!.actual, '2 of 10');
  assert.equal(
    issues[0]!.evidence[0]!.expected,
    `${Math.round(ALT_COVERAGE_MIN * 100)}% of images`,
  );

  assert.deepEqual(gradePageSeo(baseFacts({ images: 0, imagesWithAlt: 0 }), ctxStub), []);
});

test('robots.txt that blocks everyone is recognised, a partial one is not', () => {
  assert.equal(blocksEverything('User-agent: *\nDisallow: /'), true);
  assert.equal(blocksEverything('user-agent:*\ndisallow: /'), true);
  assert.equal(blocksEverything('User-agent: *\nDisallow: /admin\nSitemap: /sitemap.xml'), false);
  assert.equal(
    blocksEverything('User-agent: BadBot\nDisallow: /\nUser-agent: *\nDisallow: /cart'),
    false,
    'blocking one bot is not blocking the site',
  );
  assert.equal(blocksEverything(''), false);
});

test('robots.txt and sitemap.xml are fetched from the live site', async () => {
  const server = await startFixtureServer({
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nDisallow: /cart' },
    '/sitemap.xml': {
      contentType: 'application/xml',
      body: '<urlset><url><loc>https://sklep.pl/</loc></url><url><loc>https://sklep.pl/a</loc></url></urlset>',
    },
    '/': { body: html('<h1>Sklep</h1>') },
  });
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 8000 });
  try {
    const page = await session.newPage('desktop');
    await session.goto(page, `${server.url}/`);
    const facts = await readSiteSeo(session, page, server.url);
    assert.deepEqual(facts, {
      robotsTxt: true,
      robotsBlocksAll: false,
      sitemap: true,
      sitemapUrls: 2,
    });
  } finally {
    await session.close();
    await server.close();
  }
});

test('a site with neither file is reported as such', async () => {
  const server = await startFixtureServer({ '/': { body: html('<h1>Sklep</h1>') } });
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 8000 });
  try {
    const page = await session.newPage('desktop');
    await session.goto(page, `${server.url}/`);
    const facts = await readSiteSeo(session, page, server.url);
    assert.deepEqual(facts, {
      robotsTxt: false,
      robotsBlocksAll: false,
      sitemap: false,
      sitemapUrls: 0,
    });
  } finally {
    await session.close();
    await server.close();
  }
});

const siteCtx = { url: 'https://sklep.pl/', target: 'site' } as CheckContext;

test('site-level SEO is graded by how much it costs', () => {
  const blocked: SiteSeoFacts = {
    robotsTxt: true,
    robotsBlocksAll: true,
    sitemap: false,
    sitemapUrls: 0,
  };
  assert.deepEqual(
    gradeSiteSeo(blocked, siteCtx).map((i) => [i.title, i.severity]),
    [
      ['robots.txt blocks the whole site', 'CRITICAL'],
      ['No sitemap.xml', 'MAJOR'],
    ],
  );

  const missingRobots: SiteSeoFacts = {
    robotsTxt: false,
    robotsBlocksAll: false,
    sitemap: true,
    sitemapUrls: 120,
  };
  assert.deepEqual(
    gradeSiteSeo(missingRobots, siteCtx).map((i) => [i.title, i.severity]),
    [['No robots.txt', 'MINOR']],
  );

  assert.deepEqual(
    gradeSiteSeo(
      { robotsTxt: true, robotsBlocksAll: false, sitemap: true, sitemapUrls: 9 },
      siteCtx,
    ),
    [],
  );
});

test('the suite collects page and site facts together', async () => {
  const server = await startFixtureServer({
    '/': { body: html('<h1>Sklep</h1>', GOOD_HEAD) },
    '/robots.txt': { contentType: 'text/plain', body: 'User-agent: *\nAllow: /' },
    '/sitemap.xml': {
      contentType: 'application/xml',
      body: '<urlset><url><loc>/</loc></url></urlset>',
    },
  });
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 8000 });
  try {
    const page = await session.newPage('desktop');
    const nav = await session.goto(page, `${server.url}/`);
    const ctx = {
      page,
      session,
      url: `${server.url}/`,
      target: 'homepage',
      viewport: 'desktop',
      observations: {
        consoleErrors: [],
        failedRequests: [],
        httpErrors: [],
        requestCount: 0,
        truncated: false,
      },
      navigationMs: nav.durationMs,
      logger: silentLogger(),
    } as CheckContext;

    const result = await runSeoChecks(ctx, { site: true });
    assert.deepEqual(
      result.suite.outcomes.map((o) => [o.name, o.status]),
      [
        ['seo.page', 'ok'],
        ['seo.site', 'ok'],
      ],
    );
    assert.equal(result.page!.title !== null, true);
    assert.equal(result.site!.sitemap, true);
    assert.deepEqual(result.suite.issues, []);
  } finally {
    await session.close();
    await server.close();
  }
});
