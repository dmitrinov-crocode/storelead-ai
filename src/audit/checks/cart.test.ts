import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../browser.js';
import { AuditSession } from '../session.js';
import { silentLogger } from '../../lib/logger.js';
import { startFixtureServer } from '../testing/fixtureServer.js';
import { createShopFixture, type ShopFlags } from '../testing/shopFixture.js';
import {
  addToCart,
  changeQuantity,
  gradeCart,
  goToCheckout,
  readCart,
  readCartState,
  removeFromCart,
  runCartChecks,
  type CartFlowResult,
} from './cart.js';
import type { CheckContext } from './context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

interface OpenShop {
  session: AuditSession;
  page: Page;
  ctx: CheckContext;
  origin: string;
  quantity: () => number;
  close: () => Promise<void>;
}

async function openShop(flags: ShopFlags = {}): Promise<OpenShop> {
  const shop = createShopFixture(flags);
  const server = await startFixtureServer(shop.routes);
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });
  const page = await session.newPage('desktop');

  const ctx: CheckContext = {
    page,
    session,
    url: `${server.url}/cart`,
    target: 'cart',
    viewport: 'desktop',
    observations: {
      consoleErrors: [],
      failedRequests: [],
      httpErrors: [],
      requestCount: 0,
      truncated: false,
    },
    navigationMs: 100,
    logger: silentLogger(),
  };

  return {
    session,
    page,
    ctx,
    origin: server.url,
    quantity: shop.quantity,
    close: async () => {
      await session.close();
      await server.close();
    },
  };
}

test('the cart starts empty and the add-to-cart button fills it', async () => {
  const shop = await openShop();
  try {
    assert.deepEqual(await readCartState(shop.session, shop.page, shop.origin), {
      itemCount: 0,
      totalPrice: 0,
    });

    const result = await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    assert.equal(result.clicked, true);
    assert.equal(result.before, 0);
    assert.equal(result.after, 1);
    assert.equal(result.added, true);
    assert.equal(shop.quantity(), 1, 'the shop really received the item');
  } finally {
    await shop.close();
  }
});

test('a button that does nothing is caught by reading the cart, not the DOM', async () => {
  const shop = await openShop({ brokenAddToCart: true });
  try {
    const result = await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    assert.equal(result.clicked, true, 'the button exists and was clickable');
    assert.equal(result.added, false, 'but nothing reached the cart');
    assert.equal(shop.quantity(), 0);
  } finally {
    await shop.close();
  }
});

test('a product page without an add control is reported, not thrown', async () => {
  const shop = await openShop();
  try {
    const result = await addToCart(shop.session, shop.page, `${shop.origin}/collections/all`);
    assert.equal(result.clicked, false);
    assert.equal(result.error, 'no add-to-cart control');
  } finally {
    await shop.close();
  }
});

test('reads the cart controls of a filled cart', async () => {
  const shop = await openShop();
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const facts = await readCart(shop.page);
    assert.equal(facts.hasLines, true);
    assert.equal(facts.hasQuantityControl, true);
    assert.equal(facts.hasRemoveControl, true);
    assert.equal(facts.hasShippingEstimate, true);
    assert.equal(facts.hasCheckoutButton, true);
  } finally {
    await shop.close();
  }
});

test('missing cart controls are each detected', async () => {
  const shop = await openShop({
    noQuantityControl: true,
    noRemoveControl: true,
    noCheckoutButton: true,
  });
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const facts = await readCart(shop.page);
    assert.equal(facts.hasLines, true);
    assert.equal(facts.hasQuantityControl, false);
    assert.equal(facts.hasRemoveControl, false);
    assert.equal(facts.hasCheckoutButton, false);
  } finally {
    await shop.close();
  }
});

test('changing the quantity through the UI updates the real cart', async () => {
  const shop = await openShop();
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const result = await changeQuantity(shop.session, shop.page, shop.origin);
    assert.equal(result.attempted, true);
    assert.equal(result.before, 1);
    assert.equal(result.after, 2);
    assert.equal(result.changed, true);
    assert.equal(shop.quantity(), 2);
  } finally {
    await shop.close();
  }
});

test('a cart with no quantity input reports the attempt as not made', async () => {
  const shop = await openShop({ noQuantityControl: true });
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const result = await changeQuantity(shop.session, shop.page, shop.origin);
    assert.equal(result.attempted, false);
    assert.equal(result.changed, false);
  } finally {
    await shop.close();
  }
});

test('removing empties the cart, leaving the shop as it was found', async () => {
  const shop = await openShop();
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const result = await removeFromCart(shop.session, shop.page, shop.origin);
    assert.equal(result.attempted, true);
    assert.equal(result.before, 1);
    assert.equal(result.after, 0);
    assert.equal(result.removed, true);
    assert.equal(shop.quantity(), 0);
  } finally {
    await shop.close();
  }
});

test('the checkout button is followed exactly one step', async () => {
  const shop = await openShop();
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const result = await goToCheckout(shop.session, shop.page);
    assert.equal(result.clicked, true);
    assert.equal(result.reachedCheckout, true);
    assert.match(result.url!, /\/checkout/);
    assert.equal(shop.quantity(), 1, 'no order is placed: the cart is untouched');
  } finally {
    await shop.close();
  }
});

test('a cart without a checkout button reports no click', async () => {
  const shop = await openShop({ noCheckoutButton: true });
  try {
    await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    await shop.session.goto(shop.page, `${shop.origin}/cart`);

    const result = await goToCheckout(shop.session, shop.page);
    assert.deepEqual(result, { clicked: false, url: null, reachedCheckout: false });
  } finally {
    await shop.close();
  }
});

