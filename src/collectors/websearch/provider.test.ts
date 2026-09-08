import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchBudget, urlKey } from './provider.js';

test('urlKey ignores the spellings that make the same page look like two', () => {
  const canonical = urlKey('https://www.linkedin.com/in/anna-kowalska');

  assert.equal(urlKey('https://linkedin.com/in/anna-kowalska'), canonical);
  // A country subdomain is how Google returns a Polish profile and is not how
  // the citation spells it. Keyed strictly, every Polish hit would be dropped.
  assert.equal(urlKey('https://pl.linkedin.com/in/anna-kowalska'), canonical);
  assert.equal(canonical, 'linkedin.com/in/anna-kowalska');
  assert.equal(urlKey('https://www.linkedin.com/in/anna-kowalska/'), canonical);
  assert.equal(urlKey('https://www.linkedin.com/in/Anna-Kowalska'), canonical);
  // The query string is where LinkedIn puts locale and tracking; dropping it is
  // what lets a cited URL match the one the search actually visited.
  assert.equal(urlKey('https://www.linkedin.com/in/anna-kowalska?originalSubdomain=pl'), canonical);
  assert.equal(urlKey('https://www.linkedin.com/in/anna-kowalska#about'), canonical);
});

test('only the named hosts lose their country subdomain', () => {
  // A blanket "strip any two-letter label" rule would make these one page.
  assert.notEqual(
    urlKey('https://de.wikipedia.org/wiki/Berlin'),
    urlKey('https://en.wikipedia.org/wiki/Berlin'),
  );
  assert.equal(urlKey('https://pl.sklep.com/o-nas'), 'pl.sklep.com/o-nas');
});

test('urlKey refuses anything that is not an http(s) URL', () => {
  assert.equal(urlKey('linkedin.com/in/anna'), null);
  assert.equal(urlKey('mailto:anna@sklep.pl'), null);
  assert.equal(urlKey('javascript:alert(1)'), null);
  assert.equal(urlKey(''), null);
});

test('the budget stops the run at its ceiling', () => {
  const budget = new SearchBudget({ maxSearches: 2 });

  assert.equal(budget.reason, null);
  assert.equal(budget.reserve(), true);
  assert.equal(budget.reserve(), true);
  assert.equal(budget.reserve(), false);
  assert.equal(budget.used, 2);
  assert.equal(budget.remaining, 0);
  assert.match(budget.reason ?? '', /budget spent/);
});

test('a zero budget refuses the first search rather than allowing one', () => {
  const budget = new SearchBudget({ maxSearches: 0 });
  assert.equal(budget.reserve(), false);
  assert.equal(budget.used, 0);
});
