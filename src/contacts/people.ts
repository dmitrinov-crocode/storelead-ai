import { normalizeDomain } from '../lib/domain.js';
import type { FoundEmail } from './emails.js';
import { jsonLdBlocks, nodesByType } from './jsonld.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';

/**
 * Reading a person's name and role off the pages a shop publishes (task 4-04).
 *
 * The rule that shapes this module: a name is only accepted when something on
 * the page asserts that it belongs to a person — a JSON-LD `Person`, a role word
 * beside it, an introducing verb ("sklep prowadzi …"), or an address whose local
 * part spells it. Harvesting every capitalised pair of words would fill the
 * dashboard with "Polityka Prywatności" and "Kodeks Cywilny", and a fabricated
 * name reaching an outreach email is the single most damaging failure this
 * project has.
 *
 * The shape of a name is necessary but not sufficient: see `isConfirmedPerson`
 * for the second kind of evidence every accepted person must also carry.
 *
 * The AI half of 4-04 lives in `aboutAgent.ts`. It produces the same
 * `FoundPerson` shape and merges into the same deduplication, and it is the half
 * that can tell a founding story from a company name.
 */

/** The ladder of task 4-08, most senior first. */
export type RoleTitle =
  | 'CEO'
  | 'Founder'
  | 'Owner'
  | 'Co-Founder'
  | 'Head of Ecommerce'
  | 'CTO'
  | 'Ecommerce Manager'
  | 'Other';

export const ROLE_RANK: Record<RoleTitle, number> = {
  CEO: 0,
  Founder: 1,
  Owner: 2,
  'Co-Founder': 3,
  'Head of Ecommerce': 4,
  CTO: 5,
  'Ecommerce Manager': 6,
  Other: 7,
};

export type PersonSource = 'jsonld' | 'role_text' | 'ai_about' | 'email_local';

/**
 * How strongly a source asserts the person. A structural signal on the page
 * beats a model's reading of the same page — the markup was written on purpose,
 * the reading is an interpretation, however well grounded.
 */
const SOURCE_RANK: Record<PersonSource, number> = {
  jsonld: 0,
  role_text: 1,
  ai_about: 2,
  email_local: 3,
};

const PAGE_RANK: Record<ContactPageKind, number> = {
  about: 0,
  contact: 1,
  home: 2,
  privacy: 3,
  terms: 4,
};

export interface FoundPerson {
  name: string;
  /** Canonical title, or null when a name was found without one. */
  role: RoleTitle | null;
  /** The title as the shop wrote it, for display and for checking the mapping. */
  roleText: string | null;
  source: PersonSource;
  pageKind: ContactPageKind;
  pageUrl: string;
  evidence: string;
  /** Address whose local part spells this name, when one was found. */
  email: string | null;
}

const UPPER = 'A-ZĄĆĘŁŃÓŚŹŻ';
const LOWER = 'a-ząćęłńóśźż';
const NAME_TOKEN = `[${UPPER}][${LOWER}]{1,20}(?:-[${UPPER}][${LOWER}]{1,20})?`;
/** Two or three capitalised tokens: `Anna Kowalska`, `Jan Nowak-Kowalski`. */
const FULL_NAME = `${NAME_TOKEN}(?:\\s+${NAME_TOKEN}){1,2}`;

/**
 * Unicode word boundaries. JavaScript's `\b` counts only ASCII letters, so
 * `\bzałożyciel` matches *inside* `współzałożyciel` — the `ł` before it is not a
 * word character. That would file every co-founder as a founder.
 */
const B = String.raw`(?<![\p{L}])`;
const E = String.raw`(?![\p{L}])`;
/** Polish titles inflect (`założyciel`, `założycielka`, `właścicielką`). */
const TAIL = String.raw`[\p{L}]*`;

function roleRegex(body: string): RegExp {
  return new RegExp(`${B}(?:${body})${E}`, 'iu');
}

const ROLE_PATTERNS: readonly { role: RoleTitle; pattern: RegExp }[] = [
  {
    role: 'CEO',
    pattern: roleRegex(
      `ceo|chief executive officer|prezes(?:\\s+zarz[aą]du)?|dyrektor\\s+generaln${TAIL}`,
    ),
  },
  { role: 'Founder', pattern: roleRegex(`founder|za[lł]o[zż]yciel${TAIL}`) },
  { role: 'Owner', pattern: roleRegex(`owner|proprietor|w[lł]a[sś]ciciel${TAIL}`) },
  { role: 'Co-Founder', pattern: roleRegex(`co-?founder|wsp[oó][lł]za[lł]o[zż]yciel${TAIL}`) },
  {
    role: 'Head of Ecommerce',
    pattern: roleRegex(
      `head\\s+of\\s+e-?commerce|dyrektor\\s+e-?commerce|kierownik\\s+e-?commerce`,
    ),
  },
  { role: 'CTO', pattern: roleRegex(`cto|chief technology officer|dyrektor\\s+techniczn${TAIL}`) },
  {
    role: 'Ecommerce Manager',
    pattern: roleRegex(`e-?commerce\\s+manager|mene?[dż]?[zż]er\\s+e-?commerce|manager\\s+sklepu`),
  },
  {
    role: 'Other',
    pattern: roleRegex(`dyrektor${TAIL}|kierownik${TAIL}|mene?[dż]?[zż]er${TAIL}|manager`),
  },
];

