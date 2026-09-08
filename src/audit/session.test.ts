import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.js';
import { AuditSession } from './session.js';
import { html, startFixtureServer } from './testing/fixtureServer.js';

let browser: Browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

test('reuses one context per profile and closes them all', async () => {
  const session = new AuditSession({ browser, requestDelayMs: 0 });
  const first = await session.context('desktop');
  const again = await session.context('desktop');
  const mobile = await session.context('mobile');

  assert.equal(first, again);
  assert.notEqual(first, mobile);

  await session.close();
  assert.equal(browser.contexts().length, 0);
  await assert.rejects(() => session.context('desktop'), /closed/);
});

test('applies the configured timeout to navigation', async () => {
  const server = await startFixtureServer({ '/slow': { delayMs: 2000, body: html('late') } });
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 300 });
  try {
    const page = await session.newPage('desktop');
    const result = await session.goto(page, `${server.url}/slow`);
    assert.equal(result.response, null);
    assert.match(result.error?.message ?? '', /Timeout 300ms/);
  } finally {
    await session.close();
    await server.close();
  }
});

test('a refused connection is returned as an error, not thrown', async () => {
  const server = await startFixtureServer({});
  const port = new URL(server.url).port;
  await server.close();

  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 5000 });
  try {
    const page = await session.newPage('desktop');
    const result = await session.goto(page, `http://127.0.0.1:${port}/`);
    assert.equal(result.response, null);
    assert.ok(result.error, 'a dead host must surface as an error');
  } finally {
    await session.close();
  }
});

test('spaces navigations to the target by the politeness delay', async () => {
  const server = await startFixtureServer({
    '/a': { body: html('a') },
    '/b': { body: html('b') },
    '/c': { body: html('c') },
  });
  const session = new AuditSession({ browser, requestDelayMs: 200, pageTimeoutMs: 5000 });
  try {
    const page = await session.newPage('desktop');
    for (const path of ['/a', '/b', '/c']) {
      const result = await session.goto(page, `${server.url}${path}`);
      assert.equal(result.response?.status(), 200);
    }

    const arrivals = ['/a', '/b', '/c'].map((p) => server.hits(p)[0]!.at);
    assert.ok(arrivals[1]! - arrivals[0]! >= 150, `gap 1 was ${arrivals[1]! - arrivals[0]!}ms`);
    assert.ok(arrivals[2]! - arrivals[1]! >= 150, `gap 2 was ${arrivals[2]! - arrivals[1]!}ms`);
  } finally {
    await session.close();
    await server.close();
  }
});

test('requestDelayMs 0 disables throttling', async () => {
  const server = await startFixtureServer({ '/': { body: html('home') } });
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 5000 });
  try {
    const page = await session.newPage('desktop');
    const startedAt = Date.now();
    await session.goto(page, `${server.url}/`);
    await session.goto(page, `${server.url}/`);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(server.hits('/').length, 2);
  } finally {
    await session.close();
    await server.close();
  }
});

test('pages inherit the session user agent and locale', async () => {
  const server = await startFixtureServer({ '/': { body: html('home') } });
  const session = new AuditSession({ browser, requestDelayMs: 0, country: 'PL' });
  try {
    const page = await session.newPage('desktop');
    await session.goto(page, `${server.url}/`);
    const seen = await page.evaluate(() => ({
      ua: navigator.userAgent,
      lang: navigator.language,
    }));
    assert.doesNotMatch(seen.ua, /Headless/);
    assert.equal(seen.lang, 'pl-PL');
  } finally {
    await session.close();
    await server.close();
  }
});
