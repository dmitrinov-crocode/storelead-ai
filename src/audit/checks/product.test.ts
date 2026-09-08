import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../browser.js';
import { html } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import {
  checkProductPage,
  gradeProduct,
  MIN_DESCRIPTION_CHARS,
  readProduct,
  runProductChecks,
  type ProductFacts,
} from './product.js';
import type { CheckContext } from './context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

const DESCRIPTION = 'Wygodne buty ze skóry naturalnej, ręcznie szyte w Polsce. '.repeat(4);

const COMPLETE_PRODUCT = html(`
<main>
  <div class="product-media">
    <img src="/1.png" alt="Front"><img src="/2.png" alt="Bok"><img src="/3.png" alt="Tył">
  </div>
  <h1>Buty skórzane</h1>
  <span class="price">349,00 zł</span>
  <form action="/cart/add" method="post">
    <select name="id"><option value="1">40</option><option value="2">41</option></select>
    <input name="quantity" type="number" value="1">
    <button name="add" type="submit">Dodaj do koszyka</button>
  </form>
  <div class="shopify-payment-button"><button>Kup teraz</button></div>
  <div class="product__description">${DESCRIPTION}</div>
  <div class="jdgm-widget">Opinie klientów: 4.8/5</div>
  <p>Darmowa dostawa od 200 zł. Zwrot w ciągu 30 dni.</p>
  <section class="related"><a href="/products/inny-but">Inny but</a></section>
</main>`);

async function factsFor(body: string, viewport: 'desktop' | 'mobile' = 'desktop') {
  const fixture = await openFixturePage(
    browser,
    { '/': { body } },
    { target: 'product', viewport },
  );
  try {
    return await readProduct(fixture.ctx);
  } finally {
    await fixture.close();
  }
}

test('reads a complete product page', async () => {
  const facts = await factsFor(COMPLETE_PRODUCT);
  assert.equal(facts.hasCartForm, true);
  assert.equal(facts.addToCart.present, true);
  assert.equal(facts.addToCart.enabled, true);
  assert.match(facts.addToCart.text!, /Dodaj do koszyka/);
  assert.equal(facts.buyNow, true);
  assert.equal(facts.hasPrice, true);
  assert.equal(facts.priceText, '349,00 zł');
  assert.equal(facts.images, 3);
  assert.equal(facts.hasVariantControl, true);
  assert.equal(facts.variantOptions, 2);
  assert.equal(facts.hasQuantity, true);
  assert.ok(facts.descriptionChars > MIN_DESCRIPTION_CHARS);
  assert.equal(facts.hasReviews, true);
  assert.equal(facts.hasShippingInfo, true);
  assert.equal(facts.hasReturnsInfo, true);
  assert.equal(facts.relatedProducts, 1);
  assert.equal(facts.soldOut, false);
});

test('a complete product page raises nothing', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: COMPLETE_PRODUCT } },
    { target: 'product' },
  );
  try {
    assert.deepEqual(await checkProductPage(fixture.ctx), []);
  } finally {
    await fixture.close();
  }
});

test('a page with no cart form at all is read as unbuyable', async () => {
  const facts = await factsFor(html('<main><h1>Buty</h1><p>349,00 zł</p></main>'));
  assert.equal(facts.hasCartForm, false);
  assert.equal(facts.addToCart.present, false);
});

test('an add-to-cart button outside a cart form is still found by its label', async () => {
  const facts = await factsFor(html('<main><button>Dodaj do koszyka</button></main>'));
  assert.equal(facts.addToCart.present, true);
  assert.equal(facts.addToCart.enabled, true);
});

test('a disabled add-to-cart button is detected', async () => {
  const facts = await factsFor(
    html('<form action="/cart/add"><button name="add" disabled>Dodaj do koszyka</button></form>'),
  );
  assert.equal(facts.addToCart.present, true);
  assert.equal(facts.addToCart.enabled, false);
});

test('a sold-out product is recognised', async () => {
  const facts = await factsFor(
    html(`<main><p>Wyprzedane</p>
      <form action="/cart/add"><button name="add" disabled>Niedostępny</button></form></main>`),
  );
  assert.equal(facts.soldOut, true);
  assert.equal(facts.addToCart.enabled, false);
});

test('a price written as plain text is found', async () => {
  const facts = await factsFor(html('<main><h1>Buty</h1><div>1 299,00 zł</div></main>'));
  assert.equal(facts.hasPrice, true);
});

