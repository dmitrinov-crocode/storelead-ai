import { getConfig } from '../../config/index.js';
import { CheckSuite } from '../checkRunner.js';
import { createIssue, type Issue } from '../issues.js';
import { checkFailedResources, checkJavaScriptErrors, checkLoadTime } from './shared.js';
import type { CheckContext } from './context.js';

/**
 * Checkout checks (task 2-14).
 *
 * **Nothing is ever ordered.** The audit reaches the first data-entry step,
 * reads what it can see and stops; no address is submitted and no payment step
 * is advanced.
 *
 * Two things are deliberately collected as facts but never turned into issues:
 * shipping options and payment methods. Shopify reveals both on later steps, so
 * "no payment methods" on step one would be a finding about our own crawl depth
 * rather than about the shop, and a false accusation in an outreach email costs
 * far more than a missed observation.
 */

/** Country names as a checkout would spell them, per target market. */
const COUNTRY_LABELS: Record<string, RegExp> = {
  PL: /polska|poland/i,
};

/**
 * Local currency of a market, used to spot a shop pricing its home buyers in a
 * foreign currency. A digit has to precede `zł`: a word boundary is useless here
 * (`ł` is not an ASCII word character) and a bare `zł` also matches `złóż`.
 */
const CURRENCY_LABELS: Record<string, RegExp> = {
  PL: /\d\s*z[łl]|\bPLN\b/i,
};

const LOGIN_WALL_TEXT = /zaloguj|musisz się zalogować|sign in to continue|log in to continue/i;
const GUEST_TEXT = /kontynuuj jako go[śs][ćc]|guest|bez rejestracji|continue as guest/i;
const PAYMENT_NAMES =
  /blik|przelewy24|p24|payu|tpay|dotpay|paypal|apple\s?pay|google\s?pay|shop\s?pay|karta|visa|mastercard|klarna|za pobraniem/gi;

export interface CheckoutFacts {
  hasEmailField: boolean;
  hasAddressFields: boolean;
  /** A password gate with no guest option. */
  requiresLogin: boolean;
  countrySelect: { present: boolean; options: number; hasTargetCountry: boolean };
  hasLocalCurrency: boolean;
  /** Collected, not graded — see the note at the top of this file. */
  paymentSignals: string[];
  hasShippingSection: boolean;
  requiredFields: number;
  requiredWithoutLabel: string[];
  visibleErrors: string[];
}

export interface CheckoutOptions {
  /** Defaults to the pipeline's target market. */
  country?: string;
}

