import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectStoreContacts } from './collect.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';
import {
  buildContactCandidates,
  CONFIDENCE_WEIGHTS,
  scoreContact,
  slugMatchesBrand,
} from './ranking.js';

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

function build(pages: ScrapedPage[], domain = 'sklep.pl') {
  return buildContactCandidates(collectStoreContacts(pages, domain), domain);
}

test('a named founder with a matching address outranks everything else', () => {
  const result = build([
    page({
      text: 'Sklep prowadzi Anna Kowalska, założycielka marki.',
      mailtos: ['a.kowalska@sklep.pl', 'info@sklep.pl', 'jan@sklep.pl'],
    }),
  ]);

  assert.deepEqual(
    result.map((c) => [c.name, c.role, c.email, c.isGeneric]),
    [
      ['Anna Kowalska', 'Founder', 'a.kowalska@sklep.pl', false],
      [null, null, 'jan@sklep.pl', false],
      [null, null, 'info@sklep.pl', true],
    ],
  );
});

test('named people are ordered by seniority, not by score', () => {
  // Both titles are specific ones: a generic `Other` no longer survives the
  // confirmation rule of 4-04, which is what a company name used to arrive as.
  const result = build([
    page({ text: 'Adam Zych — E-commerce Manager. Ewa Nowak — Prezes zarządu.' }),
  ]);

  assert.deepEqual(
    result.map((c) => [c.name, c.role]),
    [
      ['Ewa Nowak', 'CEO'],
      ['Adam Zych', 'Ecommerce Manager'],
    ],
  );
});

test('shared mailboxes always come last', () => {
  const result = build([page({ mailtos: ['info@sklep.pl', 'anna@sklep.pl'] })]);

  assert.deepEqual(
    result.map((c) => [c.email, c.isGeneric]),
    [
      ['anna@sklep.pl', false],
      ['info@sklep.pl', true],
    ],
  );
});

test('the score is the sum of the stated weights', () => {
  const contacts = collectStoreContacts(
    [
      page({
        text: 'Sklep prowadzi Anna Kowalska, założycielka.',
        mailtos: ['a.kowalska@sklep.pl'],
      }),
    ],
    'sklep.pl',
  );
  const person = contacts.people[0]!;
  const email = contacts.personalEmails[0]!;
  const w = CONFIDENCE_WEIGHTS;

  const expected =
    w.person.role_text +
    w.emailSource.mailto +
    w.ownDomain +
    w.tellingPage +
    w.hasRole +
    w.nameMatchesEmail;

  // The score is rounded to two decimals; the raw sum is not.
  assert.equal(
    scoreContact({ person, email, storeDomain: 'sklep.pl' }),
    Math.round(expected * 100) / 100,
  );
});

test("an address on somebody else's domain scores lower than one on the shop's", () => {
  const own = build([page({ mailtos: ['anna@sklep.pl'] })])[0]!;
  const foreign = build([page({ mailtos: ['anna@gmail.com'] })])[0]!;

  assert.ok(
    own.confidence > foreign.confidence,
    `${own.confidence} should beat ${foreign.confidence}`,
  );
});

test('an address only seen in body copy scores lower than a linked one', () => {
  const linked = build([page({ mailtos: ['anna@sklep.pl'] })])[0]!;
  const inProse = build([page({ text: 'Napisz na anna@sklep.pl' })])[0]!;

  assert.ok(linked.confidence > inProse.confidence);
});

test('a named person comes first even when a shared mailbox is better evidenced', () => {
  // The score says how much the contact is trusted, not how useful it is: a
  // `mailto:` the shop wrote itself is certainly the shop's mailbox. Seniority,
  // not confidence, is what decides who is written to first.
  const result = build([
    page({ text: 'Sklep prowadzi Anna Kowalska, założycielka.', mailtos: ['info@sklep.pl'] }),
  ]);

  assert.equal(result[0]!.name, 'Anna Kowalska');
  assert.equal(result[1]!.isGeneric, true);
  assert.ok(result[1]!.confidence >= result[0]!.confidence);
});

test('the weights are scaled so the best possible contact reaches exactly 1.00', () => {
  const w = CONFIDENCE_WEIGHTS;
  const best =
    w.person.jsonld +
    w.emailSource.mailto +
    w.ownDomain +
    w.tellingPage +
    w.hasRole +
    w.nameMatchesEmail +
    w.linkedinProfile +
    w.brandMatch;

  assert.equal(Math.round(best * 100) / 100, 1);
});

