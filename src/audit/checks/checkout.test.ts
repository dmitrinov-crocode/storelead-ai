import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../browser.js';
import { html } from '../testing/fixtureServer.js';
import { openFixturePage } from '../testing/pageContext.js';
import { gradeCheckout, readCheckout, runCheckoutChecks, type CheckoutFacts } from './checkout.js';
import type { CheckContext } from './context.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

const COMPLETE_CHECKOUT = html(`
<main>
  <h1>Kasa</h1>
  <form>
    <label for="email">E-mail</label>
    <input id="email" type="email" name="email" required>
    <label for="addr">Adres</label>
    <input id="addr" name="address1" required>
    <label for="zip">Kod pocztowy</label>
    <input id="zip" name="zip" required>
    <label for="country">Kraj</label>
    <select id="country" name="country" required>
      <option value="PL">Polska</option>
      <option value="DE">Niemcy</option>
    </select>
  </form>
  <section class="shipping-methods">Kurier DPD — 15,00 zł</section>
  <section>Płatność: BLIK, Przelewy24, karta</section>
  <p>Razem: 349,00 zł</p>
</main>`);

async function factsFor(body: string, viewport: 'desktop' | 'mobile' = 'desktop') {
  const fixture = await openFixturePage(
    browser,
    { '/': { body } },
    { target: 'checkout', viewport },
  );
  try {
    return await readCheckout(fixture.ctx, { country: 'PL' });
  } finally {
    await fixture.close();
  }
}

test('reads a complete Polish checkout', async () => {
  const facts = await factsFor(COMPLETE_CHECKOUT);
  assert.equal(facts.hasEmailField, true);
  assert.equal(facts.hasAddressFields, true);
  assert.equal(facts.requiresLogin, false);
  assert.deepEqual(facts.countrySelect, { present: true, options: 2, hasTargetCountry: true });
  assert.equal(facts.hasLocalCurrency, true);
  assert.equal(facts.hasShippingSection, true);
  assert.equal(facts.requiredFields, 4);
  assert.deepEqual(facts.requiredWithoutLabel, []);
  assert.deepEqual(facts.visibleErrors, []);
  assert.deepEqual(facts.paymentSignals.sort(), ['blik', 'karta', 'przelewy24']);
});

test('a checkout that does not offer the target country is detected', async () => {
  const facts = await factsFor(
    html(`<form><input type="email" name="email">
      <select name="country"><option value="DE">Niemcy</option></select></form>`),
  );
  assert.equal(facts.countrySelect.hasTargetCountry, false);
  assert.equal(facts.countrySelect.options, 1);
});

test('a login wall without a guest option is detected', async () => {
  const walled = await factsFor(
    html(`<main><p>Musisz się zalogować, aby kontynuować</p>
      <form><input type="email" name="email"><input type="password" name="password"></form></main>`),
  );
  assert.equal(walled.requiresLogin, true);

  const guestAllowed = await factsFor(
    html(`<main><p>Zaloguj się lub kontynuuj jako gość</p>
      <form><input type="email" name="email"><input type="password" name="password"></form></main>`),
  );
  assert.equal(guestAllowed.requiresLogin, false);
});

test('unlabelled required fields are named', async () => {
  const facts = await factsFor(
    html(`<form>
      <label for="ok">E-mail</label><input id="ok" type="email" name="email" required>
      <input name="phone" required>
      <input name="nip" required>
    </form>`),
  );
  assert.deepEqual(facts.requiredWithoutLabel, ['phone', 'nip']);
});

test('a placeholder counts as a label, a hidden error does not count as an error', async () => {
  const facts = await factsFor(
    html(`<form><input name="phone" placeholder="Telefon" required></form>
      <div class="error" style="display:none">Coś poszło nie tak</div>`),
  );
  assert.deepEqual(facts.requiredWithoutLabel, []);
  assert.deepEqual(facts.visibleErrors, []);
});

test('a visible error message on the checkout is captured', async () => {
  const facts = await factsFor(
    html(`<div role="alert">Płatność jest chwilowo niedostępna</div>
      <form><input type="email" name="email"></form>`),
  );
  assert.deepEqual(facts.visibleErrors, ['Płatność jest chwilowo niedostępna']);
});

test('a checkout priced only in euro is noticed', async () => {
  const facts = await factsFor(
    html('<form><input type="email" name="email"></form><p>€ 79.00</p>'),
  );
  assert.equal(facts.hasLocalCurrency, false);
});

const ctxStub = { url: 'https://sklep.pl/checkouts/1', viewport: 'desktop' } as CheckContext;

const baseFacts = (overrides: Partial<CheckoutFacts> = {}): CheckoutFacts => ({
  hasEmailField: true,
  hasAddressFields: true,
  requiresLogin: false,
  countrySelect: { present: true, options: 40, hasTargetCountry: true },
  hasLocalCurrency: true,
  paymentSignals: ['blik'],
  hasShippingSection: true,
  requiredFields: 4,
  requiredWithoutLabel: [],
  visibleErrors: [],
  ...overrides,
});

