import { normalizeDomain } from '../lib/domain.js';
import { jsonLdBlocks, valuesByKey } from './jsonld.js';
import type { ContactPageKind, ScrapedPage } from './pageScraper.js';

/**
 * Reading email addresses off a scraped page (task 4-02) and deciding whether a
 * mailbox belongs to a person or to the shop (task 4-03).
 *
 * Four sources are read, in descending order of how much they prove: a `mailto:`
 * link, a JSON-LD `email` property, an obfuscated address, and finally a bare
 * address in the visible text. The source travels with the address because 4-09
 * scores confidence from it — an address only ever seen in body copy is weaker
 * evidence than one the shop linked itself.
 *
 * The classification is not cosmetic: `anna@` and `info@` lead to different
 * outreach, and the dashboard shows them in separate columns.
 */

export type EmailSource = 'mailto' | 'jsonld' | 'obfuscated' | 'text';

/** Which of the dashboard's contact columns an address belongs in (task 4-03). */
export type EmailBucket = 'personal' | 'generic';

export interface FoundEmail {
  /** Lowercased. The address as it will be stored and deduplicated. */
  email: string;
  bucket: EmailBucket;
  source: EmailSource;
  pageKind: ContactPageKind;
  pageUrl: string;
  /** Surrounding text, kept as evidence and as input for the name heuristics of 4-04. */
  evidence: string;
  /** The mailbox is on the shop's own domain rather than a third party's. */
  ownDomain: boolean;
}

/** Strength order: a link the shop wrote beats a string someone typed in a paragraph. */
const SOURCE_RANK: Record<EmailSource, number> = {
  mailto: 0,
  jsonld: 1,
  obfuscated: 2,
  text: 3,
};

/** Which page an address was found on, most telling first. */
const PAGE_RANK: Record<ContactPageKind, number> = {
  contact: 0,
  about: 1,
  home: 2,
  privacy: 3,
  terms: 4,
};

const EMAIL_PATTERN =
  /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}/gi;

/**
 * `anna at sklep dot pl`. Both words are required: a bare "at" alone would turn
 * "have a look at sklep.pl" into an address, and that sentence is common.
 * Bracketed forms are unambiguous and handled separately, by substitution.
 */
const BARE_WORD_OBFUSCATION =
  /([a-z0-9._%+-]{1,64})\s+(?:at|malpa|małpa)\s+([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*)\s+(?:dot|kropka)\s+([a-z]{2,24})/gi;

/** A TLD that is really a file extension: `logo@2x.png` is not an address. */
const FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'ico',
  'css',
  'js',
  'mjs',
  'json',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'mp4',
  'webm',
  'pdf',
  'zip',
]);

/** Domains that never belong to the merchant. */
const NOISE_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'yourdomain.com',
  'mydomain.com',
  'email.tld',
  'sentry.io',
  'sentry.wixpress.com',
  'shopify.com',
  'shopifyapps.com',
]);

/** Local parts that are placeholder copy rather than a mailbox. */
const NOISE_LOCALS = new Set([
  'youremail',
  'your-email',
  'your.email',
  'yourname',
  'email',
  'e-mail',
  'name',
  'firstname',
  'lastname',
  'username',
  'user',
  'someone',
  'example',
  'test',
]);

/**
 * Shared mailboxes. Matched against any segment of the local part, so
 * `info.sklep@`, `biuro-1@` and `kontakt+pl@` all land in the generic column.
 */
const GENERIC_TOKENS = new Set([
  // English
  'info',
  'hello',
  'contact',
  'contacts',
  'office',
  'support',
  'help',
  'helpdesk',
  'sales',
  'shop',
  'store',
  'orders',
  'order',
  'service',
  'customer',
  'customercare',
  'care',
  'team',
  'admin',
  'administrator',
  'webmaster',
  'postmaster',
  'hostmaster',
  'abuse',
  'billing',
  'invoice',
  'finance',
  'accounting',
  'legal',
  'privacy',
  'press',
  'media',
  'marketing',
  'newsletter',
  'wholesale',
  'partners',
  'partnership',
  'careers',
  'jobs',
  'recruitment',
  'noreply',
  'donotreply',
  'mailer',
  // Polish — the target segment writes these, not the English ones
  'kontakt',
  'biuro',
  'sklep',
  'zamowienia',
  'zamowienie',
  'reklamacje',
  'reklamacja',
  'obsluga',
  'pomoc',
  'bok',
  'poczta',
  'sekretariat',
  'ksiegowosc',
  'faktury',
  'hurt',
  'wspolpraca',
  'praca',
  'kariera',
  'prasa',
  'rodo',
  'iod',
  'dpo',
  'serwis',
  'zespol',
  'firma',
  'allegro',
]);

