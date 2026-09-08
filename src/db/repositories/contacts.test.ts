import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../client.js';
import { migrate } from '../migrate.js';
import { upsertStore } from './stores.js';
import {
  countStoresWithEmail,
  forgetDomain,
  forgetEmail,
  getPrimaryContact,
  isSuppressed,
  listContacts,
  listSuppressions,
  purgeExpiredContacts,
  saveContacts,
  unsuppress,
} from './contacts.js';
import type { ContactCandidate } from '../../contacts/ranking.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

function store(db: Database, domain: string): number {
  return upsertStore({ domain, url: `https://${domain}`, platform: 'shopify' }, db).store.id;
}

function candidate(overrides: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    name: null,
    role: null,
    roleText: null,
    email: null,
    linkedinUrl: null,
    source: 'about_page',
    sourceUrl: 'https://sklep.pl/pages/o-nas',
    confidence: 0.5,
    isGeneric: false,
    evidence: 'test',
    ...overrides,
  };
}

test('writes ranked candidates and marks the first person as primary', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  const result = saveContacts(
    id,
    [
      candidate({
        name: 'Anna Kowalska',
        role: 'Founder',
        email: 'anna@sklep.pl',
        confidence: 0.8,
      }),
      candidate({ email: 'info@sklep.pl', isGeneric: true, source: 'generic_email' }),
    ],
    db,
  );

  assert.deepEqual(result, { written: 2, duplicates: 0, shared: 0, suppressed: 0 });
  assert.equal(getPrimaryContact(id, db)?.email, 'anna@sklep.pl');
  assert.deepEqual(
    listContacts(id, db).map((c) => [c.email, c.is_generic, c.is_primary]),
    [
      ['anna@sklep.pl', 0, 1],
      ['info@sklep.pl', 1, 0],
    ],
  );
});

test('the same address twice in one batch is one contact', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  const result = saveContacts(
    id,
    [
      candidate({ name: 'Anna Kowalska', email: 'anna@sklep.pl' }),
      candidate({ email: 'anna@sklep.pl', sourceUrl: 'https://sklep.pl/pages/kontakt' }),
    ],
    db,
  );

  assert.equal(result.written, 1);
  assert.equal(result.duplicates, 1);
});

test('the same person named twice without an address is one contact', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  const result = saveContacts(
    id,
    [candidate({ name: 'Anna Kowalska', role: 'Founder' }), candidate({ name: 'anna kowalska' })],
    db,
  );

  assert.equal(result.written, 1);
  assert.equal(result.duplicates, 1);
});

test('saving again replaces the previous contacts rather than adding to them', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  saveContacts(id, [candidate({ email: 'stary@sklep.pl', name: 'Jan Nowak' })], db);
  saveContacts(id, [candidate({ email: 'nowy@sklep.pl', name: 'Anna Kowalska' })], db);

  const rows = listContacts(id, db);
  assert.deepEqual(
    rows.map((c) => c.email),
    ['nowy@sklep.pl'],
  );
  // Exactly one primary survives a rewrite.
  assert.equal(rows.filter((c) => c.is_primary === 1).length, 1);
});

test('an address shared across stores is demoted, not dropped', () => {
  const db = freshDb();
  const shared = 'biuro@agencja.pl';
  for (const domain of ['a.pl', 'b.pl', 'c.pl']) {
    saveContacts(store(db, domain), [candidate({ email: shared, confidence: 0.6 })], db);
  }

  const fourth = store(db, 'd.pl');
  assert.equal(countStoresWithEmail(shared, fourth, db), 3);

  const result = saveContacts(fourth, [candidate({ email: shared, confidence: 0.6 })], db);

  assert.equal(result.shared, 1);
  assert.equal(listContacts(fourth, db)[0]!.confidence, 0.3);
});

test('an address on only two other stores keeps its score', () => {
  const db = freshDb();
  const shared = 'biuro@grupa.pl';
  for (const domain of ['a.pl', 'b.pl']) {
    saveContacts(store(db, domain), [candidate({ email: shared, confidence: 0.6 })], db);
  }

  const third = store(db, 'c.pl');
  const result = saveContacts(third, [candidate({ email: shared, confidence: 0.6 })], db);

  assert.equal(result.shared, 0);
  assert.equal(listContacts(third, db)[0]!.confidence, 0.6);
});

test('a store with only shared mailboxes still gets a primary', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  saveContacts(
    id,
    [
      candidate({ email: 'info@sklep.pl', isGeneric: true, confidence: 0.4 }),
      candidate({ email: 'biuro@sklep.pl', isGeneric: true, confidence: 0.5 }),
    ],
    db,
  );

  assert.equal(getPrimaryContact(id, db)?.email, 'biuro@sklep.pl');
});

