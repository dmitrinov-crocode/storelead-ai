import { extractEmails, type FoundEmail } from './emails.js';
import type { ScrapedPage } from './pageScraper.js';
import { extractPeople, type FoundPerson } from './people.js';
import { extractLinkedIn, type LinkedInLink } from './social.js';

/**
 * The three buckets a store's contacts are read in: a personal email, a LinkedIn
 * link, and the shared mailboxes (`info@`, `support@`, `biuro@`).
 *
 * They are separated here rather than at display time because they are three
 * different things to a human reviewing a lead: a person to write to, a person
 * to look up, and an address that reaches a shared inbox. The dashboard shows
 * one column each, and 4-08 ranks within them.
 */

export interface StoreContacts {
  /** Mailboxes that look like a named person, strongest evidence first. */
  personalEmails: FoundEmail[];
  /** LinkedIn links the shop publishes; personal profiles before company pages. */
  linkedin: LinkedInLink[];
  /** Shared mailboxes — the fallback when no person can be found. */
  genericEmails: FoundEmail[];
  /** People the shop names, most senior first (task 4-04). */
  people: FoundPerson[];
  /** True when no bucket produced anything: the store needs the web search of 4-05. */
  empty: boolean;
}

/**
 * Sorts everything the scraped pages offered into the three buckets.
 *
 * Pure: it reads the pages 4-01 returned and computes, so it can be tested
 * without a browser and rerun over stored pages when the heuristics change.
 */
export function collectStoreContacts(
  pages: readonly ScrapedPage[],
  storeDomain: string,
): StoreContacts {
  const emails = extractEmails(pages, storeDomain);
  const personalEmails = emails.filter((email) => email.bucket === 'personal');
  const genericEmails = emails.filter((email) => email.bucket === 'generic');
  const linkedin = extractLinkedIn(pages);
  const people = extractPeople(pages, emails, storeDomain);

  return {
    personalEmails,
    linkedin,
    genericEmails,
    people,
    empty:
      personalEmails.length === 0 &&
      linkedin.length === 0 &&
      genericEmails.length === 0 &&
      people.length === 0,
  };
}
