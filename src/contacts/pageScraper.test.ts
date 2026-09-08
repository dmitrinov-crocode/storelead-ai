import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from '../audit/browser.js';
import { AuditSession } from '../audit/session.js';
import { html, startFixtureServer, type FixtureRoute } from '../audit/testing/fixtureServer.js';
import { classifyContactLinks, scrapeContactPages } from './pageScraper.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

function session(): AuditSession {
  // The politeness delay is exercised in session.test.ts; here it only slows tests.
  return new AuditSession({ browser, requestDelayMs: 0 });
}

function footer(links: string): string {
  return html(`<main><h1>Sklep</h1></main><footer>${links}</footer>`);
}

test('classifies footer links by path, ignoring other origins and protocols', () => {
  const result = classifyContactLinks(
    [
      { href: 'https://sklep.pl/pages/kontakt', text: 'Kontakt' },
      { href: 'https://sklep.pl/pages/o-nas', text: 'O nas' },
      { href: 'https://sklep.pl/policies/privacy-policy', text: 'Legal' },
      { href: 'https://sklep.pl/regulamin', text: 'Regulamin' },
      { href: 'https://sklep.pl/collections/buty', text: 'Buty' },
      { href: 'https://facebook.com/sklep/contact', text: 'Kontakt' },
      { href: 'mailto:info@sklep.pl', text: 'Napisz' },
      // Both shapes occur in real footers: a script-driven toggle labelled like a
      // page, and a href the URL parser rejects outright.
      { href: 'javascript:void(0)', text: 'Kontakt' },
      { href: 'http://', text: 'Kontakt' },
    ],
    'https://sklep.pl',
  );

  assert.deepEqual(result, [
    { kind: 'contact', url: 'https://sklep.pl/pages/kontakt' },
    { kind: 'about', url: 'https://sklep.pl/pages/o-nas' },
    { kind: 'privacy', url: 'https://sklep.pl/policies/privacy-policy' },
    { kind: 'terms', url: 'https://sklep.pl/regulamin' },
  ]);
});

test('falls back to the anchor text when the slug says nothing', () => {
  const result = classifyContactLinks(
    [
      { href: 'https://sklep.pl/pages/p1', text: 'Skontaktuj się z nami' },
      { href: 'https://sklep.pl/pages/p2', text: 'Kim jesteśmy' },
      { href: 'https://sklep.pl/pages/p3', text: 'Nowości' },
    ],
    'https://sklep.pl',
  );

  assert.deepEqual(result, [
    { kind: 'contact', url: 'https://sklep.pl/pages/p1' },
    { kind: 'about', url: 'https://sklep.pl/pages/p2' },
  ]);
});

test('the path wins over a misleading anchor text', () => {
  const result = classifyContactLinks(
    [{ href: 'https://sklep.pl/policies/privacy-policy', text: 'Kontakt' }],
    'https://sklep.pl',
  );

  assert.deepEqual(result, [{ kind: 'privacy', url: 'https://sklep.pl/policies/privacy-policy' }]);
});

test('links differing only by query or fragment are one page', () => {
  const result = classifyContactLinks(
    [
      { href: 'https://sklep.pl/pages/kontakt?utm_source=footer', text: 'Kontakt' },
      { href: 'https://sklep.pl/pages/kontakt#formularz', text: 'Kontakt' },
      { href: 'https://sklep.pl/pages/kontakt/', text: 'Kontakt' },
    ],
    'https://sklep.pl',
  );

  assert.deepEqual(result, [{ kind: 'contact', url: 'https://sklep.pl/pages/kontakt' }]);
});