test('a candidate with nothing to reach is not written', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  const result = saveContacts(id, [candidate({})], db);

  assert.equal(result.written, 0);
  assert.deepEqual(listContacts(id, db), []);
});

test('a LinkedIn-only contact is written', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  saveContacts(
    id,
    [candidate({ linkedinUrl: 'https://www.linkedin.com/company/sklep-pl', source: 'footer' })],
    db,
  );

  const rows = listContacts(id, db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.linkedin_url, 'https://www.linkedin.com/company/sklep-pl');
  assert.equal(rows[0]!.is_primary, 1);
});

test('two contacts without addresses do not collide on the unique index', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');

  // The unique index is partial (`WHERE email IS NOT NULL`), so several rows may
  // legitimately carry a NULL address.
  const result = saveContacts(
    id,
    [candidate({ name: 'Anna Kowalska' }), candidate({ name: 'Jan Nowak' })],
    db,
  );

  assert.equal(result.written, 2);
});

/* --------------------------------------------------------------- GDPR (4-11) */

test('forgetting an address deletes it and keeps it from coming back', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');
  const found = [candidate({ name: 'Anna Kowalska', email: 'anna@sklep.pl' })];

  saveContacts(id, found, db);
  const erased = forgetEmail('anna@sklep.pl', 'erasure_request', db);

  assert.equal(erased.deleted, 1);
  assert.deepEqual(listContacts(id, db), []);

  // The point of the suppression list: the next run scrapes the same page and
  // offers the same address, and it must not be written again.
  const again = saveContacts(id, found, db);
  assert.equal(again.written, 0);
  assert.equal(again.suppressed, 1);
  assert.deepEqual(listContacts(id, db), []);
});

test('the address is matched case-insensitively', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');
  saveContacts(id, [candidate({ email: 'anna@sklep.pl' })], db);

  forgetEmail('ANNA@Sklep.PL', 'erasure_request', db);

  assert.deepEqual(listContacts(id, db), []);
  assert.equal(isSuppressed('anna@sklep.pl', 'sklep.pl', db), true);
});

test('forgetting a storefront erases every contact it has and blocks new ones', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');
  saveContacts(
    id,
    [
      candidate({ name: 'Anna Kowalska', email: 'anna@sklep.pl' }),
      candidate({ email: 'info@sklep.pl', isGeneric: true }),
    ],
    db,
  );

  const erased = forgetDomain('https://www.sklep.pl/kontakt', 'objection', db);

  assert.equal(erased.deleted, 2);
  const again = saveContacts(id, [candidate({ email: 'nowy@sklep.pl' })], db);
  assert.equal(again.written, 0);
  assert.equal(again.suppressed, 1);
});

test('suppressing one store does not touch another', () => {
  const db = freshDb();
  const kept = store(db, 'inny.pl');
  saveContacts(kept, [candidate({ email: 'anna@inny.pl' })], db);

  forgetDomain('sklep.pl', 'erasure_request', db);

  assert.equal(listContacts(kept, db).length, 1);
});

test('a suppression is listed and can be lifted', () => {
  const db = freshDb();
  forgetEmail('anna@sklep.pl', 'objection', db);

  const rows = listSuppressions(db);
  assert.deepEqual(
    rows.map((r) => [r.email, r.domain, r.reason]),
    [['anna@sklep.pl', null, 'objection']],
  );

  assert.equal(unsuppress('anna@sklep.pl', db).removed, 1);
  assert.equal(isSuppressed('anna@sklep.pl', 'sklep.pl', db), false);
});

test('forgetting the same address twice is not an error', () => {
  const db = freshDb();
  forgetEmail('anna@sklep.pl', 'erasure_request', db);
  forgetEmail('anna@sklep.pl', 'erasure_request', db);

  assert.equal(listSuppressions(db).length, 1);
});

test('retention deletes contacts past the period and keeps fresh ones', () => {
  const db = freshDb();
  const id = store(db, 'sklep.pl');
  saveContacts(id, [candidate({ email: 'anna@sklep.pl' })], db);

  assert.equal(purgeExpiredContacts(180, db).deleted, 0, 'a contact written now is not expired');

  // Age the row rather than waiting six months.
  db.exec("UPDATE contacts SET created_at = '2020-01-01T00:00:00.000Z'");
  assert.equal(purgeExpiredContacts(180, db).deleted, 1);
  assert.deepEqual(listContacts(id, db), []);
});
