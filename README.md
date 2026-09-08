# storelead-ai

Agents for identifying problems on websites based on criteria.

A local pipeline that pulls stores from StoreLeads, audits them with Playwright and
PageSpeed, classifies them with GPT, finds a decision-maker and drafts a
personal outreach email for human review. Nothing is sent automatically.

Full task breakdown: [`docs/TASKS.md`](docs/TASKS.md).

## Status

Epics 0–4 are complete: config, database, status machines, resumable
orchestrator, CLI and dashboard; the StoreLeads collector; the Playwright audit
with PageSpeed, theme and app analysis; the AI analyst, classifier and lead
score; and contact search, from the storefront's own pages and from web search.

Not implemented: outreach emails and their QC (Epic 5), the per-store dashboard
pages (6-04…6-09), and most of the cross-cutting work of Epic 7.

Running the pipeline needs `STORELEADS_API_KEY`. `PAGESPEED_API_KEY` is required
by the pagespeed step, and `OPENAI_API_KEY` by the AI steps and by contact web
search — see [`.env.example`](.env.example).

## Requirements

- Node.js 22+ (uses the built-in `node:sqlite`, so nothing is compiled natively)
- A StoreLeads API key (the only paid dependency) — set as `STORELEADS_API_KEY`

## Quick start

```bash
# 1. dependencies (root + apps/dashboard, npm workspaces hoists them)
npm install

# 2. configuration — put your StoreLeads key in STORELEADS_API_KEY
cp .env.example .env

# 3. database: creates data/database.sqlite and applies the schema.
#    Safe to re-run; already-applied migrations are skipped.
npm run pipeline -- db migrate

# 4. fetch the first batch of stores
npm run pipeline -- run --limit 10

# 5. dashboard on http://localhost:3000
npm run dashboard
```

There is no database server to install or start: SQLite is a single file at
`data/database.sqlite`, created by step 3. `data/` and `screenshots/` are
gitignored — delete either and the next command recreates it.

To look at the UI before fetching real stores, replace step 4 with
`npm run pipeline -- db seed`, which inserts two demo stores with issues,
a contact and an email.

## Database

```bash
npm run pipeline -- db migrate      # create / update the schema (idempotent)
npm run pipeline -- db seed         # demo data for dashboard work
npm run pipeline -- db reset --yes  # delete all data, keep the schema
npm run pipeline -- db backup       # consistent snapshot into data/backups/
npm run pipeline -- status          # recent runs and per-step timings
npm run pipeline -- report          # how the newest run went, with tokens
```

The schema lives in `src/db/migrations/*.sql`. To change it, add a new numbered
file — never edit an applied one — and run `db migrate` again.

`sqlite3 data/database.sqlite` opens it for ad-hoc queries if you have the CLI.

## Commands

```bash
npm run pipeline -- run --limit 10        # run a batch through every step
npm run pipeline -- run --run 3           # resume run 3, skipping finished work
npm run pipeline -- run --only fetch_stores  # a subset of steps
npm run pipeline -- run --force           # redo work that is already done
npm run pipeline -- step fetch_stores     # run a single step
npm run pipeline -- step email_generation --run 7 --store sklep.pl --force
npm run pipeline -- report --run 7        # counts, time and tokens per step
npm run pipeline -- cooldowns list        # domains we are backing off from
npm run pipeline -- config                # resolved config, secrets masked

npm run dashboard                         # Next.js UI on http://localhost:3000
npm test                                  # node:test suite
npm run verify                            # typecheck + lint + tests + dashboard build
```

Stop the dashboard with `Ctrl+C`, or `lsof -ti:3000 | xargs kill` if it is
running in the background.

## Running from the dashboard

The dashboard has **Fetch stores** (with a 5/10/25/50 batch selector), **Seed
demo data** and **Refresh**. Both tables are paginated (`?storesPage=2`,
`?runsPage=2`, `?pageSize=50`) and each carries a legend of every status it can
show, with a one-line meaning; statuses absent from the data are dimmed.

The stores table sorts by any column heading — domain, rank, lead score, revenue,
issue severity, store status or email status (`?sort=rank&dir=desc`). Rows with no
value always sort last in either direction, and changing the sort returns to page
one. An unrecognised `sort` or `dir` falls back to the default rather than
erroring, so a hand-edited URL cannot break the page. They do not run the pipeline inside the Next
server: they spawn the same CLI as a detached process, so a run outlives the
request that started it and survives the dev server restarting. Output goes to
`data/logs/ui-<action>-<timestamp>.log`.