/** Verbs that introduce the person behind the shop. */
const INTRODUCTIONS = new RegExp(
  `(?:prowadzi|za[lł]o[zż]y[lł]\\w*(?:\\s+przez)?|stworzy[lł]\\w*|za\\s+sklepem\\s+stoi|` +
    `founded\\s+by|started\\s+by|run\\s+by|created\\s+by|owned\\s+by)\\s+(${FULL_NAME})`,
  'g',
);

/** `Anna Kowalska — założycielka` and `Founder: Anna Kowalska`. */
const NAME_THEN_ROLE = new RegExp(
  `(${FULL_NAME})\\s*[,\\-–—|(]\\s*([${UPPER}${LOWER}\\s-]{3,40})`,
  'g',
);
const ROLE_THEN_NAME = new RegExp(
  `([${UPPER}${LOWER}\\s-]{3,40})\\s*[:\\-–—]\\s*(${FULL_NAME})`,
  'g',
);

/**
 * Capitalised words that are never a person. Legal and navigation copy is full of
 * title-case pairs, and every one of these was hit while checking Polish stores.
 */
const NAME_STOPWORDS = new Set(
  [
    // Polish legal and navigation copy
    'polityka',
    'prywatności',
    'prywatnosci',
    'prywatność',
    'regulamin',
    'regulaminu',
    'sklep',
    'sklepu',
    'sklepie',
    'dostawa',
    'dostawy',
    'zwroty',
    'zwrot',
    'reklamacje',
    'reklamacja',
    'kontakt',
    'warunki',
    'ochrona',
    'danych',
    'osobowych',
    'dane',
    'osobowe',
    'nasz',
    'nasza',
    'nasze',
    'firma',
    'firmy',
    'adres',
    'godziny',
    'otwarcia',
    'zamówienia',
    'płatności',
    'wysyłka',
    'koszyk',
    'konto',
    'strona',
    'główna',
    'kodeks',
    'cywilny',
    'ustawa',
    'ustawy',
    'klient',
    'klienta',
    'sprzedawca',
    'sprzedawcy',
    'kupujący',
    'konsument',
    'rzeczypospolitej',
    'polskiej',
    'polska',
    'unii',
    'europejskiej',
    'spółka',
    'spolka',
    'oddział',
    'urząd',
    'urzędu',
    'urzedu',
    'prezes',
    'prezesa',
    'inspektor',
    'inspektora',
    'administrator',
    'administratorem',
    // English
    'privacy',
    'policy',
    'terms',
    'service',
    'shipping',
    'returns',
    'refund',
    'contact',
    'about',
    'our',
    'team',
    'store',
    'shop',
    'cart',
    'account',
    'home',
    'cookie',
    'cookies',
    'rights',
    'reserved',
    'customer',
    'support',
    'company',
    'limited',
    'newsletter',
    'data',
    'protection',
    'office',
    'officer',
    'president',
    'personal',
    'authority',
    'controller',
    'department',
  ].map((word) => word.toLowerCase()),
);

/**
 * Pages people are read from.
 *
 * Privacy and terms are excluded on purpose. They are legal boilerplate: they
 * name data-protection authorities, controllers and DPOs, never the merchant you
 * write to. On keyshorts.com the sentence "President of the Personal Data
 * Protection Office (Prezes Urzędu Ochrony Danych Osobowych)" produced a person
 * called "Data Protection Office" with the title CEO, and it became the store's
 * primary contact. Addresses from those pages are still read — an EU shop is
 * obliged to publish one there — only names are not.
 */
const PERSON_PAGES: ReadonlySet<ContactPageKind> = new Set<ContactPageKind>([
  'home',
  'about',
  'contact',
]);

const WINDOW = 90;
const EVIDENCE_PADDING = 60;

/**
 * Canonical title for a fragment of page text, or null when it names no role.
 *
 * A person often lists several ("CEO & Co-Founder"); the most senior one is
 * returned, because that is what the ranking of 4-08 acts on.
 */
