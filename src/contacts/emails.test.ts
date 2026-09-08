import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEmail, extractEmails, isOwnDomain, isValidEmail } from './emails.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';

function page(overrides: Partial<ScrapedPage> & { kind?: ContactPageKind } = {}): ScrapedPage {
  return {
    kind: 'contact',
    url: 'https://sklep.pl/pages/kontakt',
    status: 200,
    source: 'footer',
    html: '',
    text: '',
    mailtos: [],
    ...overrides,
  };
}

test('reads mailto targets, JSON-LD and body text', () => {
  const result = extractEmails(
    [
      page({
        mailtos: ['Anna@Sklep.pl'],
        html: `<script type="application/ld+json">
          {"@type":"Organization","contactPoint":{"@type":"ContactPoint","email":"mailto:biuro@sklep.pl"}}
        </script>`,
        text: 'Napisz na reklamacje@sklep.pl albo zadzwoń.',
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.map((r) => [r.email, r.source, r.bucket]),
    [
      ['anna@sklep.pl', 'mailto', 'personal'],
      ['biuro@sklep.pl', 'jsonld', 'generic'],
      ['reklamacje@sklep.pl', 'text', 'generic'],
    ],
  );
});

test('invalid JSON-LD does not lose the other sources', () => {
  const result = extractEmails(
    [
      page({
        html: '<script type="application/ld+json">{ this is not json }</script>',
        text: 'anna@sklep.pl',
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.map((r) => r.email),
    ['anna@sklep.pl'],
  );
});

test('undoes bracketed obfuscation, including the mixed forms', () => {
  const result = extractEmails(
    [
      page({
        text: 'anna (at) sklep (dot) pl, jan [at] sklep.pl, ewa@sklep (dot) pl',
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.map((r) => [r.email, r.source]),
    [
      ['anna@sklep.pl', 'obfuscated'],
      ['ewa@sklep.pl', 'obfuscated'],
      ['jan@sklep.pl', 'obfuscated'],
    ],
  );
});

test('undoes the spelled-out form when both words are present', () => {
  const result = extractEmails([page({ text: 'anna at sklep dot pl' })], 'sklep.pl');

  assert.deepEqual(
    result.map((r) => [r.email, r.source]),
    [['anna@sklep.pl', 'obfuscated']],
  );
});

test('a bare "at" in prose is not an address', () => {
  // The reason the spelled-out form requires "dot" as well.
  const result = extractEmails(
    [page({ text: 'Have a look at sklep.pl and at nasze-buty.pl for more.' })],
    'sklep.pl',
  );

  assert.deepEqual(result, []);
});

test('an address is reported once, from its strongest source', () => {
  const result = extractEmails(
    [
      page({ kind: 'home', url: 'https://sklep.pl/', text: 'anna@sklep.pl' }),
      page({ kind: 'contact', mailtos: ['anna@sklep.pl'], text: 'anna@sklep.pl' }),
    ],
    'sklep.pl',
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]!.source, 'mailto');
  assert.equal(result[0]!.pageKind, 'contact');
});

test('the same source on two pages resolves to the more telling page', () => {
  const result = extractEmails(
    [
      page({ kind: 'terms', url: 'https://sklep.pl/regulamin', text: 'anna@sklep.pl' }),
      page({ kind: 'about', url: 'https://sklep.pl/pages/o-nas', text: 'anna@sklep.pl' }),
    ],
    'sklep.pl',
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]!.pageKind, 'about');
});

test('evidence carries the surrounding sentence', () => {
  const result = extractEmails(
    [page({ text: 'Sklep prowadzi Anna Kowalska, kontakt: anna@sklep.pl — zapraszamy.' })],
    'sklep.pl',
  );

  assert.match(result[0]!.evidence, /Anna Kowalska/);
});

test('third-party mailboxes are kept but marked as off-domain', () => {
  const result = extractEmails(
    [page({ mailtos: ['anna@sklep.pl', 'anna.kowalska@gmail.com'] })],
    'sklep.pl',
  );

  assert.deepEqual(
    result.map((r) => [r.email, r.ownDomain]),
    [
      ['anna@sklep.pl', true],
      ['anna.kowalska@gmail.com', false],
    ],
  );
});

test("subdomain mailboxes count as the shop's own", () => {
  assert.equal(isOwnDomain('anna@mail.sklep.pl', 'sklep.pl'), true);
  assert.equal(isOwnDomain('anna@sklep.pl', 'https://www.sklep.pl/kontakt'), true);
  assert.equal(isOwnDomain('anna@nie-sklep.pl', 'sklep.pl'), false);
});

test('rejects the strings that only look like addresses', () => {
  for (const junk of [
    'logo@2x.png',
    'icon@3x.webp',
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6@o123456.ingest.sentry.io',
    'you@example.com',
    'youremail@sklep.pl',
    'name@domain.com',
    'anna@sklep',
    '@sklep.pl',
    'anna@.pl',
    'anna..k@sklep.pl',
    'support@shopify.com',
  ]) {
    assert.equal(isValidEmail(junk), false, `${junk} should be rejected`);
  }
});

test('accepts the shapes real merchants use', () => {
  for (const address of [
    'anna@sklep.pl',
    'a.kowalska@sklep.com.pl',
    'anna+sklep@sklep.pl',
    'biuro@xn--ata-zla6b.pl',
    "o'brien@shop.ie",
  ]) {
    assert.equal(isValidEmail(address), true, `${address} should be accepted`);
  }
});

test('shared mailboxes go to the generic bucket', () => {
  for (const address of [
    'info@sklep.pl',
    'support@sklep.pl',
    'kontakt@sklep.pl',
    'biuro@sklep.pl',
    'zamowienia@sklep.pl',
    'bok@sklep.pl',
    'info.sklep@sklep.pl',
    'biuro-1@sklep.pl',
    'kontakt+pl@sklep.pl',
    'no-reply@sklep.pl',
    'hi@sklep.pl',
    'pr@sklep.pl',
    // Named after the brand: found on perillalingerie.com and selsey.pl.
    'perilla@perilla.pl',
    'selsey@selsey.pl',
  ]) {
    assert.equal(classifyEmail(address), 'generic', `${address} should be generic`);
  }
});

test('mailboxes that name a person stay personal', () => {
  for (const address of [
    'anna@sklep.pl',
    'a.kowalska@sklep.pl',
    'anna.kowalska@sklep.pl',
    'jkowalski@sklep.pl',
    // "pr" is generic on its own but must not swallow a person's initials.
    'j.pr@sklep.pl',
    // Starts with "info" but is a word, not the mailbox.
    'informatyka@sklep.pl',
  ]) {
    assert.equal(classifyEmail(address), 'personal', `${address} should be personal`);
  }
});

test('personal addresses on the shop domain sort first', () => {
  const result = extractEmails(
    [
      page({
        mailtos: ['info@sklep.pl', 'anna.kowalska@gmail.com', 'anna@sklep.pl', 'biuro@sklep.pl'],
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.map((r) => r.email),
    ['anna@sklep.pl', 'anna.kowalska@gmail.com', 'biuro@sklep.pl', 'info@sklep.pl'],
  );
});
