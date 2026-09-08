import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMemoryDb, type Database } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { createAudit, saveIssues, saveScreenshot } from '../db/repositories/audits.js';
import { upsertStore } from '../db/repositories/stores.js';
import type { AuditIssueRow, IssuePage, ScreenshotRow } from '../db/types.js';
import {
  DEFAULT_SCREENSHOT_LIMIT,
  MAX_SCREENSHOT_HEIGHT_PX,
  describeImage,
  rankScreenshots,
  selectScreenshots,
} from './screenshots.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'db', 'migrations');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

let nextId = 1;
function shot(overrides: Partial<ScreenshotRow> = {}): ScreenshotRow {
  const page = overrides.page ?? 'homepage';
  const viewport = overrides.viewport ?? 'mobile';
  return {
    id: nextId++,
    store_id: 1,
    audit_id: 1,
    page,
    viewport,
    path: `sklep.pl/audit-1/${page}-${viewport}.png`,
    width: 390,
    height: 844,
    created_at: '2026-09-07T10:00:00.000Z',
    ...overrides,
  };
}

function issueRow(page: IssuePage, severity: AuditIssueRow['severity']): AuditIssueRow {
  return {
    id: nextId++,
    audit_id: 1,
    store_id: 1,
    page,
    category: 'ux',
    severity,
    title: 'Something',
    detail: null,
    evidence_json: null,
    source: 'playwright',
    created_at: '2026-09-07T10:00:00.000Z',
  };
}

test('a full-page capture is never attached', () => {
  const full = shot({ path: 'sklep.pl/audit-1/homepage-mobile-full.png' });
  const { ranked, skipped } = rankScreenshots([full, shot()], []);
  assert.equal(ranked.length, 1);
  assert.deepEqual(skipped, [{ screenshotId: full.id, reason: 'full-page' }]);
});

test('an absurdly tall capture is dropped', () => {
  const tall = shot({ height: MAX_SCREENSHOT_HEIGHT_PX + 1 });
  const { ranked, skipped } = rankScreenshots([tall, shot()], []);
  assert.equal(ranked.length, 1);
  assert.deepEqual(skipped, [{ screenshotId: tall.id, reason: 'too-tall' }]);
});

test('pages with the worst findings are read first', () => {
  const quietHome = shot({ page: 'homepage' });
  const brokenCheckout = shot({ page: 'checkout' });
  const { ranked } = rankScreenshots(
    [quietHome, brokenCheckout],
    [issueRow('checkout', 'CRITICAL')],
  );
  assert.deepEqual(
    ranked.map((r) => r.page),
    ['checkout', 'homepage'],
    'a critical finding outranks the shopper order',
  );
});

test('with nothing to separate them, mobile comes before desktop', () => {
  const desktop = shot({ page: 'homepage', viewport: 'desktop' });
  const mobile = shot({ page: 'homepage', viewport: 'mobile' });
  const { ranked } = rankScreenshots([desktop, mobile], []);
  assert.deepEqual(
    ranked.map((r) => r.viewport),
    ['mobile', 'desktop'],
  );
});

test('within one severity band the shopper order decides', () => {
  const product = shot({ page: 'product' });
  const homepage = shot({ page: 'homepage' });
  const cart = shot({ page: 'cart' });
  const { ranked } = rankScreenshots(
    [product, cart, homepage],
    [issueRow('product', 'MAJOR'), issueRow('cart', 'MAJOR'), issueRow('homepage', 'MAJOR')],
  );
  assert.deepEqual(
    ranked.map((r) => r.page),
    ['homepage', 'product', 'cart'],
  );
});

// ---------------------------------------------------------------- loading