Only one pipeline runs at a time. The guard is `data/pipeline.lock`, which holds
the pid of the process doing the work — the CLI claims it whether it was started
from a terminal or from a button. A database row cannot serve this purpose: a run
killed with SIGKILL leaves its row `RUNNING` forever. If the holding process is
gone the lock is ignored, and the next run marks the abandoned one `FAILED`.

## Runbook

### Keys, and what stops without them

| Key                  | Needed by                                             | Without it                                             |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `STORELEADS_API_KEY` | `fetch_stores`                                        | No new stores. Everything already in the database runs |
| `PAGESPEED_API_KEY`  | `pagespeed`                                           | That step fails per store; the run continues           |
| `OPENAI_API_KEY`     | `ai_analysis`, `email_generation`, contact web search | No analysis, no letters, no LinkedIn search            |

Only `STORELEADS_API_KEY` is paid. `WEB_SEARCH_ENABLED=false` turns off the
contact search's model calls without touching the rest.

### Backups

```bash
npm run pipeline -- db backup --keep 7                # database only
npm run pipeline -- db backup --screenshots --keep 3  # and the images
```

The database is the only thing that cannot be recomputed: audits, contacts and
letters exist nowhere else, and regenerating them costs money and another round
of requests to the storefronts. Screenshots are large and reproducible, so they
are copied only when asked.

`VACUUM INTO` is used rather than a file copy: SQLite in WAL mode keeps recent
writes in a side file, so copying `database.sqlite` mid-run yields a file missing
the newest rows. Restoring is a copy back with nothing running:

```bash
cp data/backups/20260908T135104/database.sqlite data/database.sqlite
```

### When a run dies

A run is resumable by design. Steps that declare `isSatisfied` skip work already
in the database, so the fix is almost always to run it again:

```bash
npm run pipeline -- report              # what failed and where
npm run pipeline -- run --run 7         # resume, skipping finished work
npm run pipeline -- run --run 7 --only pagespeed --force   # redo one step
```

A run killed with SIGKILL leaves `data/pipeline.lock` behind. If the pid in it is
gone the lock is ignored and the next run marks the abandoned run `FAILED` — no
cleanup needed. Delete the file by hand only if a live process is holding it and
you are sure it should not be.

### When storefronts start refusing

`429` and `403` are recorded in `domain_cooldowns`: an hour first, doubling to a
day. **`--force` does not bypass a cooldown**, deliberately — forcing is what
cost us access on 2026-09-02.

```bash
npm run pipeline -- cooldowns list          # who we are leaving alone, and until when
npm run pipeline -- cooldowns clear sklep.pl  # only when you know it recovered
```

A shop that is cooling still gets its contacts searched for on LinkedIn, since
that reads a search engine rather than the shop.

### Contacts and erasure (GDPR)

Contacts are personal data. `CONTACT_RETENTION_DAYS` (default 180) bounds how
long an unwritten-to lead is kept, and nothing expires silently mid-run:

```bash
npm run pipeline -- contacts purge                    # apply the retention window
npm run pipeline -- contacts forget --email a@b.pl    # erase and never collect again
npm run pipeline -- contacts forget --domain sklep.pl # the whole storefront
npm run pipeline -- contacts suppressions             # who asked not to be contacted
```

See [`docs/GDPR.md`](docs/GDPR.md) for the lawful basis and the retention rules.

### Nothing is ever sent

The pipeline stops at a draft. `READY` means QC passed and a human has not looked
yet; `APPROVED` is that human's decision, taken in the dashboard. Approved
letters leave the system only through the CSV export, by hand.

## Layout

```
src/
  config/       env parsing and resolved paths (single source of truth)
  db/           sqlite client, SQL migrations, row types, repositories
  pipeline/     status machines, retry/timeout, orchestrator, step registry
  collectors/   StoreLeads, Playwright, PageSpeed        (Epics 1-2)
  agents/       Store Analyst, Classifier, Contacts, Outreach (Epics 3-5)
  cli/          commander entrypoint and demo seed
apps/dashboard/ Next.js + Tailwind + shadcn/ui, read-only view of the database
data/           sqlite file and logs (gitignored)
screenshots/    audit screenshots (gitignored)
```

## How a run works

Steps are declared in `src/pipeline/steps/index.ts` and executed in `STEP_ORDER`.
Each step is retried with backoff, capped by a timeout, and recorded in `step_logs`.
A step that declares `isSatisfied` is skipped when its result already exists, which
is what makes a run resumable — a batch that dies on store 7 picks up at store 7.
A per-store failure marks that store `FAILED` and lets the run continue; only a
run-scoped failure aborts the whole run.
