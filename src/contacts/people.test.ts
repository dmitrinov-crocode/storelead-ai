import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractEmails } from './emails.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';
import { detectRole, extractPeople, looksLikePersonName } from './people.js';

function page(overrides: Partial<ScrapedPage> & { kind?: ContactPageKind } = {}): ScrapedPage {
  return {
    kind: 'about',
    url: 'https://sklep.pl/pages/o-nas',
    status: 200,
    source: 'footer',
    html: '',
    text: '',
    mailtos: [],
    ...overrides,
  };
}

test('maps Polish and English titles onto the 4-08 ladder', () => {
  const cases: [string, string][] = [
    ['Prezes zarządu', 'CEO'],
    // Several titles at once: the most senior wins, since 4-08 ranks on it.
    ['CEO & Founder', 'CEO'],
    ['Co-Founder & CEO', 'CEO'],
    ['Założycielka marki', 'Founder'],
    ['współzałożyciel', 'Co-Founder'],
    ['Właściciel sklepu', 'Owner'],
    ['Head of E-commerce', 'Head of Ecommerce'],
    ['Dyrektor techniczny', 'CTO'],
    ['E-commerce Manager', 'Ecommerce Manager'],
    ['Kierownik działu', 'Other'],
  ];

  for (const [text, expected] of cases) {
    assert.equal(detectRole(text)?.role, expected, `${text} should map to ${expected}`);
  }
  assert.equal(detectRole('Zapraszamy do sklepu'), null);
});

test('reads a person out of JSON-LD', () => {
  const result = extractPeople([
    page({
      html: `<script type="application/ld+json">
        {"@type":"Person","name":"Anna Kowalska","jobTitle":"Założycielka"}
      </script>`,
    }),
  ]);

  assert.deepEqual(
    result.map((p) => [p.name, p.role, p.source]),
    [['Anna Kowalska', 'Founder', 'jsonld']],
  );
});