/**
 * Ambiguous short mailboxes: generic on their own, but too collision-prone to
 * match as a segment — `pr` would swallow the initials of a real person.
 */
const GENERIC_EXACT = new Set(['hi', 'hey', 'pr', 'mail', 'e', 'we', 'us', 'b2b', 'faq', 'crm']);

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const EVIDENCE_PADDING = 60;

/**
 * Rejects the strings that merely look like addresses.
 *
 * This is where asset filenames, Sentry DSNs and placeholder copy are stopped —
 * every one of them was found in real Shopify markup, and each would otherwise
 * reach the outreach agent as a fact about the merchant.
 */
export function isValidEmail(candidate: string): boolean {
  const email = candidate.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;

  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (NOISE_LOCALS.has(local)) return false;
  // A Sentry DSN is `<32 hex chars>@o1234.ingest.sentry.io`; the public key is
  // the giveaway, since the host varies per project.
  if (/^[0-9a-f]{32,}$/.test(local)) return false;

  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return false;
  if (NOISE_DOMAINS.has(domain)) return false;

  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (FILE_EXTENSIONS.has(tld)) return false;

  return true;
}

/** Splits a local part into comparable words: `anna.k+shop1` -> `anna`, `k`, `shop`. */
function localSegments(local: string): string[] {
  const withoutTag = local.split('+')[0] ?? local;
  return withoutTag
    .toLowerCase()
    .split(/[._-]+/)
    .map((segment) => segment.replace(/[^a-z]/g, ''))
    .filter((segment) => segment.length > 0);
}

/**
 * Personal or shared mailbox (task 4-03).
 *
 * Anything not recognised as a shared mailbox is treated as personal, because
 * that is the direction whose cost is recoverable: a shared address in the
 * personal column is visible at a glance in the dashboard, while a real person
 * filed under `info@` is never looked at again.
 */
export function classifyEmail(email: string): EmailBucket {
  const at = email.lastIndexOf('@');
  if (at <= 0) return 'personal';

  const local = email.slice(0, at).toLowerCase();

  // `perilla@perilla.pl`, `selsey@selsey.pl`: the mailbox is named after the
  // brand, so it is the shop's own inbox however personal the word looks.
  const domainLabel = email
    .slice(at + 1)
    .split('.')[0]
    ?.replace(/[^a-z0-9]/g, '');
  if (domainLabel !== undefined && domainLabel.length > 2) {
    if (local.replace(/[^a-z0-9]/g, '') === domainLabel) return 'generic';
  }
  // `no-reply` and `do.not.reply` are one word split by punctuation, so the
  // separators are dropped before matching as well as kept.
  const collapsed = local.replace(/[^a-z]/g, '');
  if (GENERIC_EXACT.has(collapsed) || GENERIC_TOKENS.has(collapsed)) return 'generic';

  const segments = localSegments(local);
  if (segments.some((segment) => GENERIC_TOKENS.has(segment))) return 'generic';

  return 'personal';
}

/** True when the mailbox sits on the shop's own domain, subdomains included. */
export function isOwnDomain(email: string, storeDomain: string): boolean {
  const normalized = normalizeDomain(storeDomain);
  if (!normalized) return false;

  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const host = email.slice(at + 1).toLowerCase();

  return host === normalized.domain || host.endsWith(`.${normalized.domain}`);
}

/** Text around a match, so a finding can be checked without refetching the page. */
function evidenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EVIDENCE_PADDING);
  const end = Math.min(text.length, index + length + EVIDENCE_PADDING);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/** Bracketed obfuscations are unambiguous, so they are simply undone. */
