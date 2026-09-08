import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectRepetition,
  jaccard,
  normaliseText,
  shingles,
  similarity,
  SIMILARITY_THRESHOLD,
} from './similarity.js';

/** The template failure this module exists to catch: same letter, swapped facts. */
const TEMPLATE_A =
  'Anna, sprawdziłem wasz sklep na telefonie i przycisk dodania do koszyka nic nie robi na ' +
  'stronie produktu. Wygląda na to, że klienci nie mogą kupić. Czy wiecie o tym?';
const TEMPLATE_B =
  'Piotr, sprawdziłem wasz sklep na telefonie i przycisk dodania do koszyka nic nie robi na ' +
  'stronie produktu. Wygląda na to, że klienci nie mogą kupić. Czy wiecie o tym?';
const DIFFERENT =
  'Dzień dobry, wasza strona ładuje się ponad sześć sekund na telefonie, a wynik PageSpeed to ' +
  'dwadzieścia cztery na sto. Ile z tego ruchu udaje się utrzymać?';

test('normalising folds case, diacritics and punctuation', () => {
  assert.deepEqual(normaliseText('Anno, ŁÓDŹ — sklep!'), ['anno', 'lodz', 'sklep']);
  assert.deepEqual(normaliseText('   '), []);
});

test('shingles are overlapping four-word windows', () => {
  const set = shingles('one two three four five');
  assert.deepEqual([...set], ['one two three four', 'two three four five']);
});

test('a text shorter than a window still yields one shingle', () => {
  // Otherwise two short drafts both look empty and score a meaningless zero.
  assert.deepEqual([...shingles('krótkie pismo')], ['krotkie pismo']);
});

test('jaccard is symmetric and bounded', () => {
  const a = shingles(TEMPLATE_A);
  const b = shingles(DIFFERENT);
  assert.equal(jaccard(a, b), jaccard(b, a));
  assert.ok(jaccard(a, b) >= 0 && jaccard(a, b) <= 1);
  assert.equal(jaccard(a, a), 1);
  assert.equal(jaccard(a, new Set()), 0);
});

test('the same letter with a different name is caught as a repeat', () => {
  const score = similarity(TEMPLATE_A, TEMPLATE_B);
  assert.ok(score > SIMILARITY_THRESHOLD, `expected a repeat, got ${score}`);
});

test('two letters about different findings are not repeats', () => {
  const score = similarity(TEMPLATE_A, DIFFERENT);
  assert.ok(score < SIMILARITY_THRESHOLD, `expected distinct letters, got ${score}`);
});

test('shared ordinary language does not make two letters alike', () => {
  // Both mention a phone and a product page — the vocabulary of every letter we
  // write. Measuring the topic instead of the sentences would flag these.
  const a = 'Na telefonie na stronie produktu nie da się dodać niczego do koszyka.';
  const b = 'Na telefonie na stronie produktu zdjęcia ładują się bardzo długo.';
  assert.ok(similarity(a, b) < SIMILARITY_THRESHOLD);
});

test('the closest earlier letter is named, so a human can compare them', () => {
  const result = detectRepetition(TEMPLATE_A, [
    { id: 7, store_id: 3, body: DIFFERENT },
    { id: 9, store_id: 4, body: TEMPLATE_B },
  ]);

  assert.equal(result.repeats, true);
  assert.deepEqual(result.closest, { id: 9, storeId: 4 });
  assert.equal(result.compared, 2);
});

test('the first letter ever written repeats nothing', () => {
  const result = detectRepetition(TEMPLATE_A, []);

  assert.equal(result.similarity, 0);
  assert.equal(result.repeats, false);
  assert.equal(result.closest, null);
});

test('the threshold can be moved for the calibration of 5-09', () => {
  const earlier = [{ id: 1, store_id: 1, body: TEMPLATE_B }];

  // The same pair, both verdicts: the default is a starting point, and the
  // twenty-letter review is what decides where the line really sits.
  assert.equal(detectRepetition(TEMPLATE_A, earlier).repeats, true);
  const strict = detectRepetition(TEMPLATE_A, earlier, { threshold: 0.99 });
  assert.equal(strict.repeats, false);
  assert.equal(strict.threshold, 0.99);
  assert.equal(strict.similarity, detectRepetition(TEMPLATE_A, earlier).similarity);
});

test('two letters with the same subject are caught even when the bodies differ', () => {
  // The 2026-09-08 batch produced exactly this: `koszyk zostaje pusty po
  // dodaniu produktu` twice, with bodies 0% alike. The subject is the first
  // thing a merchant sees, and two of them word for word is the template tell.
  const subject = 'koszyk zostaje pusty po dodaniu produktu';
  const withSubject = detectRepetition({ subject, body: TEMPLATE_A }, [
    { id: 1, store_id: 2, subject, body: DIFFERENT },
  ]);
  const withoutSubject = detectRepetition({ body: TEMPLATE_A }, [
    { id: 1, store_id: 2, body: DIFFERENT },
  ]);

  assert.ok(withSubject.similarity > withoutSubject.similarity);
});

test('a draft may still be passed as a bare string', () => {
  assert.equal(
    detectRepetition(TEMPLATE_A, [{ id: 1, store_id: 1, body: TEMPLATE_B }]).repeats,
    true,
  );
});
