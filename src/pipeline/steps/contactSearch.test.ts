import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../../db/client.js';
import { migrate } from '../../db/migrate.js';
import { listContacts } from '../../db/repositories/contacts.js';
import { attachStoreToRun, createRun } from '../../db/repositories/runs.js';
import { upsertStore } from '../../db/repositories/stores.js';
import type { StoreRow } from '../../db/types.js';
import { silentLogger } from '../../lib/logger.js';
import { AuditPool } from '../../audit/pool.js';
import {
  html,
  startFixtureServer,
  type FixtureRoute,
  type RouteHandler,
} from '../../audit/testing/fixtureServer.js';
import { cooldownFor, listCooldowns, noteRefusal } from '../../db/repositories/cooldowns.js';
import type { WebSearchProvider } from '../../collectors/websearch/provider.js';
import type { AiClient } from '../../ai/client.js';
import { createContactSearchStep, type ContactSearchStepOptions } from './contactSearch.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'db', 'migrations');

let pool: AuditPool;

before(() => {
  pool = new AuditPool({ concurrency: 1, restartAfter: 0, session: { requestDelayMs: 0 } });
});

after(async () => {
  await pool.close();
});

function step(overrides: Partial<ContactSearchStepOptions> = {}) {
  // The fixtures serve no robots.txt; compliance itself is covered in
  // pageScraper.test.ts against a fixture that does.
  //
  // `webSearch: null` and `aiClient: null` are the defaults here so these tests
  // stay offline: without them every store the storefront says nothing about
  // would reach for the real provider (4-05…4-07) and the real model (4-04).
  // The tests that exercise either pass a fake.
  return createContactSearchStep({
    pool,
    respectRobots: false,
    webSearch: null,
    aiClient: null,
    ...overrides,
  });
}

/** A provider that answers every query with the same canned LinkedIn hit. */
function fakeSearch(
  hits: { url: string; title: string; snippet?: string | null }[],
): WebSearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    name: 'fake',
    queries,
    search: async (query) => {
      queries.push(query.query);
      return {
        provider: 'fake',
        query: query.query,
        hits: hits.map((hit) => ({ snippet: null, ...hit })),
        dropped: 0,
        usage: { tokensIn: 50, tokensOut: 5, durationMs: 1, model: 'fake', searches: 1 },
      };
    },
  };
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

test('writes the three columns a shop published', async () => {
  const f = await fixture({
    '/': {
      body: html(`<main>Sklep</main><footer>
        <a href="/pages/o-nas">O nas</a>
        <a href="/pages/kontakt">Kontakt</a>
        <a href="https://www.linkedin.com/company/sklep-test">LinkedIn</a>
        <a href="mailto:info@sklep.test">Napisz</a>
      </footer>`),
    },
    '/pages/o-nas': {
      body: html(`<h1>O nas</h1>
        <p>Sklep prowadzi Anna Kowalska, założycielka marki.</p>
        <a href="mailto:a.kowalska@sklep.test">Anna</a>
        <a href="https://pl.linkedin.com/in/anna-kowalska">LinkedIn</a>`),
    },
    '/pages/kontakt': { body: html('<h1>Kontakt</h1><a href="mailto:biuro@sklep.test">Biuro</a>') },
  });

  try {
    const outcome = await step().run(ctxFor(f.run.id, f.store, f.db));
    assert.equal(outcome.status, 'OK');

    const meta = outcome.meta as { people: number; personalEmails: number; genericEmails: number };
    assert.equal(meta.people, 1);
    assert.equal(meta.personalEmails, 1);
    assert.equal(meta.genericEmails, 2);

    const rows = listContacts(f.store.id, f.db);
    assert.deepEqual(
      rows.map((c) => [c.name, c.role, c.email, c.is_generic, c.is_primary]),
      [
        ['Anna Kowalska', 'Founder', 'a.kowalska@sklep.test', 0, 1],
        [null, null, 'biuro@sklep.test', 1, 0],
        [null, null, 'info@sklep.test', 1, 0],
      ],
    );
    assert.equal(rows[0]!.linkedin_url, 'https://www.linkedin.com/in/anna-kowalska');
  } finally {
    await f.close();
  }
});

