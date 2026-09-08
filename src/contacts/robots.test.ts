import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRobots, userAgentToken } from './robots.js';

const UA = 'StoreLeadBot/0.1 (+https://example.invalid/bot)';

test('an empty or missing file allows everything', () => {
  assert.equal(parseRobots('', UA).isAllowed('/pages/kontakt'), true);
  assert.equal(parseRobots('# just a comment\n', UA).isAllowed('/anything'), true);
});

test("Shopify's default file still allows the pages contacts live on", () => {
  const shopify = `
User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkouts/
Disallow: /checkout
Disallow: /carts
Disallow: /account
Sitemap: https://sklep.pl/sitemap.xml
`;
  const rules = parseRobots(shopify, UA);

  assert.equal(rules.isAllowed('/pages/kontakt'), true);
  assert.equal(rules.isAllowed('/pages/o-nas'), true);
  assert.equal(rules.isAllowed('/policies/privacy-policy'), true);
  // The very paths the audit needs — which is why the audit does not use this.
  assert.equal(rules.isAllowed('/cart'), false);
  assert.equal(rules.isAllowed('/checkout'), false);
});

test('an empty Disallow means everything is allowed', () => {
  const rules = parseRobots('User-agent: *\nDisallow:\n', UA);
  assert.equal(rules.isAllowed('/pages/kontakt'), true);
});

test('Disallow: / closes the whole site', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /\n', UA);
  assert.equal(rules.isAllowed('/'), false);
  assert.equal(rules.isAllowed('/pages/kontakt'), false);
});

test('a group naming us wins over the wildcard group', () => {
  const text = `
User-agent: *
Disallow: /

User-agent: StoreLeadBot
Disallow: /pages/tajne
`;
  const rules = parseRobots(text, UA);

  assert.equal(rules.isAllowed('/pages/kontakt'), true, 'our own group applies, not the wildcard');
  assert.equal(rules.isAllowed('/pages/tajne'), false);
});

test('a group that bans us is obeyed even when the wildcard is permissive', () => {
  const text = 'User-agent: *\nDisallow:\n\nUser-agent: StoreLeadBot\nDisallow: /\n';
  assert.equal(parseRobots(text, UA).isAllowed('/pages/kontakt'), false);
});

test('the longest matching rule wins, so Allow can carve out an exception', () => {
  const text = `
User-agent: *
Disallow: /pages
Allow: /pages/kontakt
`;
  const rules = parseRobots(text, UA);

  assert.equal(rules.isAllowed('/pages/kontakt'), true);
  assert.equal(rules.isAllowed('/pages/inne'), false);
});

test('wildcards and end-anchors are honoured', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /*.json$\nDisallow: /a/*/b\n', UA);

  assert.equal(rules.isAllowed('/cart.json'), false);
  assert.equal(rules.isAllowed('/cart.json?x=1'), true, '$ anchors to the end');
  assert.equal(rules.isAllowed('/a/x/b'), false);
  assert.equal(rules.isAllowed('/a/b'), true);
});

test('consecutive User-agent lines share one group', () => {
  const text = 'User-agent: GPTBot\nUser-agent: StoreLeadBot\nDisallow: /pages\n';
  assert.equal(parseRobots(text, UA).isAllowed('/pages/kontakt'), false);
});

test('Crawl-delay is read', () => {
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: 10\n', UA).crawlDelaySeconds, 10);
  assert.equal(parseRobots('User-agent: *\nDisallow:\n', UA).crawlDelaySeconds, null);
});

test('the product token is what robots.txt matches on', () => {
  assert.equal(userAgentToken(UA), 'storeleadbot');
  assert.equal(userAgentToken('Mozilla/5.0 (Macintosh)'), 'mozilla');
});
