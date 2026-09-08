import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { createRun } from '../../db/repositories/runs.js';
import { upsertStore } from '../../db/repositories/stores.js';
import {
  getAppStack,
  getThemeInfo,
  saveStoreApps,
  saveThemeInfo,
} from '../../db/repositories/storeFacts.js';
import type { ThemeCatalog } from '../../analysis/themeCatalog.js';
import { silentLogger } from '../../lib/logger.js';
import type { StoreRow } from '../../db/types.js';
import { createThemeAppsStep, type ThemeAppsStepMeta } from './themeApps.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');
const NOW = new Date('2026-09-01T00:00:00.000Z');

const CATALOG: ThemeCatalog = {
  updatedAt: '2026-09-01',
  themes: {
    dawn: {
      displayName: 'Dawn',
      architecture: 'os2',
      source: 'test',
      releases: [
        { version: '5.0.0', releasedAt: '2026-08-01' },
        { version: '1.0.0', releasedAt: '2021-06-01' },
      ],
    },
    debut: { displayName: 'Debut', architecture: 'vintage', source: 'test', releases: [] },
  },
};

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

function setup(
  theme: { name?: string | null; version?: string | null } = {},
  options: { apps?: { name: string; category?: string | null }[]; appsCount?: number | null } = {},
): {
  db: Database;
  runId: number;
  store: StoreRow;
} {
  const db = freshDb();
  const runId = createRun('PL', 10, db).id;
  const { store } = upsertStore(
    {
      domain: 'sklep.pl',
      url: 'https://sklep.pl',
      theme_name: theme.name ?? null,
      theme_version: theme.version ?? null,
      apps_count: options.appsCount ?? options.apps?.length ?? null,
    },
    db,
  );
  if (options.apps) saveStoreApps(store.id, options.apps, db);
  return { db, runId, store };
}

function context(db: Database, runId: number, store: StoreRow | null) {
  return {
    runId,
    store,
    db,
    logger: silentLogger(),
    force: false,
    signal: new AbortController().signal,
  };
}

const step = () => createThemeAppsStep({ catalog: CATALOG, now: () => NOW });

test('stores the full verdict for a catalogued theme', async () => {
  const { db, runId, store } = setup({ name: 'Dawn', version: '1.0.0' });

  const outcome = await step().run(context(db, runId, store));

  const row = getThemeInfo(store.id, db)!;
  assert.equal(row.name, 'Dawn');
  assert.equal(row.current_version, '1.0.0');
  assert.equal(row.latest_version, '5.0.0');
  assert.equal(row.version_gap, 1);
  assert.equal(row.released_at, '2021-06-01');
  assert.equal(row.age_months, 63);
  assert.equal(row.architecture, 'os2');
  assert.equal(row.freshness, 'severely_outdated');
  assert.equal(outcome.status, 'OK');
});

test('writes a row with nulls for a theme the reference does not know', async () => {
  const { db, runId, store } = setup({ name: 'keyshortscom/main', version: '1.0.0' });

  const outcome = await step().run(context(db, runId, store));

  const row = getThemeInfo(store.id, db)!;
  assert.equal(row.architecture, null);
  assert.equal(row.freshness, null);
  assert.equal(row.version_gap, null);
  // A gap in our reference is not a finding about the store.
  assert.equal(outcome.status, 'SKIPPED');
  assert.equal((outcome.meta as ThemeAppsStepMeta).theme.catalogued, false);
});

test('does not clobber the raw facts fetch_stores already recorded', async () => {
  const { db, runId, store } = setup({ name: 'Debut', version: '17.9.0' });
  saveThemeInfo(store.id, { name: 'Debut', currentVersion: '17.9.0' }, db);

  await step().run(context(db, runId, store));

  const row = getThemeInfo(store.id, db)!;
  assert.equal(row.name, 'Debut');
  assert.equal(row.current_version, '17.9.0');
  assert.equal(row.freshness, 'very_outdated');
});

test('a later run withdraws a verdict the reference no longer supports', async () => {
  const { db, runId, store } = setup({ name: 'Dawn', version: '1.0.0' });
  await step().run(context(db, runId, store));
  assert.equal(getThemeInfo(store.id, db)!.freshness, 'severely_outdated');

  // The reference is refreshed and no longer carries Dawn at all (task 2-22).
  const emptied = createThemeAppsStep({
    catalog: { updatedAt: '2026-10-01', themes: {} },
    now: () => NOW,
  });
  await emptied.run(context(db, runId, store));

  const row = getThemeInfo(store.id, db)!;
  assert.equal(row.freshness, null);
  assert.equal(row.version_gap, null);
  assert.equal(row.latest_version, null);
  // The raw facts survive: only the derived columns are withdrawn.
  assert.equal(row.current_version, '1.0.0');
});

