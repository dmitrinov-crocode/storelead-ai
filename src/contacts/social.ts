import type { ContactPageKind, ScrapedPage } from './pageScraper.js';

/**
 * LinkedIn links a shop publishes about itself.
 *
 * The plan also sources LinkedIn from search-engine snippets (task 4-07, now in
 * `serp.ts`), but this is the source tried first: a shop's own footer costs
 * nothing and is already fetched by 4-01 — it usually links the company page,
 * and on small merchants often the owner's profile. It is also the more
 * trustworthy of the two, and 4-08 keeps it when both produce a link: the shop
 * itself asserts this one, where a SERP snippet only suggests one.
 *
 * Nothing here touches LinkedIn: the links are read out of the merchant's own
 * markup, never fetched (the plan forbids scraping LinkedIn).
 */

export type LinkedInKind = 'profile' | 'company';

/** A LinkedIn URL reduced to what identifies it, wherever it was found. */
export interface LinkedInTarget {
  /** Canonical `https://www.linkedin.com/{in|company}/{slug}`. */
  url: string;
  kind: LinkedInKind;
  slug: string;
}

export interface LinkedInLink extends LinkedInTarget {
  pageKind: ContactPageKind;
  pageUrl: string;
}

/**
 * Matches the link in raw markup rather than in the DOM, so an href inside a
 * `<meta>`, a JSON blob or a social-icon list is found the same way.
 * Country subdomains (`pl.linkedin.com`) are the norm in this segment.
 */
const LINKEDIN_PATTERN =
  /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company|pub)\/([a-z0-9%._-]{2,100})/gi;

/** Which page the link was found on, most telling first. */
const PAGE_RANK: Record<ContactPageKind, number> = {
  contact: 0,
  about: 1,
  home: 2,
  privacy: 3,
  terms: 4,
};

/**
 * Canonical form of one LinkedIn URL, or null when it is not one.
 *
 * Shared with the SERP reader of 4-07, which receives whole URLs rather than
 * markup: both halves of the epic must agree on what counts as a profile and on
 * how a slug is spelled, or the same person found twice would be stored twice.
 * `/pub/` is LinkedIn's legacy profile prefix and is normalised to `/in/`.
 */
/**
 * Slugs that are LinkedIn's own pages rather than anybody's.
 *
 * `/pub/dir/…` is the people directory, and a search for a short brand returns
 * it readily: the 2026-09-08 probe got `2300+ "Natu" profiles` and `800+ "Nago"
 * profiles` back as if they were profiles. The name heuristics refused them, but
 * a directory listing is not a person and should not reach them.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['dir', 'directory']);

export function parseLinkedInUrl(input: string): LinkedInTarget | null {
  const match = new RegExp(LINKEDIN_PATTERN.source, 'i').exec(input.trim());
  if (!match) return null;

  const rawSlug = match[2];
  if (rawSlug === undefined) return null;
  const slug = rawSlug.replace(/[._-]+$/, '').toLowerCase();
  if (slug === '' || RESERVED_SLUGS.has(slug)) return null;

  const kind: LinkedInKind = (match[1] ?? '').toLowerCase() === 'company' ? 'company' : 'profile';
  const path = kind === 'company' ? 'company' : 'in';
  return { url: `https://www.linkedin.com/${path}/${slug}`, kind, slug };
}

/**
 * LinkedIn links published by the shop, deduplicated.
 *
 * Personal profiles come first: a named human is what outreach needs, and a
 * company page is the fallback.
 */
export function extractLinkedIn(pages: readonly ScrapedPage[]): LinkedInLink[] {
  const best = new Map<string, LinkedInLink>();

  for (const page of pages) {
    for (const match of page.html.matchAll(LINKEDIN_PATTERN)) {
      const target = parseLinkedInUrl(match[0]);
      if (!target) continue;

      const link: LinkedInLink = { ...target, pageKind: page.kind, pageUrl: page.url };
      const existing = best.get(link.url);
      if (!existing || PAGE_RANK[link.pageKind] < PAGE_RANK[existing.pageKind]) {
        best.set(link.url, link);
      }
    }
  }

  return [...best.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'profile' ? -1 : 1;
    if (PAGE_RANK[a.pageKind] !== PAGE_RANK[b.pageKind]) {
      return PAGE_RANK[a.pageKind] - PAGE_RANK[b.pageKind];
    }
    return a.url.localeCompare(b.url);
  });
}
