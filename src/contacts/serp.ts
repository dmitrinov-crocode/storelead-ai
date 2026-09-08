import type { WebSearchHit } from '../collectors/websearch/provider.js';
import { collapse, domainLabel, slugMatchesBrand, textMentionsBrand } from './brand.js';
import { detectRole, looksLikePersonName, nameKey, ROLE_RANK, type RoleTitle } from './people.js';
import { parseLinkedInUrl, type LinkedInTarget } from './social.js';

/**
 * Reading a person off a LinkedIn search result (task 4-07).
 *
 * The plan is explicit that LinkedIn itself is never fetched — only what a
 * search engine already showed about it. That is the whole input here: a URL, a
 * title and a snippet.
 *
 * Everything in this module is deterministic string work, and that is the point.
 * The provider could have been asked to say who the founder is, and it would
 * have answered for every shop, including the ones with no founder on LinkedIn.
 * A SERP title, by contrast, has a shape — `Name - Role - Company | LinkedIn` —
 * and either it parses or it does not. Nothing here can produce a person the
 * search did not show.
 *
 * Three rules do the filtering, and the last two were rewritten after the first
 * live probe (5 Polish shops, 10 searches, 2026-09-08) contradicted the shape
 * this module was originally written against.
 *
 *   - **The name comes from the title, never from the slug.** A slug is a URL,
 *     not an assertion that anybody is called that; the title is what LinkedIn
 *     published as the person's name.
 *   - **Only the employer segment of the title, or the slug, ties a hit to the
 *     shop.** The probe also tied on the snippet, and every one of the six people
 *     it produced that way worked somewhere else: a recruiter quoting a
 *     `jobs@lamania.eu` posting, someone who had attended a lecture by the
 *     founder of Astrography. A brand in a snippet means the person's feed
 *     mentions the shop, not that they work there. The company in the title does
 *     mean that, and it was right for six of seven.
 *   - **The role is read from the snippet when the title has none.** The
 *     expected `Name - Role - Company` shape is rare; live titles are
 *     `Łukasz Pamuła – Maxton Design`, and reading roles from the title alone
 *     found none at all in thirteen people. The title is still preferred where
 *     it has one — that is the person's own headline — and the snippet is the
 *     fallback, where `### CEO, Founder` and `Founder/CEO at …` actually appear.
 */

/** What connected a search hit to the shop. Recorded as evidence, not scored. */
export type SerpMatch = 'title' | 'slug';

/** Where the role was read. A headline outranks a line in the snippet. */
export type RoleSource = 'title' | 'snippet';

export interface SerpPerson {
  name: string;
  role: RoleTitle | null;
  roleText: string | null;
  /** Null exactly when `role` is. */
  roleSource: RoleSource | null;
  /** Canonical `https://www.linkedin.com/in/{slug}`. */
  linkedinUrl: string;
  slug: string;
  match: SerpMatch;
  /** The query that surfaced this hit, so a bad template can be traced. */
  query: string;
  evidence: string;
}

export interface SerpReadOptions {
  storeDomain: string;
  /** The shop's name as the query used it, for matching a headline. */
  brand?: string | null;
  query: string;
}

/** LinkedIn's own suffix, in the spellings search engines produce. */
const LINKEDIN_SUFFIX = /\s*[|\-–—·]\s*linkedin\s*$/i;

/**
 * Separators LinkedIn titles use between name, role and company. Split on the
 * spaced forms only: `Nowak-Kowalski` must survive, and it is only ever hyphen
 * without spaces.
 */
const SEGMENTS = /\s+[–—|·]\s+|\s+-\s+/;

