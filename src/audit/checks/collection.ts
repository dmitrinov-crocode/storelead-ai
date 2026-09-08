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
 * Collection (category) page checks (task 2-11).
 *
 * The collection page is where a visitor decides whether the shop has anything
 * for them: cards that show a picture, a name and a price, and — once the list
 * gets long — the tools to narrow it down.
 */

/** Below this many products, filters and sorting are not worth having. */
export const PRODUCTS_NEEDING_TOOLS = 12;
/** A full first page with no way forward means the rest is unreachable. */
export const PRODUCTS_NEEDING_PAGINATION = 24;

export interface CardFacts {
  total: number;
  withImage: number;
  withPrice: number;
  withTitle: number;
  soldOut: number;
  /** Selectors of cards missing a price, as evidence. */
  missingPrice: string[];
  hasFilters: boolean;
  hasSorting: boolean;
  hasPagination: boolean;
  hasQuickAdd: boolean;
}

/** Money as Polish shops write it. `\s` already covers the non-breaking space in `1 299,00 zl`. */
const PRICE_PATTERN = /(\d[\d\s]*[,.]?\d*)\s*(zł|pln|eur|€|\$|usd)|(€|\$)\s*\d/i;
const SOLD_OUT_PATTERN = /wyprzedan|niedost[eę]pn|brak w magazynie|sold out|out of stock/i;

export async function readCollection(ctx: CheckContext): Promise<CardFacts> {
  return ctx.page.evaluate(
    (patterns) => {
      const priceRe = new RegExp(patterns.price, 'i');
      const soldOutRe = new RegExp(patterns.soldOut, 'i');

      const roots: Element[] = [];
      for (const link of Array.from(document.querySelectorAll('a[href*="/products/"]'))) {
        const root =
          link.closest(
            'li, article, .card, .card-wrapper, .product-card, .product-item, [data-product-card]',
          ) ??
          link.parentElement ??
          link;
        if (!roots.includes(root)) roots.push(root);
      }

      const facts = {
        total: roots.length,
        withImage: 0,
        withPrice: 0,
        withTitle: 0,
        soldOut: 0,
        missingPrice: [] as string[],
        hasFilters:
          document.querySelector(
            '[id*="filter" i], [class*="filter" i], [id*="facet" i], [class*="facet" i], [data-filter], input[name^="filter"], facet-filters-form',
          ) !== null,
        hasSorting:
          document.querySelector(
            'select[name="sort_by"], [id*="sort" i], [class*="sort-by" i], [data-sort]',
          ) !== null,
        hasPagination:
          document.querySelector(
            '.pagination, [class*="pagination" i], a[href*="page="], [data-infinite-scroll], [class*="load-more" i]',
          ) !== null,
        hasQuickAdd:
          document.querySelector(
            '[data-quick-add], [class*="quick-add" i], [class*="quick-buy" i], form[action*="/cart/add"] button',
          ) !== null,
      };

      for (const root of roots) {
        const text = root instanceof HTMLElement ? root.innerText : (root.textContent ?? '');
        if (root.querySelector('img, svg image, [style*="background-image"]')) facts.withImage += 1;

        const hasPriceNode =
          root.querySelector('[class*="price" i], .money, [data-price]') !== null;
        if (hasPriceNode || priceRe.test(text)) {
          facts.withPrice += 1;
        } else if (facts.missingPrice.length < 5) {
          const id = root.id ? `#${root.id}` : '';
          const cls = (root.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
          facts.missingPrice.push(id || `${root.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
        }

        if (text.trim().length > 0) facts.withTitle += 1;
        if (soldOutRe.test(text)) facts.soldOut += 1;
      }

      return facts;
    },
    { price: PRICE_PATTERN.source, soldOut: SOLD_OUT_PATTERN.source },
  );
}

export function gradeCollection(facts: CardFacts, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const evidence = { url: ctx.url, viewport: ctx.viewport };

  if (facts.total === 0) {
    return [
      createIssue({
        page: 'collection',
        category: 'cro',
        severity: 'CRITICAL',
        title: 'Collection page shows no products',
        detail: 'No product cards were found on the category page',
        evidence: { ...evidence, expected: 'at least one product card', actual: '0 cards' },
      }),
    ];
  }

  if (facts.withImage < facts.total) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'ux',
        severity: 'MAJOR',
        title: 'Product cards without an image',
        detail: `${facts.total - facts.withImage} of ${facts.total} cards show no picture`,
        evidence: { ...evidence, expected: `${facts.total} images`, actual: `${facts.withImage}` },
      }),
    );
  }

  if (facts.withPrice < facts.total) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'cro',
        severity: 'MAJOR',
        title: 'Product cards without a price',
        detail: `${facts.total - facts.withPrice} of ${facts.total} cards show no price`,
        evidence: facts.missingPrice.length
          ? facts.missingPrice.map((selector) => ({ ...evidence, selector }))
          : { ...evidence, actual: `${facts.withPrice} of ${facts.total} cards priced` },
      }),
    );
  }

  if (facts.soldOut === facts.total) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'cro',
        severity: 'MAJOR',
        title: 'Every product in the collection is sold out',
        evidence: { ...evidence, actual: `${facts.soldOut} of ${facts.total} marked unavailable` },
      }),
    );
  }

  if (facts.total >= PRODUCTS_NEEDING_TOOLS && !facts.hasFilters) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'cro',
        severity: 'MINOR',
        title: 'No filters on a long product list',
        evidence: { ...evidence, actual: `${facts.total} products, no filter controls` },
      }),
    );
  }

  if (facts.total >= PRODUCTS_NEEDING_TOOLS && !facts.hasSorting) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'cro',
        severity: 'MINOR',
        title: 'No sorting on a long product list',
        evidence: { ...evidence, actual: `${facts.total} products, no sort control` },
      }),
    );
  }

  if (facts.total >= PRODUCTS_NEEDING_PAGINATION && !facts.hasPagination) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'ux',
        severity: 'MAJOR',
        title: 'No pagination on a full collection page',
        detail: 'The page is full but offers no way to reach the rest of the catalogue',
        evidence: { ...evidence, actual: `${facts.total} products, no pagination or load-more` },
      }),
    );
  }

  if (!facts.hasQuickAdd) {
    issues.push(
      createIssue({
        page: 'collection',
        category: 'cro',
        severity: 'MINOR',
        title: 'No quick add to cart on the listing',
        detail: 'Every purchase needs a detour through the product page',
        evidence,
      }),
    );
  }

  return issues;
}

export async function checkCollectionCards(ctx: CheckContext): Promise<Issue[]> {
  return gradeCollection(await readCollection(ctx), ctx);
}

export async function runCollectionChecks(
  ctx: CheckContext,
  options: { suite?: CheckSuite } = {},
): Promise<CheckSuite> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });

  await suite.run('collection.load_time', () => Promise.resolve(checkLoadTime(ctx)));
  await suite.run('collection.js_errors', () => Promise.resolve(checkJavaScriptErrors(ctx)));
  await suite.run('collection.failed_resources', () => Promise.resolve(checkFailedResources(ctx)));
  await suite.run('collection.images', () => checkBrokenImages(ctx));
  await suite.run('collection.cards', () => checkCollectionCards(ctx));

  return suite;
}