test('a working checkout raises nothing', () => {
  assert.deepEqual(
    gradeCheckout({ opened: true, httpStatus: 200, facts: baseFacts() }, ctxStub, {
      country: 'PL',
    }),
    [],
  );
});

test('a checkout that never opens is the single worst finding', () => {
  const issues = gradeCheckout({ opened: false, httpStatus: 500, facts: null }, ctxStub, {
    country: 'PL',
  });
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [['Checkout does not open', 'CRITICAL']],
  );
  assert.equal(issues[0]!.evidence[0]!.status, 500);
});

test('an error on the checkout is critical and quoted verbatim', () => {
  const issues = gradeCheckout(
    { opened: true, httpStatus: 200, facts: baseFacts({ visibleErrors: ['Brak dostawy'] }) },
    ctxStub,
    { country: 'PL' },
  );
  assert.equal(issues[0]!.severity, 'CRITICAL');
  assert.equal(issues[0]!.evidence[0]!.text, 'Brak dostawy');
});

test('a forced account and a missing country are separate major findings', () => {
  const issues = gradeCheckout(
    {
      opened: true,
      httpStatus: 200,
      facts: baseFacts({
        requiresLogin: true,
        countrySelect: { present: true, options: 12, hasTargetCountry: false },
      }),
    },
    ctxStub,
    { country: 'PL' },
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [
      ['No guest checkout', 'MAJOR'],
      ['Checkout does not offer PL as a delivery country', 'MAJOR'],
    ],
  );
});

test('a page with no form at all is reported as not a checkout', () => {
  const issues = gradeCheckout(
    {
      opened: true,
      httpStatus: 200,
      facts: baseFacts({ hasEmailField: false, hasAddressFields: false }),
    },
    ctxStub,
    { country: 'PL' },
  );
  assert.deepEqual(
    issues.map((i) => i.title),
    ['Checkout has no data-entry form'],
  );
});

test('currency and unlabelled fields are minor', () => {
  const issues = gradeCheckout(
    {
      opened: true,
      httpStatus: 200,
      facts: baseFacts({ hasLocalCurrency: false, requiredWithoutLabel: ['phone'] }),
    },
    ctxStub,
    { country: 'PL' },
  );
  assert.deepEqual(
    issues.map((i) => [i.title, i.severity]),
    [
      ['Checkout does not show prices in the local currency', 'MINOR'],
      ['Required checkout fields have no label', 'MINOR'],
    ],
  );
  assert.equal(issues[1]!.evidence[0]!.selector, '[name="phone"]');
});

test('shipping and payment options are collected but never accused', () => {
  const issues = gradeCheckout(
    {
      opened: true,
      httpStatus: 200,
      facts: baseFacts({ paymentSignals: [], hasShippingSection: false }),
    },
    ctxStub,
    { country: 'PL' },
  );
  assert.deepEqual(issues, [], 'Shopify shows those on later steps we deliberately do not enter');
});

test('the suite grades the checkout together with the technical checks', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { body: COMPLETE_CHECKOUT.replace('</main>', '<script>null.boom()</script></main>') } },
    { target: 'checkout' },
  );
  try {
    const { suite, facts } = await runCheckoutChecks(fixture.ctx, {
      opened: true,
      httpStatus: 200,
      country: 'PL',
    });

    assert.deepEqual(
      suite.outcomes.map((o) => o.name),
      ['checkout.load_time', 'checkout.js_errors', 'checkout.failed_resources', 'checkout.form'],
    );
    assert.equal(facts!.hasEmailField, true);
    assert.deepEqual(
      suite.issues.map((i) => [i.title, i.severity]),
      [['JavaScript errors break the page', 'CRITICAL']],
      'a script error on checkout is graded at its true cost',
    );
  } finally {
    await fixture.close();
  }
});

test('a checkout that did not open is graded without reading the page', async () => {
  const fixture = await openFixturePage(
    browser,
    { '/': { status: 503, body: html('<h1>Serwis niedostępny</h1>') } },
    { target: 'checkout' },
  );
  try {
    const { suite, facts } = await runCheckoutChecks(fixture.ctx, {
      opened: false,
      httpStatus: 503,
      country: 'PL',
    });
    assert.equal(facts, null);
    assert.deepEqual(
      suite.issues.map((i) => i.title),
      ['Checkout does not open'],
    );
  } finally {
    await fixture.close();
  }
});

test('the checkout reads the same way on a phone', async () => {
  const facts = await factsFor(COMPLETE_CHECKOUT, 'mobile');
  assert.equal(facts.hasEmailField, true);
  assert.equal(facts.countrySelect.hasTargetCountry, true);
});