test('a shop that publishes nothing is SKIPPED, not FAILED', async () => {
  const f = await fixture({
    '/': { body: html('<main>Sklep</main><footer><a href="/collections/all">Sklep</a></footer>') },
  });

  try {
    const outcome = await step().run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'SKIPPED');
    assert.deepEqual(listContacts(f.store.id, f.db), []);
  } finally {
    await f.close();
  }
});

test('a store that already has contacts is satisfied and not rescraped', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="mailto:info@sklep.test">Napisz</a></footer>') },
  });

  try {
    const contactStep = step();
    await contactStep.run(ctxFor(f.run.id, f.store, f.db));
    const before = f.server.requests.length;

    assert.equal(
      contactStep.isSatisfied?.({
        runId: f.run.id,
        store: f.store,
        db: f.db,
        logger: silentLogger(),
        force: false,
      }),
      true,
    );
    assert.equal(f.server.requests.length, before, 'isSatisfied must not touch the storefront');
  } finally {
    await f.close();
  }
});

test('a storefront that refuses us starts a cooldown instead of a retry', async () => {
  const f = await fixture({ '/': { status: 429, headers: { 'retry-after': '120' } } });

  try {
    const outcome = await step().run(ctxFor(f.run.id, f.store, f.db));
    const meta = outcome.meta as { reason: string; strikes: number };

    assert.equal(outcome.status, 'SKIPPED');
    assert.match(meta.reason, /answered 429/);
    assert.equal(meta.strikes, 1);

    const cooling = cooldownFor(f.store.domain, f.db);
    assert.ok(cooling, 'the refusal must be recorded');
    assert.equal(cooling.reason, 'rate_limited');
  } finally {
    await f.close();
  }
});

test('a cooling domain is not touched at all, not even once', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="mailto:i@sklep.test">x</a></footer>') },
  });

  try {
    noteRefusal(f.store.domain, { reason: 'bot_challenge' }, f.db);
    const before = f.server.requests.length;

    const outcome = await step().run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'SKIPPED');
    assert.match((outcome.meta as { reason: string }).reason, /cooling down/);
    assert.equal(f.server.requests.length, before, 'no request may reach a cooling storefront');
  } finally {
    await f.close();
  }
});

test('a storefront that answers normally clears an earlier cooldown', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="mailto:i@sklep.test">x</a></footer>') },
  });

  try {
    // An expired cooldown row is still in the table; a good visit must remove it.
    noteRefusal(f.store.domain, { reason: 'rate_limited' }, f.db, new Date(Date.now() - 7_200_000));
    await step().run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(cooldownFor(f.store.domain, f.db), null);
    assert.deepEqual(listCooldowns(f.db), []);
  } finally {
    await f.close();
  }
});

test('a storefront that never answers is reported as unloadable, without a cooldown', async () => {
  const server = await startFixtureServer({});
  const url = server.url;
  await server.close();

  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  const run = createRun('PL', 1, db);
  const { store } = upsertStore({ domain: 'sklep.test', url }, db);
  attachStoreToRun(run.id, store.id, db);

  try {
    const outcome = await step().run(ctxFor(run.id, store, db));

    assert.equal(outcome.status, 'SKIPPED');
    assert.equal((outcome.meta as { reason: string }).reason, 'storefront could not be loaded');
    // A dead host is not a refusal: backing off would hide a real outage.
    assert.deepEqual(listCooldowns(db), []);
  } finally {
    db.close();
  }
});

// ------------------------------------------------- web search (tasks 4-05…4-07)

// The headline names the hostname, not the bare word "sklep": that label is the
// Polish for "shop" and is refused as a brand tie on its own (see brand.ts).
const ANNA_HIT = {
  url: 'https://pl.linkedin.com/in/anna-kowalska',
  title: 'Anna Kowalska - Founder - sklep.test | LinkedIn',
};

