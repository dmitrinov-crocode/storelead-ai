import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { createMemoryDb, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { createAudit, listScreenshots } from '../db/repositories/audits.js';
import { upsertStore } from '../db/repositories/stores.js';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import { captureScreenshot, pngSize, safeSegment, screenshotPath } from './screenshots.js';
import { html, startFixtureServer } from './testing/fixtureServer.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'db', 'migrations');

let browser: Browser;
let baseDir: string;

before(async () => {
  browser = await launchBrowser();
  baseDir = await mkdtemp(path.join(tmpdir(), 'storelead-shots-'));
});

after(async () => {
  await browser.close();
  await rm(baseDir, { recursive: true, force: true });
});

function freshDb(): { db: Database; storeId: number; auditId: number } {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const { store } = upsertStore({ domain: 'sklep.pl', url: 'https://sklep.pl' }, db);
  const audit = createAudit(store.id, null, db);
  return { db, storeId: store.id, auditId: audit.id };
}

test('paths group one audit into one folder', () => {
  assert.equal(
    screenshotPath({ domain: 'sklep.pl', auditId: 7, page: 'product', viewport: 'mobile' }),
    'sklep.pl/audit-7/product-mobile.png',
  );
  assert.equal(
    screenshotPath({
      domain: 'sklep.pl',
      auditId: 7,
      page: 'homepage',
      viewport: 'desktop',
      fullPage: true,
    }),
    'sklep.pl/audit-7/homepage-desktop-full.png',
  );
  assert.equal(
    screenshotPath({ domain: 'sklep.pl', auditId: null, page: 'cart', viewport: 'desktop' }),
    'sklep.pl/manual/cart-desktop.png',
  );
});

test('domain segments cannot escape the screenshots folder', () => {
  assert.equal(safeSegment('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeSegment('SKLEP.PL'), 'sklep.pl');
  assert.equal(safeSegment('xn--sklep-9db.pl'), 'xn--sklep-9db.pl');
  assert.equal(safeSegment('///'), 'unknown');
});

test('pngSize reads the header and rejects non-PNG data', () => {
  assert.equal(pngSize(Buffer.from('not a png')), null);
  const header = Buffer.alloc(24);
  header.write('89504e470d0a1a0a', 0, 'hex');
  header.writeUInt32BE(1440, 16);
  header.writeUInt32BE(900, 20);
  assert.deepEqual(pngSize(header), { width: 1440, height: 900 });
});

test('captures desktop and mobile shots and records both rows', async () => {
  const server = await startFixtureServer({
    '/': { body: html('<h1 style="height:2000px">Sklep</h1>') },
  });
  const { db, storeId, auditId } = freshDb();
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });

  try {
    for (const viewport of ['desktop', 'mobile'] as const) {
      const page = await session.newPage(viewport);
      await session.goto(page, `${server.url}/`);
      const result = await captureScreenshot(page, {
        storeId,
        auditId,
        domain: 'sklep.pl',
        page: 'homepage',
        viewport,
        db,
        baseDir,
      });
      assert.equal(result.error, null);
      const bytes = await readFile(result.absolutePath);
      assert.ok(pngSize(bytes), 'a real PNG must be written to disk');
    }

    const rows = listScreenshots(auditId, db);
    assert.deepEqual(
      rows.map((r) => [r.viewport, r.path]),
      [
        ['desktop', 'sklep.pl/audit-' + auditId + '/homepage-desktop.png'],
        ['mobile', 'sklep.pl/audit-' + auditId + '/homepage-mobile.png'],
      ],
    );
    assert.equal(rows[0]!.width, 1440);
    assert.equal(rows[0]!.height, 900);
    assert.equal(rows[1]!.width, 390 * 3, 'mobile shots keep the device pixel ratio');
  } finally {
    await session.close();
    await server.close();
    db.close();
  }
});

test('a full-page shot is taller than the viewport and stored separately', async () => {
  const server = await startFixtureServer({
    '/': { body: html('<div style="height:3000px">tall</div>') },
  });
  const { db, storeId, auditId } = freshDb();
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });

  try {
    const page = await session.newPage('desktop');
    await session.goto(page, `${server.url}/`);
    const result = await captureScreenshot(page, {
      storeId,
      auditId,
      domain: 'sklep.pl',
      page: 'homepage',
      viewport: 'desktop',
      fullPage: true,
      db,
      baseDir,
    });

    assert.equal(result.row!.path, `sklep.pl/audit-${auditId}/homepage-desktop-full.png`);
    assert.ok(result.row!.height! > 900, 'a full-page capture must exceed the viewport height');
  } finally {
    await session.close();
    await server.close();
    db.close();
  }
});

test('a failed capture is reported, not thrown, and writes no row', async () => {
  const server = await startFixtureServer({ '/': { body: html('<p>home</p>') } });
  const { db, storeId, auditId } = freshDb();
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });

  try {
    const page = await session.newPage('desktop');
    await session.goto(page, `${server.url}/`);
    await page.close(); // capturing from a closed page is the realistic failure

    const result = await captureScreenshot(page, {
      storeId,
      auditId,
      domain: 'sklep.pl',
      page: 'homepage',
      viewport: 'desktop',
      db,
      baseDir,
    });

    assert.equal(result.row, null);
    assert.ok(result.error);
    assert.deepEqual(listScreenshots(auditId, db), []);
  } finally {
    await session.close();
    await server.close();
    db.close();
  }
});
