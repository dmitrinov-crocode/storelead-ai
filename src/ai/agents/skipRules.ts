import type { StoreContext } from '../context.js';

/**
 * SKIP rules, checked in code before the classifier is called (task 3-09).
 *
 * These are the cases where there is nothing for a model to weigh up: there is
 * no shop at the address, the shop is not trading, it is too small to be worth a
 * letter, or we have no way to reach anyone. Sending them to the AI would cost a
 * call and invite a judgement where a fact will do.
 *
 * One case deliberately does not skip: an audit blocked by bot protection. That
 * is our problem, not evidence about the shop, and skipping on it would quietly
 * delete every Cloudflare-fronted merchant from the pipeline — which, in this
 * segment, is most of them.
 */

export const SKIP_REASONS = ['no_storefront', 'closed', 'too_small', 'no_contacts'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Below both of these a shop cannot fund the work we would be selling. Either
 * figure on its own is not enough — StoreLeads reports plenty of real shops with
 * one of the two missing.
 */
export const MIN_REVENUE = 10_000;
export const MIN_TRAFFIC = 1_000;

/** Shopify answers 402 for a frozen or unpaid shop and 423 for one locked down. */
const CLOSED_STATUSES = new Set([402, 423]);

export interface SkipVerdict {
  skip: boolean;
  reason: SkipReason | null;
  /** Why, in terms a human reading the dashboard can check. */
  detail: string;
}

export interface SkipRuleOptions {
  /**
   * Contacts already known for this store. Null means "not looked yet", which is
   * the normal state at analysis time — contact search runs after this step, so
   * the rule only bites on a re-run.
   */
  contactCount?: number | null;
}

export function evaluateSkipRules(
  context: StoreContext,
  options: SkipRuleOptions = {},
): SkipVerdict {
  const audit = context.audit;

  // Blocked is not a verdict about the shop. Say so before anything else looks
  // at the empty page list a blocked audit leaves behind.
  if (audit?.blocked) {
    return {
      skip: false,
      reason: null,
      detail: 'audit blocked by bot protection, not a shop verdict',
    };
  }

  const homepage = audit?.pages.find((page) => page.page === 'homepage');

  if (homepage && homepage.httpStatus !== null && CLOSED_STATUSES.has(homepage.httpStatus)) {
    return {
      skip: true,
      reason: 'closed',
      detail: `homepage answers HTTP ${homepage.httpStatus} — the shop is frozen or locked`,
    };
  }

  if (!audit || audit.status === 'FAILED') {
    return {
      skip: true,
      reason: 'no_storefront',
      detail: audit ? `audit failed: ${audit.error ?? 'no reason recorded'}` : 'no audit on record',
    };
  }

  if (audit.pages.length > 0 && audit.pages.every((page) => page.availability !== 'ok')) {
    return {
      skip: true,
      reason: 'no_storefront',
      detail: 'no page of the shop could be loaded',
    };
  }

  // A shop with no products is a parked domain or a shop in setup, whichever it
  // is there is nothing to sell to yet.
  if (context.business.productsCount === 0) {
    return { skip: true, reason: 'closed', detail: 'the catalogue is empty' };
  }

  const { revenueEstimate, trafficEstimate } = context.business;
  if (
    revenueEstimate !== null &&
    revenueEstimate < MIN_REVENUE &&
    trafficEstimate !== null &&
    trafficEstimate < MIN_TRAFFIC
  ) {
    return {
      skip: true,
      reason: 'too_small',
      detail: `revenue ≈ ${revenueEstimate} and traffic ≈ ${trafficEstimate} are both under the floor`,
    };
  }

  if (options.contactCount === 0) {
    return {
      skip: true,
      reason: 'no_contacts',
      detail: 'contact search found nobody to write to',
    };
  }

  return { skip: false, reason: null, detail: 'no skip rule applies' };
}
