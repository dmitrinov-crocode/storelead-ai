import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeTheme,
  compareVersions,
  monthsBetween,
  parseVersion,
  type ThemeFreshness,
} from './theme.js';
import { catalogKey, findTheme, loadThemeCatalog, type ThemeCatalog } from './themeCatalog.js';

const NOW = new Date('2026-09-01T00:00:00.000Z');

/**
 * A fixed reference, so the assertions below describe the analyser's behaviour
 * rather than today's contents of themeCatalog.json — that file is refreshed by
 * task 2-22 and its numbers are expected to move.
 */
const CATALOG: ThemeCatalog = {
  updatedAt: '2026-09-01',
  themes: {
    dawn: {
      displayName: 'Dawn',
      architecture: 'os2',
      source: 'test',
      releases: [
        { version: '5.0.0', releasedAt: '2026-08-01' },
        { version: '4.0.0', releasedAt: '2026-05-01' },
        { version: '3.1.0', releasedAt: '2025-09-01' },
        { version: '3.0.0', releasedAt: '2024-09-01' },
        { version: '2.0.0', releasedAt: '2022-01-01' },
        { version: '1.0.0', releasedAt: '2021-06-01' },
      ],
    },
    debut: { displayName: 'Debut', architecture: 'vintage', source: 'test', releases: [] },
    brooklyn: {
      displayName: 'Brooklyn',
      architecture: 'vintage',
      source: 'test',
      releases: [{ version: '17.9.0', releasedAt: '2026-08-20' }],
    },
    horizon: {
      displayName: 'Horizon',
      architecture: 'theme_blocks',
      source: 'test',
      releases: [],
    },
  },
};

function analyze(name: string | null, version: string | null) {
  return analyzeTheme({ name, version }, { catalog: CATALOG, now: NOW });
}

