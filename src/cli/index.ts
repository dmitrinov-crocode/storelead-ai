#!/usr/bin/env node
import { Command } from 'commander';
import { getConfig } from '../config/index.js';
import { closeDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { resetDatabase } from '../db/reset.js';
import { clearLock } from '../lib/pipelineLock.js';
import {
  forgetDomain,
  forgetEmail,
  listSuppressions,
  purgeExpiredContacts,
  unsuppress,
} from '../db/repositories/contacts.js';
import { listCooldowns, noteSuccess } from '../db/repositories/cooldowns.js';
import { listRuns } from '../db/repositories/runs.js';
import { listRunSteps } from '../db/repositories/stepLogs.js';
import { formatRunReport, summariseRun } from '../pipeline/report.js';
import { createBackup } from '../db/backup.js';
import { logger } from '../lib/logger.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { STEP_ORDER, type StepName } from '../pipeline/status.js';
import { STEPS } from '../pipeline/steps/index.js';
import { seed } from './seed.js';
import { loadThemeCatalog, saveThemeCatalog } from '../analysis/themeCatalog.js';
import { updateThemeCatalog } from '../analysis/updateCatalog.js';

const program = new Command();

program
  .name('pipeline')
  .description('StoreLead AI — local lead discovery pipeline')
  .version('0.1.0');

function parseSteps(value: string): StepName[] {
  const names = value.split(',').map((s) => s.trim());
  const invalid = names.filter((n) => !STEP_ORDER.includes(n as StepName));
  if (invalid.length > 0) {
    throw new Error(`Unknown step(s): ${invalid.join(', ')}. Known: ${STEP_ORDER.join(', ')}`);
  }
  return names as StepName[];
}

/** `--store a.pl,b.pl`, or the flag repeated. Normalisation happens in the orchestrator. */
function parseDomains(value: string, previous: string[] = []): string[] {
  const names = value
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain !== '');
  if (names.length === 0) throw new Error('--store needs at least one domain');
  return [...previous, ...names];
}

program
  .command('run')
  .description('Run the pipeline over a batch of stores')
  .option('-l, --limit <n>', 'stores per batch', (v) => Number.parseInt(v, 10))
  .option('-c, --country <code>', 'two-letter country code')
  .option('-j, --concurrency <n>', 'stores audited in parallel', (v) => Number.parseInt(v, 10))
  .option('--only <steps>', 'comma-separated subset of steps', parseSteps)
  .option('--run <id>', 'resume an existing run', (v) => Number.parseInt(v, 10))
  .option('--store <domains>', 'restrict store steps to these domains', parseDomains)
  .option('--force', 'redo work that is already done', false)
  .action(async (opts: Record<string, unknown>) => {
    // Touch the database up front so a schema drift fails before any network call.
    migrate();

    if (STEPS.length === 0) {
      logger().warn('no pipeline steps are registered yet — see src/pipeline/steps');
    }

    const report = await runPipeline(STEPS, {
      ...(opts.run ? { runId: opts.run as number } : {}),
      ...(opts.only ? { only: opts.only as StepName[] } : {}),
      ...(opts.limit ? { batchSize: opts.limit as number } : {}),
      ...(opts.country ? { country: opts.country as string } : {}),
      ...(opts.concurrency ? { concurrency: opts.concurrency as number } : {}),
      ...(opts.store ? { domains: opts.store as string[] } : {}),
      force: Boolean(opts.force),
    });

    process.exitCode = report.status === 'COMPLETED' ? 0 : 1;
  });

program
  .command('step <name>')
  .description('Run a single step, optionally for one store')
  .option('--run <id>', 'run to attribute the step to', (v) => Number.parseInt(v, 10))
  .option('--store <domains>', 'restrict the step to these domains', parseDomains)
  .option('--force', 'redo work that is already done', false)
  .action(async (name: string, opts: Record<string, unknown>) => {
    const only = parseSteps(name);
    migrate();

    const report = await runPipeline(STEPS, {
      only,
      ...(opts.run ? { runId: opts.run as number } : {}),
      ...(opts.store ? { domains: opts.store as string[] } : {}),
      force: Boolean(opts.force),
    });
    process.exitCode = report.status === 'COMPLETED' ? 0 : 1;
  });

const db = program.command('db').description('Database maintenance');

db.command('migrate')
  .description('Apply pending migrations')
  .action(() => {
    const applied = migrate();
    logger().info({ applied: applied.length }, 'migrate finished');
  });

