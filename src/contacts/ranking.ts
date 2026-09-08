import { slugMatchesBrand } from './brand.js';
import type { StoreContacts } from './collect.js';
import type { EmailSource, FoundEmail } from './emails.js';
import type { ContactPageKind } from './pageScraper.js';
import { nameKey, ROLE_RANK, type FoundPerson, type RoleTitle } from './people.js';
import type { SerpPerson } from './serp.js';
import type { LinkedInLink, LinkedInTarget } from './social.js';

export { slugMatchesBrand } from './brand.js';

/**
 * Turning what the pages offered into ranked, scored contact rows (tasks 4-08, 4-09).
 *
 * Two decisions live here, and both are made in code rather than by an agent:
 * who to write to first, and how much the contact is trusted. The score is a sum
 * of stated weights, so a number in the dashboard can always be explained by
 * pointing at the rows below — the same discipline the lead score follows in 3-08.
 */

/** The `source` column of the `contacts` table. */
export type ContactSource =
  'about_page' | 'footer' | 'generic_email' | 'web_search' | 'linkedin_serp';

export interface ContactCandidate {
  name: string | null;
  role: RoleTitle | null;
  roleText: string | null;
  email: string | null;
  linkedinUrl: string | null;
  source: ContactSource;
  sourceUrl: string | null;
  /** 0…1, rounded to two decimals. */
  confidence: number;
  isGeneric: boolean;
  evidence: string;
}

/**
 * Weights of task 4-09. Kept as one table so the score can be read off it, and
 * so a calibration pass in Milestone 2 has a single place to change.
 *
 * They are scaled so that the best case a storefront can produce — a JSON-LD
 * `Person` with a title, a `mailto:` on the shop's own domain that spells the
 * name, and a LinkedIn profile whose slug matches the domain — lands on exactly
 * 1.00. Weights that overshoot would clamp, and every well-evidenced contact
 * would then score the same 1.00 as the merely good ones.
 */
export const CONFIDENCE_WEIGHTS = {
  /** Base: how strongly the page asserted this is a person at all. */
  person: { jsonld: 0.45, role_text: 0.35, ai_about: 0.35, email_local: 0.2 },
  /** Base for a shared mailbox — it is a real address, just not a person. */
  genericBase: 0.2,
  /**
   * Base for a person a web search found rather than the shop (tasks 4-05…4-07).
   *
   * Below every storefront source on purpose. The shop asserting "our founder is
   * Anna" is evidence; a search engine returning a profile that mentions the shop
   * is a suggestion. With a title and a matching slug a searched contact tops out
   * at 0.50, so it can never outrank a well-evidenced contact the storefront
   * published — which is exactly the order a human reviewing the row wants.
   */
  serpBase: 0.3,
  /** How the address itself was found. */
  emailSource: { mailto: 0.08, jsonld: 0.08, obfuscated: 0.04, text: 0 } as Record<
    EmailSource,
    number
  >,
  /** The mailbox is on the shop's own domain. */
  ownDomain: 0.15,
  /** …and the penalty when it is on somebody else's. */
  foreignDomain: -0.08,
  /** A title was found, not just a name. */
  hasRole: 0.08,
  /** The address spells the person's name. */
  nameMatchesEmail: 0.08,
  /** A LinkedIn profile backs the person up. */
  linkedinProfile: 0.08,
  /** The LinkedIn slug matches the shop's domain — the link is about this shop. */
  brandMatch: 0.04,
  /** Found on the About or Contact page rather than buried in the policies. */
  tellingPage: 0.04,
} as const;

/** Pages that exist to introduce the shop, as opposed to legal boilerplate. */
const TELLING_PAGES: ReadonlySet<ContactPageKind> = new Set<ContactPageKind>(['about', 'contact']);