test('parses the version shapes StoreLeads actually sends', () => {
  assert.deepEqual(parseVersion('2.1.0'), { major: 2, minor: 1, patch: 0 });
  assert.deepEqual(parseVersion('v2.1'), { major: 2, minor: 1, patch: 0 });
  assert.deepEqual(parseVersion('17'), { major: 17, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion('7.3.6-beta'), { major: 7, minor: 3, patch: 6 });
  assert.equal(parseVersion('main'), null);
  assert.equal(parseVersion(null), null);
});

test('orders versions numerically, not as strings', () => {
  const a = parseVersion('10.0.0')!;
  const b = parseVersion('9.0.0')!;
  // '10.0.0' < '9.0.0' as strings; the whole gap count depends on this.
  assert.ok(compareVersions(a, b) > 0);
  assert.equal(compareVersions(parseVersion('2.1.0')!, parseVersion('2.1.0')!), 0);
});

test('counts whole calendar months only', () => {
  assert.equal(
    monthsBetween(new Date('2026-01-31T00:00:00Z'), new Date('2026-02-28T00:00:00Z')),
    0,
  );
  assert.equal(
    monthsBetween(new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')),
    1,
  );
  assert.equal(
    monthsBetween(new Date('2024-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z')),
    24,
  );
});

test('a store on the newest release is fresh with a zero gap', () => {
  const result = analyze('Dawn', '5.0.0');

  assert.equal(result.freshness, 'fresh');
  assert.equal(result.versionGap, 0);
  assert.equal(result.latestVersion, '5.0.0');
  assert.equal(result.releasedAt, '2026-08-01');
  assert.equal(result.ageMonths, 1);
});

test('counts every release published after the one the store runs', () => {
  const result = analyze('Dawn', '3.0.0');

  // 3.1.0, 4.0.0 and 5.0.0 came later; 2.0.0 and 1.0.0 did not.
  assert.equal(result.versionGap, 3);
  assert.equal(result.releasedAt, '2024-09-01');
  assert.equal(result.ageMonths, 24);
});

test('the worse of the two signals decides the bucket', () => {
  // Two releases behind is only 'slightly_outdated', but the version is 4 years
  // old, and four years is what the store's visitors actually experience.
  const result = analyze('Dawn', '2.0.0');

  assert.equal(result.versionGap, 4);
  assert.equal(result.ageMonths, 56);
  assert.equal(result.freshness, 'severely_outdated');
  assert.match(result.reason, /4 release\(s\) behind 5\.0\.0/);
  assert.match(result.reason, /released 56 month\(s\) ago/);
});

test('a version missing from the history gets a gap but no invented release date', () => {
  const result = analyze('Dawn', '3.0.5');

  // 3.1.0, 4.0.0 and 5.0.0 are all newer than 3.0.5.
  assert.equal(result.versionGap, 3);
  assert.equal(result.releasedAt, null);
  assert.equal(result.ageMonths, null);
  assert.equal(result.freshness, 'slightly_outdated');
});

test('a vintage theme can never read better than very_outdated', () => {
  // Brooklyn's latest release is three weeks old: gap 0, age 0, both 'fresh'.
  const result = analyze('Brooklyn', '17.9.0');

  assert.equal(result.versionGap, 0);
  assert.equal(result.freshness, 'very_outdated');
  assert.match(result.reason, /unsupported since 2021/);
});

test('a vintage theme with no history still gets a verdict from its architecture', () => {
  const result = analyze('Debut', '17.9.0');

  assert.equal(result.architecture, 'vintage');
  assert.equal(result.versionGap, null);
  assert.equal(result.freshness, 'very_outdated');
});

test('a theme-blocks theme with no history is treated as recent', () => {
  const result = analyze('horizon', '2.3.2');

  assert.equal(result.architecture, 'theme_blocks');
  assert.equal(result.freshness, 'fresh');
  assert.match(result.reason, /theme-blocks architecture/);
});

test('a catalogued theme with no reported version gets no freshness verdict', () => {
  const result = analyze('Dawn', null);

  assert.equal(result.architecture, 'os2');
  assert.equal(result.versionGap, null);
  // Unknown must not read as fine.
  assert.equal(result.freshness, null);
  assert.match(result.reason, /no version reported/);
});

test('an unknown theme yields nulls and says why', () => {
  const result = analyze('keyshortscom/main', '1.0.0');

  assert.equal(result.catalogued, false);
  assert.equal(result.architecture, null);
  assert.equal(result.freshness, null);
  assert.equal(result.versionGap, null);
  assert.equal(result.name, 'keyshortscom/main');
  assert.match(result.reason, /not in the reference/);
});

test('a store with no theme at all is reported as such', () => {
  const result = analyze(null, null);

  assert.equal(result.name, null);
  assert.equal(result.catalogued, false);
  assert.match(result.reason, /no theme reported/);
});

test('theme names are matched regardless of case and padding', () => {
  for (const name of ['Dawn', 'dawn', '  DAWN  ']) {
    assert.equal(analyze(name, '5.0.0').name, 'Dawn', name);
  }
  assert.equal(catalogKey('  Dawn '), 'dawn');
  assert.equal(catalogKey('   '), null);
});

test('freshness values stay inside the set the schema documents', () => {
  const allowed: ThemeFreshness[] = [
    'fresh',
    'slightly_outdated',
    'outdated',
    'very_outdated',
    'severely_outdated',
  ];
  const seen = ['5.0.0', '4.0.0', '3.0.0', '2.0.0', '1.0.0'].map(
    (v) => analyze('Dawn', v).freshness,
  );

  for (const freshness of seen) {
    assert.ok(freshness && allowed.includes(freshness), String(freshness));
  }
});

// --- the shipped reference itself -------------------------------------------

test('the shipped catalogue is well formed', () => {
  const catalog = loadThemeCatalog();
  const entries = Object.entries(catalog.themes);

  assert.ok(entries.length > 0);
  for (const [key, entry] of entries) {
    assert.equal(key, key.toLowerCase(), `${key} must be a lowercase lookup key`);
    assert.ok(entry, key);
    // Absent is allowed — it means "not verified"; a wrong value is not.
    if (entry.architecture !== undefined) {
      assert.ok(
        ['vintage', 'os2', 'theme_blocks', 'custom'].includes(entry.architecture),
        `${key}: ${entry.architecture}`,
      );
    }
    assert.ok(entry.source.length > 0, `${key} must record where its classification came from`);

    // Newest first: the analyser reads releases[0] as the latest version.
    const dates = entry.releases.map((r) => r.releasedAt);
    assert.deepEqual(dates, [...dates].sort().reverse(), `${key} releases must be newest first`);
  }
});

test('Dawn carries a real release history', () => {
  const dawn = findTheme('dawn');

  assert.ok(dawn);
  assert.equal(dawn.architecture, 'os2');
  assert.ok(dawn.releases.length > 10, 'Dawn should carry its full public history');
  assert.match(dawn.source, /github\.com\/Shopify\/dawn/);
});