test('a shop that names nobody is searched for, and the profile becomes a contact', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="mailto:info@sklep.test">Napisz</a></footer>') },
  });
  const provider = fakeSearch([ANNA_HIT]);

  try {
    const outcome = await step({ webSearch: provider }).run(ctxFor(f.run.id, f.store, f.db));
    assert.equal(outcome.status, 'OK');
    assert.equal((outcome.meta as { serpPeople: number }).serpPeople, 1);

    const rows = listContacts(f.store.id, f.db);
    assert.deepEqual(
      rows.map((c) => [c.name, c.role, c.source, c.is_primary]),
      [
        ['Anna Kowalska', 'Founder', 'linkedin_serp', 1],
        [null, null, 'generic_email', 0],
      ],
    );
    assert.equal(rows[0]!.linkedin_url, 'https://www.linkedin.com/in/anna-kowalska');
  } finally {
    await f.close();
  }
});

test('a shop that already names its owner is never searched for', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="/pages/o-nas">O nas</a></footer>') },
    '/pages/o-nas': {
      body: html('<p>Sklep prowadzi Jan Nowak, właściciel.</p>'),
    },
  });
  const provider = fakeSearch([ANNA_HIT]);

  try {
    const outcome = await step({ webSearch: provider }).run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'OK');
    // The spending rule: the scrape is free and its answer is better evidence.
    assert.deepEqual(provider.queries, []);
    assert.deepEqual(
      listContacts(f.store.id, f.db).map((c) => c.name),
      ['Jan Nowak'],
    );
  } finally {
    await f.close();
  }
});

test('a storefront that answers 429 still gets searched, and keeps its cooldown', async () => {
  const f = await fixture({ '/': { status: 429 } });
  const provider = fakeSearch([ANNA_HIT]);

  try {
    const outcome = await step({ webSearch: provider }).run(ctxFor(f.run.id, f.store, f.db));

    // The defect from the 2026-09-02 run: five shops behind Cloudflare were
    // filed as "publishes no contact" when we had simply never reached them.
    assert.equal(outcome.status, 'OK');
    assert.match((outcome.meta as { reason: string }).reason, /answered 429/);
    assert.equal(provider.queries.length, 1);

    const cooling = cooldownFor(f.store.domain, f.db);
    assert.ok(cooling, 'the refusal is still recorded — the search does not excuse it');

    assert.deepEqual(
      listContacts(f.store.id, f.db).map((c) => [c.name, c.source]),
      [['Anna Kowalska', 'linkedin_serp']],
    );
  } finally {
    await f.close();
  }
});

test('a search that finds nobody leaves the store SKIPPED as before', async () => {
  const f = await fixture({ '/': { body: html('<main>Sklep</main>') } });
  const provider = fakeSearch([]);

  try {
    const outcome = await step({ webSearch: provider }).run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'SKIPPED');
    assert.equal((outcome.meta as { searchQueries: number }).searchQueries, 2);
    assert.deepEqual(listContacts(f.store.id, f.db), []);
  } finally {
    await f.close();
  }
});

test('the run budget bounds the searches a whole batch can spend', async () => {
  const f = await fixture({ '/': { body: html('<main>Sklep</main>') } });
  const provider = fakeSearch([]);
  // One search for the entire run, not one per store.
  const contactStep = step({ webSearch: provider, maxSearchesPerRun: 1 });

  try {
    await contactStep.run(ctxFor(f.run.id, f.store, f.db));
    await contactStep.run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(provider.queries.length, 1);
  } finally {
    await f.close();
  }
});

test('zero queries per store turns the search off without touching the rest', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="mailto:info@sklep.test">x</a></footer>') },
  });
  const provider = fakeSearch([ANNA_HIT]);

  try {
    const outcome = await step({ webSearch: provider, maxQueriesPerStore: 0 }).run(
      ctxFor(f.run.id, f.store, f.db),
    );

    assert.equal(outcome.status, 'OK');
    assert.deepEqual(provider.queries, []);
    assert.deepEqual(
      listContacts(f.store.id, f.db).map((c) => c.email),
      ['info@sklep.test'],
    );
  } finally {
    await f.close();
  }
});

