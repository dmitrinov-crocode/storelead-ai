import type { Page } from 'playwright';
import { CheckSuite } from '../checkRunner.js';
import { createIssue, type Issue } from '../issues.js';
import type { AuditSession } from '../session.js';
import type { CheckContext } from './context.js';

/**
 * Cart checks (task 2-13).
 *
 * This is the only part of the audit that changes anything on the shop: it adds
 * one item to its own throwaway session cart, changes the quantity, removes it
 * again and stops at the door of the checkout. Nothing is ordered — that limit
 * is enforced here and in task 2-14.
 */

const ADD_TO_CART_SELECTOR =
  'form[action*="/cart/add"] button[name="add"], form[action*="/cart/add"] button[type="submit"], button[name="add"]';
const ADD_TO_CART_TEXT = /do koszyka|add to (cart|bag)/i;
const CHECKOUT_SELECTOR =
  'button[name="checkout"], [name="checkout"], a[href*="/checkout"], form[action*="/checkout"] button';
const CHECKOUT_TEXT = /do kasy|zam[oó]wienie|checkout|kasa/i;
const REMOVE_SELECTOR =
  'a[href*="quantity=0"], cart-remove-button, [class*="cart-remove" i], [aria-label*="usu" i], [aria-label*="remove" i]';

/** How long the theme gets to talk to `/cart/add` before we read the cart. */
const CART_SETTLE_MS = 1200;

export interface CartState {
  /** Null when the shop exposes no `/cart.js` — then only the DOM can be read. */
  itemCount: number | null;
  totalPrice: number | null;
}

/**
 * Ground truth for what is in the cart. Shopify's `/cart.js` is a public, read-only
 * endpoint, and it says what the theme's own JavaScript would only imply.
 */
export async function readCartState(
  session: AuditSession,
  page: Page,
  origin: string,
): Promise<CartState> {
  await session.throttle();
  try {
    const response = await page.context().request.get(`${origin}/cart.js`, {
      timeout: session.pageTimeoutMs,
    });
    if (!response.ok()) return { itemCount: null, totalPrice: null };
    const body = (await response.json()) as { item_count?: number; total_price?: number };
    return {
      itemCount: typeof body.item_count === 'number' ? body.item_count : null,
      totalPrice: typeof body.total_price === 'number' ? body.total_price : null,
    };
  } catch {
    return { itemCount: null, totalPrice: null };
  }
}

export interface AddToCartResult {
  clicked: boolean;
  /** Items in the cart before and after the click. */
  before: number | null;
  after: number | null;
  added: boolean;
  error: string | null;
}

