import type { Page } from 'playwright';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { AuditSession } from './session.js';

/**
 * Finding the three pages an audit needs (task 2-09).
 *
 * A store is judged on its homepage, one collection and one product, so those
 * URLs have to be discovered per shop. Three sources are tried in order of cost:
 * Shopify's `/collections/all`, then the links on the homepage, then the sitemap.
 * Which one answered is recorded, because a shop whose product page can only be
 * found in the sitemap has a navigation problem worth reporting.
 */

export type DiscoverySource = 'collections-all' | 'navigation' | 'sitemap';

export interface KeyUrls {
  homepage: string;
  collection: string | null;
  product: string | null;
  sources: { collection?: DiscoverySource; product?: DiscoverySource };
  /** Human-readable trace of what was tried. */
  notes: string[];
}

const MAX_LINKS = 500;
/** Handles that are collections by URL shape but never a product listing. */
const COLLECTION_DENYLIST = /\/collections\/(all|frontpage|vendors|types)(\?|$)/;

export interface ClassifiedLinks {
  collections: string[];
  products: string[];
}

/**
 * Splits same-origin links into Shopify collection and product URLs.
 * Cross-origin links are dropped: an audit must never wander off the store.
 */
export function classifyShopifyLinks(hrefs: readonly string[], origin: string): ClassifiedLinks {
  const collections: string[] = [];
  const products: string[] = [];

  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, origin);
    } catch {
      continue;
    }
    if (url.origin !== new URL(origin).origin) continue;

    // Query strings on a listing (sorting, filters) would audit a variant of the
    // page rather than the page; the fragment is irrelevant to the server.
    url.hash = '';
    const clean = `${url.origin}${url.pathname}`;

    if (/\/products\/[^/]+$/.test(url.pathname)) {
      if (!products.includes(clean)) products.push(clean);
      continue;
    }
    if (/^\/collections\/[^/]+$/.test(url.pathname)) {
      if (!collections.includes(clean)) collections.push(clean);
    }
  }

  return { collections, products };
}

/** Picks the collection most likely to be a real, populated listing. */
export function pickCollection(collections: readonly string[]): string | null {
  const real = collections.filter((url) => !COLLECTION_DENYLIST.test(url));
  return real[0] ?? collections[0] ?? null;
}

