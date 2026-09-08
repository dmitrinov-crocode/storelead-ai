/**
 * The repetition detector (task 5-07).
 *
 * The failure it exists to catch is the one that kills a campaign quietly. Each
 * letter looks fine on its own; it is only when twenty of them sit side by side
 * that the shared scaffolding shows — the same opening, the same hinge sentence,
 * the same closing question, with a shop name and a metric swapped in. Merchants
 * talk to each other, and a template is obvious the moment two of them compare.
 *
 * Word shingles with Jaccard, not TF-IDF. The plan allows either, and shingles
 * are the better fit here: TF-IDF measures whether two texts are *about* the
 * same thing, which every letter we write is — broken carts and slow phones.
 * Shingles measure whether they are *made of the same sentences*, which is the
 * actual question. Four-word windows are short enough to catch a reworded
 * sentence and long enough that two letters sharing only ordinary language
 * ("na telefonie", "on the product page") do not look alike.
 */

/** Window size. Four words: long enough to be a phrase, short enough to survive edits. */
export const SHINGLE_SIZE = 4;

/**
 * Similarity above which a draft counts as a repeat.
 *
 * **Uncalibrated.** It is a starting point, not a measurement: two letters
 * sharing 40% of their four-word sequences are substantially the same text, but
 * where the real line sits is exactly what the twenty-letter review of 5-09 is
 * for. It lives here as one named constant so that pass can move it in one place.
 */
export const SIMILARITY_THRESHOLD = 0.4;

/** Lowercase, diacritics folded, punctuation dropped, whitespace collapsed. */
export function normaliseText(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/**
 * The set of overlapping word windows in a text.
 *
 * A text shorter than one window yields a single shingle of everything it has,
 * so two very short drafts still compare rather than both looking empty and
 * scoring a meaningless 0.
 */
export function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const words = normaliseText(text);
  if (words.length === 0) return new Set();
  if (words.length <= size) return new Set([words.join(' ')]);

  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) {
    out.add(words.slice(i, i + size).join(' '));
  }
  return out;
}

/** Jaccard: shared windows over all windows either text has. 0…1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  // Iterate the smaller set: the result is symmetric, the work need not be.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : Math.round((shared / union) * 1000) / 1000;
}

export function similarity(a: string, b: string, size = SHINGLE_SIZE): number {
  return jaccard(shingles(a, size), shingles(b, size));
}

export interface EarlierLetter {
  id: number;
  store_id: number;
  /** Compared alongside the body — see `letterText`. */
  subject?: string | null;
  body: string;
}

/**
 * Subject and body as one text.
 *
 * The first batch of real letters (2026-09-08) produced two with the identical
 * subject `koszyk zostaje pusty po dodaniu produktu` and bodies only 0% alike.
 * A subject line is one sentence in a hundred-word letter, so it barely moves a
 * similarity score — but it is the first thing a merchant sees, and two of them
 * word for word is exactly the template signal the detector exists to catch.
 * Weighting it would need calibration; including it costs nothing and makes an
 * exact repeat visible.
 */
export function letterText(letter: { subject?: string | null; body: string }): string {
  return letter.subject ? `${letter.subject}\n${letter.body}` : letter.body;
}

export interface RepetitionResult {
  /** Highest similarity against any earlier letter, 0 when there are none. */
  similarity: number;
  /** The letter it most resembles, so a human can put them side by side. */
  closest: { id: number; storeId: number } | null;
  threshold: number;
  /** True when the draft is too close to something already written. */
  repeats: boolean;
  /** How many letters it was compared against. */
  compared: number;
}

/**
 * Compares a draft against everything written before it.
 *
 * Rejected drafts count. A letter that repeats one QC already refused is no
 * better than one that repeats a letter that went out — the shared scaffolding
 * is the problem, not the fate of the earlier draft.
 */
export function detectRepetition(
  draft: { subject?: string | null; body: string } | string,
  earlier: readonly EarlierLetter[],
  options: { threshold?: number; size?: number } = {},
): RepetitionResult {
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  const mine = shingles(typeof draft === 'string' ? draft : letterText(draft), options.size);

  let best = 0;
  let closest: { id: number; storeId: number } | null = null;

  for (const letter of earlier) {
    const score = jaccard(mine, shingles(letterText(letter), options.size));
    if (score > best) {
      best = score;
      closest = { id: letter.id, storeId: letter.store_id };
    }
  }

  return {
    similarity: best,
    closest,
    threshold,
    repeats: best >= threshold,
    compared: earlier.length,
  };
}
