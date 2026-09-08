import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import { html, startFixtureServer, type FixtureRoute } from './testing/fixtureServer.js';
import {
  classifyShopifyLinks,
  discoverKeyUrls,
  parseSitemapLocations,
  pickCollection,
} from './discovery.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

test('classifies Shopify collection and product links, ignoring other origins', () => {
  const result = classifyShopifyLinks(
    [
      'https://sklep.pl/collections/buty',
      'https://sklep.pl/collections/buty/products/but-1',
      'https://sklep.pl/products/but-2',
      'https://sklep.pl/pages/kontakt',
      'https://facebook.com/sklep/products/spam',
      'not a url',
    ],
    'https://sklep.pl',
  );

  assert.deepEqual(result.collections, ['https://sklep.pl/collections/buty']);
  assert.deepEqual(result.products, [
    'https://sklep.pl/collections/buty/products/but-1',
    'https://sklep.pl/products/but-2',
  ]);
});

test('links are deduplicated and stripped of query and fragment', () => {
  const result = classifyShopifyLinks(
    [
      'https://sklep.pl/products/but?variant=1',
      'https://sklep.pl/products/but#opis',
      'https://sklep.pl/products/but',
    ],
    'https://sklep.pl',
  );
  assert.deepEqual(result.products, ['https://sklep.pl/products/but']);
});

test('pickCollection avoids the synthetic Shopify listings', () => {
  assert.equal(
    pickCollection(['https://sklep.pl/collections/all', 'https://sklep.pl/collections/buty']),
    'https://sklep.pl/collections/buty',
  );
  // …but takes what it can get when there is nothing else.
  assert.equal(
    pickCollection(['https://sklep.pl/collections/all']),
    'https://sklep.pl/collections/all',
  );
  assert.equal(pickCollection([]), null);
});

test('parseSitemapLocations reads a sitemap index and decodes entities', () => {
  const xml = `<?xml version="1.0"?>
    <sitemapindex><sitemap><loc>https://sklep.pl/sitemap_products_1.xml?from=1&amp;to=9</loc></sitemap>
    <sitemap>
      <loc>
        https://sklep.pl/sitemap_collections_1.xml
      </loc>
    </sitemap></sitemapindex>`;
  assert.deepEqual(parseSitemapLocations(xml), [
    'https://sklep.pl/sitemap_products_1.xml?from=1&to=9',
    'https://sklep.pl/sitemap_collections_1.xml',
  ]);
  assert.deepEqual(parseSitemapLocations('<urlset></urlset>'), []);
});

async function discover(routes: Record<string, FixtureRoute>) {
  const server = await startFixtureServer(routes);
  // Sitemaps must contain absolute URLs, which need the port the server just took.
  for (const route of Object.values(routes)) {
    if (typeof route.body === 'string' && route.body.includes('SERVER')) {
      route.body = route.body.replaceAll('SERVER', server.url);
    }
  }
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });
  try {
    const result = await discoverKeyUrls(session, `${server.url}/`);
    return { result, server };
  } finally {
    await session.close();
    await server.close();
  }
}

test('prefers /collections/all when it lists products', async () => {
  const { result, server } = await discover({
    '/': { body: html('<a href="/collections/buty">Buty</a>') },
    '/collections/all': {
      body: html('<a href="/products/but-1">But 1</a><a href="/products/but-2">But 2</a>'),
    },
  });

  assert.equal(result.collection, `${server.url}/collections/all`);
  assert.equal(result.product, `${server.url}/products/but-1`);
  assert.deepEqual(result.sources, { collection: 'collections-all', product: 'collections-all' });
});

test('falls back to the navigation when /collections/all is empty', async () => {
  const { result, server } = await discover({
    '/': { body: html('<nav><a href="/collections/buty">Buty</a></nav>') },
    '/collections/all': { body: html('<p>Brak produktów</p>') },
    '/collections/buty': { body: html('<a href="/products/but-7">But 7</a>') },
  });

  assert.equal(result.collection, `${server.url}/collections/buty`);
  assert.equal(result.product, `${server.url}/products/but-7`);
  assert.deepEqual(result.sources, { collection: 'navigation', product: 'navigation' });
  assert.match(result.notes.join(' '), /listed no products/);
});

test('falls back to the navigation when /collections/all is a 404', async () => {
  const { result, server } = await discover({
    '/': { body: html('<a href="/collections/nowosci">Nowości</a>') },
    '/collections/nowosci': { body: html('<a href="/products/x">X</a>') },
  });

  assert.equal(result.collection, `${server.url}/collections/nowosci`);
  assert.equal(result.sources.collection, 'navigation');
  assert.match(result.notes.join(' '), /returned 404/);
});

test('falls back to the sitemap when the navigation hides everything', async () => {
  const { result, server } = await discover({
    '/': { body: html('<p>Sklep w budowie</p>') },
    '/sitemap.xml': {
      contentType: 'application/xml',
      body: `<sitemapindex>
        <sitemap><loc>SERVER/sitemap_products_1.xml</loc></sitemap>
        <sitemap><loc>SERVER/sitemap_collections_1.xml</loc></sitemap>
      </sitemapindex>`,
    },
    '/sitemap_products_1.xml': {
      contentType: 'application/xml',
      body: '<urlset><url><loc>SERVER/products/ukryty</loc></url></urlset>',
    },
    '/sitemap_collections_1.xml': {
      contentType: 'application/xml',
      body: '<urlset><url><loc>SERVER/collections/ukryta</loc></url></urlset>',
    },
  });

  assert.equal(result.collection, `${server.url}/collections/ukryta`);
  assert.equal(result.product, `${server.url}/products/ukryty`);
  assert.deepEqual(result.sources, { collection: 'sitemap', product: 'sitemap' });
  assert.match(result.notes.join(' '), /only in the sitemap/);
});

test('a store with nothing discoverable returns nulls instead of throwing', async () => {
  const { result } = await discover({ '/': { body: html('<p>Wkrótce otwarcie</p>') } });
  assert.equal(result.collection, null);
  assert.equal(result.product, null);
  assert.deepEqual(result.sources, {});
});

test('an unreachable store is reported, not thrown', async () => {
  const server = await startFixtureServer({});
  const dead = server.url;
  await server.close();

  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 5000 });
  try {
    const result = await discoverKeyUrls(session, `${dead}/`);
    assert.equal(result.collection, null);
    assert.equal(result.product, null);
    assert.match(result.notes.join(' '), /no response/);
  } finally {
    await session.close();
  }
});