db.command('reset')
  .description('Delete all pipeline data, keeping the schema')
  .option('-y, --yes', 'required: confirms the data will be deleted', false)
  .action((opts: { yes: boolean }) => {
    if (!opts.yes) {
      process.stdout.write(
        'This deletes every store, run, audit, contact and email.\n' +
          'Re-run with --yes to confirm: npm run pipeline -- db reset --yes\n',
      );
      process.exitCode = 1;
      return;
    }
    migrate();
    const summary = resetDatabase();
    clearLock(getConfig().paths.data);
    logger().info({ tables: summary.tables.length, rows: summary.rowsDeleted }, 'database reset');
  });

db.command('backup')
  .description('Snapshot the database (and optionally the screenshots)')
  .option('--dir <path>', 'where to write it (default: data/backups)')
  .option('--screenshots', 'copy the screenshots too — large, and regenerable', false)
  .option('--keep <n>', 'keep only the newest N backups', (v) => Number.parseInt(v, 10))
  .action((opts: { dir?: string; screenshots: boolean; keep?: number }) => {
    migrate();
    const result = createBackup({
      ...(opts.dir ? { dir: opts.dir } : {}),
      screenshots: opts.screenshots,
      ...(opts.keep === undefined ? {} : { keep: opts.keep }),
    });
    const mb = (result.databaseBytes / 1024 / 1024).toFixed(1);
    process.stdout.write(`Database: ${result.database} (${mb} MB)\n`);
    if (result.screenshots) {
      process.stdout.write(
        `Screenshots: ${result.screenshots} (${result.screenshotFiles} files)\n`,
      );
    }
    if (result.pruned.length > 0) {
      process.stdout.write(`Removed older backups: ${result.pruned.join(', ')}\n`);
    }
  });

db.command('seed')
  .description('Insert one demo run with stores, issues and an email (for dashboard work)')
  .action(() => {
    migrate();
    const result = seed();
    logger().info(result, 'seed finished');
  });

const cooldowns = program
  .command('cooldowns')
  .description('Domains we are backing off from after a refusal');

cooldowns
  .command('list', { isDefault: true })
  .description('Show the domains currently being left alone, and until when')
  .action(() => {
    migrate();
    const rows = listCooldowns();
    if (rows.length === 0) {
      process.stdout.write('  (none)\n');
      return;
    }
    for (const row of rows) {
      const minutes = Math.ceil((Date.parse(row.blocked_until) - Date.now()) / 60_000);
      process.stdout.write(
        `  ${row.domain.padEnd(28)} ${row.reason.padEnd(14)} ` +
          `strike ${row.strikes}  ${String(minutes).padStart(4)} min left\n`,
      );
    }
  });

cooldowns
  .command('clear')
  .description('Lift the backoff for one domain — use when you know it recovered')
  .argument('<domain>')
  .action((domain: string) => {
    migrate();
    noteSuccess(domain);
    logger().info({ domain }, 'cooldown cleared');
  });

/**
 * Contact data protection (task 4-11).
 *
 * These are the mechanisms behind `docs/GDPR.md`: the right to erasure and the
 * right to object are only real if there is a command that honours them, and if
 * what it does survives the next pipeline run.
 */
const contacts = program
  .command('contacts')
  .description('Contact data protection: erasure requests and retention');

contacts
  .command('forget')
  .description('Erase a contact and refuse to collect it again (GDPR art. 17 / 21)')
  .option('--email <address>', 'a single mailbox')
  .option('--domain <domain>', 'every contact of one storefront')
  .option('--reason <reason>', 'erasure_request | objection | manual', 'erasure_request')
  .action((opts: { email?: string; domain?: string; reason: string }) => {
    if (!opts.email === !opts.domain) {
      process.stderr.write('Pass exactly one of --email or --domain\n');
      process.exitCode = 1;
      return;
    }
    migrate();
    const reason = opts.reason as 'erasure_request' | 'objection' | 'manual';
    const result = opts.email
      ? forgetEmail(opts.email, reason)
      : forgetDomain(opts.domain!, reason);

    logger().info(
      { target: opts.email ?? opts.domain, reason, deleted: result.deleted },
      'contact erased and suppressed',
    );
  });

contacts
  .command('allow')
  .description('Remove an entry from the suppression list (does not restore the contacts)')
  .argument('<identifier>', 'the email or domain to un-suppress')
  .action((identifier: string) => {
    migrate();
    const { removed } = unsuppress(identifier);
    logger().info({ identifier, removed }, 'suppression removed');
  });

contacts
  .command('suppressions')
  .description('List everyone who asked not to be contacted')
  .action(() => {
    migrate();
    const rows = listSuppressions();
    if (rows.length === 0) {
      process.stdout.write('  (none)\n');
      return;
    }
    for (const row of rows) {
      process.stdout.write(
        `  ${(row.email ?? row.domain ?? '').padEnd(40)} ${row.reason.padEnd(16)} ${row.created_at}\n`,
      );
    }
  });