/** The title stripped of its suffix and cut into segments. */
export function titleSegments(title: string): string[] {
  return title
    .replace(LINKEDIN_SUFFIX, '')
    .split(SEGMENTS)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

const EVIDENCE_MAX = 240;

function evidenceFor(hit: WebSearchHit): string {
  const parts = [hit.title, hit.snippet].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  const joined = parts.join(' — ');
  return joined.length > EVIDENCE_MAX ? `${joined.slice(0, EVIDENCE_MAX - 1)}…` : joined;
}

/**
 * The person one hit names, or null when it names nobody we can stand behind.
 *
 * Exported on its own because the rejections are the interesting half: every
 * reason a hit is refused deserves a test, and testing them through the batch
 * function would hide which rule fired.
 */
export function readSerpHit(hit: WebSearchHit, options: SerpReadOptions): SerpPerson | null {
  const target = parseLinkedInUrl(hit.url);
  // Company pages name no person, and the outreach needs one.
  if (!target || target.kind !== 'profile') return null;

  const title = hit.title?.trim() ?? '';
  if (title === '') return null;

  const segments = titleSegments(title);
  const name = segments[0];
  if (name === undefined || !looksLikePersonName(name, options.storeDomain)) return null;
  if (isBrandAccount(name, options)) return null;

  // Everything after the name: the employer, and the role when the headline
  // states one. The name itself is excluded from both readings — a profile
  // headlined "Prezes" must not become a person called Prezes, and a person
  // whose surname happens to contain the brand must not tie on their own name.
  //
  // A segment that merely repeats the name is dropped with it. LinkedIn emits
  // `Anna Łacwik - Anna Łacwik | LinkedIn` for a profile with no headline, and
  // that second segment names no employer at all.
  const employer = segments
    .slice(1)
    .filter((segment) => nameKey(segment) !== nameKey(name))
    .join(' · ');

  const match = tieToShop(employer, target.slug, options);
  if (match === null) return null;

  const detected = detectRoleFor(employer, hit.snippet, name);

  return {
    name,
    role: detected?.role ?? null,
    roleText: detected?.matched ?? null,
    roleSource: detected?.from ?? null,
    linkedinUrl: target.url,
    slug: target.slug,
    match,
    query: options.query,
    evidence: evidenceFor(hit),
  };
}

/**
 * The role, from the headline if it states one and from the snippet otherwise.
 *
 * The order is the point. A headline is what the person says they are; a snippet
 * is whatever text the search chose to show, and it can quote somebody else's
 * title. Reading the headline first keeps the snippet as a fallback rather than
 * a competing source, and a snippet role that names somebody else is refused
 * outright — see `attributedToSomeoneElse`.
 */
function detectRoleFor(
  employer: string,
  snippet: string | null,
  personName: string,
): { role: RoleTitle; matched: string; from: RoleSource } | null {
  const fromTitle = employer === '' ? null : detectRole(employer);
  if (fromTitle) return { ...fromTitle, from: 'title' };

  if (snippet === null) return null;
  const fromSnippet = detectRole(snippet);
  if (!fromSnippet) return null;
  if (attributedToSomeoneElse(snippet, fromSnippet.matched, personName)) return null;
  return { ...fromSnippet, from: 'snippet' };
}

/**
 * A name immediately before the role, in the appositive shape both languages
 * use for attribution: `Adam Jesionkiewicz, założyciela`, `Wasilewska,`.
 *
 * One capitalised word only counts when a comma separates it from the role,
 * because that comma is what makes it an attribution rather than a compound
 * noun; two capitalised words count either way, being a full name.
 */
const ATTRIBUTION = /(\p{Lu}[\p{L}'’-]+)(?:\s+(\p{Lu}[\p{L}'’-]+))?(\s*,)?\s*$/u;

/**
 * Whether a role found in a snippet belongs to somebody other than this person.
 *
 * The 2026-09-08 probe made the case: Agata Kozielska was filed as Founder of
 * Orientana on the strength of "Wasilewska, założycielka marki Orientana" — a
 * sentence about a different woman that happened to sit in her snippet. Adam
 * Jesionkiewicz's "### CEO, Founder" has no name in front of it and is his own.
 *
 * The person's own name in front of the role is not somebody else, and keeps it.
 */
function attributedToSomeoneElse(snippet: string, matched: string, personName: string): boolean {
  const index = snippet.indexOf(matched);
  if (index <= 0) return false;

  const before = snippet.slice(Math.max(0, index - 60), index);
  const found = ATTRIBUTION.exec(before);
  if (!found) return false;

  const words = [found[1], found[2]].filter((word): word is string => word !== undefined);
  const hasComma = found[3] !== undefined;
  if (words.length === 1 && !hasComma) return false;

  const attributed = nameKey(words.join(' '));
  if (attributed === '') return false;
  // A surname alone still names this person when it is part of their name.
  const own = nameKey(personName);
  return attributed !== own && !own.split(' ').includes(attributed);
}

