import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../browser.js';
import { html } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import {
  checkCollectionCards,
  gradeCollection,
  PRODUCTS_NEEDING_PAGINATION,
  PRODUCTS_NEEDING_TOOLS,
  readCollection,
  runCollectionChecks,
  type CardFacts,
} from './collection.js';
import type { CheckContext } from './context.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

function card(
  n: number,
  options: { price?: string; image?: boolean; soldOut?: boolean } = {},
): string {
  const { price = '129,00 zł', image = true, soldOut = false } = options;
  return `<li class="product-card" id="card-${n}">
    ${image ? `<img src="/p${n}.png" alt="Produkt ${n}">` : ''}
    <a href="/products/produkt-${n}">Produkt ${n}</a>
    ${price ? `<span class="price">${price}</span>` : ''}
    ${soldOut ? '<span class="badge">Wyprzedane</span>' : ''}
  </li>`;
}

function grid(count: number, extras = '', cardOptions: Parameters<typeof card>[1] = {}): string {
  const cards = Array.from({ length: count }, (_, i) => card(i + 1, cardOptions)).join('');
  return html(`<main>${extras}<ul class="grid">${cards}</ul></main>`);
}

const TOOLS = `
  <div class="facets"><input type="checkbox" name="filter.v.price"></div>
  <select name="sort_by"><option>Cena</option></select>
  <nav class="pagination"><a href="?page=2">2</a></nav>
  <button class="quick-add">Szybki zakup</button>`;

async function factsFor(body: string, viewport: 'desktop' | 'mobile' = 'desktop') {
  const fixture = await openFixturePage(
    browser,
    { '/': { body } },
    { target: 'collection', viewport },
  );
  try {
    return { facts: await readCollection(fixture.ctx) };
  } finally {
    await fixture.close();
  }
}

test('reads the cards, their images and their prices', async () => {
  const { facts } = await factsFor(grid(3, TOOLS));
  assert.equal(facts.total, 3);
  assert.equal(facts.withImage, 3);
  assert.equal(facts.withPrice, 3);
  assert.equal(facts.soldOut, 0);
  assert.deepEqual(
    [facts.hasFilters, facts.hasSorting, facts.hasPagination, facts.hasQuickAdd],
    [true, true, true, true],
  );
});

test('a price written only as text is still a price', async () => {
  const body = html(`<ul><li><a href="/products/x">But</a><div>1 299,00 zł</div></li></ul>`);
  const { facts } = await factsFor(body);
  assert.equal(facts.withPrice, 1);
});

test('cards missing a price are named', async () => {
  const body = html(`<ul>
    <li id="a"><a href="/products/a">A</a><span class="price">10,00 zł</span></li>
    <li id="b"><a href="/products/b">B</a></li>
  </ul>`);
  const { facts } = await factsFor(body);
  assert.equal(facts.withPrice, 1);
  assert.deepEqual(facts.missingPrice, ['#b']);
});

test('sold-out badges are counted', async () => {
  const { facts } = await factsFor(grid(2, TOOLS, { soldOut: true }));
  assert.equal(facts.soldOut, 2);
});

test('an empty collection is critical and nothing else is reported', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: html('<main><p>Brak produktów w tej kolekcji</p></main>') } },
    { target: 'collection' },
  );
  try {
    const issues = await checkCollectionCards(fixture.ctx);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'CRITICAL');
    assert.equal(issues[0]!.title, 'Collection page shows no products');
  } finally {
    await fixture.close();
  }
});

test('a well-built collection raises nothing', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: grid(4, TOOLS) } },
    { target: 'collection' },
  );
  try {
    assert.deepEqual(await checkCollectionCards(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

const baseFacts = (overrides: Partial<CardFacts> = {}): CardFacts => ({
  total: 4,
  withImage: 4,
  withPrice: 4,
  withTitle: 4,
  soldOut: 0,
  missingPrice: [],
  hasFilters: true,
  hasSorting: true,
  hasPagination: true,
  hasQuickAdd: true,
  ...overrides,
});

const ctxStub = { url: 'https://sklep.pl/collections/buty', viewport: 'desktop' } as CheckContext;

test('missing images and prices are separate findings', () => {
  const issues = gradeCollection(
    baseFacts({ withImage: 2, withPrice: 3, missingPrice: ['#card-4'] }),
    ctxStub,
  );
  assert.deepEqual(
    issues.map((i) => i.title),
    ['Product cards without an image', 'Product cards without a price'],
  );
  assert.match(issues[0]!.detail!, /2 of 4 cards/);
  assert.equal(issues[1]!.evidence[0]!.selector, '#card-4');
});

test('a fully sold-out collection is reported', () => {
  const issues = gradeCollection(baseFacts({ soldOut: 4 }), ctxStub);
  assert.deepEqual(
    issues.map((i) => i.title),
    ['Every product in the collection is sold out'],
  );
});

test('filters and sorting are only expected on a long list', () => {
  const short = gradeCollection(
    baseFacts({ total: 6, withImage: 6, withPrice: 6, hasFilters: false, hasSorting: false }),
    ctxStub,
  );
  assert.deepEqual(short, []);

  const long = gradeCollection(
    baseFacts({
      total: PRODUCTS_NEEDING_TOOLS,
      withImage: PRODUCTS_NEEDING_TOOLS,
      withPrice: PRODUCTS_NEEDING_TOOLS,
      hasFilters: false,
      hasSorting: false,
    }),
    ctxStub,
  );
  assert.deepEqual(
    long.map((i) => i.title),
    ['No filters on a long product list', 'No sorting on a long product list'],
  );
});

test('a full page without pagination hides the rest of the catalogue', () => {
  const issues = gradeCollection(
    baseFacts({
      total: PRODUCTS_NEEDING_PAGINATION,
      withImage: PRODUCTS_NEEDING_PAGINATION,
      withPrice: PRODUCTS_NEEDING_PAGINATION,
      hasPagination: false,
    }),
    ctxStub,
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['No pagination on a full collection page', 'MAJOR']],
  );
});

test('quick add is expected on every listing', () => {
  const issues = gradeCollection(baseFacts({ hasQuickAdd: false }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['No quick add to cart on the listing', 'MINOR']],
  );
});

test('the suite covers the technical checks too', async () => {
  const fixture = await openFixturePage(
    browser,
    {
      '/': { body: grid(4, `${TOOLS}<script>null.boom()</script>`) },
      ...Object.fromEntries(
        [1, 2, 3, 4].map((n) => [`/p${n}.png`, { contentType: 'image/png', body: PNG }]),
      ),
    },
    { target: 'collection' },
  );
  try {
    const suite = await runCollectionChecks(fixture.ctx);
    assert.deepEqual(
      suite.outcomes.map((o) => o.name),
      [
        'collection.load_time',
        'collection.js_errors',
        'collection.failed_resources',
        'collection.images',
        'collection.cards',
      ],
    );
    assert.equal(suite.partial, false);
    assert.deepEqual(
      suite.issues.map((i) => i.title),
      ['JavaScript errors break the page'],
    );
    assert.equal(suite.issues[0]!.page, 'collection');
  } finally {
    await fixture.close();
  }
});

test('cards are found on a mobile viewport as well', async () => {
  const { facts } = await factsFor(grid(3, TOOLS), 'mobile');
  assert.equal(facts.total, 3);
});
