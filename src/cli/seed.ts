import { execute, transaction, type Database } from '../db/client.js';
import { attachStoreToRun, createRun, setRunStatus } from '../db/repositories/runs.js';
import { setStoreStatus, upsertStore } from '../db/repositories/stores.js';

interface SeedStore {
  domain: string;
  name: string;
  rank: number;
  revenue: number;
  traffic: number;
  theme: string;
  themeVersion: string;
  category: string;
  leadScore: number;
}

const DEMO_STORES: SeedStore[] = [
  {
    domain: 'demo-fashion.pl',
    name: 'Demo Fashion',
    rank: 412,
    revenue: 180_000,
    traffic: 42_000,
    theme: 'Dawn',
    themeVersion: '2.1.0',
    category: 'HIGH_REVENUE_OPPORTUNITY',
    leadScore: 93,
  },
  {
    domain: 'demo-tools.pl',
    name: 'Demo Tools',
    rank: 908,
    revenue: 45_000,
    traffic: 11_000,
    theme: 'Debut',
    themeVersion: '17.9.0',
    category: 'PERFORMANCE_PROBLEMS',
    leadScore: 71,
  },
];

/**
 * Demo data so the dashboard (Epic 6) can be developed before the real
 * collectors exist. Safe to run repeatedly — stores dedupe on domain.
 */
export function seed(db?: Database): { runId: number; stores: number } {
  return transaction(() => {
    const run = createRun('PL', DEMO_STORES.length, db);
    setRunStatus(run.id, 'RUNNING', {}, db);

    for (const demo of DEMO_STORES) {
      const { store } = upsertStore(
        {
          domain: demo.domain,
          url: `https://${demo.domain}`,
          name: demo.name,
          country: 'PL',
          platform: 'shopify',
          rank: demo.rank,
          revenue_estimate: demo.revenue,
          traffic_estimate: demo.traffic,
          products_count: 240,
          apps_count: 14,
          theme_name: demo.theme,
          theme_version: demo.themeVersion,
          first_seen_run_id: run.id,
        },
        db,
      );
      attachStoreToRun(run.id, store.id, db);

      const { lastInsertRowid: auditId } = execute(
        "INSERT INTO audits (store_id, run_id, status) VALUES (?, ?, 'OK')",
        [store.id, run.id],
        db,
      );

      execute(
        `INSERT INTO audit_issues (audit_id, store_id, page, category, severity, title, detail, evidence_json)
         VALUES (?, ?, 'product', 'technical', 'CRITICAL', 'Add to Cart does not respond',
                 'Clicking Add to Cart produces a console error and the cart count stays at 0.',
                 '{"console":"TypeError: cart is undefined","selector":"button[name=add]"}')`,
        [auditId, store.id],
        db,
      );
      execute(
        `INSERT INTO audit_issues (audit_id, store_id, page, category, severity, title, detail, evidence_json)
         VALUES (?, ?, 'site', 'performance', 'MAJOR', 'Mobile PageSpeed 38',
                 'LCP 5.4s on mobile.', '{"strategy":"mobile","lcp_ms":5400}')`,
        [auditId, store.id],
        db,
      );

      execute(
        `INSERT INTO pagespeed_results (store_id, strategy, performance, accessibility, best_practices, seo, lcp_ms, cls, ttfb_ms)
         VALUES (?, 'mobile', 38, 82, 75, 91, 5400, 0.21, 940)`,
        [store.id],
        db,
      );
      execute(
        `INSERT INTO pagespeed_results (store_id, strategy, performance, accessibility, best_practices, seo, lcp_ms, cls, ttfb_ms)
         VALUES (?, 'desktop', 74, 85, 83, 93, 2100, 0.08, 480)`,
        [store.id],
        db,
      );

      execute(
        `INSERT INTO ai_analyses (store_id, run_id, agent, prompt_version, category, lead_score, priority, reason)
         VALUES (?, ?, 'lead_classifier', 'v0-demo', ?, ?, 'HIGH',
                 'High traffic and estimated revenue combined with poor mobile performance and an outdated theme.')`,
        [store.id, run.id, demo.category, demo.leadScore],
        db,
      );

      const { lastInsertRowid: contactId } = execute(
        `INSERT INTO contacts (store_id, name, role, email, source, source_url, confidence, is_primary)
         VALUES (?, 'Demo Owner', 'Founder', ?, 'about_page', ?, 0.8, 1)`,
        [store.id, `owner@${demo.domain}`, `https://${demo.domain}/pages/about`],
        db,
      );

      execute(
        `INSERT INTO emails (store_id, contact_id, run_id, version, subject, body, word_count, category, prompt_version, status, qc_passed)
         VALUES (?, ?, ?, 1, ?, ?, 96, ?, 'v0-demo', 'READY', 1)`,
        [
          store.id,
          contactId,
          run.id,
          `Quick note about ${demo.name}`,
          `Hi,\n\nI was looking at ${demo.name} and noticed the Add to Cart button on product pages throws a console error, and mobile PageSpeed sits around 38. It may already be on your list.\n\nIf it is useful, I can send over the specific pages where I saw it.\n\nBest,`,
          demo.category,
        ],
        db,
      );

      setStoreStatus(store.id, 'AUDITED', undefined, db);
      setStoreStatus(store.id, 'ANALYZED', undefined, db);
      setStoreStatus(store.id, 'CONTACTED', undefined, db);
      setStoreStatus(store.id, 'EMAIL_READY', undefined, db);
    }

    setRunStatus(run.id, 'COMPLETED', {}, db);
    return { runId: run.id, stores: DEMO_STORES.length };
  }, db);
}