contacts
  .command('purge')
  .description('Delete contacts older than CONTACT_RETENTION_DAYS')
  .option('--days <n>', 'override the configured retention', (v) => Number.parseInt(v, 10))
  .action((opts: { days?: number }) => {
    migrate();
    const days = opts.days ?? getConfig().contacts.retentionDays;
    const { deleted } = purgeExpiredContacts(days);
    logger().info({ days, deleted }, 'expired contacts purged');
  });

const themes = program.command('themes').description('Theme reference maintenance');

themes
  .command('update')
  .description('Refresh src/analysis/themeCatalog.json from the public theme repositories')
  .option('--check', 'report what would change and exit non-zero, without writing', false)
  .option('--token <token>', 'GitHub token (defaults to $GITHUB_TOKEN); raises the rate limit')
  .action(async (opts: { check: boolean; token?: string }) => {
    const before = loadThemeCatalog();
    const { catalog, updates, changed } = await updateThemeCatalog(before, {
      // Maintenance-only credential, so it is read here rather than in the
      // validated config every run has to satisfy.
      token: opts.token ?? process.env.GITHUB_TOKEN,
    });

    for (const update of updates) {
      if (update.error) {
        process.stdout.write(`  ${update.displayName.padEnd(12)} FAILED — ${update.error}\n`);
        continue;
      }
      const move = update.changed ? `${update.from ?? '—'} → ${update.to ?? '—'}` : 'unchanged';
      process.stdout.write(
        `  ${update.displayName.padEnd(12)} ${String(update.to ?? '—').padEnd(10)} ` +
          `${String(update.releases).padStart(3)} release(s)  ${move}\n`,
      );
    }

    const failed = updates.filter((u) => u.error).length;
    if (failed > 0) {
      // Nothing was lost — a failed entry keeps its previous data — but the run
      // is incomplete, and a silent partial refresh is how stale data survives.
      process.stdout.write(`\n${failed} theme(s) could not be refreshed; existing data kept\n`);
    }

    if (opts.check) {
      process.stdout.write(
        changed ? '\ncatalogue is out of date\n' : '\ncatalogue is up to date\n',
      );
      process.exitCode = changed || failed > 0 ? 1 : 0;
      return;
    }

    saveThemeCatalog(catalog);
    process.stdout.write(`\nwrote ${catalog.updatedAt} to src/analysis/themeCatalog.json\n`);
    process.exitCode = failed > 0 ? 1 : 0;
  });

program
  .command('status')
  .description('Show recent runs and their steps')
  .option('-n, --limit <n>', 'how many runs to show', (v) => Number.parseInt(v, 10), 5)
  .action((opts: { limit: number }) => {
    migrate();
    const runs = listRuns(opts.limit);
    if (runs.length === 0) {
      process.stdout.write('No runs yet. Try: npm run pipeline -- run --limit 10\n');
      return;
    }
    for (const run of runs) {
      process.stdout.write(
        `\nRun #${run.id}  ${run.status}  ${run.country}  batch=${run.batch_size}  ${run.started_at}\n`,
      );
      if (run.error) process.stdout.write(`  error: ${run.error}\n`);
      for (const step of listRunSteps(run.id)) {
        const target = step.store_id ? `store ${step.store_id}` : 'run';
        const ms = step.duration_ms == null ? '' : ` ${step.duration_ms}ms`;
        process.stdout.write(
          `  ${step.step.padEnd(18)} ${step.status.padEnd(8)} ${target}${ms}${step.error ? ` — ${step.error}` : ''}\n`,
        );
      }
    }
  });

program
  .command('report')
  .description('How one run went: counts, time and tokens per step')
  .option('--run <id>', 'which run (default: the newest)', (v) => Number.parseInt(v, 10))
  .action((opts: { run?: number }) => {
    migrate();
    const runId = opts.run ?? listRuns(1)[0]?.id;
    if (runId === undefined) {
      process.stdout.write('No runs yet. Try: npm run pipeline -- run --limit 10\n');
      return;
    }
    process.stdout.write(formatRunReport(summariseRun(runId, listRunSteps(runId))));
  });

program
  .command('config')
  .description('Print the resolved configuration (secrets masked)')
  .action(() => {
    const config = getConfig();
    const mask = (v?: string) => (v ? `${v.slice(0, 4)}…(${v.length})` : '(not set)');
    process.stdout.write(
      JSON.stringify(
        {
          ...config,
          storeleads: { ...config.storeleads, apiKey: mask(config.storeleads.apiKey) },
          pagespeed: { apiKey: mask(config.pagespeed.apiKey) },
        },
        null,
        2,
      ) + '\n',
    );
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  logger().error({ err: (error as Error).message }, 'command failed');
  process.exitCode = 1;
} finally {
  closeDb();
}
