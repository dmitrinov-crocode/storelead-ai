import type { Page, Response } from 'playwright';
import type { Database } from '../db/client.js';
import {
  clearIssues,
  createAudit,
  finishAudit,
  saveIssues,
  type AuditIssueInput,
} from '../db/repositories/audits.js';
import type { AuditRow, IssuePage, IssueSeverity, StoreRow } from '../db/types.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { AuditStatus } from '../pipeline/status.js';
import type { ViewportProfile } from './browser.js';
import {
  CheckSuite,
  classifyNavigation,
  type CheckOutcome,
  type PageAvailability,
} from './checkRunner.js';
import { runCollectionChecks } from './checks/collection.js';
import type { CheckContext } from './checks/context.js';
import { runCartChecks } from './checks/cart.js';
import { gradeCheckout, readCheckout } from './checks/checkout.js';
import { runHomepageChecks } from './checks/homepage.js';
import { runProductChecks } from './checks/product.js';
import { runResponsiveChecks } from './checks/responsive.js';
import { runSeoChecks, type SeoFacts, type SiteSeoFacts } from './checks/seo.js';
import { discoverKeyUrls, type KeyUrls } from './discovery.js';
import { countBySeverity, dedupeIssues, sortIssues, type Issue } from './issues.js';
import { checkLinks, gradeLinks } from './linkChecker.js';
import { attachPageCollectors, type PageCollector } from './pageCollector.js';
import { detectBotProtection, dismissConsentBanner } from './protection.js';
import { captureScreenshot } from './screenshots.js';
import type { AuditSession } from './session.js';

/**
 * The audit aggregator (task 2-18).
 *
 * Runs every check from tasks 2-10 … 2-17 over one store, collects the findings
 * into a single object and writes it to `audits`, `audit_issues` and
 * `screenshots`. Nothing here throws for a bad storefront: a shop that is down,
 * blocked or half-broken produces a *result* saying so.
 */

export interface PageReport {
  page: IssuePage;
  viewport: ViewportProfile;
  url: string | null;
  availability: PageAvailability | 'not_found';
  httpStatus: number | null;
  navigationMs: number | null;
  screenshotId: number | null;
  checks: { name: string; status: CheckOutcome['status']; error: string | null }[];
  facts?: unknown;
}

export interface AuditReport {
  audit: AuditRow;
  status: AuditStatus;
  blocked: boolean;
  botProtection: { vendor: string | null; signal: string | null };
  keyUrls: KeyUrls | null;
  issues: Issue[];
  counts: Record<IssueSeverity, number>;
  pages: PageReport[];
  seo: { page: SeoFacts | null; site: SiteSeoFacts | null };
}

export interface AuditStoreOptions {
  store: StoreRow;
  session: AuditSession;
  runId?: number | null;
  db?: Database | undefined;
  logger?: Logger | undefined;
  /** Turns off the depth-1 link crawl, the slowest part of the audit. */
  skipLinks?: boolean | undefined;
  /** Turns off the only part that changes the shop's state. */
  skipCart?: boolean | undefined;
  /** Overrides SCREENSHOTS_DIR; tests write into a temp folder. */
  screenshotsDir?: string | undefined;
}

export async function auditStore(options: AuditStoreOptions): Promise<AuditReport> {
  return new StoreAuditor(options).run();
}

class StoreAuditor {
  private readonly logger: Logger;
  private readonly store: StoreRow;
  private readonly session: AuditSession;
  private readonly db: Database | undefined;

  private readonly suite: CheckSuite;
  private readonly pages: PageReport[] = [];
  private readonly issues: Issue[] = [];

  private auditId = 0;
  private blocked = false;
  private botProtection: { vendor: string | null; signal: string | null } = {
    vendor: null,
    signal: null,
  };
  private homepageReachable = false;
  private keyUrls: KeyUrls | null = null;
  private seo: { page: SeoFacts | null; site: SiteSeoFacts | null } = { page: null, site: null };