export function detectRole(text: string): { role: RoleTitle; matched: string } | null {
  let best: { role: RoleTitle; matched: string } | null = null;
  for (const { role, pattern } of ROLE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (best === null || ROLE_RANK[role] < ROLE_RANK[best.role]) {
      best = { role, matched: match[0].trim() };
    }
  }
  return best;
}

/** Rejects title-case fragments that are legal or navigation copy, not people. */
export function looksLikePersonName(candidate: string, storeDomain?: string): boolean {
  const tokens = candidate.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 3) return false;

  for (const token of tokens) {
    const word = token.replace(/[^\p{L}-]/gu, '').toLowerCase();
    if (word.length < 2) return false;
    if (NAME_STOPWORDS.has(word)) return false;
    for (const part of word.split('-')) {
      if (NAME_STOPWORDS.has(part)) return false;
    }
  }

  // A shop named "Anna Nova" must not become a person called Anna Nova.
  if (storeDomain !== undefined) {
    const normalized = normalizeDomain(storeDomain);
    const label = normalized?.domain.split('.')[0] ?? '';
    const collapsed = candidate.toLowerCase().replace(/[^a-z]/g, '');
    if (label.length > 3 && collapsed === label.replace(/[^a-z]/g, '')) return false;
  }

  return true;
}

function evidenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EVIDENCE_PADDING);
  const end = Math.min(text.length, index + length + EVIDENCE_PADDING);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** `anna.kowalska@` -> `anna kowalska`, for matching an address to a name. */
function emailNameKey(email: string): string {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at) : email;
  return (local.split('+')[0] ?? local)
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * Comparison key for a person's name: lowercase ASCII words, diacritics folded.
 * Exported because 4-08 deduplicates a searched person against a scraped one,
 * and "Anna Kowalska" from LinkedIn must collide with "Anna Kowalską" from the
 * About page rather than become a second row.
 */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/** The address that spells this person's name, if the shop published one. */
function emailForName(name: string, emails: readonly FoundEmail[]): string | null {
  const key = nameKey(name);
  const parts = key.split(' ').filter((part) => part.length > 1);
  if (parts.length < 2) return null;

  for (const candidate of emails) {
    const localKey = emailNameKey(candidate.email);
    if (localKey === key) return candidate.email;
    // `a.kowalska@` — an initial plus the surname is still a match.
    const initial = parts[0]?.[0] ?? '';
    const surname = parts[parts.length - 1] ?? '';
    if (localKey === `${initial} ${surname}` || localKey === `${initial}${surname}`) {
      return candidate.email;
    }
  }
  return null;
}

interface Candidate {
  name: string;
  role: RoleTitle | null;
  roleText: string | null;
  source: PersonSource;
  evidence: string;
}

function fromJsonLd(page: ScrapedPage): Candidate[] {
  const out: Candidate[] = [];
  for (const block of jsonLdBlocks(page.html)) {
    for (const node of nodesByType(block, 'Person')) {
      const name = typeof node['name'] === 'string' ? node['name'].trim() : '';
      if (name === '') continue;
      const title = typeof node['jobTitle'] === 'string' ? node['jobTitle'].trim() : null;
      const detected = title ? detectRole(title) : null;
      out.push({
        name,
        role: detected?.role ?? null,
        roleText: title,
        source: 'jsonld',
        evidence: `JSON-LD Person${title ? `: ${title}` : ''}`,
      });
    }
  }
  return out;
}

function fromText(page: ScrapedPage): Candidate[] {
  const out: Candidate[] = [];
  const text = page.text;

  const push = (name: string, index: number, length: number, roleSource: string) => {
    const detected = detectRole(roleSource);
    out.push({
      name: name.trim(),
      role: detected?.role ?? null,
      roleText: detected?.matched ?? null,
      source: 'role_text',
      evidence: evidenceAround(text, index, length),
    });
  };

  for (const match of text.matchAll(INTRODUCTIONS)) {
    const name = match[1];
    if (name === undefined) continue;
    // The role, if any, is stated near the introduction rather than inside it.
    const window = text.slice(
      Math.max(0, match.index - WINDOW),
      match.index + match[0].length + WINDOW,
    );
    push(name, match.index, match[0].length, window);
  }

  for (const match of text.matchAll(NAME_THEN_ROLE)) {
    const name = match[1];
    const role = match[2];
    if (name === undefined || role === undefined || !detectRole(role)) continue;
    push(name, match.index, match[0].length, role);
  }

  for (const match of text.matchAll(ROLE_THEN_NAME)) {
    const role = match[1];
    const name = match[2];
    if (name === undefined || role === undefined || !detectRole(role)) continue;
    push(name, match.index, match[0].length, role);
  }

  return out;
}