test('a shop with only a company page still ends OK, not SKIPPED', () => {
  const provider = fakeSearch([
    { url: 'https://www.linkedin.com/company/sklep-test', title: 'sklep.test | LinkedIn' },
  ]);
  return (async () => {
    const f = await fixture({ '/': { body: html('<main>Sklep</main>') } });
    try {
      const outcome = await step({ webSearch: provider }).run(ctxFor(f.run.id, f.store, f.db));

      // A page to look at is not a person to write to, but it is the only lead
      // this shop has, and the run should not throw it away.
      assert.equal(outcome.status, 'OK');
      assert.equal(
        (outcome.meta as { searchCompany?: string }).searchCompany,
        'https://www.linkedin.com/company/sklep-test',
      );
      assert.deepEqual(
        listContacts(f.store.id, f.db).map((c) => [c.name, c.linkedin_url, c.source]),
        [[null, 'https://www.linkedin.com/company/sklep-test', 'linkedin_serp']],
      );
    } finally {
      await f.close();
    }
  })();
});

// ------------------------------------------- the about reader (task 4-04)

/** A model that reports one person, quoting the sentence that names them. */
function fakeReader(
  people: { name: string; role: string; quote: string }[],
): AiClient & { calls: number } {
  const client = {
    calls: 0,
    model: 'test-model',
    complete: async () => {
      client.calls += 1;
      return {
        text: JSON.stringify({ people }),
        tokensIn: 500,
        tokensOut: 40,
        durationMs: 1,
        model: 'test-model',
      };
    },
  };
  return client;
}

const STORY = 'Firma powstała w 2019 roku, gdy Anna Kowalska rzuciła pracę w korporacji.';

test('a founding story no regex parses becomes a contact', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="/pages/o-nas">O nas</a></footer>') },
    '/pages/o-nas': { body: html(`<h1>O nas</h1><p>${STORY}</p>`) },
  });
  const reader = fakeReader([{ name: 'Anna Kowalska', role: 'założycielka', quote: STORY }]);

  try {
    const outcome = await step({ aiClient: reader }).run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'OK');
    assert.equal((outcome.meta as { aboutPeople: number }).aboutPeople, 1);
    assert.deepEqual(
      listContacts(f.store.id, f.db).map((c) => [c.name, c.role, c.source]),
      [['Anna Kowalska', 'Founder', 'about_page']],
    );
  } finally {
    await f.close();
  }
});

test('a shop whose own pages already name somebody is not read by the model', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="/pages/o-nas">O nas</a></footer>') },
    '/pages/o-nas': {
      body: html('<p>Sklep prowadzi Jan Nowak, właściciel.</p>'),
    },
  });
  const reader = fakeReader([{ name: 'Anna Kowalska', role: '', quote: STORY }]);

  try {
    await step({ aiClient: reader }).run(ctxFor(f.run.id, f.store, f.db));

    // The heuristics found him; a model reading would only cost a call.
    assert.equal(reader.calls, 0);
    assert.deepEqual(
      listContacts(f.store.id, f.db).map((c) => c.name),
      ['Jan Nowak'],
    );
  } finally {
    await f.close();
  }
});

test('a person the model invented never reaches the contacts', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="/pages/o-nas">O nas</a></footer>') },
    '/pages/o-nas': { body: html(`<h1>O nas</h1><p>${STORY}</p>`) },
  });
  const reader = fakeReader([
    { name: 'Jan Wymyślony', role: 'CEO', quote: 'Sklep prowadzi Jan Wymyślony.' },
  ]);

  try {
    const outcome = await step({ aiClient: reader }).run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'SKIPPED');
    assert.equal((outcome.meta as { aboutUngrounded?: number }).aboutUngrounded, 1);
    assert.deepEqual(listContacts(f.store.id, f.db), []);
  } finally {
    await f.close();
  }
});

test('a model that fails does not lose the addresses the scrape found', async () => {
  const f = await fixture({
    '/': { body: html('<footer><a href="mailto:info@sklep.test">Napisz</a></footer>') },
  });
  const broken: AiClient = {
    model: 'test-model',
    complete: () => Promise.reject(new Error('model unavailable')),
  };

  try {
    const outcome = await step({ aiClient: broken }).run(ctxFor(f.run.id, f.store, f.db));

    assert.equal(outcome.status, 'OK');
    assert.deepEqual(
      listContacts(f.store.id, f.db).map((c) => c.email),
      ['info@sklep.test'],
    );
  } finally {
    await f.close();
  }
});