const ctxStub = { url: 'https://sklep.pl/cart', viewport: 'desktop' } as CheckContext;

const flow = (overrides: Partial<CartFlowResult> = {}): CartFlowResult => ({
  add: { clicked: true, before: 0, after: 1, added: true, error: null },
  facts: {
    itemCount: 1,
    hasLines: true,
    hasQuantityControl: true,
    hasRemoveControl: true,
    hasDiscountField: false,
    hasShippingEstimate: true,
    hasCheckoutButton: true,
  },
  quantity: { attempted: true, before: 1, after: 2, changed: true },
  remove: { attempted: true, before: 2, after: 0, removed: true },
  checkout: { clicked: true, url: 'https://sklep.pl/checkouts/1', reachedCheckout: true },
  ...overrides,
});

test('a working cart raises nothing', () => {
  assert.deepEqual(gradeCart(flow(), ctxStub), []);
});

test('a broken add to cart is critical and stops the grading', () => {
  const issues = gradeCart(
    flow({
      add: { clicked: true, before: 0, after: 0, added: false, error: null },
      facts: {
        itemCount: 0,
        hasLines: false,
        hasQuantityControl: false,
        hasRemoveControl: false,
        hasDiscountField: false,
        hasShippingEstimate: false,
        hasCheckoutButton: false,
      },
    }),
    ctxStub,
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Adding to cart does not work', 'CRITICAL']],
    'nothing downstream can be judged with an empty cart',
  );
  assert.equal(issues[0]!.evidence[0]!.actual, '0 → 0 items');
});

test('controls that exist but do nothing are graded apart from missing ones', () => {
  const missing = gradeCart(
    flow({
      facts: { ...flow().facts, hasQuantityControl: false, hasRemoveControl: false },
    }),
    ctxStub,
  );
  assert.deepEqual(
    missing.map((i) => i.title),
    ['Quantity cannot be changed in the cart', 'Items cannot be removed from the cart'],
  );

  const inert = gradeCart(
    flow({
      quantity: { attempted: true, before: 1, after: 1, changed: false },
      remove: { attempted: true, before: 1, after: 1, removed: false },
    }),
    ctxStub,
  );
  assert.deepEqual(
    inert.map((i) => i.title),
    ['Changing the quantity has no effect', 'Removing an item has no effect'],
  );
});

test('a cart page that hides the added item is critical', () => {
  const issues = gradeCart(flow({ facts: { ...flow().facts, hasLines: false } }), ctxStub);
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Cart page does not show the added item', 'CRITICAL']],
  );
});

test('a missing delivery estimate is a minor CRO finding', () => {
  const issues = gradeCart(
    flow({ facts: { ...flow().facts, hasShippingEstimate: false } }),
    ctxStub,
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['No delivery cost shown in the cart', 'MINOR']],
  );
});

test('a checkout button that leads nowhere is critical', () => {
  const missing = gradeCart(
    flow({ facts: { ...flow().facts, hasCheckoutButton: false } }),
    ctxStub,
  );
  assert.deepEqual(
    missing.map((i) => i.title),
    ['No checkout button in the cart'],
  );

  const stuck = gradeCart(
    flow({ checkout: { clicked: true, url: 'https://sklep.pl/cart', reachedCheckout: false } }),
    ctxStub,
  );
  assert.deepEqual(
    stuck.map((i) => [i.title, i.severity]),
    [['Checkout button does not reach the checkout', 'CRITICAL']],
  );
});

test('the whole flow runs end to end on a working shop and leaves it clean', async () => {
  const shop = await openShop();
  try {
    const { suite, result } = await runCartChecks(shop.ctx, {
      productUrl: `${shop.origin}/products/but`,
    });

    assert.deepEqual(
      suite.outcomes.map((o) => [o.name, o.status]),
      [['cart.flow', 'ok']],
    );
    assert.deepEqual(suite.issues, []);
    assert.equal(result!.add.added, true);
    assert.equal(result!.quantity.changed, true);
    assert.equal(result!.checkout.reachedCheckout, true);
    assert.equal(result!.remove.removed, true);
    assert.equal(shop.quantity(), 0, 'the audit cleans up after itself');
  } finally {
    await shop.close();
  }
});

test('the whole flow on a broken shop reports the blocker', async () => {
  const shop = await openShop({ brokenAddToCart: true });
  try {
    const { suite, result } = await runCartChecks(shop.ctx, {
      productUrl: `${shop.origin}/products/but`,
    });

    assert.deepEqual(
      suite.issues.map((i) => i.title),
      ['Adding to cart does not work'],
    );
    assert.equal(result!.checkout.clicked, false, 'no point checking out an empty cart');
  } finally {
    await shop.close();
  }
});

test('a shop without /cart.js falls back to reporting unknown counts', async () => {
  const shop = await openShop({ noCartApi: true });
  try {
    const state = await readCartState(shop.session, shop.page, shop.origin);
    assert.deepEqual(state, { itemCount: null, totalPrice: null });

    const result = await addToCart(shop.session, shop.page, `${shop.origin}/products/but`);
    assert.equal(result.clicked, true);
    assert.equal(result.added, false, 'without ground truth the add cannot be confirmed');
  } finally {
    await shop.close();
  }
});

test('an unverifiable cart produces no finding rather than a guess', () => {
  const issues = gradeCart(
    flow({
      add: { clicked: true, before: null, after: null, added: false, error: null },
      facts: {
        itemCount: null,
        hasLines: false,
        hasQuantityControl: false,
        hasRemoveControl: false,
        hasDiscountField: false,
        hasShippingEstimate: false,
        hasCheckoutButton: false,
      },
    }),
    ctxStub,
  );
  assert.deepEqual(issues, [], 'no ground truth means no claim');
});