/** A one-pixel PNG, so the fixture writes a real file the loader can read. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(
  pages: { page: IssuePage; viewport: 'desktop' | 'mobile'; bytes?: Buffer }[],
  issues: Parameters<typeof saveIssues>[2] = [],
) {
  const db = freshDb();
  const store = upsertStore({ domain: 'sklep.pl', url: 'https://sklep.pl' }, db).store;
  const audit = createAudit(store.id, null, db);
  if (issues.length > 0) saveIssues(audit.id, store.id, issues, db);

  const baseDir = await mkdtemp(path.join(tmpdir(), 'shots-'));
  for (const item of pages) {
    const relative = `sklep.pl/audit-${audit.id}/${item.page}-${item.viewport}.png`;
    const absolute = path.join(baseDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, item.bytes ?? PNG_1PX);
    saveScreenshot(
      {
        storeId: store.id,
        auditId: audit.id,
        page: item.page,
        viewport: item.viewport,
        path: relative,
        width: 390,
        height: 844,
      },
      db,
    );
  }
  return { db, auditId: audit.id, baseDir };
}

test('selected screenshots arrive as data URLs with their page and viewport', async () => {
  const { db, auditId, baseDir } = await fixture([{ page: 'homepage', viewport: 'mobile' }]);
  const selection = await selectScreenshots(auditId, { db, baseDir });

  assert.equal(selection.images.length, 1);
  const image = selection.images[0]!;
  assert.equal(image.page, 'homepage');
  assert.equal(image.viewport, 'mobile');
  assert.ok(image.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(image.bytes, PNG_1PX.byteLength);
  assert.equal(selection.totalBytes, PNG_1PX.byteLength);
  assert.match(describeImage(image), /homepage \(mobile\), screenshot id \d+/);
});

test('the image count is capped and the rest is recorded as skipped', async () => {
  const { db, auditId, baseDir } = await fixture([
    { page: 'homepage', viewport: 'mobile' },
    { page: 'collection', viewport: 'mobile' },
    { page: 'product', viewport: 'mobile' },
    { page: 'cart', viewport: 'mobile' },
    { page: 'checkout', viewport: 'mobile' },
    { page: 'homepage', viewport: 'desktop' },
  ]);
  const selection = await selectScreenshots(auditId, { db, baseDir });

  assert.equal(selection.images.length, DEFAULT_SCREENSHOT_LIMIT);
  assert.equal(
    selection.skipped.filter((s) => s.reason === 'over-limit').length,
    6 - DEFAULT_SCREENSHOT_LIMIT,
  );
});

test('the byte budget stops the set even under the count limit', async () => {
  const fat = Buffer.concat([PNG_1PX, Buffer.alloc(2000)]);
  const { db, auditId, baseDir } = await fixture([
    { page: 'homepage', viewport: 'mobile', bytes: fat },
    { page: 'product', viewport: 'mobile', bytes: fat },
  ]);
  const selection = await selectScreenshots(auditId, { db, baseDir, maxTotalBytes: 2500 });

  assert.equal(selection.images.length, 1);
  assert.deepEqual(
    selection.skipped.map((s) => s.reason),
    ['over-budget'],
  );
  assert.ok(selection.totalBytes <= 2500);
});

test('a screenshot missing from disk is skipped, not fatal', async () => {
  const { db, auditId, baseDir } = await fixture([
    { page: 'homepage', viewport: 'mobile' },
    { page: 'product', viewport: 'mobile' },
  ]);
  const selection = await selectScreenshots(auditId, {
    db,
    baseDir: path.join(baseDir, 'moved-away'),
  });

  assert.deepEqual(selection.images, []);
  assert.deepEqual(
    selection.skipped.map((s) => s.reason),
    ['unreadable', 'unreadable'],
  );
});

test('a page with findings is sent at full detail', async () => {
  const { db, auditId, baseDir } = await fixture(
    [
      { page: 'homepage', viewport: 'desktop' },
      { page: 'product', viewport: 'desktop' },
    ],
    [
      {
        page: 'product',
        category: 'ux',
        severity: 'CRITICAL',
        title: 'Add to cart does nothing',
      },
    ],
  );
  const selection = await selectScreenshots(auditId, { db, baseDir });

  assert.equal(selection.images[0]?.page, 'product');
  assert.equal(selection.images[0]?.detail, 'high');
  assert.equal(selection.images[1]?.detail, 'low', 'the quiet desktop page needs one flat tile');
});
