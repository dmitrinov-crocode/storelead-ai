import { normalizeDomain } from '../lib/domain.js';

/**
 * Deciding whether a name, a slug or a sentence is about *this* shop.
 *
 * It lives in its own module because two very different callers need it and
 * importing one from the other would make a cycle: 4-09 scores a contact partly
 * on whether its LinkedIn slug matches the brand, and 4-07 refuses a search hit
 * outright unless something ties it to the shop. The second is the stricter use
 * — a LinkedIn profile pulled off a search result page with no link back to the
 * merchant is some other Anna Kowalska, and filing her as the contact would be a
 * fabricated lead dressed up as a found one.
 */

/** The shop's own label: `sklep-anna.pl` -> `sklepanna`. */
export function domainLabel(storeDomain: string): string {
  const normalized = normalizeDomain(storeDomain);
  const label = normalized?.domain.split('.')[0] ?? '';
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Letters and digits only, diacritics folded: `Sklep Anną` -> `sklepanna`. */
export function collapse(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Labels that name a category, not a shop.
 *
 * `domainLabel('sklep.pl')` is `sklep`, which is simply the Polish for "shop" —
 * it appears in the headline of every merchant in the market. Matching on it
 * would tie any e-commerce profile in Poland to this one store, which is the
 * fabricated-contact failure wearing a different hat. A generic label is not
 * refused outright: the full hostname (`skleppl`) is still distinctive, and so
 * is a multi-word brand, so those two paths remain open.
 */
const GENERIC_LABELS: ReadonlySet<string> = new Set([
  'sklep',
  'sklepy',
  'sklepik',
  'zakupy',
  'moda',
  'buty',
  'odziez',
  'meble',
  'kosmetyki',
  'prezenty',
  'shop',
  'store',
  'shopping',
  'market',
  'online',
  'ecommerce',
  'outlet',
  'boutique',
  'butik',
  'fashion',
  'style',
  'home',
  'design',
  'brand',
  'group',
  'company',
]);

/** The shop's whole hostname, collapsed: `sklep-anna.pl` -> `sklepannapl`. */
function domainKey(storeDomain: string): string {
  return collapse(normalizeDomain(storeDomain)?.domain ?? storeDomain);
}

/** A label distinctive enough to identify the shop on its own. */
function distinctive(value: string): boolean {
  return value.length >= 4 && !GENERIC_LABELS.has(value);
}

/**
 * Whether a LinkedIn slug plausibly names this shop rather than someone else.
 *
 * Short labels are refused: a three-letter shop would match half of LinkedIn.
 */
export function slugMatchesBrand(slug: string, storeDomain: string): boolean {
  const collapsed = collapse(slug);
  if (collapsed === '') return false;

  const key = domainKey(storeDomain);
  if (key.length >= 4 && (collapsed.includes(key) || key.includes(collapsed))) return true;

  const label = domainLabel(storeDomain);
  if (!distinctive(label)) return false;
  return collapsed.includes(label) || label.includes(collapsed);
}

/**
 * Whether a fragment of text — a SERP title or snippet — names this shop.
 *
 * Three spellings are tried, because a profile can name the shop in three
 * places: the whole hostname (`sklep-anna.pl`, which merchants put in the
 * website field), the domain's label, and the brand as a human writes it
 * (`Sklep Anna`, which is what a headline says). Collapsing both sides makes the
 * comparison indifferent to spacing, case and Polish diacritics.
 */
export function textMentionsBrand(
  text: string,
  storeDomain: string,
  brand?: string | null,
): boolean {
  const haystack = collapse(text);
  if (haystack === '') return false;

  const key = domainKey(storeDomain);
  if (key.length >= 4 && haystack.includes(key)) return true;

  const label = domainLabel(storeDomain);
  if (distinctive(label) && haystack.includes(label)) return true;

  const collapsedBrand = brand ? collapse(brand) : '';
  return distinctive(collapsedBrand) && haystack.includes(collapsedBrand);
}
