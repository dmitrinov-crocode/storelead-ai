/**
 * Domain normalisation (task 1-05).
 *
 * The normalised form is the deduplication key for stores, so it must be stable
 * across every shape StoreLeads, a sitemap or a human might supply:
 *   https://WWW.Shop.PL/collections/all?page=2  ->  shop.pl
 *   sklep.żółć.pl                               ->  sklep.xn--ata-zla6b.pl
 *
 * IDNs are stored punycode-encoded because that is what DNS, Playwright and the
 * PageSpeed API all use — keeping the unicode form would create two keys for one store.
 */

/** Hostnames that are never a real storefront. */
const INVALID_HOSTS = new Set(['localhost', 'example.com', 'example.org', 'example.net']);

export interface NormalizedDomain {
  /** Deduplication key: lowercase, punycode, no scheme, no `www.`, no port or path. */
  domain: string;
  /** Canonical https URL built from the normalised domain. */
  url: string;
}

function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/**
 * Returns null for anything that is not a usable public domain, so callers can
 * skip the row instead of poisoning the database with a bad key.
 */
export function normalizeDomain(input: string | null | undefined): NormalizedDomain | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (trimmed === '') return null;

  // A scheme may appear with or without `//` (`mailto:` has none). Anything that
  // carries a scheme must be http(s); otherwise prefixing `https://` would turn
  // `mailto:hi@shop.pl` into a URL whose hostname is shop.pl.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch && !/^https?:\/\//i.test(trimmed)) return null;
  const withScheme = schemeMatch ? trimmed : `https://${trimmed}`;

  let hostname: string;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Credentials in the authority mean this is not a plain storefront URL.
    if (parsed.username !== '' || parsed.password !== '') return null;
    // URL lowercases and punycodes the hostname for us.
    hostname = parsed.hostname;
  } catch {
    return null;
  }

  // A trailing dot is a valid FQDN but a different string — drop it.
  hostname = hostname.replace(/\.$/, '');
  hostname = stripWww(hostname);

  if (hostname === '') return null;
  if (INVALID_HOSTS.has(hostname)) return null;
  // Bracketed IPv6, or a bare IPv4 — neither is a storefront domain.
  if (hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  // Must have a dot-separated public suffix and only DNS-legal characters.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) return null;
  if (
    hostname
      .split('.')
      .some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))
  ) {
    return null;
  }

  return { domain: hostname, url: `https://${hostname}` };
}

/** Convenience wrapper for call sites that only need the key. */
export function toDomainKey(input: string | null | undefined): string | null {
  return normalizeDomain(input)?.domain ?? null;
}
