import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandName, buildContactQueries, LINKEDIN_DOMAIN } from './queries.js';

test('a name that says more than the domain is kept, spacing included', () => {
  // "Evelinecosmetics" is a string nobody writes; the phrase is what a LinkedIn
  // headline actually contains, and quoting it is the point of the template.
  assert.equal(
    brandName({ domain: 'evelinecosmetics.com', name: 'Eveline Cosmetics' }),
    'Eveline Cosmetics',
  );
  assert.equal(brandName({ domain: 'sklepanna.pl', name: 'Sklep Anna' }), 'Sklep Anna');
});

test('a name that only restates the domain falls back to the de-slugged label', () => {
  assert.equal(brandName({ domain: 'sklep.pl', name: 'sklep.pl' }), 'Sklep');
  assert.equal(brandName({ domain: 'keyshorts.com', name: 'Keyshorts' }), 'Keyshorts');
  assert.equal(brandName({ domain: 'sklep-anna.pl', name: null }), 'Sklep Anna');
  assert.equal(brandName({ domain: 'www.perillalingerie.com' }), 'Perillalingerie');
});

test('the LinkedIn templates restrict by filter and quote the brand', () => {
  const queries = buildContactQueries({
    domain: 'sklepanna.pl',
    name: 'Sklep Anna',
    country: 'PL',
  });
  const profile = queries.find((q) => q.kind === 'linkedin_profile');

  assert.ok(profile);
  assert.match(profile.query, /"Sklep Anna"/);
  assert.deepEqual(profile.allowedDomains, [LINKEDIN_DOMAIN]);
  // The host is a filter; the path prefix cannot be, so it stays in the text.
  assert.match(profile.query, /linkedin\.com\/in/);
  assert.doesNotMatch(profile.query, /site:/);
});

test('a Polish shop is searched in Polish as well as English', () => {
  const [profile] = buildContactQueries({ domain: 'sklep.pl', name: 'Sklep', country: 'PL' });

  assert.ok(profile);
  for (const term of ['founder', 'CEO', 'owner', 'założyciel', 'właściciel', 'prezes']) {
    assert.match(profile.query, new RegExp(term, 'i'), `missing ${term}`);
  }
});

test('a shop outside the known markets gets the English terms only', () => {
  const [profile] = buildContactQueries({ domain: 'shop.de', name: 'Shop', country: 'DE' });

  assert.ok(profile);
  assert.match(profile.query, /founder/);
  assert.doesNotMatch(profile.query, /założyciel/);
});

test('the second template searches the bare domain, which profiles list verbatim', () => {
  const queries = buildContactQueries({ domain: 'https://www.sklep.pl/', name: 'Sklep Anna' });
  const byDomain = queries.find((q) => q.kind === 'linkedin_company');

  assert.ok(byDomain);
  assert.match(byDomain.query, /"sklep\.pl"/);
  assert.deepEqual(byDomain.allowedDomains, [LINKEDIN_DOMAIN]);
});

test('the open-web template carries no domain filter', () => {
  const openWeb = buildContactQueries({ domain: 'sklep.pl' }).find((q) => q.kind === 'open_web');

  assert.ok(openWeb);
  assert.equal(openWeb.allowedDomains, undefined);
});

test('quotes inside a shop name cannot break out of the quoted phrase', () => {
  const [profile] = buildContactQueries({ domain: 'sklep.pl', name: 'Anna "Ania" Kowalska' });

  assert.ok(profile);
  assert.match(profile.query, /"Anna Ania Kowalska"/);
  assert.equal(profile.query.split('"').length - 1, 2);
});