test('reads a person introduced by a verb', () => {
  const result = extractPeople([
    page({ text: 'Sklep prowadzi Anna Kowalska, założycielka marki, od 2019 roku.' }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, 'Anna Kowalska');
  assert.equal(result[0]!.role, 'Founder');
  assert.match(result[0]!.evidence, /Anna Kowalska/);
});

test('reads the name-then-role and role-then-name shapes', () => {
  const both = extractPeople([page({ text: 'Jan Nowak — Właściciel. Founder: Ewa Wiśniewska.' })]);

  assert.deepEqual(
    both.map((p) => [p.name, p.role]),
    [
      ['Ewa Wiśniewska', 'Founder'],
      ['Jan Nowak', 'Owner'],
    ],
  );
});

test('legal and navigation copy never becomes a person', () => {
  const result = extractPeople([
    page({
      kind: 'privacy',
      url: 'https://sklep.pl/polityka-prywatnosci',
      text: [
        'Polityka Prywatności — Administrator danych osobowych.',
        'Regulamin Sklepu określa warunki. Kodeks Cywilny stosuje się wprost.',
        'Dane Osobowe przetwarza Nasza Firma z siedzibą w Warszawie.',
        'Privacy Policy: Our Team is the data controller.',
      ].join(' '),
    }),
  ]);

  assert.deepEqual(result, []);
});

test('a bare capitalised pair without any assertion is not a person', () => {
  // No role word, no introducing verb, no matching address — nothing claims it
  // is a human, so it must not be harvested.
  const result = extractPeople([page({ text: 'Zapraszamy do Nowego Salonu w Krakowie.' })]);

  assert.deepEqual(result, []);
});

test('the shop name is not mistaken for its owner', () => {
  const result = extractPeople(
    [page({ text: 'Sklep prowadzi Anna Nova od 2019 roku.' })],
    [],
    'annanova.pl',
  );

  assert.deepEqual(result, []);
});

test('derives a name from a personal address and links the two', () => {
  const emails = extractEmails([page({ mailtos: ['anna.kowalska@sklep.pl'] })], 'sklep.pl');
  const result = extractPeople([page({ mailtos: ['anna.kowalska@sklep.pl'] })], emails, 'sklep.pl');

  assert.deepEqual(
    result.map((p) => [p.name, p.source, p.email]),
    [['Anna Kowalska', 'email_local', 'anna.kowalska@sklep.pl']],
  );
});

test('an initial plus surname address is matched to the named person', () => {
  const pages = [
    page({
      text: 'Sklep prowadzi Anna Kowalska, założycielka.',
      mailtos: ['a.kowalska@sklep.pl'],
    }),
  ];
  const result = extractPeople(pages, extractEmails(pages, 'sklep.pl'), 'sklep.pl');

  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, 'Anna Kowalska');
  assert.equal(result[0]!.email, 'a.kowalska@sklep.pl');
});

test('one person seen twice keeps the sighting that states a role', () => {
  const result = extractPeople([
    page({ kind: 'home', url: 'https://sklep.pl/', text: 'Sklep prowadzi Anna Kowalska.' }),
    page({ text: 'Anna Kowalska — Prezes zarządu' }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.role, 'CEO');
});

test('people are ordered by seniority', () => {
  const result = extractPeople([
    page({
      text: 'Jan Nowak — Kierownik działu. Ewa Wiśniewska — Właścicielka. Adam Zych — Prezes.',
    }),
  ]);

  // Jan Nowak is gone: `Other` matches any `kierownik` or `manager`, and that is
  // the pattern that put the company `Best Expansion` in pepco.pl's contacts.
  assert.deepEqual(
    result.map((p) => [p.name, p.role]),
    [
      ['Adam Zych', 'CEO'],
      ['Ewa Wiśniewska', 'Owner'],
    ],
  );
});

test('a name needs a second kind of evidence, not just the right shape', () => {
  // `Salon Bmw Bawaria` reached a real letter through an introducing verb, and
  // it is two capitalised words with no stopword among them, like any name.
  assert.deepEqual(extractPeople([page({ text: 'Sklep prowadzi Salon Bmw Bawaria.' })]), []);

  // The same sentence with a title beside it is a person.
  const withRole = extractPeople([
    page({ text: 'Sklep prowadzi Anna Kowalska, założycielka marki.' }),
  ]);
  assert.deepEqual(
    withRole.map((p) => p.name),
    ['Anna Kowalska'],
  );
});

test('an address that spells the name is confirmation enough on its own', () => {
  const result = extractPeople(
    [page({ text: 'Sklep prowadzi Anna Kowalska.' })],
    [
      {
        email: 'a.kowalska@sklep.pl',
        bucket: 'personal',
        source: 'mailto',
        pageKind: 'about',
        pageUrl: 'https://sklep.pl/pages/o-nas',
        evidence: 'mailto',
        ownDomain: true,
      },
    ],
    'sklep.pl',
  );

  assert.deepEqual(
    result.map((p) => [p.name, p.role]),
    [['Anna Kowalska', null]],
  );
});

test('an introduction with no title and no address is dropped', () => {
  // The cost of the rule, stated plainly: a real person, introduced with
  // nothing to confirm they are one, no longer becomes a contact.
  assert.deepEqual(extractPeople([page({ text: 'Sklep prowadzi Anna Kowalska.' })]), []);
});

test('name shapes accepted and rejected', () => {
  assert.equal(looksLikePersonName('Anna Kowalska'), true);
  assert.equal(looksLikePersonName('Jan Nowak-Kowalski'), true);
  assert.equal(looksLikePersonName('Anna'), false, 'a single token is not enough');
  assert.equal(looksLikePersonName('Polityka Prywatności'), false);
  assert.equal(looksLikePersonName('Regulamin Sklepu'), false);
  assert.equal(looksLikePersonName('Anna Kowalska Nowak Zych'), false, 'four tokens is not a name');
});

test('a data-protection authority on the privacy page is not a person', () => {
  // Found on keyshorts.com: the sentence names the Polish regulator, and
  // "Prezes" beside it made it a CEO called "Data Protection Office".
  const result = extractPeople([
    page({
      kind: 'privacy',
      url: 'https://keyshorts.com/pages/privacy',
      text:
        'You may lodge a complaint about the processing of your personal data with: ' +
        'President of the Personal Data Protection Office (Prezes Urzędu Ochrony Danych ' +
        'Osobowych — UODO), Poland.',
    }),
  ]);

  assert.deepEqual(result, []);
});

test('the same sentence is rejected even if it appears on the About page', () => {
  const result = extractPeople([
    page({
      text: 'Skargi kieruj do Personal Data Protection Office (Prezes Urzędu Ochrony Danych).',
    }),
  ]);

  assert.deepEqual(result, []);
});