test('a LinkedIn profile is attributed to the person, a company page is not', () => {
  const result = build([
    page({
      text: 'Sklep prowadzi Anna Kowalska, założycielka.',
      html: `<a href="https://pl.linkedin.com/in/anna-kowalska">Anna</a>
             <a href="https://www.linkedin.com/company/sklep-pl">Sklep</a>`,
    }),
  ]);

  assert.equal(result[0]!.name, 'Anna Kowalska');
  assert.equal(result[0]!.linkedinUrl, 'https://www.linkedin.com/in/anna-kowalska');
  // The company page is not a second contact once a profile is attached.
  assert.equal(result.length, 1);
});

test('a company page with nobody attached is still kept', () => {
  const result = build([
    page({ html: '<a href="https://www.linkedin.com/company/sklep-pl">Sklep</a>' }),
  ]);

  assert.deepEqual(
    result.map((c) => [c.name, c.linkedinUrl]),
    [[null, 'https://www.linkedin.com/company/sklep-pl']],
  );
});

test('a LinkedIn slug is matched against the shop domain', () => {
  assert.equal(slugMatchesBrand('sklep-pl', 'sklep.pl'), true);
  assert.equal(slugMatchesBrand('maxton-design', 'maxtondesign.com'), true);
  assert.equal(slugMatchesBrand('some-agency', 'sklep.pl'), false);
});

test('confidence never leaves the 0…1 range', () => {
  for (const candidate of build([
    page({
      text: 'Sklep prowadzi Anna Kowalska, prezes zarządu.',
      html: '<a href="https://linkedin.com/in/anna-kowalska">A</a>',
      mailtos: ['a.kowalska@sklep.pl'],
    }),
  ])) {
    assert.ok(candidate.confidence >= 0 && candidate.confidence <= 1, `${candidate.confidence}`);
  }
});

// ---------------------------------------------------------------- web search

import type { SerpPerson } from './serp.js';

function serp(overrides: Partial<SerpPerson> = {}): SerpPerson {
  return {
    name: 'Anna Kowalska',
    role: 'CEO',
    roleText: 'CEO',
    roleSource: 'title',
    linkedinUrl: 'https://www.linkedin.com/in/anna-kowalska',
    slug: 'anna-kowalska',
    match: 'title',
    query: '"Sklep" (founder OR CEO) linkedin.com/in',
    evidence: 'Anna Kowalska - CEO - Sklep | LinkedIn',
    ...overrides,
  };
}

function buildWith(pages: ScrapedPage[], people: SerpPerson[], domain = 'sklep.pl') {
  return buildContactCandidates(collectStoreContacts(pages, domain), domain, people);
}

test('a searched person becomes a contact when the storefront named nobody', () => {
  const [row] = buildWith([page({ mailtos: ['info@sklep.pl'] })], [serp()]);

  assert.equal(row?.name, 'Anna Kowalska');
  assert.equal(row?.role, 'CEO');
  assert.equal(row?.source, 'linkedin_serp');
  assert.equal(row?.linkedinUrl, 'https://www.linkedin.com/in/anna-kowalska');
  assert.equal(row?.email, null);
  assert.match(row?.evidence ?? '', /web search/);
});

test('a searched person never outscores one the storefront asserted', () => {
  const searched = buildWith([page()], [serp()])[0];
  const asserted = build([
    page({ text: 'Sklep prowadzi Anna Nowak, założycielka.', mailtos: ['a.nowak@sklep.pl'] }),
  ])[0];

  assert.ok(searched);
  assert.ok(asserted);
  // A shop asserting who runs it is evidence; a search returning a profile that
  // mentions the shop is a suggestion, and the two must not read alike.
  assert.ok(
    searched.confidence < asserted.confidence,
    `${searched.confidence} should be under ${asserted.confidence}`,
  );
  assert.ok(searched.confidence <= 0.5);
});

test('a search hit for somebody already named merges into that row', () => {
  const result = buildWith(
    [page({ text: 'Sklep prowadzi Anna Kowalska, założycielka.' })],
    [serp()],
  );

  // One person, not two: the search supplied the profile link that row lacked.
  assert.equal(result.filter((row) => row.name === 'Anna Kowalska').length, 1);
  assert.equal(result[0]?.source, 'about_page');
  assert.equal(result[0]?.linkedinUrl, 'https://www.linkedin.com/in/anna-kowalska');
});