  constructor(private readonly options: AuditStoreOptions) {
    this.store = options.store;
    this.session = options.session;
    this.db = options.db;
    this.logger = (options.logger ?? silentLogger()).child({
      store_id: this.store.id,
      domain: this.store.domain,
      step: 'audit',
    });
    this.suite = new CheckSuite({ logger: this.logger });
  }

  async run(): Promise<AuditReport> {
    const audit = createAudit(this.store.id, this.options.runId ?? null, this.db);
    this.auditId = audit.id;
    // A re-run replaces its own previous findings rather than adding to them.
    clearIssues(this.auditId, this.db);

    const origin = new URL(this.store.url).origin;

    await this.auditHomepage(origin, 'desktop');
    if (!this.blocked && this.homepageReachable) {
      await this.auditHomepage(origin, 'mobile');
      this.keyUrls = await this.discover(origin);
      await this.auditCollection();
      await this.auditProduct();
      if (!this.options.skipCart) await this.auditCartAndCheckout(origin);
    }

    return this.persist();
  }

  /** Opens a page with collectors attached and classifies whether it loaded. */
  private async open(
    url: string,
    target: IssuePage,
    viewport: ViewportProfile,
  ): Promise<{
    ctx: CheckContext;
    collector: PageCollector;
    report: PageReport;
    ok: boolean;
    /** The navigation response, so callers can read its status and headers. */
    response: Response | null;
    /** Index of the availability issue this call recorded, if any. */
    issueIndex: number | null;
  }> {
    const page = await this.session.newPage(viewport);
    const collector = attachPageCollectors(page);
    const nav = await this.session.goto(page, url, { waitUntil: 'load' });
    const verdict = classifyNavigation(nav, { page: target, url });
    let issueIndex: number | null = null;
    if (verdict.issue) {
      issueIndex = this.issues.length;
      this.issues.push(verdict.issue);
    }

    const report: PageReport = {
      page: target,
      viewport,
      url,
      availability: verdict.availability,
      httpStatus: verdict.httpStatus,
      navigationMs: nav.durationMs,
      screenshotId: null,
      checks: [],
    };
    this.pages.push(report);

    const ctx: CheckContext = {
      page,
      session: this.session,
      url,
      target,
      viewport,
      observations: collector.observations,
      navigationMs: nav.durationMs,
      logger: this.logger,
    };

    return {
      ctx,
      collector,
      report,
      ok: verdict.availability === 'ok',
      response: nav.response,
      issueIndex,
    };
  }

  private async close(ctx: CheckContext, collector: PageCollector): Promise<void> {
    collector.stop();
    await ctx.page.close().catch(() => undefined);
  }

  /** Records the outcomes a page's suite produced and keeps its issues. */
  private absorb(report: PageReport, suite: CheckSuite, from: number): void {
    for (const outcome of suite.outcomes.slice(from)) {
      report.checks.push({ name: outcome.name, status: outcome.status, error: outcome.error });
      this.issues.push(...outcome.issues);
    }
  }

  private async shoot(ctx: CheckContext, report: PageReport): Promise<void> {
    const result = await captureScreenshot(ctx.page, {
      storeId: this.store.id,
      auditId: this.auditId,
      domain: this.store.domain,
      page: ctx.target,
      viewport: ctx.viewport,
      db: this.db,
      logger: this.logger,
      ...(this.options.screenshotsDir === undefined
        ? {}
        : { baseDir: this.options.screenshotsDir }),
    });
    report.screenshotId = result.row?.id ?? null;
  }

