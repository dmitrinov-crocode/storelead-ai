import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThemeCatalog } from './themeCatalog.js';
import { readSettingsVersion, toReleases, updateThemeCatalog } from './updateCatalog.js';

const NOW = new Date('2026-09-15T00:00:00.000Z');

function catalog(): ThemeCatalog {
  return {
    updatedAt: '2026-09-01',
    themes: {
      dawn: {
        displayName: 'Dawn',
        architecture: 'os2',
        source: 'github',
        github: 'Shopify/dawn',
        latest: { version: '15.0.0', releasedAt: '2026-01-01' },
        releases: [{ version: '15.0.0', releasedAt: '2026-01-01' }],
      },
      horizon: {
        displayName: 'Horizon',
        architecture: 'theme_blocks',
        source: 'settings_schema',
        github: 'Shopify/horizon',
        latest: { version: '4.0.0', releasedAt: null },
        releases: [],
      },
      debut: { displayName: 'Debut', architecture: 'vintage', source: 'manual', releases: [] },
    },
  };
}

/** Serves canned bodies by URL substring and records what was asked for. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const impl = ((url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.Authorization });

    for (const [fragment, body] of Object.entries(routes)) {
      if (!url.includes(fragment)) continue;
      if (typeof body === 'function') return Promise.resolve((body as () => Response)());
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('[]', { status: 404, statusText: 'Not Found' }));
  }) as unknown as typeof fetch;

  return { impl, calls };
}

test('keeps only real releases, newest first, without the tag prefix', () => {
  const releases = toReleases([
    { tag_name: 'v2.0.0', published_at: '2026-05-01T10:00:00Z' },
    { tag_name: 'v3.0.0-rc1', published_at: '2026-06-01T10:00:00Z', prerelease: true },
    { tag_name: 'v1.0.0', published_at: '2026-01-01T10:00:00Z' },
    { tag_name: 'v4.0.0', published_at: '2026-07-01T10:00:00Z', draft: true },
    { tag_name: 'v2.0.0', published_at: '2026-05-01T10:00:00Z' },
    { tag_name: 'v9.9.9' },
  ]);

  assert.deepEqual(releases, [
    { version: '2.0.0', releasedAt: '2026-05-01' },
    { version: '1.0.0', releasedAt: '2026-01-01' },
  ]);
});

test('reads the version a theme declares in its settings schema', () => {
  const schema = [
    { name: 'theme_info', theme_name: 'Horizon', theme_version: '4.1.5' },
    { name: 'Colors', settings: [] },
  ];

  assert.equal(readSettingsVersion(schema), '4.1.5');
  assert.equal(readSettingsVersion([{ name: 'Colors' }]), null);
  assert.equal(readSettingsVersion([{ name: 'theme_info', theme_version: '  ' }]), null);
  assert.equal(readSettingsVersion({ not: 'an array' }), null);
});

test('replaces the history of a theme that publishes releases', async () => {
  const { impl } = stubFetch({
    '/repos/Shopify/dawn/releases': [
      { tag_name: 'v16.0.0', published_at: '2026-08-10T10:00:00Z' },
      { tag_name: 'v15.0.0', published_at: '2026-01-01T10:00:00Z' },
    ],
    '/repos/Shopify/horizon/releases': [],
    'horizon/main/config/settings_schema.json': [{ name: 'theme_info', theme_version: '4.0.0' }],
  });

  const result = await updateThemeCatalog(catalog(), { fetchImpl: impl, now: NOW });

  const dawn = result.catalog.themes['dawn']!;
  assert.equal(dawn.latest?.version, '16.0.0');
  assert.equal(dawn.latest?.releasedAt, '2026-08-10');
  assert.equal(dawn.releases.length, 2);
  assert.equal(result.changed, true);
  assert.equal(result.catalog.updatedAt, '2026-09-15');
});

test('falls back to the settings schema when a repository has no releases', async () => {
  const { impl, calls } = stubFetch({
    '/repos/Shopify/dawn/releases': [{ tag_name: 'v15.0.0', published_at: '2026-01-01T10:00:00Z' }],
    '/repos/Shopify/horizon/releases': [],
    'horizon/main/config/settings_schema.json': [
      { name: 'theme_info', theme_name: 'Horizon', theme_version: '4.1.5' },
    ],
  });

  const result = await updateThemeCatalog(catalog(), { fetchImpl: impl, now: NOW });

  const horizon = result.catalog.themes['horizon']!;
  assert.equal(horizon.latest?.version, '4.1.5');
  // No dates are available from a settings file, and none are invented.
  assert.equal(horizon.latest?.releasedAt, null);
  assert.deepEqual(horizon.releases, []);
  assert.ok(calls.some((c) => c.url.includes('raw.githubusercontent.com')));
});

test('a failed fetch leaves the entry exactly as it was', async () => {
  const { impl } = stubFetch({
    '/repos/Shopify/dawn/releases': () =>
      new Response('rate limited', { status: 403, statusText: 'Forbidden' }),
    '/repos/Shopify/horizon/releases': [],
    'horizon/main/config/settings_schema.json': [{ name: 'theme_info', theme_version: '4.0.0' }],
  });

  const result = await updateThemeCatalog(catalog(), { fetchImpl: impl, now: NOW });

  const dawn = result.catalog.themes['dawn']!;
  // Stale data beats an emptied reference: every Dawn store would otherwise
  // lose its verdict because GitHub had a bad minute.
  assert.equal(dawn.latest?.version, '15.0.0');
  assert.equal(dawn.releases.length, 1);

  const failure = result.updates.find((u) => u.key === 'dawn')!;
  assert.match(failure.error ?? '', /403 Forbidden/);
  assert.equal(failure.changed, false);
  assert.equal(result.changed, false);
});

test('themes with no repository are left alone and not reported', async () => {
  const { impl } = stubFetch({
    '/repos/Shopify/dawn/releases': [{ tag_name: 'v15.0.0', published_at: '2026-01-01T10:00:00Z' }],
    '/repos/Shopify/horizon/releases': [],
    'horizon/main/config/settings_schema.json': [{ name: 'theme_info', theme_version: '4.0.0' }],
  });

  const result = await updateThemeCatalog(catalog(), { fetchImpl: impl, now: NOW });

  assert.deepEqual(result.catalog.themes['debut'], catalog().themes['debut']);
  assert.deepEqual(
    result.updates.map((u) => u.key),
    ['dawn', 'horizon'],
  );
  // Nothing moved: same version, same release count.
  assert.equal(result.changed, false);
});

test('sends the token when one is given', async () => {
  const { impl, calls } = stubFetch({
    '/repos/Shopify/dawn/releases': [{ tag_name: 'v15.0.0', published_at: '2026-01-01T10:00:00Z' }],
    '/repos/Shopify/horizon/releases': [],
    'horizon/main/config/settings_schema.json': [{ name: 'theme_info', theme_version: '4.0.0' }],
  });

  await updateThemeCatalog(catalog(), { fetchImpl: impl, now: NOW, token: 'ghp_test' });

  assert.ok(calls.every((c) => c.auth === 'Bearer ghp_test'));
});

test('walks past the first page when a theme has more than 100 releases', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    tag_name: `v${200 - i}.0.0`,
    published_at: `2026-01-01T10:00:00Z`,
  }));
  const calls: string[] = [];
  const impl = ((url: string) => {
    calls.push(url);
    if (url.includes('dawn/releases')) {
      // '&page=' matters: 'per_page=100' contains 'page=100', so a bare
      // 'page=1' check would match every page.
      const body = url.includes('&page=1')
        ? page1
        : url.includes('&page=2')
          ? [{ tag_name: 'v1.0.0', published_at: '2021-01-01T10:00:00Z' }]
          : [];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    if (url.includes('horizon/releases')) {
      return Promise.resolve(new Response('[]', { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify([{ name: 'theme_info', theme_version: '4.0.0' }]), {
        status: 200,
      }),
    );
  }) as unknown as typeof fetch;

  const result = await updateThemeCatalog(catalog(), { fetchImpl: impl, now: NOW });

  assert.equal(result.catalog.themes['dawn']!.releases.length, 101);
  assert.equal(calls.filter((u) => u.includes('dawn/releases')).length, 2);
});
