import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryDb, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { createAudit, finishAudit, listIssues } from '../../db/repositories/audits.js';
import { attachStoreToRun, createRun } from '../../db/repositories/runs.js';
import { getStore, upsertStore } from '../../db/repositories/stores.js';
import type { StoreRow } from '../../db/types.js';
import { silentLogger } from '../../lib/logger.js';
import { AuditPool } from '../../audit/pool.js';
import {
  html,
  startFixtureServer,
  type FixtureRoute,
  type RouteHandler,
} from '../../audit/testing/fixtureServer.js';
import { createShopFixture } from '../../audit/testing/shopFixture.js';
import { cooldownFor } from '../../db/repositories/cooldowns.js';
import { createAuditStep } from './audit.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');

let pool: AuditPool;
let shotsDir: string;

before(async () => {
  pool = new AuditPool({ concurrency: 1, restartAfter: 0, session: { requestDelayMs: 0 } });
  shotsDir = await mkdtemp(path.join(tmpdir(), 'storelead-step-'));
});

after(async () => {
  await pool.close();
  await rm(shotsDir, { recursive: true, force: true });
});

function step() {
  return createAuditStep({ pool, screenshotsDir: shotsDir, skipLinks: true });
}

async function fixture(routes: Record<string, FixtureRoute | RouteHandler>) {
  const server = await startFixtureServer(routes);
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore({ domain: 'sklep.test', url: server.url }, db);
  attachStoreToRun(run.id, store.id, db);
  return {
    server,
    db,
    run,
    store,
    close: async () => {
      await server.close();
      db.close();
    },
  };
}

function ctxFor(runId: number, store: StoreRow, db: Database) {
  return {
    runId,
    store,
    db,
    logger: silentLogger(),
    force: false,
    signal: new AbortController().signal,
  };
}

test('auditing a working shop marks the store AUDITED and reports the counts', async () => {
  const f = await fixture(createShopFixture().routes);
  try {
    const outcome = await step().run(ctxFor(f.run.id, f.store, f.db));
    const meta = outcome.meta as {
      auditId: number;
      auditStatus: string;
      issues: number;
      CRITICAL: number;
      pagesAudited: number;
    };

    assert.equal(outcome.status, 'OK');
    assert.equal(meta.auditStatus, 'OK');
    assert.ok(meta.pagesAudited >= 5);
    assert.equal(meta.issues, listIssues(meta.auditId, f.db).length);
    assert.equal(getStore(f.store.id, f.db)!.status, 'AUDITED');
  } finally {
    await f.close();
  }
});

test('a blocked shop is skipped with the reason recorded on the store', async () => {
  const f = await fixture({
    '/': {
      body: html('<h1>Just a moment...</h1><p>Enable JavaScript and cookies to continue</p>'),
    },
  });
  try {
    const outcome = await step().run(ctxFor(f.run.id, f.store, f.db));
    assert.equal(outcome.status, 'OK');
    assert.equal((outcome.meta as { auditStatus: string }).auditStatus, 'BLOCKED');

    const store = getStore(f.store.id, f.db)!;
    assert.equal(store.status, 'SKIPPED');
    assert.match(store.status_reason!, /cloudflare/);
  } finally {
    await f.close();
  }
});

test('a shop that does not answer fails the step so the run can retry it', async () => {
  const server = await startFixtureServer({});
  const dead = server.url;
  await server.close();

  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore({ domain: 'zamkniety.test', url: dead }, db);
  attachStoreToRun(run.id, store.id, db);

  try {
    await assert.rejects(
      () => step().run(ctxFor(run.id, store, db)),
      /homepage could not be opened/,
    );
    // The audit row survives as the record of the attempt.
    assert.equal(getStore(store.id, db)!.status, 'NEW', 'the orchestrator owns the FAILED status');
  } finally {
    db.close();
  }
});

test('a finished audit satisfies the step, an unfinished one does not', async () => {
  const f = await fixture(createShopFixture().routes);
  try {
    const audited = step();
    const ctx = ctxFor(f.run.id, f.store, f.db);
    assert.equal(audited.isSatisfied!(ctx), false, 'nothing audited yet');

    const running = createAudit(f.store.id, f.run.id, f.db);
    assert.equal(audited.isSatisfied!(ctx), false, 'a RUNNING audit is not a result');

    finishAudit(running.id, { status: 'PARTIAL' }, f.db);
    assert.equal(audited.isSatisfied!(ctx), true);

    const retryable = createAudit(f.store.id, f.run.id, f.db);
    finishAudit(retryable.id, { status: 'FAILED' }, f.db);
    assert.equal(audited.isSatisfied!(ctx), false, 'a failed audit is worth another attempt');
  } finally {
    await f.close();
  }
});

test('the step is store-scoped, soft-failing and releases its browser', async () => {
  const own = createAuditStep({ screenshotsDir: shotsDir });
  assert.equal(own.scope, 'store');
  assert.equal(own.softFail, true);
  assert.equal(own.attempts, 1);
  // Nothing was launched, so teardown is a no-op rather than an error.
  await own.teardown!();

  await assert.rejects(
    () =>
      step().run({
        runId: 1,
        store: null,
        db: undefined,
        logger: silentLogger(),
        force: false,
        signal: new AbortController().signal,
      }),
    /store-scoped/,
  );
});

test('a blocked shop starts a cooldown and is not audited again', async () => {
  // The challenge shape gatta.pl serves: 429 with no vendor name in the body.
  const f = await fixture({
    '/': {
      status: 429,
      body: html('<title>Verifying your connection...</title>', ''),
    },
  });

  try {
    const first = await step().run(ctxFor(f.run.id, f.store, f.db));
    assert.equal((first.meta as { auditStatus: string }).auditStatus, 'BLOCKED');

    const cooling = cooldownFor(f.store.domain, f.db);
    assert.ok(cooling, 'a bot wall must start a cooldown');
    assert.equal(cooling.reason, 'bot_challenge');

    const before = f.server.requests.length;
    const second = await step().run(ctxFor(f.run.id, getStore(f.store.id, f.db)!, f.db));

    assert.equal(second.status, 'SKIPPED');
    assert.match((second.meta as { reason: string }).reason, /cooling down/);
    assert.equal(f.server.requests.length, before, 'a cooling shop receives no request at all');
  } finally {
    await f.close();
  }
});
