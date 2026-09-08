import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { isRetryable } from '../lib/errors.js';
import { getConfig, requireKey, resetConfig, ROOT_DIR } from './index.js';

/** Runs `fn` with a patched environment, restoring it afterwards. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  resetConfig();
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  }
}

test('treats an empty env value as unset rather than invalid', () => {
  withEnv({ STORELEADS_API_KEY: '', PAGESPEED_API_KEY: '   ' }, () => {
    const config = getConfig();
    assert.equal(config.storeleads.apiKey, undefined);
    assert.equal(config.pagespeed.apiKey, undefined);
  });
});

test('resolves relative paths against the project root', () => {
  withEnv({ DATABASE_PATH: 'data/test.sqlite' }, () => {
    assert.equal(getConfig().paths.database, path.join(ROOT_DIR, 'data/test.sqlite'));
  });
});

test('keeps absolute paths as given', () => {
  withEnv({ DATABASE_PATH: '/tmp/elsewhere.sqlite' }, () => {
    assert.equal(getConfig().paths.database, '/tmp/elsewhere.sqlite');
  });
});

test('applies defaults for pipeline limits', () => {
  withEnv(
    { BATCH_SIZE: undefined, TARGET_COUNTRY: undefined, STORE_CONCURRENCY: undefined },
    () => {
      const config = getConfig();
      assert.equal(config.pipeline.batchSize, 10);
      assert.equal(config.pipeline.targetCountry, 'PL');
      assert.equal(config.pipeline.storeConcurrency, 2);
    },
  );
});

test('coerces numeric env vars and uppercases the country', () => {
  withEnv({ BATCH_SIZE: '25', TARGET_COUNTRY: 'de' }, () => {
    assert.equal(getConfig().pipeline.batchSize, 25);
    assert.equal(getConfig().pipeline.targetCountry, 'DE');
  });
});

test('rejects an out-of-range batch size with a readable message', () => {
  withEnv({ BATCH_SIZE: '500' }, () => {
    assert.throws(() => getConfig(), /Invalid environment configuration[\s\S]*BATCH_SIZE/);
  });
});

test('rejects a non-numeric batch size', () => {
  withEnv({ BATCH_SIZE: 'ten' }, () => {
    assert.throws(() => getConfig(), /BATCH_SIZE/);
  });
});

test('requireKey returns the key when present', () => {
  withEnv({ STORELEADS_API_KEY: 'abc123' }, () => {
    assert.equal(requireKey('storeleads'), 'abc123');
  });
});

test('a missing key is a non-retryable error, not a transient one', () => {
  withEnv({ STORELEADS_API_KEY: '' }, () => {
    assert.throws(
      () => requireKey('storeleads'),
      (error: Error & { retryable?: boolean }) => {
        assert.equal(error.retryable, false);
        assert.equal(isRetryable(error), false, 'the pipeline must not retry a missing key');
        assert.match(error.message, /STORELEADS_API_KEY is required/);
        return true;
      },
    );
  });
});

test('the config module imports nothing by relative path', () => {
  // apps/dashboard/next.config.ts loads this file through Next's CommonJS config
  // loader, which cannot resolve a '.js' specifier onto a '.ts' file. A relative
  // import here breaks `next build`; it already did once.
  const source = readFileSync(new URL('index.ts', import.meta.url), 'utf-8');
  const relativeImports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'(\.[^']*)'/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(relativeImports, [], 'move the dependency or inline it');
});

test('names the right variable for each service', () => {
  withEnv({ PAGESPEED_API_KEY: '' }, () => {
    assert.throws(() => requireKey('pagespeed'), /PAGESPEED_API_KEY is required/);
  });
  withEnv({ OPENAI_API_KEY: '' }, () => {
    assert.throws(() => requireKey('ai'), /OPENAI_API_KEY is required/);
  });
});

test('reads the AI agent settings from the OPENAI_ variables', () => {
  withEnv(
    { OPENAI_API_KEY: 'sk-proj-test', OPENAI_MODEL: undefined, OPENAI_PROJECT_ID: '' },
    () => {
      const { ai } = getConfig();
      assert.equal(ai.apiKey, 'sk-proj-test');
      assert.equal(requireKey('ai'), 'sk-proj-test');
      // A project key carries its own project; the header is only for user-level keys.
      assert.equal(ai.projectId, undefined);
      assert.match(ai.model, /^gpt-/, 'the default model must be a GPT model');
    },
  );
  withEnv({ OPENAI_MODEL: 'gpt-5.4-mini', OPENAI_PROJECT_ID: 'proj_abc' }, () => {
    assert.equal(getConfig().ai.model, 'gpt-5.4-mini');
    assert.equal(getConfig().ai.projectId, 'proj_abc');
  });
});

test('defaults the platform filter to shopify and allows disabling it', () => {
  withEnv({ TARGET_PLATFORM: undefined }, () => {
    assert.equal(getConfig().pipeline.targetPlatform, 'shopify');
  });
  withEnv({ TARGET_PLATFORM: '' }, () => {
    assert.equal(getConfig().pipeline.targetPlatform, '', 'empty means every platform');
  });
  withEnv({ TARGET_PLATFORM: 'WooCommerce' }, () => {
    assert.equal(getConfig().pipeline.targetPlatform, 'woocommerce');
  });
});

test('the StoreLeads base url points at the /all namespace', () => {
  withEnv({ STORELEADS_API_URL: undefined }, () => {
    assert.match(getConfig().storeleads.apiUrl, /\/json\/api\/v1\/all$/);
  });
});
