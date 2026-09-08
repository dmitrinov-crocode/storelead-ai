import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { createMemoryDb, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { listIssues, listScreenshots } from '../db/repositories/audits.js';
import { createRun } from '../db/repositories/runs.js';
import { upsertStore } from '../db/repositories/stores.js';
import type { StoreRow } from '../db/types.js';
import { silentLogger } from '../lib/logger.js';
import { auditStore } from './auditStore.js';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import {
  html,
  startFixtureServer,
  type FixtureRoute,
  type RouteHandler,
} from './testing/fixtureServer.js';
import { createShopFixture } from './testing/shopFixture.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'db', 'migrations');

let browser: Browser;
let shotsDir: string;

before(async () => {
  browser = await launchBrowser();
  shotsDir = await mkdtemp(path.join(tmpdir(), 'storelead-audit-'));
});

after(async () => {
  await browser.close();
  await rm(shotsDir, { recursive: true, force: true });
});

interface Harness {
  db: Database;
  store: StoreRow;
  runId: number;
  session: AuditSession;
  close: () => Promise<void>;
}

async function harness(routes: Record<string, FixtureRoute | RouteHandler>): Promise<Harness> {
  const server = await startFixtureServer(routes);
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore({ domain: 'sklep.test', url: server.url }, db);
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });

  return {
    db,
    store,
    runId: run.id,
    session,
    close: async () => {
      await session.close();
      await server.close();
      db.close();
    },
  };
}

const audit = (h: Harness, overrides = {}) =>
  auditStore({
    store: h.store,
    session: h.session,
    runId: h.runId,
    db: h.db,
    logger: silentLogger(),
    screenshotsDir: shotsDir,
    ...overrides,
  });

test('audits a whole shop and writes the result to the database', async () => {
  const h = await harness(createShopFixture().routes);
  try {
    const report = await audit(h);

    assert.equal(report.blocked, false);
    assert.equal(report.audit.store_id, h.store.id);
    assert.equal(report.audit.run_id, h.runId);
    assert.ok(report.audit.finished_at, 'the audit must be closed out');

    // Every key page was found and visited.
    assert.equal(report.keyUrls!.collection !== null, true);
    assert.equal(report.keyUrls!.product !== null, true);
    const visited = report.pages.filter((p) => p.availability === 'ok').map((p) => p.page);
    for (const page of ['homepage', 'collection', 'product', 'cart', 'checkout']) {
      assert.ok(visited.includes(page as (typeof visited)[number]), `${page} was not audited`);
    }

    // Findings and screenshots are persisted, not just returned.
    const rows = listIssues(report.audit.id, h.db);
    assert.equal(rows.length, report.issues.length);
    assert.ok(rows.length > 0, 'the fixture shop is deliberately imperfect');
    assert.deepEqual(JSON.parse(rows[0]!.evidence_json!), report.issues[0]!.evidence);

    const shots = listScreenshots(report.audit.id, h.db);
    assert.ok(shots.length >= 5, `expected a screenshot per page, got ${shots.length}`);
    assert.ok(shots.every((s) => s.path.startsWith('sklep.test/audit-')));
  } finally {
    await h.close();
  }
});

test('findings are deduplicated and sorted worst-first', async () => {
  const h = await harness(createShopFixture().routes);
  try {
    const report = await audit(h);
    const severities = report.issues.map((i) => i.severity);
    const rank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 };
    for (let i = 1; i < severities.length; i += 1) {
      assert.ok(rank[severities[i - 1]!] <= rank[severities[i]!], 'issues must be sorted');
    }
    const keys = report.issues.map((i) => `${i.page}|${i.category}|${i.title}`);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate findings');
    assert.equal(
      report.counts.CRITICAL + report.counts.MAJOR + report.counts.MINOR,
      report.issues.length,
    );
  } finally {
    await h.close();
  }
});

test('a shop behind bot protection is flagged, not audited', async () => {
  const h = await harness({
    '/': {
      body: html('<h1>Just a moment...</h1><p>Enable JavaScript and cookies to continue</p>'),
    },
  });
  try {
    const report = await audit(h);

    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.blocked, true);
    assert.equal(report.audit.blocked, 1);
    assert.equal(report.botProtection.vendor, 'cloudflare');
    assert.match(report.audit.error!, /cloudflare/);
    // A blocked shop must not produce invented findings about its storefront.
    assert.deepEqual(report.issues, []);
    assert.equal(report.pages.length, 1);
    assert.ok(listScreenshots(report.audit.id, h.db).length > 0, 'the block itself is evidence');
  } finally {
    await h.close();
  }
});

