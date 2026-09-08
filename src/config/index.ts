/**
 * IMPORTANT: this module must not import anything by relative path.
 *
 * `apps/dashboard/next.config.ts` imports it to learn where the database lives,
 * and Next's config loader resolves that file with CommonJS `require`, which
 * cannot map a `.js` specifier onto a `.ts` file. A single relative import here
 * breaks `next build` with "Cannot find module '../lib/errors.js'".
 * Node built-ins and node_modules packages are fine.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';

/**
 * Project root. The CLI runs from the repository root, but the Next.js dashboard
 * runs from `apps/dashboard` and may be bundled, so neither cwd nor this file's
 * location can be trusted alone. Walk up looking for the workspace package.json.
 */
function resolveRoot(): string {
  const explicit = process.env.STORELEAD_ROOT;
  if (explicit) return path.resolve(explicit);

  for (const start of [import.meta.dirname, process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const pkgPath = path.join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
          if (pkg.name === 'storelead-ai') return dir;
        } catch {
          // unreadable package.json — keep walking up
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(import.meta.dirname, '../..');
}

export const ROOT_DIR = resolveRoot();

/** `KEY=` in a .env file yields '' — treat that as "not set" rather than an invalid value. */
const optionalSecret = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Only paid subscription the project requires.
  STORELEADS_API_KEY: optionalSecret,
  // The domain endpoints live under /all — verified against the live API.
  STORELEADS_API_URL: z.string().url().default('https://storeleads.app/json/api/v1/all'),

  // OpenAI API — the agents of Epics 3–5 call the model directly with this key.
  OPENAI_API_KEY: optionalSecret,
  // Every agent runs on the same model unless a step overrides it.
  OPENAI_MODEL: z.string().default('gpt-5.5'),
  // Optional. An `sk-proj-…` key already names its project, so this only matters
  // for a user-level key that can see more than one; it sets the OpenAI-Project
  // header requests are attributed to.
  OPENAI_PROJECT_ID: optionalSecret,

  // Google PageSpeed Insights. Optional at boot, required by the pagespeed step:
  // the anonymous quota is zero since 2026 (a keyless call answers 429).
  PAGESPEED_API_KEY: optionalSecret,

  // Filesystem locations. Relative paths are resolved against ROOT_DIR.
  DATABASE_PATH: z.string().default('data/database.sqlite'),
  SCREENSHOTS_DIR: z.string().default('screenshots'),
  LOG_DIR: z.string().default('data/logs'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Pipeline limits.
  BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  STORE_CONCURRENCY: z.coerce.number().int().positive().max(10).default(2),
  TARGET_COUNTRY: z.string().length(2).default('PL'),
  // The audit checks are Shopify-shaped; leave empty to fetch every platform.
  TARGET_PLATFORM: z.string().default('shopify'),

  // Politeness towards audited storefronts (task 7-06).
  REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(1000),
  PAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // PageSpeed quota and cache (task 2-20). An analysis costs a Lighthouse run on
  // Google's hardware and the numbers barely move day to day, so a result is
  // reused for a week. The per-run ceiling is a stop-loss, not the API's quota:
  // it bounds what one accidental `--force` over a large batch can spend.
  PAGESPEED_CACHE_DAYS: z.coerce.number().int().positive().max(365).default(7),
  PAGESPEED_MAX_REQUESTS_PER_RUN: z.coerce.number().int().positive().default(200),

  // Ceiling for the fact bundle sent to the AI agents (task 3-01), in bytes of JSON.
  AI_CONTEXT_MAX_BYTES: z.coerce.number().int().positive().default(32_000),

  // Web search for contacts (tasks 4-05…4-07). It runs on the OpenAI key that is
  // already here — that is why the provider was chosen — so there is no separate
  // secret, only spend controls.
  WEB_SEARCH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Defaults to OPENAI_MODEL. The search runner reasons about nothing — it copies
  // out a result list — so a cheaper model belongs here when one is available.
  OPENAI_WEB_SEARCH_MODEL: optionalSecret,
  // Queries per store. Two covers the plan's LinkedIn templates; the third
  // template of 4-06 has no reader yet (see contacts/webSearch.ts).
  WEB_SEARCH_MAX_QUERIES_PER_STORE: z.coerce.number().int().nonnegative().max(5).default(2),
  // Stop-loss for one run, in billable searches. At roughly $10 per thousand,
  // the default caps a single run at about a dollar — the ceiling exists because
  // `--force` over a large batch is what turns a cheap feature into a bill.
  WEB_SEARCH_MAX_SEARCHES_PER_RUN: z.coerce.number().int().nonnegative().default(100),

  // How the contact scraper introduces itself (task 7-06). The audit keeps a
  // browser user agent on purpose: it has to see the storefront the way a
  // shopper does, and a shop that serves bots a different page would make its
  // findings describe something no customer ever sees. The contact scraper needs
  // no such fidelity, so it says who it is and obeys robots.txt.
  CRAWLER_CONTACT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(1).optional(),
  ),

  // How long a contact may be kept (task 4-11). Contacts are personal data of EU
  // citizens; storage limitation means a lead nobody wrote to has to expire.
  // Applied by `pipeline contacts purge`, never silently mid-run.
  CONTACT_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(180),
});