/** `<loc>` entries of a sitemap or sitemap index, in document order. */
export function parseSitemapLocations(xml: string): string[] {
  const out: string[] = [];
  const pattern = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match = pattern.exec(xml);
  while (match) {
    out.push(decodeXmlEntities(match[1]!));
    if (out.length >= MAX_LINKS) break;
    match = pattern.exec(xml);
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Every anchor the rendered page offers, absolute and capped. */
export async function pageLinks(page: Page): Promise<string[]> {
  const links = await page
    .evaluate((limit) => Array.from(document.links, (a) => a.href).slice(0, limit), MAX_LINKS)
    .catch(() => [] as string[]);
  return links;
}

export interface DiscoverOptions {
  logger?: Logger;
  /** Reuses an already-loaded homepage instead of fetching it again. */
  homepageLinks?: readonly string[];
}

export async function discoverKeyUrls(
  session: AuditSession,
  homepage: string,
  options: DiscoverOptions = {},
): Promise<KeyUrls> {
  const logger = options.logger ?? silentLogger();
  const origin = new URL(homepage).origin;
  const result: KeyUrls = { homepage, collection: null, product: null, sources: {}, notes: [] };

  const page = await session.newPage('desktop');
  try {
    // 1. Shopify's catch-all listing: one request, and it contains products.
    const allUrl = `${origin}/collections/all`;
    const all = await session.goto(page, allUrl);
    const allStatus = all.response?.status() ?? 0;
    if (allStatus >= 200 && allStatus < 400) {
      const { products } = classifyShopifyLinks(await pageLinks(page), origin);
      if (products.length > 0) {
        result.collection = allUrl;
        result.sources.collection = 'collections-all';
        result.product = products[0]!;
        result.sources.product = 'collections-all';
        result.notes.push(`/collections/all served ${products.length} product links`);
        return result;
      }
      result.notes.push('/collections/all loaded but listed no products');
    } else {
      result.notes.push(`/collections/all returned ${allStatus || 'no response'}`);
    }

    // 2. The shop's own navigation.
    const homeLinks = options.homepageLinks ?? (await loadHomepageLinks(session, page, homepage));
    const fromNav = classifyShopifyLinks(homeLinks, origin);
    const navCollection = pickCollection(fromNav.collections);
    if (navCollection) {
      result.collection = navCollection;
      result.sources.collection = 'navigation';
    }
    if (fromNav.products[0]) {
      result.product = fromNav.products[0];
      result.sources.product = 'navigation';
    }

    // A collection page is the natural place to find a product link.
    if (result.collection && !result.product) {
      const visit = await session.goto(page, result.collection);
      if ((visit.response?.status() ?? 0) < 400) {
        const { products } = classifyShopifyLinks(await pageLinks(page), origin);
        if (products[0]) {
          result.product = products[0];
          result.sources.product = 'navigation';
        }
      }
    }

    if (result.collection && result.product) return result;

    // 3. The sitemap: slowest, and the only source that survives a broken menu.
    const fromSitemap = await discoverFromSitemap(session, page, origin);
    if (!result.collection && fromSitemap.collection) {
      result.collection = fromSitemap.collection;
      result.sources.collection = 'sitemap';
      result.notes.push('collection found only in the sitemap, not in the navigation');
    }
    if (!result.product && fromSitemap.product) {
      result.product = fromSitemap.product;
      result.sources.product = 'sitemap';
      result.notes.push('product found only in the sitemap, not in the navigation');
    }

    return result;
  } finally {
    logger.debug({ ...result.sources, notes: result.notes }, 'key url discovery finished');
    await page.close().catch(() => undefined);
  }
}

async function loadHomepageLinks(
  session: AuditSession,
  page: Page,
  homepage: string,
): Promise<string[]> {
  const visit = await session.goto(page, homepage);
  if (visit.error) return [];
  return pageLinks(page);
}

/**
 * Walks `/sitemap.xml`. Shopify splits it into per-type child sitemaps, so one
 * extra request per type is enough; a flat sitemap is handled by the same code.
 */
async function discoverFromSitemap(
  session: AuditSession,
  page: Page,
  origin: string,
): Promise<{ collection: string | null; product: string | null }> {
  const found = { collection: null as string | null, product: null as string | null };

  const root = await fetchText(session, page, `${origin}/sitemap.xml`);
  if (!root) return found;

  const locations = parseSitemapLocations(root);
  const direct = classifyShopifyLinks(locations, origin);
  found.collection = pickCollection(direct.collections);
  found.product = direct.products[0] ?? null;
  if (found.collection && found.product) return found;

  const children = locations.filter((loc) => /\.xml(\?|$)/.test(loc));
  for (const child of children.slice(0, 4)) {
    if (found.collection && found.product) break;
    const wantsProducts = /product/i.test(child) && !found.product;
    const wantsCollections = /collection/i.test(child) && !found.collection;
    if (!wantsProducts && !wantsCollections) continue;

    const body = await fetchText(session, page, child);
    if (!body) continue;
    const classified = classifyShopifyLinks(parseSitemapLocations(body), origin);
    found.collection ??= pickCollection(classified.collections);
    found.product ??= classified.products[0] ?? null;
  }

  return found;
}

/** Throttled plain-HTTP fetch through the browser context, so cookies and UA match. */
async function fetchText(session: AuditSession, page: Page, url: string): Promise<string | null> {
  await session.throttle();
  try {
    const response = await page.context().request.get(url, { timeout: session.pageTimeoutMs });
    if (!response.ok()) return null;
    return await response.text();
  } catch {
    return null;
  }
}