const baseFacts = (overrides: Partial<ProductFacts> = {}): ProductFacts => ({
  hasCartForm: true,
  addToCart: { present: true, enabled: true, text: 'Dodaj do koszyka' },
  buyNow: true,
  hasPrice: true,
  priceText: '349,00 zł',
  images: 3,
  hasVariantControl: true,
  variantOptions: 2,
  variantControlDisabled: false,
  hasQuantity: true,
  descriptionChars: 400,
  hasReviews: true,
  hasShippingInfo: true,
  hasReturnsInfo: true,
  relatedProducts: 3,
  soldOut: false,
  ...overrides,
});

const ctxStub = { url: 'https://sklep.pl/products/but', viewport: 'desktop' } as CheckContext;

test('a missing add-to-cart button is critical', () => {
  const issues = gradeProduct(
    baseFacts({ addToCart: { present: false, enabled: false, text: null } }),
    ctxStub,
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['No add to cart button', 'CRITICAL']],
  );
});

test('a disabled button is critical only when the product is in stock', () => {
  const inStock = gradeProduct(
    baseFacts({ addToCart: { present: true, enabled: false, text: 'Dodaj' } }),
    ctxStub,
  );
  assert.deepEqual(
    inStock.map((i) => i.title),
    ['Add to cart button is disabled'],
  );

  const soldOut = gradeProduct(
    baseFacts({ addToCart: { present: true, enabled: false, text: 'Wyprzedane' }, soldOut: true }),
    ctxStub,
  );
  assert.deepEqual(soldOut, [], 'a sold-out product is a fact, not a defect');
});

test('a missing price is critical', () => {
  const issues = gradeProduct(baseFacts({ hasPrice: false, priceText: null }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Product page shows no price', 'CRITICAL']],
  );
});

test('photos: none is major, one is minor, several are fine', () => {
  assert.deepEqual(
    gradeProduct(baseFacts({ images: 0 }), ctxStub).map((i) => [i.title, i.severity]),
    [['Product page has no photo', 'MAJOR']],
  );
  assert.deepEqual(
    gradeProduct(baseFacts({ images: 1 }), ctxStub).map((i) => [i.title, i.severity]),
    [['Only one product photo', 'MINOR']],
  );
  assert.deepEqual(gradeProduct(baseFacts({ images: 2 }), ctxStub), []);
});

test('a disabled variant control is a major finding', () => {
  const issues = gradeProduct(baseFacts({ variantControlDisabled: true }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Variant selection is disabled', 'MAJOR']],
  );
});

test('a missing description is graded by whether there is any at all', () => {
  assert.match(
    gradeProduct(baseFacts({ descriptionChars: 0 }), ctxStub)[0]!.title,
    /No product description/,
  );
  const short = gradeProduct(baseFacts({ descriptionChars: MIN_DESCRIPTION_CHARS - 1 }), ctxStub);
  assert.match(short[0]!.title, /too short/);
  assert.equal(short[0]!.severity, 'MAJOR');
});

test('the reassurance items are each a minor finding', () => {
  const issues = gradeProduct(
    baseFacts({
      hasQuantity: false,
      buyNow: false,
      hasReviews: false,
      hasShippingInfo: false,
      hasReturnsInfo: false,
      relatedProducts: 0,
    }),
    ctxStub,
  );
  assert.deepEqual(
    issues.map((i) => i.title),
    [
      'No quantity selector',
      'No express checkout button',
      'No reviews or ratings',
      'No delivery information on the product page',
      'No returns information on the product page',
      'No related products or upsell',
    ],
  );
  assert.ok(issues.every((i) => i.severity === 'MINOR'));
  assert.ok(issues.every((i) => i.page === 'product'));
});

test('the checks also run on a mobile viewport', async () => {
  const facts = await factsFor(COMPLETE_PRODUCT, 'mobile');
  assert.equal(facts.addToCart.present, true);
  assert.equal(facts.images, 3);
});

test('the suite runs the technical checks alongside the page checks', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: html('<main><h1>But</h1></main>') } },
    { target: 'product' },
  );
  try {
    const suite = await runProductChecks(fixture.ctx);
    assert.deepEqual(
      suite.outcomes.map((o) => o.name),
      [
        'product.load_time',
        'product.js_errors',
        'product.failed_resources',
        'product.images',
        'product.page',
      ],
    );
    assert.equal(suite.partial, false);
    const titles = suite.issues.map((i) => i.title);
    assert.ok(titles.includes('No add to cart button'));
    assert.ok(titles.includes('Product page shows no price'));
  } finally {
    await fixture.close();
  }
});