test('the merge is indifferent to diacritics and case', () => {
  const result = buildWith(
    [page({ text: 'Sklep prowadzi Anna Kowalską, założycielka.' })],
    [serp({ name: 'Anna Kowalska' })],
  );

  assert.equal(result.filter((row) => row.name !== null).length, 1);
});

test('a LinkedIn profile the shop links itself is not replaced by a searched one', () => {
  const result = buildWith(
    [
      page({
        text: 'Sklep prowadzi Anna Kowalska, założycielka.',
        html: '<a href="https://linkedin.com/in/anna-k-sklep">A</a>',
      }),
    ],
    [serp()],
  );

  assert.equal(result[0]?.linkedinUrl, 'https://www.linkedin.com/in/anna-k-sklep');
});

test('a headline supplies the title an About page left out', () => {
  const result = buildWith(
    [page({ text: 'Za sklepem stoi Anna Kowalska.' })],
    [serp({ role: 'Founder', roleText: 'Founder' })],
  );

  assert.equal(result[0]?.name, 'Anna Kowalska');
  assert.equal(result[0]?.role, 'Founder');
});

test('a searched person is scored from the weights, not from a constant', () => {
  const w = CONFIDENCE_WEIGHTS;
  const person = serp();

  assert.equal(
    scoreContact({ serp: person, storeDomain: 'sklep.pl' }),
    w.serpBase + w.hasRole + w.linkedinProfile,
  );
  // `anna-kowalska` says nothing about the shop; a slug carrying a distinctive
  // brand does. `sklep` would not count — it is the Polish for "shop".
  assert.equal(
    scoreContact({
      serp: serp({ slug: 'anna-maxtondesign' }),
      storeDomain: 'maxtondesign.com',
    }),
    w.serpBase + w.hasRole + w.linkedinProfile + w.brandMatch,
  );
  assert.equal(
    scoreContact({ serp: serp({ slug: 'anna-sklep' }), storeDomain: 'sklep.pl' }),
    w.serpBase + w.hasRole + w.linkedinProfile,
  );
  assert.equal(
    scoreContact({ serp: serp({ role: null }), storeDomain: 'sklep.pl' }),
    w.serpBase + w.linkedinProfile,
  );
});

test('searched people sort under storefront contacts of the same seniority', () => {
  const result = buildWith(
    [page({ text: 'Sklep prowadzi Jan Nowak, prezes zarządu.', mailtos: ['j.nowak@sklep.pl'] })],
    [serp({ name: 'Anna Kowalska', role: 'CEO' })],
  );

  assert.deepEqual(
    result.map((row) => [row.name, row.source]),
    [
      ['Jan Nowak', 'about_page'],
      ['Anna Kowalska', 'linkedin_serp'],
    ],
  );
});

test('a company page the search found is kept when nobody else has a link', () => {
  const result = buildContactCandidates(
    collectStoreContacts([page({ mailtos: ['info@sklep.pl'] })], 'sklep.pl'),
    'sklep.pl',
    [],
    { url: 'https://www.linkedin.com/company/sklep-pl', kind: 'company', slug: 'sklep-pl' },
  );

  const link = result.find((row) => row.linkedinUrl !== null);
  assert.equal(link?.linkedinUrl, 'https://www.linkedin.com/company/sklep-pl');
  assert.equal(link?.source, 'linkedin_serp');
  assert.match(link?.evidence ?? '', /web search/);
});

test('the shop’s own company link wins over the one a search found', () => {
  const result = buildContactCandidates(
    collectStoreContacts(
      [page({ html: '<a href="https://www.linkedin.com/company/from-footer">x</a>' })],
      'sklep.pl',
    ),
    'sklep.pl',
    [],
    { url: 'https://www.linkedin.com/company/from-search', kind: 'company', slug: 'from-search' },
  );

  assert.equal(result[0]?.linkedinUrl, 'https://www.linkedin.com/company/from-footer');
  assert.equal(result[0]?.source, 'footer');
});

test('a company page is not added when a person already carries a profile', () => {
  const result = buildContactCandidates(
    collectStoreContacts(
      [page({ text: 'Sklep prowadzi Anna Kowalska, założycielka.' })],
      'sklep.pl',
    ),
    'sklep.pl',
    [serp()],
    { url: 'https://www.linkedin.com/company/sklep-pl', kind: 'company', slug: 'sklep-pl' },
  );

  assert.equal(result.filter((row) => row.linkedinUrl !== null).length, 1);
  assert.equal(result[0]?.linkedinUrl, 'https://www.linkedin.com/in/anna-kowalska');
});
