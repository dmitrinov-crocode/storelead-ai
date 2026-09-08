import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectStoreContacts } from './collect.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';

function page(overrides: Partial<ScrapedPage> & { kind?: ContactPageKind } = {}): ScrapedPage {
  return {
    kind: 'home',
    url: 'https://sklep.pl/',
    status: 200,
    source: 'homepage',
    html: '',
    text: '',
    mailtos: [],
    ...overrides,
  };
}

test('sorts a store into the three columns', () => {
  const result = collectStoreContacts(
    [
      page({
        html: '<footer><a href="https://www.linkedin.com/company/sklep-pl">LinkedIn</a></footer>',
        mailtos: ['info@sklep.pl'],
      }),
      page({
        kind: 'about',
        url: 'https://sklep.pl/pages/o-nas',
        html: '<a href="https://pl.linkedin.com/in/anna-kowalska">Anna</a>',
        mailtos: ['anna@sklep.pl'],
        text: 'Sklep prowadzi Anna Kowalska.',
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.personalEmails.map((e) => e.email),
    ['anna@sklep.pl'],
  );
  assert.deepEqual(
    result.linkedin.map((l) => [l.kind, l.url]),
    [
      ['profile', 'https://www.linkedin.com/in/anna-kowalska'],
      ['company', 'https://www.linkedin.com/company/sklep-pl'],
    ],
  );
  assert.deepEqual(
    result.genericEmails.map((e) => e.email),
    ['info@sklep.pl'],
  );
  assert.equal(result.empty, false);
});

test('a store that published nothing is reported as empty', () => {
  const result = collectStoreContacts([page({ text: 'Zapraszamy do sklepu.' })], 'sklep.pl');

  assert.deepEqual(result, {
    personalEmails: [],
    linkedin: [],
    genericEmails: [],
    people: [],
    empty: true,
  });
});

test('only generic mailboxes still counts as found', () => {
  const result = collectStoreContacts([page({ mailtos: ['biuro@sklep.pl'] })], 'sklep.pl');

  assert.equal(result.empty, false);
  assert.equal(result.personalEmails.length, 0);
  assert.equal(result.genericEmails.length, 1);
});

test('the same LinkedIn link on several pages appears once', () => {
  const result = collectStoreContacts(
    [
      page({ html: '<a href="https://linkedin.com/company/sklep-pl?trk=footer">LI</a>' }),
      page({
        kind: 'contact',
        url: 'https://sklep.pl/pages/kontakt',
        html: '<a href="https://www.linkedin.com/company/sklep-pl/">LI</a>',
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.linkedin.map((l) => l.url),
    ['https://www.linkedin.com/company/sklep-pl'],
  );
  // The contact page is the more telling place to have found it.
  assert.equal(result.linkedin[0]!.pageKind, 'contact');
});

test('legacy /pub/ profile links are normalised to /in/', () => {
  const result = collectStoreContacts(
    [page({ html: '<a href="https://pl.linkedin.com/pub/jan-kowalski">Jan</a>' })],
    'sklep.pl',
  );

  assert.deepEqual(
    result.linkedin.map((l) => [l.kind, l.url]),
    [['profile', 'https://www.linkedin.com/in/jan-kowalski']],
  );
});

test('links to LinkedIn itself, not to a profile, are ignored', () => {
  const result = collectStoreContacts(
    [
      page({
        html: `<a href="https://www.linkedin.com/">LinkedIn</a>
               <a href="https://www.linkedin.com/feed/">Feed</a>
               <a href="https://www.linkedin.com/sharing/share-offsite/?url=https://sklep.pl">Share</a>`,
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(result.linkedin, []);
});

test('the person behind the shop travels with the columns', () => {
  const result = collectStoreContacts(
    [
      page({
        kind: 'about',
        url: 'https://sklep.pl/pages/o-nas',
        text: 'Sklep prowadzi Anna Kowalska, założycielka marki.',
        mailtos: ['a.kowalska@sklep.pl', 'info@sklep.pl'],
      }),
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.people.map((p) => [p.name, p.role, p.email]),
    [['Anna Kowalska', 'Founder', 'a.kowalska@sklep.pl']],
  );
  assert.deepEqual(
    result.personalEmails.map((e) => e.email),
    ['a.kowalska@sklep.pl'],
  );
  assert.deepEqual(
    result.genericEmails.map((e) => e.email),
    ['info@sklep.pl'],
  );
});