export async function readCheckout(
  ctx: CheckContext,
  options: CheckoutOptions = {},
): Promise<CheckoutFacts> {
  const country = (options.country ?? getConfig().pipeline.targetCountry).toUpperCase();
  const countryPattern = (COUNTRY_LABELS[country] ?? new RegExp(`\\b${country}\\b`, 'i')).source;
  const currencyPattern = (CURRENCY_LABELS[country] ?? /./).source;

  return ctx.page.evaluate(
    (patterns) => {
      const countryRe = new RegExp(patterns.country, 'i');
      const currencyRe = new RegExp(patterns.currency, 'i');
      const loginRe = new RegExp(patterns.login, 'i');
      const guestRe = new RegExp(patterns.guest, 'i');
      const paymentRe = new RegExp(patterns.payment, 'gi');
      const bodyText = document.body?.innerText ?? '';

      const countrySelect = document.querySelector(
        'select[name*="country" i], select[id*="country" i], select[autocomplete="country"]',
      );
      let countryOptions = 0;
      let hasTargetCountry = false;
      if (countrySelect instanceof HTMLSelectElement) {
        countryOptions = countrySelect.options.length;
        for (const option of Array.from(countrySelect.options)) {
          if (countryRe.test(option.textContent ?? '') || countryRe.test(option.value)) {
            hasTargetCountry = true;
            break;
          }
        }
      }

      // Required fields whose purpose a screen reader — or a hurried buyer — cannot tell.
      const requiredWithoutLabel: string[] = [];
      const required = Array.from(
        document.querySelectorAll('input[required], select[required], textarea[required]'),
      );
      for (const field of required) {
        if (requiredWithoutLabel.length >= 5) break;
        const id = field.getAttribute('id');
        const labelled =
          (id && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null) ||
          field.getAttribute('aria-label') !== null ||
          field.getAttribute('aria-labelledby') !== null ||
          field.closest('label') !== null ||
          field.getAttribute('placeholder') !== null;
        if (!labelled) {
          const name = field.getAttribute('name') ?? field.tagName.toLowerCase();
          requiredWithoutLabel.push(name);
        }
      }

      const visibleErrors: string[] = [];
      for (const node of Array.from(
        document.querySelectorAll('[role="alert"], [class*="error" i], [class*="alert" i]'),
      )) {
        if (visibleErrors.length >= 5) break;
        if (!(node instanceof HTMLElement)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = node.innerText.trim();
        if (text.length > 0 && text.length < 300) visibleErrors.push(text);
      }

      const payments = new Set<string>();
      for (const match of bodyText.matchAll(paymentRe)) payments.add(match[0].toLowerCase());
      if (
        document.querySelector(
          '[class*="express" i], shopify-payment-terms, [data-shopify="payment-button"]',
        )
      ) {
        payments.add('express checkout');
      }

      const hasPassword = document.querySelector('input[type="password"]') !== null;

      return {
        hasEmailField:
          document.querySelector('input[type="email"], input[name*="email" i]') !== null,
        hasAddressFields:
          document.querySelector(
            'input[name*="address" i], input[autocomplete*="address" i], input[name*="zip" i], input[name*="postal" i]',
          ) !== null,
        requiresLogin: hasPassword && loginRe.test(bodyText) && !guestRe.test(bodyText),
        countrySelect: {
          present: countrySelect !== null,
          options: countryOptions,
          hasTargetCountry,
        },
        hasLocalCurrency: currencyRe.test(bodyText),
        paymentSignals: [...payments],
        hasShippingSection:
          document.querySelector(
            '[class*="shipping" i], [class*="delivery" i], [class*="dostaw" i]',
          ) !== null,
        requiredFields: required.length,
        requiredWithoutLabel,
        visibleErrors,
      };
    },
    {
      country: countryPattern,
      currency: currencyPattern,
      login: LOGIN_WALL_TEXT.source,
      guest: GUEST_TEXT.source,
      payment: PAYMENT_NAMES.source,
    },
  );
}

export interface CheckoutInput {
  /** False when the checkout URL never opened; the single worst finding there is. */
  opened: boolean;
  httpStatus: number | null;
  facts: CheckoutFacts | null;
}

export function gradeCheckout(
  input: CheckoutInput,
  ctx: CheckContext,
  options: CheckoutOptions = {},
): Issue[] {
  const country = (options.country ?? getConfig().pipeline.targetCountry).toUpperCase();
  const issues: Issue[] = [];
  const where = { url: ctx.url, viewport: ctx.viewport };
  const add = (item: Omit<Parameters<typeof createIssue>[0], 'page'>) =>
    issues.push(createIssue({ page: 'checkout', ...item }));

  if (!input.opened || !input.facts) {
    add({
      category: 'cro',
      severity: 'CRITICAL',
      title: 'Checkout does not open',
      detail: 'The shop cannot take an order: the checkout step never loaded',
      evidence: {
        ...where,
        expected: 'a checkout form',
        ...(input.httpStatus === null ? {} : { status: input.httpStatus }),
      },
    });
    return issues;
  }

  const facts = input.facts;

  if (facts.visibleErrors.length > 0) {
    add({
      category: 'technical',
      severity: 'CRITICAL',
      title: 'Checkout shows an error message',
      evidence: facts.visibleErrors.map((text) => ({ ...where, text })),
    });
  }

  if (!facts.hasEmailField && !facts.hasAddressFields) {
    add({
      category: 'cro',
      severity: 'MAJOR',
      title: 'Checkout has no data-entry form',
      detail: 'Neither a contact nor an address field was found on the checkout step',
      evidence: where,
    });
  }

  if (facts.requiresLogin) {
    add({
      category: 'cro',
      severity: 'MAJOR',
      title: 'No guest checkout',
      detail: 'Buyers are forced to create an account before they can pay',
      evidence: where,
    });
  }

  if (facts.countrySelect.present && !facts.countrySelect.hasTargetCountry) {
    add({
      category: 'cro',
      severity: 'MAJOR',
      title: `Checkout does not offer ${country} as a delivery country`,
      evidence: {
        ...where,
        expected: country,
        actual: `${facts.countrySelect.options} countries listed, none matching`,
      },
    });
  }

  if (!facts.hasLocalCurrency) {
    add({
      category: 'cro',
      severity: 'MINOR',
      title: 'Checkout does not show prices in the local currency',
      evidence: { ...where, expected: country === 'PL' ? 'zł / PLN' : country },
    });
  }

  if (facts.requiredWithoutLabel.length > 0) {
    add({
      category: 'ux',
      severity: 'MINOR',
      title: 'Required checkout fields have no label',
      detail: 'Unlabelled mandatory fields are a common cause of abandoned checkouts',
      evidence: facts.requiredWithoutLabel.map((name) => ({
        ...where,
        selector: `[name="${name}"]`,
      })),
    });
  }

  return issues;
}

export interface CheckoutCheckOptions extends CheckoutOptions {
  opened: boolean;
  httpStatus: number | null;
  suite?: CheckSuite;
}

export async function runCheckoutChecks(
  ctx: CheckContext,
  options: CheckoutCheckOptions,
): Promise<{ suite: CheckSuite; facts: CheckoutFacts | null }> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });
  let facts: CheckoutFacts | null = null;

  await suite.run('checkout.load_time', () => Promise.resolve(checkLoadTime(ctx)));
  await suite.run('checkout.js_errors', () => Promise.resolve(checkJavaScriptErrors(ctx)));
  await suite.run('checkout.failed_resources', () => Promise.resolve(checkFailedResources(ctx)));
  await suite.run('checkout.form', async () => {
    facts = options.opened ? await readCheckout(ctx, options) : null;
    return gradeCheckout(
      { opened: options.opened, httpStatus: options.httpStatus, facts },
      ctx,
      options,
    );
  });

  return { suite, facts };
}