test('follows the footer and reads text and mailto targets', async () => {
  const server = await startFixtureServer({
    '/': {
      body: footer(`
        <a href="/pages/kontakt">Kontakt</a>
        <a href="/pages/o-nas">O nas</a>
        <a href="mailto:shop@sklep.pl">Napisz</a>
      `),
    },
    '/pages/kontakt': {
      body: html(`<h1>Kontakt</h1><p>Napisz: <a href="mailto:anna%40sklep.pl">anna</a></p>`),
    },
    '/pages/o-nas': {
      body: html(`<h1>O nas</h1><p>Sklep prowadzi Anna Kowalska od 2019 roku.</p>`),
    },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, { respectRobots: false });

    assert.deepEqual(
      result.pages.map((p) => [p.kind, p.source, p.status]),
      [
        ['home', 'homepage', 200],
        ['contact', 'footer', 200],
        ['about', 'footer', 200],
      ],
    );

    const home = result.pages[0]!;
    assert.deepEqual(home.mailtos, ['shop@sklep.pl'], 'footer mailto belongs to the homepage');

    const contact = result.pages[1]!;
    // Percent-encoded @ is what obfuscating themes emit; 4-02 must not have to decode it.
    assert.deepEqual(contact.mailtos, ['anna@sklep.pl']);

    const about = result.pages[2]!;
    assert.match(about.text, /Anna Kowalska/);
    assert.match(about.html, /<h1>O nas<\/h1>/);
  } finally {
    await audit.close();
    await server.close();
  }
});

test('guesses slugs for the kinds the footer did not link', async () => {
  const server = await startFixtureServer({
    '/': { body: footer('<a href="/collections/all">Sklep</a>') },
    '/pages/kontakt': { body: html('<h1>Kontakt</h1><p>biuro@sklep.pl</p>') },
    '/policies/privacy-policy': { body: html('<h1>Prywatność</h1>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, {
      respectRobots: false,
      maxGuessesPerKind: 3,
    });

    assert.deepEqual(
      result.pages.map((p) => [p.kind, p.source]),
      [
        ['home', 'homepage'],
        ['contact', 'guess'],
        ['privacy', 'guess'],
      ],
    );
    // /pages/contact is tried before /pages/kontakt and must be counted as a miss.
    assert.deepEqual(server.hits('/pages/contact').length, 1);
    assert.ok(
      result.notes.some((n) => n.includes('no about page found')),
      `expected a note about the missing About page, got ${JSON.stringify(result.notes)}`,
    );
  } finally {
    await audit.close();
    await server.close();
  }
});

test('a 200 page whose body says "not found" is not treated as a hit', async () => {
  const server = await startFixtureServer({
    '/': { body: footer('<a href="/pages/o-nas">O nas</a>') },
    // Themes serve a soft 404 for unknown slugs; the body is the only tell.
    '/pages/o-nas': { body: html('<h1>404</h1><p>Nie znaleziono strony</p>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, { respectRobots: false });

    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home'],
    );
    assert.ok(result.notes.some((n) => n.includes('not-found body')));
  } finally {
    await audit.close();
    await server.close();
  }
});

test('a long policy page that merely mentions "not found" is kept', async () => {
  const filler = 'Regulamin sklepu internetowego. '.repeat(30);
  const server = await startFixtureServer({
    '/': { body: footer('<a href="/regulamin">Regulamin</a>') },
    '/regulamin': {
      body: html(`<h1>Regulamin</h1><p>${filler} Jeśli produkt not found, prosimy o kontakt.</p>`),
    },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, { respectRobots: false });

    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home', 'terms'],
    );
  } finally {
    await audit.close();
    await server.close();
  }
});

test('a 404 status is a miss even with a plausible body', async () => {
  const server = await startFixtureServer({
    '/': { body: footer('<a href="/pages/kontakt">Kontakt</a>') },
    '/pages/kontakt': { status: 404, body: html('<h1>Kontakt</h1><p>biuro@sklep.pl</p>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, { respectRobots: false });

    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home'],
    );
  } finally {
    await audit.close();
    await server.close();
  }
});

test('the request cap bounds how much of a store we touch', async () => {
  const routes: Record<string, FixtureRoute> = {
    '/': {
      body: footer(`
        <a href="/pages/kontakt">Kontakt</a>
        <a href="/pages/o-nas">O nas</a>
        <a href="/policies/privacy-policy">Prywatność</a>
        <a href="/regulamin">Regulamin</a>
      `),
    },
    '/pages/kontakt': { body: html('<h1>Kontakt</h1>') },
    '/pages/o-nas': { body: html('<h1>O nas</h1>') },
    '/policies/privacy-policy': { body: html('<h1>Prywatność</h1>') },
    '/regulamin': { body: html('<h1>Regulamin</h1>') },
  };
  const server = await startFixtureServer(routes);
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, {
      respectRobots: false,
      maxRequests: 3,
    });

    assert.equal(result.requests, 3);
    // Homepage plus the two highest-priority kinds; Terms is what the cap drops.
    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home', 'contact', 'about'],
    );
    assert.equal(server.hits('/regulamin').length, 0);
  } finally {
    await audit.close();
    await server.close();
  }
});

test('an unreachable homepage yields an empty result rather than throwing', async () => {
  const server = await startFixtureServer({});
  const url = server.url;
  await server.close();
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, url, { respectRobots: false });

    assert.deepEqual(result.pages, []);
    assert.ok(result.notes.some((n) => n.includes('contact scraping skipped')));
  } finally {
    await audit.close();
  }
});

