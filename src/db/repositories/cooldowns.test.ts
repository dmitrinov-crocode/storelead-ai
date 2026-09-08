import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createMemoryDb, type Database } from '../client.js';
import { migrate } from '../migrate.js';
import {
  canonicalDomain,
  cooldownFor,
  listCooldowns,
  noteRefusal,
  noteSuccess,
  parseRetryAfter,
} from './cooldowns.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');
const HOUR = 60 * 60 * 1000;

function freshDb(): Database {
  const db = createMemoryDb();
  migrate(db, MIGRATIONS_DIR);
  return db;
}

test('a refusal blocks the domain for an hour', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');

  const cooldown = noteRefusal('sklep.pl', { reason: 'rate_limited', status: 429 }, db, now);

  assert.equal(cooldown.msRemaining, HOUR);
  assert.equal(cooldownFor('sklep.pl', db, now)?.reason, 'rate_limited');
});

test('the wait doubles while the refusals keep coming', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');

  noteRefusal('sklep.pl', { reason: 'rate_limited' }, db, now);
  const second = noteRefusal('sklep.pl', { reason: 'rate_limited' }, db, now);
  const third = noteRefusal('sklep.pl', { reason: 'rate_limited' }, db, now);

  assert.equal(second.msRemaining, 2 * HOUR);
  assert.equal(third.msRemaining, 4 * HOUR);
  assert.equal(third.strikes, 3);
});

test('doubling stops at a day', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');
  let last = noteRefusal('sklep.pl', { reason: 'bot_challenge' }, db, now);
  for (let i = 0; i < 10; i += 1) {
    last = noteRefusal('sklep.pl', { reason: 'bot_challenge' }, db, now);
  }
  assert.equal(last.msRemaining, 24 * HOUR);
});

test('a refusal after the wait expired starts over', () => {
  const db = freshDb();
  const first = new Date('2026-09-02T12:00:00.000Z');
  noteRefusal('sklep.pl', { reason: 'rate_limited' }, db, first);

  const later = new Date('2026-09-02T14:00:00.000Z');
  assert.equal(cooldownFor('sklep.pl', db, later), null, 'the wait has expired');

  const again = noteRefusal('sklep.pl', { reason: 'rate_limited' }, db, later);
  assert.equal(again.strikes, 1);
  assert.equal(again.msRemaining, HOUR);
});

test('Retry-After wins when the site sent a longer one', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');

  const cooldown = noteRefusal(
    'sklep.pl',
    { reason: 'rate_limited', retryAfterSeconds: 3 * 3600 },
    db,
    now,
  );

  assert.equal(cooldown.msRemaining, 3 * HOUR);
});

test('a Retry-After shorter than our backoff does not shorten it', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');

  // Answering "wait 30s" with a request in 30s is how a rate limit becomes a ban.
  const cooldown = noteRefusal(
    'sklep.pl',
    { reason: 'rate_limited', retryAfterSeconds: 30 },
    db,
    now,
  );

  assert.equal(cooldown.msRemaining, HOUR);
});

test('a success clears the cooldown', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');
  noteRefusal('sklep.pl', { reason: 'rate_limited' }, db, now);

  noteSuccess('sklep.pl', db);

  assert.equal(cooldownFor('sklep.pl', db, now), null);
  assert.deepEqual(listCooldowns(db, now), []);
});

test('the domain is canonical, so one shop is one cooldown', () => {
  const db = freshDb();
  const now = new Date('2026-09-02T12:00:00.000Z');

  noteRefusal('https://WWW.Sklep.pl/pages/kontakt', { reason: 'rate_limited' }, db, now);

  assert.equal(canonicalDomain('https://WWW.Sklep.pl/pages/kontakt'), 'sklep.pl');
  assert.ok(cooldownFor('sklep.pl', db, now), 'the same shop must not get a second entry');
  assert.equal(listCooldowns(db, now).length, 1);
});

test('Retry-After is read as seconds or as a date', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');

  assert.equal(parseRetryAfter('120', now), 120);
  assert.equal(parseRetryAfter('Wed, 02 Sep 2026 12:05:00 GMT', now), 300);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('nonsense', now), null);
  // A date in the past means "now", not a negative wait.
  assert.equal(parseRetryAfter('Wed, 02 Sep 2026 11:00:00 GMT', now), 0);
});
