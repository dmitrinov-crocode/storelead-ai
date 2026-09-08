import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import { html, startFixtureServer } from './testing/fixtureServer.js';
import {
  checkLinks,
  gradeLinks,
  isBrokenStatus,
  MAX_EXTERNAL_LINKS,
  selectLinks,
  type LinkCheckResult,
} from './linkChecker.js';
import type { CheckContext } from './checks/context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

test('a status is broken only when it really means "gone"', () => {
  assert.equal(isBrokenStatus(200, true), false);
  assert.equal(isBrokenStatus(301, true), false);
  assert.equal(isBrokenStatus(404, true), true);
  assert.equal(isBrokenStatus(410, true), true);
  assert.equal(isBrokenStatus(500, true), true);

  // Anti-bot answers are not evidence of a broken link.
  for (const status of [401, 403, 405, 406, 429, 999]) {
    assert.equal(isBrokenStatus(status, true), false, String(status));
  }
  // Someone else's server erroring is not the shop's defect.
  assert.equal(isBrokenStatus(500, false), false);
  assert.equal(isBrokenStatus(404, false), true);
});

test('links are deduplicated, stripped of fragments and filtered by scheme', () => {
  const { links, skipped } = selectLinks(
    [
      { url: 'https://sklep.pl/a', text: 'A' },
      { url: 'https://sklep.pl/a#sekcja', text: 'A again' },
      { url: 'https://sklep.pl/a', text: 'A third time' },
      { url: 'mailto:sklep@sklep.pl', text: 'Napisz' },
      { url: 'tel:+48123', text: 'Zadzwoń' },
      { url: 'javascript:void(0)', text: 'Menu' },
      { url: 'https://instagram.com/sklep', text: 'Instagram' },
    ],
    'https://sklep.pl',
  );

  assert.deepEqual(
    links.map((l) => [l.url, l.internal]),
    [
      ['https://sklep.pl/a', true],
      ['https://instagram.com/sklep', false],
    ],
  );
  assert.equal(skipped, 5);
});

test('internal links come first and the caps bound the crawl', () => {
  const raw = [
    ...Array.from({ length: 40 }, (_, i) => ({ url: `https://sklep.pl/p${i}`, text: `p${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://inny${i}.pl/`, text: `x${i}` })),
  ];

  const { links, skipped } = selectLinks(raw, 'https://sklep.pl', { maxLinks: 10 });
  assert.equal(links.length, 10);
  assert.ok(links.every((l) => l.internal));
  assert.equal(skipped, 50);

  const wide = selectLinks(raw, 'https://sklep.pl', { maxLinks: 100 });
  assert.equal(wide.links.filter((l) => !l.internal).length, MAX_EXTERNAL_LINKS);
});

async function withHomepage<T>(
  routes: Parameters<typeof startFixtureServer>[0],
  fn: (ctx: { session: AuditSession; page: Page; origin: string }) => Promise<T>,
): Promise<T> {
  const server = await startFixtureServer(routes);
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 8000 });
  try {
    const page = await session.newPage('desktop');
    await session.goto(page, `${server.url}/`);
    return await fn({ session, page, origin: server.url });
  } finally {
    await session.close();
    await server.close();
  }
}

test('finds the dead links and leaves the live ones alone', async () => {
  const result = await withHomepage(
    {
      '/': {
        body: html(`
          <a href="/ok">Działa</a>
          <a href="/zniknelo">Regulamin</a>
          <a href="/awaria">Kontakt</a>
          <a href="/zakaz">Panel</a>
          <a href="mailto:sklep@sklep.pl">Napisz</a>
          <a href="/ok#dol">To samo</a>`),
      },
      '/ok': { body: html('ok') },
      '/zniknelo': { status: 404, body: html('nie ma') },
      '/awaria': { status: 500, body: html('błąd') },
      '/zakaz': { status: 403, body: html('brak dostępu') },
    },
    ({ session, page, origin }) => checkLinks(session, page, origin),
  );

  assert.equal(result.checked, 4);
  assert.deepEqual(result.broken.map((b) => [new URL(b.url).pathname, b.status]).sort(), [
    ['/awaria', 500],
    ['/zniknelo', 404],
  ]);
  assert.equal(result.skipped, 2, 'the mailto: and the duplicate anchor');
});

test('a server that rejects HEAD is retried with GET', async () => {
  const seen: string[] = [];
  const result = await withHomepage(
    {
      '/': { body: html('<a href="/tylko-get">Polityka</a>') },
      '/tylko-get': (req, res) => {
        seen.push(req.method ?? '');
        if (req.method === 'HEAD') {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('ok');
      },
    },
    ({ session, page, origin }) => checkLinks(session, page, origin),
  );

  assert.deepEqual(seen, ['HEAD', 'GET']);
  assert.deepEqual(result.broken, []);
});

test('a link to a host that does not answer is broken', async () => {
  const result = await withHomepage(
    { '/': { body: html('<a href="http://127.0.0.1:1/nic">Partner</a>') } },
    ({ session, page, origin }) => checkLinks(session, page, origin),
  );

  assert.equal(result.broken.length, 1);
  assert.equal(result.broken[0]!.status, null);
  assert.ok(result.broken[0]!.error);
});

test('a page with only good links reports nothing', async () => {
  const result = await withHomepage(
    {
      '/': { body: html('<a href="/a">A</a><a href="/b">B</a>') },
      '/a': { body: html('a') },
      '/b': { body: html('b') },
    },
    ({ session, page, origin }) => checkLinks(session, page, origin),
  );
  assert.deepEqual(result.broken, []);
  assert.equal(result.checked, 2);
});

const ctxStub = { url: 'https://sklep.pl/', target: 'site', viewport: 'desktop' } as CheckContext;

test('internal dead links are major, outbound ones minor', () => {
  const result: LinkCheckResult = {
    checked: 12,
    skipped: 3,
    broken: [
      {
        url: 'https://sklep.pl/regulamin',
        text: 'Regulamin',
        internal: true,
        status: 404,
        error: null,
      },
      {
        url: 'https://sklep.pl/kontakt',
        text: 'Kontakt',
        internal: true,
        status: null,
        error: 'ECONNREFUSED',
      },
      { url: 'https://partner.pl/x', text: 'Partner', internal: false, status: 404, error: null },
    ],
  };

  const issues = gradeLinks(result, ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [
      ['Broken links on the site', 'MAJOR'],
      ['Links to external pages that no longer exist', 'MINOR'],
    ],
  );
  assert.match(issues[0]!.detail!, /2 of 12/);
  assert.equal(issues[0]!.evidence[0]!.status, 404);
  assert.equal(issues[0]!.evidence[0]!.selector, 'a "Regulamin"');
  assert.equal(issues[0]!.evidence[1]!.text, 'ECONNREFUSED');
});

test('no broken links means no issues', () => {
  assert.deepEqual(gradeLinks({ checked: 20, skipped: 0, broken: [] }, ctxStub), []);
});
