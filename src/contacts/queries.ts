import { normalizeDomain } from '../lib/domain.js';
import { collapse } from './brand.js';

/**
 * Search templates for finding the person behind a shop (task 4-06).
 *
 * Pure string building, deliberately separate from the provider: the templates
 * are the part worth arguing about and iterating on, and they can be read and
 * tested without spending a search. The order matters — a store's query budget
 * is small (two by default), so the templates are listed best-first and the
 * caller takes the first N.
 *
 * Polish role words sit beside the English ones because the target segment is
 * Polish shops, and `założyciel` is what a Polish LinkedIn headline actually
 * says. Leaving them out would make the second-best query useless in the only
 * market we currently run against.
 */

/** LinkedIn profile paths live under `/in/`; the filter can only name the host. */
export const LINKEDIN_DOMAIN = 'linkedin.com';

export type ContactQueryKind = 'linkedin_profile' | 'linkedin_company' | 'open_web';

export interface ContactQuery {
  kind: ContactQueryKind;
  query: string;
  /** Passed to the provider as a filter, never folded into `query` as `site:`. */
  allowedDomains?: readonly string[];
  maxResults: number;
}

export interface QueryTarget {
  domain: string;
  /** The shop's name as StoreLeads reported it, when it reported one. */
  name?: string | null;
  /** Two-letter country, used to pick the role vocabulary and bias the locale. */
  country?: string | null;
}

/** Senior titles, in the vocabulary of the market the shop sells in. */
const ROLE_TERMS: Record<string, readonly string[]> = {
  EN: ['founder', 'CEO', 'owner'],
  PL: ['założyciel', 'właściciel', 'prezes'],
};

function roleTerms(country: string | null | undefined): string[] {
  const code = (country ?? '').toUpperCase();
  const local = ROLE_TERMS[code];
  // English terms always go in: Polish merchants routinely write "Founder" in a
  // LinkedIn headline even when the rest of the profile is in Polish.
  return local ? [...ROLE_TERMS['EN']!, ...local] : [...ROLE_TERMS['EN']!];
}

/**
 * The name to search for.
 *
 * StoreLeads sometimes gives the domain straight back as the name, which would
 * make the query `"sklep.pl" founder` — a string that appears in every footer of
 * the site and nowhere on LinkedIn. That case falls back to the domain's label,
 * de-slugged.
 *
 * Everything else keeps the name, spacing included. `"Eveline Cosmetics"` and
 * `"Evelinecosmetics"` are not the same query: the first is the phrase a
 * headline is written in, the second matches nothing a human ever typed.
 */
export function brandName(target: QueryTarget): string {
  const normalized = normalizeDomain(target.domain);
  const label = normalized?.domain.split('.')[0] ?? target.domain;

  const name = (target.name ?? '').trim();
  if (name !== '') {
    const collapsedName = collapse(name);
    // The name is the domain restated when it collapses onto the whole hostname,
    // or onto the label as a single unspaced token.
    const restatesDomain =
      collapsedName === collapse(normalized?.domain ?? target.domain) ||
      (collapsedName === collapse(label) && !/\s/.test(name));
    if (collapsedName !== '' && !restatesDomain) return name;
  }

  return label
    .split(/[-_]+/)
    .filter((part) => part !== '')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

/** `"…"` around a phrase, with any quotes of its own removed. */
function quoted(value: string): string {
  return `"${value.replace(/["']/g, '').trim()}"`;
}

function anyOf(terms: readonly string[]): string {
  return `(${terms.join(' OR ')})`;
}

/**
 * Queries for one shop, best first.
 *
 * 1. The brand plus a senior title, restricted to LinkedIn. This is the query
 *    the plan names, and the only one that returns a profile page directly.
 * 2. The bare domain, restricted to LinkedIn. Merchants put their shop's URL in
 *    the profile's website field, so this finds people whose headline never
 *    mentions the brand — the case where query 1 returns nothing.
 * 3. The open web. No domain filter: an "about the founder" interview or a press
 *    piece names people no LinkedIn search will, and 4-07 reads names only from
 *    LinkedIn hits, so this one exists to feed the AI half of 4-04 later.
 */
export function buildContactQueries(target: QueryTarget): ContactQuery[] {
  const brand = brandName(target);
  const roles = anyOf(roleTerms(target.country));
  const domain = normalizeDomain(target.domain)?.domain ?? target.domain;

  return [
    {
      kind: 'linkedin_profile',
      query: `${quoted(brand)} ${roles} linkedin.com/in`,
      allowedDomains: [LINKEDIN_DOMAIN],
      maxResults: 5,
    },
    {
      kind: 'linkedin_company',
      query: `${quoted(domain)} ${roles}`,
      allowedDomains: [LINKEDIN_DOMAIN],
      maxResults: 5,
    },
    {
      kind: 'open_web',
      query: `${quoted(brand)} ${roles} ecommerce`,
      maxResults: 5,
    },
  ];
}
