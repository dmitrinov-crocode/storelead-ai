import { CheckSuite } from '../checkRunner.js';
import { createIssue, type Issue } from '../issues.js';
import {
  checkBrokenImages,
  checkFailedResources,
  checkJavaScriptErrors,
  checkLoadTime,
} from './shared.js';
import type { CheckContext } from './context.js';

/**
 * Product page checks (task 2-12).
 *
 * This is the page that sells. Everything here is either a blocker (no price,
 * no way to add to the cart) or one of the reassurances a buyer looks for before
 * paying a stranger: photos, a description, delivery and returns, other people's
 * opinions.
 */

/** A description shorter than this tells a buyer nothing. */
export const MIN_DESCRIPTION_CHARS = 120;

const ADD_TO_CART_TEXT = /do koszyka|dodaj|add to (cart|bag)|kup(uj[eę])?$/i;
const BUY_NOW_TEXT = /kup teraz|buy it now|buy now|zamów teraz/i;
const SOLD_OUT_TEXT = /wyprzedan|niedost[eę]pn|brak w magazynie|sold out|out of stock/i;
const SHIPPING_TEXT = /dostaw|wysy[łl]k|przesy[łl]k|shipping|delivery/i;
const RETURNS_TEXT = /zwrot|reklamacj|odst[aą]pieni|returns?|refund/i;
const PRICE_PATTERN = /(\d[\d\s]*[,.]?\d*)\s*(zł|pln|eur|€|\$|usd)|(€|\$)\s*\d/i;

export interface ProductFacts {
  hasCartForm: boolean;
  addToCart: { present: boolean; enabled: boolean; text: string | null };
  buyNow: boolean;
  hasPrice: boolean;
  priceText: string | null;
  images: number;
  hasVariantControl: boolean;
  variantOptions: number;
  variantControlDisabled: boolean;
  hasQuantity: boolean;
  descriptionChars: number;
  hasReviews: boolean;
  hasShippingInfo: boolean;
  hasReturnsInfo: boolean;
  relatedProducts: number;
  soldOut: boolean;
}

export async function readProduct(ctx: CheckContext): Promise<ProductFacts> {
  return ctx.page.evaluate(
    (patterns) => {
      const addRe = new RegExp(patterns.add, 'i');
      const buyRe = new RegExp(patterns.buy, 'i');
      const soldRe = new RegExp(patterns.sold, 'i');
      const shipRe = new RegExp(patterns.ship, 'i');
      const returnRe = new RegExp(patterns.ret, 'i');
      const priceRe = new RegExp(patterns.price, 'i');

      const form = document.querySelector('form[action*="/cart/add"]');
      const scope: ParentNode = form ?? document;
      const bodyText = document.body?.innerText ?? '';

      // Add to cart: the submit button of the cart form, or any button that says so.
      let addButton: Element | null =
        scope.querySelector('button[name="add"], [name="add"], button[type="submit"]') ?? null;
      if (!addButton) {
        for (const candidate of Array.from(
          document.querySelectorAll('button, input[type="submit"], [role="button"]'),
        )) {
          const label =
            candidate instanceof HTMLInputElement ? candidate.value : (candidate.textContent ?? '');
          if (addRe.test(label.trim())) {
            addButton = candidate;
            break;
          }
        }
      }
      const addLabel = addButton
        ? addButton instanceof HTMLInputElement
          ? addButton.value
          : (addButton.textContent ?? '').trim().slice(0, 80)
        : null;

      let buyNow = document.querySelector('.shopify-payment-button, [data-buy-now]') !== null;
      if (!buyNow) {
        for (const candidate of Array.from(document.querySelectorAll('button, [role="button"]'))) {
          if (buyRe.test((candidate.textContent ?? '').trim())) {
            buyNow = true;
            break;
          }
        }
      }

      const priceNode = document.querySelector(
        '[itemprop="price"], [class*="price" i], .money, [data-price]',
      );
      const priceText = priceNode instanceof HTMLElement ? priceNode.innerText.trim() : null;

      const mediaScope =
        document.querySelector(
          '[class*="product__media" i], [class*="product-media" i], [class*="product-gallery" i], [class*="product-single__photo" i], [class*="product-image" i]',
        ) ?? document.querySelector('main, [role="main"]');
      const images = mediaScope ? mediaScope.querySelectorAll('img').length : 0;

      const variantControl = document.querySelector(
        'variant-selects, variant-radios, select[name="id"], select[name*="option" i], [name^="options"], fieldset[class*="variant" i], [class*="swatch" i]',
      );
      let variantOptions = 0;
      if (variantControl instanceof HTMLSelectElement)
        variantOptions = variantControl.options.length;
      else if (variantControl)
        variantOptions = variantControl.querySelectorAll('input, option').length;

      const descriptionNode = document.querySelector(
        '[itemprop="description"], [class*="product__description" i], [class*="product-description" i], .rte, [class*="description" i]',
      );
      const descriptionChars =
        descriptionNode instanceof HTMLElement ? descriptionNode.innerText.trim().length : 0;

      const related = new Set<string>();
      const current = window.location.pathname;
      for (const link of Array.from(document.querySelectorAll('a[href*="/products/"]'))) {
        const href = (link as HTMLAnchorElement).pathname;
        if (href && href !== current) related.add(href);
      }

      return {
        hasCartForm: form !== null,
        addToCart: {
          present: addButton !== null,
          enabled:
            addButton !== null &&
            !(addButton as HTMLButtonElement).disabled &&
            addButton.getAttribute('aria-disabled') !== 'true',
          text: addLabel,
        },
        buyNow,
        hasPrice: priceNode !== null || priceRe.test(bodyText),
        priceText,
        images,
        hasVariantControl: variantControl !== null,
        variantOptions,
        variantControlDisabled:
          variantControl instanceof HTMLSelectElement ? variantControl.disabled : false,
        hasQuantity:
          document.querySelector(
            'input[name="quantity"], quantity-input, [class*="quantity" i] input',
          ) !== null,
        descriptionChars,
        hasReviews:
          document.querySelector(
            '[class*="review" i], [id*="review" i], .spr-badge, .jdgm-widget, [data-reviews]',
          ) !== null,
        hasShippingInfo: shipRe.test(bodyText),
        hasReturnsInfo: returnRe.test(bodyText),
        relatedProducts: related.size,
        soldOut: soldRe.test(bodyText),
      };
    },
    {
      add: ADD_TO_CART_TEXT.source,
      buy: BUY_NOW_TEXT.source,
      sold: SOLD_OUT_TEXT.source,
      ship: SHIPPING_TEXT.source,
      ret: RETURNS_TEXT.source,
      price: PRICE_PATTERN.source,
    },
  );
}