/** `anna.kowalska@sklep.pl` names a person even when the page never does. */
function fromEmails(emails: readonly FoundEmail[]): Candidate[] {
  const out: Candidate[] = [];
  for (const email of emails) {
    if (email.bucket !== 'personal') continue;
    const parts = emailNameKey(email.email)
      .split(' ')
      .filter((part) => part.length > 1);
    if (parts.length !== 2) continue;

    const name = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
    out.push({
      name,
      role: null,
      roleText: null,
      source: 'email_local',
      evidence: `derived from ${email.email}`,
    });
  }
  return out;
}

/**
 * People named by the shop's own pages, deduplicated and ranked.
 *
 * Ordering is the ladder of task 4-08 — CEO before Founder before Owner — then
 * how strongly the source asserts the person, then which page it came from.
 */
export function extractPeople(
  pages: readonly ScrapedPage[],
  emails: readonly FoundEmail[] = [],
  storeDomain?: string,
): FoundPerson[] {
  const best = new Map<string, FoundPerson>();

  const consider = (candidate: Candidate, page: ScrapedPage): void => {
    if (!looksLikePersonName(candidate.name, storeDomain)) return;

    const person: FoundPerson = {
      name: candidate.name,
      role: candidate.role,
      roleText: candidate.roleText,
      source: candidate.source,
      pageKind: page.kind,
      pageUrl: page.url,
      evidence: candidate.evidence,
      email: emailForName(candidate.name, emails),
    };

    const key = nameKey(person.name);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, person);
      return;
    }
    // A sighting that also states a role beats one that only gives the name.
    if (existing.role === null && person.role !== null) {
      best.set(key, { ...person, email: person.email ?? existing.email });
      return;
    }
    if (person.role !== null || existing.role === null) {
      if (SOURCE_RANK[person.source] < SOURCE_RANK[existing.source]) {
        best.set(key, { ...person, email: person.email ?? existing.email });
      }
    }
  };

  for (const page of pages) {
    if (!PERSON_PAGES.has(page.kind)) continue;
    for (const candidate of fromJsonLd(page)) consider(candidate, page);
    for (const candidate of fromText(page)) consider(candidate, page);
  }

  // Addresses are page-independent; attribute them to the page they were seen on.
  for (const email of emails) {
    const page = pages.find((p) => p.url === email.pageUrl) ?? pages[0];
    if (!page) break;
    for (const candidate of fromEmails([email])) consider(candidate, page);
  }

  return [...best.values()].filter(isConfirmedPerson).sort(comparePeople);
}

/**
 * Whether the page did more than put two capitalised words next to a verb.
 *
 * Added after the first batch of real letters (2026-09-08). Two of twelve were
 * addressed to a company: `Salon Bmw Bawaria` reached the contacts through an
 * introducing verb, and `Best Expansion` through the name-then-role pattern with
 * the catch-all `Other` title. Both passed every shape heuristic — they are two
 * or three capitalised words with no stopword among them — and a letter opening
 * "Salon Bmw Bawaria," is worse than a letter opening with nothing.
 *
 * The shape of a name was never enough; what was missing is a second, different
 * kind of evidence that the name belongs to a person:
 *
 *   - the page marked it up as a `Person` in JSON-LD, or
 *   - an address on the page spells it, or
 *   - a specific title sits beside it — CEO, Founder, Owner and the rest of the
 *     4-08 ladder, but not `Other`, which matches any `dyrektor` or `manager`
 *     and is exactly what let a company through.
 *
 * This costs real contacts: someone introduced as "za sklepem stoi Anna
 * Kowalska", with no title and no address, is now dropped. That is the trade the
 * epic has made everywhere else too — a missing contact is a gap a human can
 * see, an invented one is a mistake that goes out over our name.
 *
 * The web-search people of 4-07 do not pass through here. Their confirmation is
 * the LinkedIn profile itself, which is why a title is not required of them.
 */
export function isConfirmedPerson(person: FoundPerson): boolean {
  if (person.source === 'jsonld') return true;
  // The about reader's confirmation is its quote, verified against the page in
  // `aboutAgent.ts`: a name that got here came with a sentence that names it.
  if (person.source === 'ai_about') return true;
  if (person.source === 'email_local') return true;
  if (person.email !== null) return true;
  return person.role !== null && person.role !== 'Other';
}

function comparePeople(a: FoundPerson, b: FoundPerson): number {
  const rankA = a.role === null ? ROLE_RANK.Other + 1 : ROLE_RANK[a.role];
  const rankB = b.role === null ? ROLE_RANK.Other + 1 : ROLE_RANK[b.role];
  if (rankA !== rankB) return rankA - rankB;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) {
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  }
  if (PAGE_RANK[a.pageKind] !== PAGE_RANK[b.pageKind]) {
    return PAGE_RANK[a.pageKind] - PAGE_RANK[b.pageKind];
  }
  return a.name.localeCompare(b.name);
}