  private async auditHomepage(origin: string, viewport: ViewportProfile): Promise<void> {
    const { ctx, collector, report, ok, response, issueIndex } = await this.open(
      `${origin}/`,
      'homepage',
      viewport,
    );
    try {
      if (viewport === 'desktop') {
        // The response carries the status and headers three of the detector's
        // rules depend on; passing null here made them dead code (task 2-24).
        const protection = await detectBotProtection(ctx.page, response);
        if (protection.blocked) {
          this.blocked = true;
          this.botProtection = { vendor: protection.vendor, signal: protection.signal };
          this.logger.warn(protection, 'storefront is behind bot protection');
          // A 403/429 from a bot wall is not a defect of the shop. The audit
          // already refuses to count those statuses against external links; the
          // audited page itself deserves the same treatment.
          if (issueIndex !== null) this.issues.splice(issueIndex, 1);
          await this.shoot(ctx, report);
          return;
        }
        this.homepageReachable = ok;
      }
      if (!ok) return;

      const consent = await dismissConsentBanner(ctx.page, { logger: this.logger });
      // The screenshot is taken after the banner, so it shows the shop, not the banner.
      await this.shoot(ctx, report);

      const from = this.suite.outcomes.length;
      await runHomepageChecks(ctx, { consent, suite: this.suite });
      await runResponsiveChecks(ctx, { suite: this.suite });

      if (viewport === 'desktop') {
        const seo = await runSeoChecks(ctx, { site: true, suite: this.suite });
        this.seo = { page: seo.page, site: seo.site };

        if (!this.options.skipLinks) {
          await this.suite.run('site.links', async () => {
            const links = await checkLinks(this.session, ctx.page, origin);
            report.facts = { links: { checked: links.checked, broken: links.broken.length } };
            return gradeLinks(links, { ...ctx, target: 'site' });
          });
        }
      }
      this.absorb(report, this.suite, from);
    } finally {
      await this.close(ctx, collector);
    }
  }

  private async discover(origin: string): Promise<KeyUrls | null> {
    try {
      return await discoverKeyUrls(this.session, `${origin}/`, { logger: this.logger });
    } catch (error) {
      this.logger.warn({ err: String(error) }, 'key url discovery failed');
      return null;
    }
  }

  private async auditCollection(): Promise<void> {
    const url = this.keyUrls?.collection;
    if (!url) {
      this.pages.push(notFound('collection'));
      return;
    }
    const { ctx, collector, report, ok } = await this.open(url, 'collection', 'desktop');
    try {
      if (!ok) return;
      await dismissConsentBanner(ctx.page, { logger: this.logger });
      await this.shoot(ctx, report);
      const from = this.suite.outcomes.length;
      await runCollectionChecks(ctx, { suite: this.suite });
      await runResponsiveChecks(ctx, { suite: this.suite });
      this.absorb(report, this.suite, from);
    } finally {
      await this.close(ctx, collector);
    }
  }

  private async auditProduct(): Promise<void> {
    const url = this.keyUrls?.product;
    if (!url) {
      this.pages.push(notFound('product'));
      return;
    }

    for (const viewport of ['desktop', 'mobile'] as const) {
      const { ctx, collector, report, ok } = await this.open(url, 'product', viewport);
      try {
        if (!ok) continue;
        await dismissConsentBanner(ctx.page, { logger: this.logger });
        await this.shoot(ctx, report);
        const from = this.suite.outcomes.length;
        if (viewport === 'desktop') {
          await runProductChecks(ctx, { suite: this.suite });
          const seo = await runSeoChecks(ctx, { suite: this.suite });
          report.facts = { seo: seo.page };
        }
        await runResponsiveChecks(ctx, { suite: this.suite });
        this.absorb(report, this.suite, from);
      } finally {
        await this.close(ctx, collector);
      }
    }
  }

  private async auditCartAndCheckout(origin: string): Promise<void> {
    const productUrl = this.keyUrls?.product;
    if (!productUrl) {
      this.pages.push(notFound('cart'), notFound('checkout'));
      return;
    }

    const { ctx, collector, report } = await this.open(`${origin}/cart`, 'cart', 'desktop');
    const checkoutReport: PageReport = {
      page: 'checkout',
      viewport: 'desktop',
      url: null,
      availability: 'not_found',
      httpStatus: null,
      navigationMs: null,
      screenshotId: null,
      checks: [],
    };
    this.pages.push(checkoutReport);

    try {
      await dismissConsentBanner(ctx.page, { logger: this.logger });
      const from = this.suite.outcomes.length;

      const { result } = await runCartChecks(ctx, {
        productUrl,
        suite: this.suite,
        onCheckout: async (page, transition) => {
          checkoutReport.url = transition.url;
          checkoutReport.availability = 'ok';
          await this.auditCheckout(page, checkoutReport);
        },
      });
      report.facts = result;
      await this.shoot(ctx, report);
      this.absorb(report, this.suite, from);
    } finally {
      await this.close(ctx, collector);
    }
  }