/**
 * Whether the "person" is really the shop's own brand account.
 *
 * `Gatta Manufaktura – GATTA | Ferax sp. z o.o.` passes every name heuristic —
 * two capitalised words, no stopwords — but it is the shop posting as itself.
 * The tell is the first word: a person is not named after the shop.
 */
function isBrandAccount(name: string, options: SerpReadOptions): boolean {
  const first = collapse(name.trim().split(/\s+/)[0] ?? '');
  if (first.length < 4) return false;

  const label = domainLabel(options.storeDomain);
  if (label.length >= 4 && first === label) return true;

  const brand = options.brand ? collapse(options.brand) : '';
  return brand.length >= 4 && first === brand;
}

/**
 * Which link to the shop this hit has, or null if it has none.
 *
 * The snippet is deliberately not consulted; see the note at the top of the
 * module for the six people it wrongly produced.
 *
 * A stated employer settles the question either way: when the title names a
 * company that is not the shop, the slug may not overrule it. `Bob Gatta -
 * TechVetta Solutions` was filed under gatta.pl because his surname is in his
 * slug, while his title said plainly where he works. The slug is what is left
 * when the title says nothing.
 */
function tieToShop(employer: string, slug: string, options: SerpReadOptions): SerpMatch | null {
  const { storeDomain, brand } = options;
  if (employer !== '') {
    return textMentionsBrand(employer, storeDomain, brand) ? 'title' : null;
  }
  return slugMatchesBrand(slug, storeDomain) ? 'slug' : null;
}

/**
 * The people a set of search hits names, deduplicated by profile and ranked.
 *
 * Order is the ladder of 4-08 — the senior title first — then how the hit was
 * tied to the shop, because an employer that names the merchant is a stronger
 * link than a slug that happens to contain the brand.
 */
export function extractSerpPeople(
  hits: readonly WebSearchHit[],
  options: SerpReadOptions,
): SerpPerson[] {
  const best = new Map<string, SerpPerson>();

  for (const hit of hits) {
    const person = readSerpHit(hit, options);
    if (!person) continue;
    const existing = best.get(person.slug);
    if (!existing || compareSerpPeople(person, existing) < 0) best.set(person.slug, person);
  }

  return [...best.values()].sort(compareSerpPeople);
}

/**
 * The shop's own LinkedIn company page, when the search returned it.
 *
 * Seven of the forty-five hits in the 2026-09-08 probe were exactly this, and
 * they were being thrown away. A company page names nobody, so it is not a
 * person — but it is the "somebody to look up" column of Epic 4, and for a shop
 * where no person could be found it is the only lead there is.
 *
 * The same tie discipline applies: the page must name the shop, in its slug or
 * in its title, or it is some other company with a similar name.
 */
export function extractSerpCompany(
  hits: readonly WebSearchHit[],
  options: SerpReadOptions,
): LinkedInTarget | null {
  for (const hit of hits) {
    const target = parseLinkedInUrl(hit.url);
    if (!target || target.kind !== 'company') continue;

    const title = hit.title?.replace(LINKEDIN_SUFFIX, '').trim() ?? '';
    const tied =
      slugMatchesBrand(target.slug, options.storeDomain) ||
      (title !== '' && textMentionsBrand(title, options.storeDomain, options.brand));
    if (tied) return target;
  }
  return null;
}

const MATCH_RANK: Record<SerpMatch, number> = { title: 0, slug: 1 };

/** Role rank comes from 4-08; a person with no title sorts after every titled one. */
function compareSerpPeople(a: SerpPerson, b: SerpPerson): number {
  const rankA = a.role === null ? Number.MAX_SAFE_INTEGER : ROLE_RANK[a.role];
  const rankB = b.role === null ? Number.MAX_SAFE_INTEGER : ROLE_RANK[b.role];
  if (rankA !== rankB) return rankA - rankB;
  if (MATCH_RANK[a.match] !== MATCH_RANK[b.match]) return MATCH_RANK[a.match] - MATCH_RANK[b.match];
  return a.name.localeCompare(b.name);
}