/** Clicks the real add-to-cart control on the product page and verifies the result. */
export async function addToCart(
  session: AuditSession,
  page: Page,
  productUrl: string,
): Promise<AddToCartResult> {
  const origin = new URL(productUrl).origin;
  const before = (await readCartState(session, page, origin)).itemCount;

  const visit = await session.goto(page, productUrl);
  if (visit.error) {
    return { clicked: false, before, after: before, added: false, error: visit.error.message };
  }

  let button = page.locator(ADD_TO_CART_SELECTOR).first();
  if (!(await button.isVisible({ timeout: 1000 }).catch(() => false))) {
    button = page.locator('button, [role="button"]').filter({ hasText: ADD_TO_CART_TEXT }).first();
  }
  if (!(await button.isVisible({ timeout: 1000 }).catch(() => false))) {
    return { clicked: false, before, after: before, added: false, error: 'no add-to-cart control' };
  }

  await session.throttle();
  try {
    await button.click({ timeout: session.pageTimeoutMs });
  } catch (error) {
    return {
      clicked: false,
      before,
      after: before,
      added: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // The theme may navigate, open a drawer or do nothing visible; the cart decides.
  await page.waitForTimeout(CART_SETTLE_MS);
  const after = (await readCartState(session, page, origin)).itemCount;

  return {
    clicked: true,
    before,
    after,
    added: before !== null && after !== null ? after > before : false,
    error: null,
  };
}

export interface CartFacts {
  itemCount: number | null;
  hasLines: boolean;
  hasQuantityControl: boolean;
  hasRemoveControl: boolean;
  /** Recorded but never reported: Shopify takes discount codes at checkout. */
  hasDiscountField: boolean;
  hasShippingEstimate: boolean;
  hasCheckoutButton: boolean;
}

export async function readCart(page: Page): Promise<Omit<CartFacts, 'itemCount'>> {
  return page.evaluate(
    (selectors) => {
      const checkoutRe = new RegExp(selectors.checkoutText, 'i');
      let hasCheckoutButton = document.querySelector(selectors.checkout) !== null;
      if (!hasCheckoutButton) {
        for (const candidate of Array.from(
          document.querySelectorAll('button, a, [role="button"]'),
        )) {
          if (checkoutRe.test((candidate.textContent ?? '').trim())) {
            hasCheckoutButton = true;
            break;
          }
        }
      }

      return {
        hasLines:
          document.querySelector(
            '[class*="cart-item" i], [class*="cart__item" i], tr[class*="item" i], [data-cart-item]',
          ) !== null,
        hasQuantityControl:
          document.querySelector(
            'input[name="quantity"], input[name^="updates"], quantity-input, [class*="quantity" i] input',
          ) !== null,
        hasRemoveControl: document.querySelector(selectors.remove) !== null,
        hasDiscountField:
          document.querySelector(
            'input[name="discount"], [id*="discount" i] input, [class*="discount" i] input, [id*="promo" i] input',
          ) !== null,
        hasShippingEstimate:
          document.querySelector(
            '[class*="shipping-calculator" i], [id*="shipping-calculator" i], [class*="shipping-estimate" i]',
          ) !== null,
        hasCheckoutButton,
      };
    },
    { checkout: CHECKOUT_SELECTOR, checkoutText: CHECKOUT_TEXT.source, remove: REMOVE_SELECTOR },
  );
}

export interface QuantityChangeResult {
  attempted: boolean;
  before: number | null;
  after: number | null;
  changed: boolean;
}

/** Sets the line quantity to 2 through the UI and checks the cart agreed. */
export async function changeQuantity(
  session: AuditSession,
  page: Page,
  origin: string,
): Promise<QuantityChangeResult> {
  const before = (await readCartState(session, page, origin)).itemCount;
  const input = page
    .locator('input[name="quantity"], input[name^="updates"], [class*="quantity" i] input')
    .first();

  if (!(await input.isVisible({ timeout: 1000 }).catch(() => false))) {
    return { attempted: false, before, after: before, changed: false };
  }

  await session.throttle();
  try {
    await input.fill('2', { timeout: 5000 });
    await input.press('Enter');
  } catch {
    return { attempted: true, before, after: before, changed: false };
  }

  await page.waitForTimeout(CART_SETTLE_MS);
  const after = (await readCartState(session, page, origin)).itemCount;
  return { attempted: true, before, after, changed: before !== after && after !== null };
}

export interface RemoveResult {
  attempted: boolean;
  before: number | null;
  after: number | null;
  removed: boolean;
}

/** Empties the session cart again, leaving the shop as it was found. */
export async function removeFromCart(
  session: AuditSession,
  page: Page,
  origin: string,
): Promise<RemoveResult> {
  const before = (await readCartState(session, page, origin)).itemCount;
  const control = page.locator(REMOVE_SELECTOR).first();

  if (!(await control.isVisible({ timeout: 1000 }).catch(() => false))) {
    return { attempted: false, before, after: before, removed: false };
  }

  await session.throttle();
  try {
    await control.click({ timeout: session.pageTimeoutMs });
  } catch {
    return { attempted: true, before, after: before, removed: false };
  }

  await page.waitForTimeout(CART_SETTLE_MS);
  const after = (await readCartState(session, page, origin)).itemCount;
  return { attempted: true, before, after, removed: after !== null && after < (before ?? 0) };
}

export interface CheckoutTransition {
  clicked: boolean;
  /** URL the shop landed on; task 2-14 audits it. */
  url: string | null;
  reachedCheckout: boolean;
}

/**
 * Follows the checkout button one step. It stops as soon as the checkout URL is
 * reached: no address is filled in and no order is ever placed.
 */
export async function goToCheckout(session: AuditSession, page: Page): Promise<CheckoutTransition> {
  let button = page.locator(CHECKOUT_SELECTOR).first();
  if (!(await button.isVisible({ timeout: 1000 }).catch(() => false))) {
    button = page.locator('button, a, [role="button"]').filter({ hasText: CHECKOUT_TEXT }).first();
  }
  if (!(await button.isVisible({ timeout: 1000 }).catch(() => false))) {
    return { clicked: false, url: null, reachedCheckout: false };
  }

  await session.throttle();
  const before = page.url();
  try {
    await Promise.all([
      page.waitForURL((url) => url.toString() !== before, { timeout: session.pageTimeoutMs }),
      button.click({ timeout: session.pageTimeoutMs }),
    ]);
  } catch {
    return { clicked: true, url: page.url(), reachedCheckout: false };
  }

  const url = page.url();
  return { clicked: true, url, reachedCheckout: /\/checkouts?\b|\/checkout/.test(url) };
}

export interface CartFlowResult {
  add: AddToCartResult;
  facts: CartFacts;
  quantity: QuantityChangeResult;
  remove: RemoveResult;
  checkout: CheckoutTransition;
}

export function gradeCart(result: CartFlowResult, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const where = { url: ctx.url, viewport: ctx.viewport };
  const add = (input: Omit<Parameters<typeof createIssue>[0], 'page'>) =>
    issues.push(createIssue({ page: 'cart', ...input }));

  // Without `/cart.js` there is no ground truth, and a guess would become a claim
  // in an outreach email. No evidence, no finding.
  const cartCountKnown = result.add.before !== null && result.add.after !== null;
  if (!result.add.added && !cartCountKnown) return issues;

  if (!result.add.added) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Adding to cart does not work',
      detail: result.add.error ?? 'The add-to-cart button was clicked but the cart did not change',
      evidence: {
        ...where,
        expected: 'the cart gains an item',
        actual: `${result.add.before ?? '?'} → ${result.add.after ?? '?'} items`,
      },
    });
    // Nothing downstream can be judged with an empty cart.
    return issues;
  }

  if (!result.facts.hasLines) {
    add({
      category: 'technical',
      severity: 'CRITICAL',
      title: 'Cart page does not show the added item',
      evidence: { ...where, actual: `${result.facts.itemCount ?? '?'} items in the cart API` },
    });
  }

  if (!result.facts.hasQuantityControl) {
    add({
      category: 'ux',
      severity: 'MAJOR',
      title: 'Quantity cannot be changed in the cart',
      evidence: where,
    });
  } else if (result.quantity.attempted && !result.quantity.changed) {
    add({
      category: 'technical',
      severity: 'MAJOR',
      title: 'Changing the quantity has no effect',
      evidence: {
        ...where,
        expected: '2 items',
        actual: `${result.quantity.after ?? '?'} items after the update`,
      },
    });
  }

  if (!result.facts.hasRemoveControl) {
    add({
      category: 'ux',
      severity: 'MAJOR',
      title: 'Items cannot be removed from the cart',
      evidence: where,
    });
  } else if (result.remove.attempted && !result.remove.removed) {
    add({
      category: 'technical',
      severity: 'MAJOR',
      title: 'Removing an item has no effect',
      evidence: {
        ...where,
        actual: `${result.remove.before ?? '?'} → ${result.remove.after ?? '?'} items`,
      },
    });
  }

  if (!result.facts.hasShippingEstimate) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No delivery cost shown in the cart',
      detail: 'Buyers who first see the shipping cost at checkout abandon more often',
      evidence: where,
    });
  }

  if (!result.facts.hasCheckoutButton) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'No checkout button in the cart',
      evidence: where,
    });
  } else if (result.checkout.clicked && !result.checkout.reachedCheckout) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Checkout button does not reach the checkout',
      evidence: {
        ...where,
        expected: 'a /checkout URL',
        actual: result.checkout.url ?? 'no navigation',
      },
    });
  }

  return issues;
}