  /**
   * Runs on the live checkout page while the cart still exists. Only the form is
   * read — the shared technical checks stay on the cart page, whose collector
   * covers this navigation too, so a script error is reported once.
   */
  private async auditCheckout(page: Page, report: PageReport): Promise<void> {
    const ctx: CheckContext = {
      page,
      session: this.session,
      url: page.url(),
      target: 'checkout',
      viewport: 'desktop',
      observations: {
        consoleErrors: [],
        failedRequests: [],
        httpErrors: [],
        requestCount: 0,
        truncated: false,
      },
      navigationMs: 0,
      logger: this.logger,
    };

    const from = this.suite.outcomes.length;
    await this.suite.run('checkout.form', async () => {
      const facts = await readCheckout(ctx);
      report.facts = facts;
      return gradeCheckout({ opened: true, httpStatus: null, facts }, ctx);
    });
    await this.shoot(ctx, report);
    this.absorb(report, this.suite, from);
  }

  private persist(): AuditReport {
    const issues = sortIssues(dedupeIssues(this.issues));
    const counts = countBySeverity(issues);
    const status = this.decideStatus();

    saveIssues(this.auditId, this.store.id, issues.map(toRow), this.db);

    const audit = finishAudit(
      this.auditId,
      {
        status,
        blocked: this.blocked,
        pages: { pages: this.pages, keyUrls: this.keyUrls, botProtection: this.botProtection },
        seo: this.seo,
        error: this.failureReason(status),
      },
      this.db,
    );

    this.logger.info(
      { status, ...counts, pages: this.pages.length, failedChecks: this.suite.failed.length },
      'audit finished',
    );

    return {
      audit,
      status,
      blocked: this.blocked,
      botProtection: this.botProtection,
      keyUrls: this.keyUrls,
      issues,
      counts,
      pages: this.pages,
      seo: this.seo,
    };
  }

  private decideStatus(): AuditStatus {
    if (this.blocked) return 'BLOCKED';
    // Nothing was observable, so there is no audit — only a fact about the shop.
    if (!this.homepageReachable) return 'FAILED';
    if (this.suite.partial) return 'PARTIAL';
    // A shop whose product page was never found was audited only in part.
    if (!this.keyUrls?.product || !this.keyUrls.collection) return 'PARTIAL';
    return 'OK';
  }

  private failureReason(status: AuditStatus): string | null {
    if (status === 'BLOCKED') {
      return `blocked by ${this.botProtection.vendor ?? 'bot protection'}: ${this.botProtection.signal ?? ''}`.trim();
    }
    if (status === 'FAILED') return 'the homepage could not be opened';
    if (status === 'PARTIAL' && this.suite.failed.length > 0) {
      return `${this.suite.failed.length} check(s) failed: ${this.suite.failed
        .map((f) => f.name)
        .join(', ')}`;
    }
    if (status === 'PARTIAL') return 'not every key page could be found';
    return null;
  }
}

function notFound(page: IssuePage): PageReport {
  return {
    page,
    viewport: 'desktop',
    url: null,
    availability: 'not_found',
    httpStatus: null,
    navigationMs: null,
    screenshotId: null,
    checks: [],
  };
}

function toRow(issue: Issue): AuditIssueInput {
  return {
    page: issue.page,
    category: issue.category,
    severity: issue.severity,
    title: issue.title,
    detail: issue.detail,
    evidence: issue.evidence,
    source: issue.source,
  };
}