function undoBracketedObfuscation(text: string): string {
  return text
    .replace(/\s*[([{<]\s*(?:at|malpa|małpa)\s*[)\]}>]\s*/gi, '@')
    .replace(/\s*[([{<]\s*(?:dot|kropka)\s*[)\]}>]\s*/gi, '.');
}

interface Candidate {
  email: string;
  source: EmailSource;
  evidence: string;
}

function collectFromPage(page: ScrapedPage): Candidate[] {
  const out: Candidate[] = [];

  for (const address of page.mailtos) {
    out.push({ email: address.toLowerCase(), source: 'mailto', evidence: `mailto:${address}` });
  }

  for (const block of jsonLdBlocks(page.html)) {
    for (const address of valuesByKey(block, 'email')) {
      const value = address.replace(/^mailto:/i, '').trim();
      out.push({ email: value.toLowerCase(), source: 'jsonld', evidence: 'JSON-LD email' });
    }
  }

  const plain = new Set<string>();
  for (const match of page.text.matchAll(EMAIL_PATTERN)) {
    const email = match[0].toLowerCase();
    plain.add(email);
    out.push({
      email,
      source: 'text',
      evidence: evidenceAround(page.text, match.index, match[0].length),
    });
  }

  // Bracketed forms: `anna (at) sklep (dot) pl`, and the mixed variants.
  const unbracketed = undoBracketedObfuscation(page.text);
  if (unbracketed !== page.text) {
    for (const match of unbracketed.matchAll(EMAIL_PATTERN)) {
      const email = match[0].toLowerCase();
      if (plain.has(email)) continue;
      out.push({
        email,
        source: 'obfuscated',
        evidence: evidenceAround(unbracketed, match.index, match[0].length),
      });
    }
  }

  // Spelled-out form: `anna at sklep dot pl`.
  for (const match of page.text.matchAll(BARE_WORD_OBFUSCATION)) {
    const email = `${match[1]}@${match[2]}.${match[3]}`.toLowerCase();
    if (plain.has(email)) continue;
    out.push({
      email,
      source: 'obfuscated',
      evidence: evidenceAround(page.text, match.index, match[0].length),
    });
  }

  return out;
}

/**
 * Every address the scraped pages offer, deduplicated and classified.
 *
 * One address may appear on several pages from several sources; the strongest
 * source on the most telling page wins, so the surviving row is the one worth
 * showing a human. Results are ordered personal-first, then by that same
 * strength, which is the order the dashboard columns want.
 */
export function extractEmails(pages: readonly ScrapedPage[], storeDomain: string): FoundEmail[] {
  const best = new Map<string, FoundEmail>();

  for (const page of pages) {
    for (const candidate of collectFromPage(page)) {
      if (!isValidEmail(candidate.email)) continue;
      const email = candidate.email.trim().toLowerCase();

      const found: FoundEmail = {
        email,
        bucket: classifyEmail(email),
        source: candidate.source,
        pageKind: page.kind,
        pageUrl: page.url,
        evidence: candidate.evidence,
        ownDomain: isOwnDomain(email, storeDomain),
      };

      const existing = best.get(email);
      if (!existing || isStronger(found, existing)) best.set(email, found);
    }
  }

  return [...best.values()].sort(compareEmails);
}

function isStronger(a: FoundEmail, b: FoundEmail): boolean {
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) {
    return SOURCE_RANK[a.source] < SOURCE_RANK[b.source];
  }
  return PAGE_RANK[a.pageKind] < PAGE_RANK[b.pageKind];
}

function compareEmails(a: FoundEmail, b: FoundEmail): number {
  if (a.bucket !== b.bucket) return a.bucket === 'personal' ? -1 : 1;
  if (a.ownDomain !== b.ownDomain) return a.ownDomain ? -1 : 1;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) {
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  }
  if (PAGE_RANK[a.pageKind] !== PAGE_RANK[b.pageKind]) {
    return PAGE_RANK[a.pageKind] - PAGE_RANK[b.pageKind];
  }
  return a.email.localeCompare(b.email);
}