export interface CartFlowOptions {
  productUrl: string;
  suite?: CheckSuite;
  /**
   * Called while the browser is standing on the checkout page, before the cart
   * is emptied. A Shopify checkout URL belongs to a specific cart, so auditing
   * it afterwards would find a dead page (task 2-14 runs from here).
   */
  onCheckout?: (page: Page, transition: CheckoutTransition) => Promise<void>;
}

/**
 * Walks the whole cart flow on one page and grades it. Returns the suite plus
 * the checkout URL, which task 2-14 continues from.
 */
export async function runCartChecks(
  ctx: CheckContext,
  options: CartFlowOptions,
): Promise<{ suite: CheckSuite; result: CartFlowResult | null }> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });
  const origin = new URL(ctx.url).origin;
  let result: CartFlowResult | null = null;

  await suite.run('cart.flow', async () => {
    const addResult = await addToCart(ctx.session, ctx.page, options.productUrl);

    await ctx.session.goto(ctx.page, `${origin}/cart`);
    const facts = {
      itemCount: (await readCartState(ctx.session, ctx.page, origin)).itemCount,
      ...(await readCart(ctx.page)),
    };

    const quantity = addResult.added
      ? await changeQuantity(ctx.session, ctx.page, origin)
      : { attempted: false, before: null, after: null, changed: false };

    // Checkout is tried before emptying the cart, since an empty cart cannot check out.
    const checkout = addResult.added
      ? await goToCheckout(ctx.session, ctx.page)
      : { clicked: false, url: null, reachedCheckout: false };

    if (checkout.reachedCheckout && options.onCheckout) {
      await options.onCheckout(ctx.page, checkout);
    }

    if (checkout.clicked) await ctx.session.goto(ctx.page, `${origin}/cart`);
    const remove = addResult.added
      ? await removeFromCart(ctx.session, ctx.page, origin)
      : { attempted: false, before: null, after: null, removed: false };

    result = { add: addResult, facts, quantity, remove, checkout };
    return gradeCart(result, ctx);
  });

  return { suite, result };
}