export function gradeProduct(facts: ProductFacts, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const where = { url: ctx.url, viewport: ctx.viewport };
  const add = (input: Omit<Parameters<typeof createIssue>[0], 'page'>) =>
    issues.push(createIssue({ page: 'product', ...input }));

  if (!facts.addToCart.present) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'No add to cart button',
      detail: 'The product cannot be bought from its own page',
      evidence: { ...where, expected: 'an add-to-cart button', actual: 'none found' },
    });
  } else if (!facts.addToCart.enabled && !facts.soldOut) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Add to cart button is disabled',
      detail: 'The button is present but cannot be clicked, and the product is not marked sold out',
      evidence: { ...where, text: facts.addToCart.text ?? '', actual: 'disabled' },
    });
  }

  if (!facts.hasPrice) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Product page shows no price',
      evidence: { ...where, expected: 'a price', actual: 'none found' },
    });
  }

  if (facts.images === 0) {
    add({
      category: 'ux',
      severity: 'MAJOR',
      title: 'Product page has no photo',
      evidence: where,
    });
  } else if (facts.images === 1) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'Only one product photo',
      detail: 'Buyers who cannot see the product from several angles hesitate',
      evidence: { ...where, actual: '1 image' },
    });
  }

  if (facts.hasVariantControl && facts.variantControlDisabled) {
    add({
      category: 'cro',
      severity: 'MAJOR',
      title: 'Variant selection is disabled',
      detail: 'Sizes or colours cannot be chosen, so only one variant can be bought',
      evidence: { ...where, actual: `${facts.variantOptions} option(s), control disabled` },
    });
  }

  if (!facts.hasQuantity) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No quantity selector',
      evidence: where,
    });
  }

  if (!facts.buyNow) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No express checkout button',
      detail: 'Shopify’s dynamic checkout button removes a step for returning buyers',
      evidence: where,
    });
  }

  if (facts.descriptionChars < MIN_DESCRIPTION_CHARS) {
    add({
      category: 'cro',
      severity: 'MAJOR',
      title:
        facts.descriptionChars === 0
          ? 'No product description'
          : 'Product description is too short',
      detail: `The description holds ${facts.descriptionChars} characters`,
      evidence: {
        ...where,
        expected: `at least ${MIN_DESCRIPTION_CHARS} characters`,
        actual: `${facts.descriptionChars}`,
      },
    });
  }

  if (!facts.hasReviews) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No reviews or ratings',
      detail: 'Nothing on the page shows what other buyers thought',
      evidence: where,
    });
  }

  if (!facts.hasShippingInfo) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No delivery information on the product page',
      evidence: where,
    });
  }

  if (!facts.hasReturnsInfo) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No returns information on the product page',
      evidence: where,
    });
  }

  if (facts.relatedProducts === 0) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'No related products or upsell',
      detail: 'The page is a dead end: nothing else from the shop is offered',
      evidence: where,
    });
  }

  return issues;
}

export async function checkProductPage(ctx: CheckContext): Promise<Issue[]> {
  return gradeProduct(await readProduct(ctx), ctx);
}

export async function runProductChecks(
  ctx: CheckContext,
  options: { suite?: CheckSuite } = {},
): Promise<CheckSuite> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });

  await suite.run('product.load_time', () => Promise.resolve(checkLoadTime(ctx)));
  await suite.run('product.js_errors', () => Promise.resolve(checkJavaScriptErrors(ctx)));
  await suite.run('product.failed_resources', () => Promise.resolve(checkFailedResources(ctx)));
  await suite.run('product.images', () => checkBrokenImages(ctx));
  await suite.run('product.page', () => checkProductPage(ctx));

  return suite;
}