test('a shop whose homepage does not open ends FAILED with the reason', async () => {
  const server = await startFixtureServer({});
  const dead = server.url;
  await server.close();

  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore({ domain: 'zamkniety.test', url: dead }, db);
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 5000 });

  try {
    const report = await auditStore({
      store,
      session,
      runId: run.id,
      db,
      logger: silentLogger(),
      screenshotsDir: shotsDir,
    });

    assert.equal(report.status, 'FAILED');
    assert.equal(report.audit.error, 'the homepage could not be opened');
    assert.deepEqual(
      report.issues.map((i) => [i.page, i.title, i.severity]),
      [['homepage', 'Page could not be opened', 'CRITICAL']],
    );
    assert.equal(listIssues(report.audit.id, db).length, 1);
  } finally {
    await session.close();
    db.close();
  }
});

test('a shop with no discoverable product page is PARTIAL, not OK', async () => {
  const h = await harness({
    '/': {
      body: html(`<header><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>
        <input type="search"></header><main>Wkrótce otwarcie</main>
        <footer><a href="/regulamin">Regulamin</a></footer>`),
    },
  });
  try {
    const report = await audit(h);
    assert.equal(report.status, 'PARTIAL');
    assert.equal(report.audit.error, 'not every key page could be found');
    assert.deepEqual(
      report.pages.filter((p) => p.availability === 'not_found').map((p) => p.page),
      ['collection', 'product', 'cart', 'checkout'],
    );
  } finally {
    await h.close();
  }
});

test('a broken storefront produces the blockers as CRITICAL findings', async () => {
  const shop = createShopFixture({ brokenAddToCart: true });
  const h = await harness({
    ...shop.routes,
    '/products/but': {
      body: html('<main><h1>Buty</h1></main>'), // no price, no cart form
    },
  });
  try {
    const report = await audit(h);
    const critical = report.issues.filter((i) => i.severity === 'CRITICAL').map((i) => i.title);
    assert.ok(critical.includes('No add to cart button'), critical.join(' | '));
    assert.ok(critical.includes('Product page shows no price'));
    assert.ok(report.counts.CRITICAL >= 2);
  } finally {
    await h.close();
  }
});

test('skipping the cart leaves the shop untouched', async () => {
  const shop = createShopFixture();
  const h = await harness(shop.routes);
  try {
    const report = await audit(h, { skipCart: true, skipLinks: true });
    assert.equal(shop.quantity(), 0, 'nothing was added to the shop cart');
    assert.deepEqual(
      report.pages.map((p) => p.page).filter((p) => p === 'cart' || p === 'checkout'),
      [],
    );
    assert.ok(report.pages.some((p) => p.page === 'product' && p.availability === 'ok'));
  } finally {
    await h.close();
  }
});

test('the cart flow returns the shop to the state it was found in', async () => {
  const shop = createShopFixture();
  const h = await harness(shop.routes);
  try {
    await audit(h);
    assert.equal(shop.quantity(), 0);
  } finally {
    await h.close();
  }
});

test('a check that throws makes the audit PARTIAL instead of losing everything', async () => {
  const h = await harness({
    ...createShopFixture().routes,
    // A collection page that never finishes loading breaks that page's checks only.
    '/collections/all': { delayMs: 30_000, body: html('late') },
  });
  try {
    const report = await audit(h);
    assert.equal(report.status, 'PARTIAL');
    assert.ok(report.issues.length > 0, 'the pages that did load still produced findings');
    assert.ok(report.pages.some((p) => p.page === 'homepage' && p.availability === 'ok'));
  } finally {
    await h.close();
  }
});

test('pages_json and seo_json carry the collected facts', async () => {
  const h = await harness(createShopFixture().routes);
  try {
    const report = await audit(h, { skipLinks: true });
    const pages = JSON.parse(report.audit.pages_json!) as {
      pages: { page: string; checks: unknown[] }[];
      keyUrls: unknown;
    };
    assert.ok(pages.pages.length >= 5);
    assert.ok(pages.keyUrls);

    const seo = JSON.parse(report.audit.seo_json!) as {
      page: { title: string | null; h1Text: string | null } | null;
      site: { sitemap: boolean; robotsTxt: boolean } | null;
    };
    assert.deepEqual(seo.site, {
      robotsTxt: false,
      robotsBlocksAll: false,
      sitemap: false,
      sitemapUrls: 0,
    });
    // The fixture shop ships no <title>, and the SEO check says exactly that.
    assert.equal(seo.page!.title, null);
    assert.equal(seo.page!.h1Text, 'Sklep');
    assert.ok(report.issues.some((i) => i.title === 'Page has no title tag'));
    assert.ok(report.issues.some((i) => i.title === 'No sitemap.xml'));
  } finally {
    await h.close();
  }
});
