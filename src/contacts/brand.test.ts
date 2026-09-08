import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapse, domainLabel, slugMatchesBrand, textMentionsBrand } from './brand.js';

test('collapsing folds Polish spelling onto one comparable form', () => {
  assert.equal(collapse('Sklep Anną'), 'sklepanna');
  assert.equal(collapse('Maxton-Design'), 'maxtondesign');
  assert.equal(collapse('Łódź'), 'lodz');
  assert.equal(domainLabel('https://www.sklep-anna.pl/o-nas'), 'sklepanna');
});

test('a category word is not a brand, however long it is', () => {
  // "sklep" is the Polish for "shop" and appears in the headline of every
  // merchant in the market; tying on it would make every one of them this store.
  assert.equal(textMentionsBrand('Jan Nowak - Founder - Inny Sklep', 'sklep.pl'), false);
  assert.equal(textMentionsBrand('Founder at an online store', 'store.com'), false);
  assert.equal(slugMatchesBrand('jan-nowak-sklep', 'sklep.pl'), false);
});

test('the full hostname stays distinctive even when the label is generic', () => {
  assert.equal(textMentionsBrand('Prowadzę sklep.pl od 2019 roku.', 'sklep.pl'), true);
  assert.equal(slugMatchesBrand('sklep-pl', 'sklep.pl'), true);
});

test('a distinctive label matches on its own, in text or in a slug', () => {
  assert.equal(textMentionsBrand('Founder - Maxton Design', 'maxtondesign.com'), true);
  assert.equal(slugMatchesBrand('anna-maxtondesign', 'maxtondesign.com'), true);
  assert.equal(textMentionsBrand('Founder - Some Agency', 'maxtondesign.com'), false);
});

test('a multi-word brand ties even when the domain label does not appear', () => {
  assert.equal(
    textMentionsBrand('Anna Kowalska - CEO - Sklep Anna', 'annakowalska-shop.pl', 'Sklep Anna'),
    true,
  );
  // …but a generic brand string is refused the same way a generic label is.
  assert.equal(textMentionsBrand('praca w sklepie', 'zakupy24.pl', 'Sklep'), false);
});

test('a shop name too short to identify anything matches nothing', () => {
  assert.equal(slugMatchesBrand('anna-kowalska', 'ab.pl'), false);
  assert.equal(textMentionsBrand('cokolwiek', 'ab.pl'), false);
});