export type Env = z.infer<typeof envSchema>;

function loadEnvFile(): void {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!existsSync(envPath)) return;
  // Node 20.6+ ships a .env parser; avoids a dotenv dependency.
  process.loadEnvFile(envPath);
}

function buildConfig() {
  loadEnvFile();

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example`);
  }

  const env = parsed.data;
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(ROOT_DIR, p));

  return {
    env: env.NODE_ENV,
    isTest: env.NODE_ENV === 'test',

    storeleads: {
      apiKey: env.STORELEADS_API_KEY,
      apiUrl: env.STORELEADS_API_URL,
    },
    pagespeed: {
      apiKey: env.PAGESPEED_API_KEY,
      cacheDays: env.PAGESPEED_CACHE_DAYS,
      maxRequestsPerRun: env.PAGESPEED_MAX_REQUESTS_PER_RUN,
    },
    paths: {
      root: ROOT_DIR,
      database: resolve(env.DATABASE_PATH),
      data: path.dirname(resolve(env.DATABASE_PATH)),
      screenshots: resolve(env.SCREENSHOTS_DIR),
      logs: resolve(env.LOG_DIR),
      migrations: path.join(ROOT_DIR, 'src/db/migrations'),
    },
    log: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
    },
    pipeline: {
      batchSize: env.BATCH_SIZE,
      storeConcurrency: env.STORE_CONCURRENCY,
      targetCountry: env.TARGET_COUNTRY.toUpperCase(),
      targetPlatform: env.TARGET_PLATFORM.trim().toLowerCase(),
    },
    audit: {
      requestDelayMs: env.REQUEST_DELAY_MS,
      pageTimeoutMs: env.PAGE_TIMEOUT_MS,
    },
    contacts: {
      retentionDays: env.CONTACT_RETENTION_DAYS,
    },
    crawler: {
      /** Product token plus a way to reach us, when the operator supplied one. */
      userAgent: env.CRAWLER_CONTACT
        ? `StoreLeadBot/0.1 (+${env.CRAWLER_CONTACT})`
        : 'StoreLeadBot/0.1',
      contact: env.CRAWLER_CONTACT,
    },
    ai: {
      contextMaxBytes: env.AI_CONTEXT_MAX_BYTES,
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      projectId: env.OPENAI_PROJECT_ID,
    },
    webSearch: {
      enabled: env.WEB_SEARCH_ENABLED,
      model: env.OPENAI_WEB_SEARCH_MODEL ?? env.OPENAI_MODEL,
      maxQueriesPerStore: env.WEB_SEARCH_MAX_QUERIES_PER_STORE,
      maxSearchesPerRun: env.WEB_SEARCH_MAX_SEARCHES_PER_RUN,
    },
  } as const;
}

export type Config = ReturnType<typeof buildConfig>;

let cached: Config | undefined;

/** Lazily built and memoised so importing a module never throws on a missing .env. */
export function getConfig(): Config {
  cached ??= buildConfig();
  return cached;
}

/**
 * Fails fast when a step genuinely needs a key that is only optional at boot.
 * `retryable: false` is read by `lib/errors.isRetryable` — set as a plain property
 * rather than by throwing StepError, to preserve the no-relative-imports rule above.
 */
const KEY_VARS = {
  storeleads: 'STORELEADS_API_KEY',
  pagespeed: 'PAGESPEED_API_KEY',
  ai: 'OPENAI_API_KEY',
} as const;

export function requireKey<K extends keyof typeof KEY_VARS>(service: K): string {
  const key = getConfig()[service].apiKey;
  if (!key) {
    const varName = KEY_VARS[service];
    throw Object.assign(
      new Error(`${varName} is required for this step but is not set. See .env.example`),
      { retryable: false },
    );
  }
  return key;
}

/** Clears the memoised config so tests can rebuild it from a modified environment. */
export function resetConfig(): void {
  cached = undefined;
}
