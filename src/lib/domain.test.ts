import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDomain, toDomainKey } from './domain.js';

test('strips scheme, www, port, path and query', () => {
  const cases: [string, string][] = [
    ['shop.pl', 'shop.pl'],
    ['www.shop.pl', 'shop.pl'],
    ['https://shop.pl', 'shop.pl'],
    ['http://www.shop.pl', 'shop.pl'],
    ['https://www.shop.pl/collections/all?page=2', 'shop.pl'],
    ['https://shop.pl:443/', 'shop.pl'],
    ['https://shop.pl#anchor', 'shop.pl'],
    ['  https://shop.pl/  ', 'shop.pl'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toDomainKey(input), expected, `input: ${input}`);
  }
});

test('lowercases and drops a trailing FQDN dot', () => {
  assert.equal(toDomainKey('HTTPS://WWW.Shop.PL'), 'shop.pl');
  assert.equal(toDomainKey('Shop.PL.'), 'shop.pl');
});

test('keeps subdomains other than www', () => {
  assert.equal(toDomainKey('sklep.shop.pl'), 'sklep.shop.pl');
  assert.equal(toDomainKey('shop.myshopify.com'), 'shop.myshopify.com');
  // only a leading www. is removed, not one in the middle
  assert.equal(toDomainKey('www.www.shop.pl'), 'www.shop.pl');
  assert.equal(toDomainKey('shop.www.pl'), 'shop.www.pl');
});

test('punycodes IDN hostnames so one store yields one key', () => {
  const unicode = toDomainKey('żółć.pl');
  assert.equal(unicode, 'xn--kda4b0koi.pl');
  assert.equal(toDomainKey('https://WWW.ŻÓŁĆ.PL/'), unicode);
  assert.equal(toDomainKey('xn--kda4b0koi.pl'), unicode, 'already-punycode input is stable');
});

test('normalisation is idempotent', () => {
  const once = normalizeDomain('https://www.Shop.PL/x');
  assert.ok(once);
  const twice = normalizeDomain(once.domain);
  assert.deepEqual(twice, once);
});

test('returns a canonical https url alongside the key', () => {
  assert.deepEqual(normalizeDomain('http://www.shop.pl/a/b'), {
    domain: 'shop.pl',
    url: 'https://shop.pl',
  });
});

test('rejects input that is not a usable public domain', () => {
  const rejected = [
    null,
    undefined,
    '',
    '   ',
    'localhost',
    'example.com',
    'shop',
    '.pl',
    'shop..pl',
    '-shop.pl',
    'shop-.pl',
    '127.0.0.1',
    'http://192.168.0.1/',
    'ftp://shop.pl',
    'mailto:hi@shop.pl',
    'javascript:alert(1)',
    'http://[::1]/',
    'https://user:pw@shop.pl',
  ];
  for (const input of rejected) {
    assert.equal(toDomainKey(input as string), null, `should reject: ${String(input)}`);
  }
});