test('one unreachable page does not lose the pages that answered', async () => {
  const server = await startFixtureServer({
    '/': {
      body: footer(`
        <a href="/pages/kontakt">Kontakt</a>
        <a href="/pages/o-nas">O nas</a>
      `),
    },
    '/pages/kontakt': { status: 500, body: 'boom' },
    '/pages/o-nas': { body: html('<h1>O nas</h1><p>Anna Kowalska</p>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, {
      respectRobots: false,
      maxGuessesPerKind: 0,
    });

    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home', 'about'],
    );
  } finally {
    await audit.close();
    await server.close();
  }
});

test('robots.txt is fetched and obeyed', async () => {
  const server = await startFixtureServer({
    '/robots.txt': {
      contentType: 'text/plain',
      body: 'User-agent: *\nDisallow: /pages/o-nas\n',
    },
    '/': {
      body: footer(`
        <a href="/pages/kontakt">Kontakt</a>
        <a href="/pages/o-nas">O nas</a>
      `),
    },
    '/pages/kontakt': { body: html('<h1>Kontakt</h1>') },
    '/pages/o-nas': { body: html('<h1>O nas</h1>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, {
      userAgent: 'StoreLeadBot/0.1',
    });

    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home', 'contact'],
    );
    assert.equal(result.disallowed.length, 1);
    assert.match(result.disallowed[0]!, /\/pages\/o-nas$/);
    // The forbidden page must not have been requested at all.
    assert.equal(server.hits('/pages/o-nas').length, 0);
  } finally {
    await audit.close();
    await server.close();
  }
});

test('a shop that bans our crawler outright is left alone', async () => {
  const server = await startFixtureServer({
    '/robots.txt': {
      contentType: 'text/plain',
      body: 'User-agent: StoreLeadBot\nDisallow: /\n',
    },
    '/': { body: footer('<a href="/pages/kontakt">Kontakt</a>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, {
      userAgent: 'StoreLeadBot/0.1 (+https://example.invalid)',
    });

    assert.deepEqual(result.pages, []);
    assert.equal(server.hits('/').length, 0, 'not even the homepage');
  } finally {
    await audit.close();
    await server.close();
  }
});

test('a missing robots.txt is treated as permission', async () => {
  const server = await startFixtureServer({
    '/': { body: footer('<a href="/pages/kontakt">Kontakt</a>') },
    '/pages/kontakt': { body: html('<h1>Kontakt</h1>') },
  });
  const audit = session();

  try {
    const result = await scrapeContactPages(audit, server.url, {
      userAgent: 'StoreLeadBot/0.1',
      maxGuessesPerKind: 0,
    });

    assert.deepEqual(
      result.pages.map((p) => p.kind),
      ['home', 'contact'],
    );
  } finally {
    await audit.close();
    await server.close();
  }
});