function clamp(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

interface ScoreInput {
  person?: FoundPerson;
  /** A person a search found. Mutually exclusive with `person`. */
  serp?: SerpPerson;
  email?: FoundEmail;
  linkedin?: LinkedInTarget;
  storeDomain: string;
}

/**
 * Confidence for one contact row (task 4-09).
 *
 * Exported on its own so the weights can be exercised directly: a score built
 * from six modifiers is only trustworthy while each one is pinned by a test.
 */
export function scoreContact(input: ScoreInput): number {
  const { person, serp, email, linkedin, storeDomain } = input;
  const w = CONFIDENCE_WEIGHTS;

  let score = person ? w.person[person.source] : serp ? w.serpBase : w.genericBase;

  if (serp) {
    if (serp.role !== null) score += w.hasRole;
    score += w.linkedinProfile;
    if (slugMatchesBrand(serp.slug, storeDomain)) score += w.brandMatch;
  }

  if (email) {
    score += w.emailSource[email.source];
    score += email.ownDomain ? w.ownDomain : w.foreignDomain;
    if (TELLING_PAGES.has(email.pageKind)) score += w.tellingPage;
  }

  if (person) {
    if (person.role !== null) score += w.hasRole;
    if (person.email !== null) score += w.nameMatchesEmail;
    if (!email && TELLING_PAGES.has(person.pageKind)) score += w.tellingPage;
  }

  if (linkedin) {
    if (linkedin.kind === 'profile') score += w.linkedinProfile;
    if (slugMatchesBrand(linkedin.slug, storeDomain)) score += w.brandMatch;
  }

  return clamp(score);
}

/** A link the shop published carries the page it was found on; a searched one does not. */
function isStorefrontLink(link: LinkedInTarget): link is LinkedInLink {
  return 'pageUrl' in link;
}

/** Where a contact was read, mapped onto the `source` values the schema allows. */
function sourceOf(person: FoundPerson | undefined, email: FoundEmail | undefined): ContactSource {
  const kind = person?.pageKind ?? email?.pageKind;
  return kind === 'about' ? 'about_page' : 'footer';
}

/**
 * Ranked contact rows for one store (task 4-08).
 *
 * Order is the ladder of the plan: a named person by seniority first, then
 * anyone named without a title, and shared mailboxes last — writing to `info@`
 * is what you do when there is no person to write to. Within a tier the higher
 * confidence wins, so the row a human sees first is the best-evidenced one.
 */
export function buildContactCandidates(
  contacts: StoreContacts,
  storeDomain: string,
  serpPeople: readonly SerpPerson[] = [],
  serpCompany: LinkedInTarget | null = null,
): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const usedEmails = new Set<string>();
  /** Rows for people the storefront named, by name key, so 4-07 can find them. */
  const scraped = new Map<
    string,
    { row: ContactCandidate; person: FoundPerson; email?: FoundEmail }
  >();

  const profile = contacts.linkedin.find((link) => link.kind === 'profile');
  const company = contacts.linkedin.find((link) => link.kind === 'company');

  for (const person of contacts.people) {
    const email = person.email
      ? contacts.personalEmails.find((candidate) => candidate.email === person.email)
      : undefined;
    if (email) usedEmails.add(email.email);

    // Only a personal profile is attributed to a person; a company page belongs
    // to the shop and would inflate every row it touched.
    const linkedin = profile;

    const row: ContactCandidate = {
      name: person.name,
      role: person.role,
      roleText: person.roleText,
      email: email?.email ?? null,
      linkedinUrl: linkedin?.url ?? null,
      source: sourceOf(person, email),
      sourceUrl: person.pageUrl,
      confidence: scoreContact({
        person,
        ...(email ? { email } : {}),
        ...(linkedin ? { linkedin } : {}),
        storeDomain,
      }),
      isGeneric: false,
      evidence: person.evidence,
    };
    out.push(row);
    scraped.set(nameKey(person.name), { row, person, ...(email ? { email } : {}) });
  }

  // People a web search found (tasks 4-05…4-07). A search hit for somebody the
  // storefront already named is not a second contact — it is the profile link
  // that row was missing, and merging it there is worth more than a duplicate.
  for (const found of serpPeople) {
    const match = scraped.get(nameKey(found.name));
    if (match) {
      if (match.row.linkedinUrl === null) {
        match.row.linkedinUrl = found.linkedinUrl;
        match.row.confidence = scoreContact({
          person: match.person,
          ...(match.email ? { email: match.email } : {}),
          linkedin: { url: found.linkedinUrl, kind: 'profile', slug: found.slug },
          storeDomain,
        });
        // The role the storefront never stated may be in the LinkedIn headline.
        if (match.row.role === null && found.role !== null) {
          match.row.role = found.role;
          match.row.roleText = found.roleText;
        }
      }
      continue;
    }

    out.push({
      name: found.name,
      role: found.role,
      roleText: found.roleText,
      email: null,
      linkedinUrl: found.linkedinUrl,
      source: 'linkedin_serp',
      sourceUrl: found.linkedinUrl,
      confidence: scoreContact({ serp: found, storeDomain }),
      isGeneric: false,
      evidence: `web search (${found.query}) — ${found.evidence}`,
    });
  }

  // Personal-looking addresses nobody claimed: `anna@` with no name on the page.
  for (const email of contacts.personalEmails) {
    if (usedEmails.has(email.email)) continue;
    out.push({
      name: null,
      role: null,
      roleText: null,
      email: email.email,
      linkedinUrl: null,
      source: sourceOf(undefined, email),
      sourceUrl: email.pageUrl,
      confidence: scoreContact({ email, storeDomain }),
      isGeneric: false,
      evidence: email.evidence,
    });
  }

  for (const email of contacts.genericEmails) {
    out.push({
      name: null,
      role: null,
      roleText: null,
      email: email.email,
      linkedinUrl: null,
      source: 'generic_email',
      sourceUrl: email.pageUrl,
      confidence: scoreContact({ email, storeDomain }),
      isGeneric: true,
      evidence: email.evidence,
    });
  }

  // A company page with nobody attached is still a lead worth keeping: it is the
  // "somebody to look up" column, and for a shop where no person could be found
  // it is the only one with anything in it. The shop's own link wins over the
  // searched one for the usual reason — the shop asserted it.
  if (!out.some((row) => row.linkedinUrl !== null)) {
    const fallback = company ?? serpCompany;
    if (fallback) {
      const fromStorefront = isStorefrontLink(fallback);
      out.push({
        name: null,
        role: null,
        roleText: null,
        email: null,
        linkedinUrl: fallback.url,
        source: fromStorefront ? 'footer' : 'linkedin_serp',
        sourceUrl: fromStorefront ? fallback.pageUrl : fallback.url,
        confidence: scoreContact({ linkedin: fallback, storeDomain }),
        isGeneric: false,
        evidence: fromStorefront
          ? `LinkedIn company page linked from ${fallback.pageKind}`
          : 'LinkedIn company page found by web search',
      });
    }
  }

  return out.sort(compareCandidates);
}

/** Named people by seniority, then unnamed personal addresses, then shared mailboxes. */
function compareCandidates(a: ContactCandidate, b: ContactCandidate): number {
  if (a.isGeneric !== b.isGeneric) return a.isGeneric ? 1 : -1;

  const namedA = a.name === null ? 1 : 0;
  const namedB = b.name === null ? 1 : 0;
  if (namedA !== namedB) return namedA - namedB;

  const rankA = a.role === null ? ROLE_RANK.Other + 1 : ROLE_RANK[a.role];
  const rankB = b.role === null ? ROLE_RANK.Other + 1 : ROLE_RANK[b.role];
  if (rankA !== rankB) return rankA - rankB;

  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return (a.email ?? a.linkedinUrl ?? '').localeCompare(b.email ?? b.linkedinUrl ?? '');
}