test('runs again on every pass rather than caching its own output', () => {
  // The verdict depends on the reference file, which changes without the store
  // changing, so the step deliberately declares no isSatisfied.
  assert.equal(step().isSatisfied, undefined);
});

test('refuses to run without a store', async () => {
  const { db, runId } = setup();

  await assert.rejects(step().run(context(db, runId, null)), /store-scoped/);
});

test('handles a store with no theme reported at all', async () => {
  const { db, runId, store } = setup();

  const outcome = await step().run(context(db, runId, store));

  const row = getThemeInfo(store.id, db)!;
  assert.equal(row.name, null);
  assert.equal(row.freshness, null);
  assert.match((outcome.meta as ThemeAppsStepMeta).theme.reason, /no theme reported/);
});

test('stores the app-stack verdict alongside the theme one', async () => {
  const { db, runId, store } = setup(
    { name: 'Dawn', version: '5.0.0' },
    {
      apps: [
        { name: 'Klaviyo', category: 'email marketing' },
        { name: 'Judge.me', category: 'product reviews' },
        { name: 'ReConvert', category: 'upsell and cross-sell' },
        { name: 'Plug in SEO', category: 'seo' },
      ],
    },
  );

  const outcome = await step().run(context(db, runId, store));

  const row = getAppStack(store.id, db)!;
  assert.equal(row.total, 4);
  assert.equal(row.size, 'low');
  assert.deepEqual(JSON.parse(row.groups_json), {
    marketing: 1,
    reviews: 1,
    analytics: 0,
    upsell: 1,
    loyalty: 0,
    subscription: 0,
    search: 0,
    personalization: 0,
    tracking: 0,
    other: 1,
  });
  assert.deepEqual(JSON.parse(row.other_json!), [{ category: 'seo', count: 1 }]);
  assert.deepEqual((outcome.meta as ThemeAppsStepMeta).apps.groups, [
    'marketing',
    'reviews',
    'upsell',
    'other',
  ]);
});

test("sizes the stack by StoreLeads' count when it exceeds the apps we hold", async () => {
  const { db, runId, store } = setup(
    { name: 'Dawn', version: '5.0.0' },
    { apps: [{ name: 'Klaviyo', category: 'email marketing' }], appsCount: 21 },
  );

  await step().run(context(db, runId, store));

  const row = getAppStack(store.id, db)!;
  assert.equal(row.total, 1);
  assert.equal(row.reported_count, 21);
  assert.equal(row.size, 'very_high');
});

test('a store with apps but an unknown theme still produced a verdict', async () => {
  const { db, runId, store } = setup(
    { name: 'keyshortscom/main', version: '1.0.0' },
    { apps: [{ name: 'Klaviyo', category: 'email marketing' }] },
  );

  const outcome = await step().run(context(db, runId, store));

  assert.equal(outcome.status, 'OK');
  assert.equal(getAppStack(store.id, db)!.total, 1);
  assert.equal(getThemeInfo(store.id, db)!.freshness, null);
});

test('a re-run rewrites the app verdict rather than adding to it', async () => {
  const { db, runId, store } = setup(
    { name: 'Dawn', version: '5.0.0' },
    { apps: [{ name: 'Klaviyo', category: 'email marketing' }] },
  );

  await step().run(context(db, runId, store));
  saveStoreApps(store.id, [{ name: 'Judge.me', category: 'product reviews' }], db);
  await step().run(context(db, runId, store));

  const row = getAppStack(store.id, db)!;
  assert.equal(row.total, 2);
  assert.equal((JSON.parse(row.groups_json) as Record<string, number>).reviews, 1);
});

test('writes a row even for a store with no apps at all', async () => {
  const { db, runId, store } = setup({ name: 'Dawn', version: '5.0.0' });

  await step().run(context(db, runId, store));

  const row = getAppStack(store.id, db)!;
  assert.equal(row.total, 0);
  assert.equal(row.size, null);
  assert.equal(row.other_json, null);
});
