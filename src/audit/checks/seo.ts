import type { Page } from 'playwright';
import { CheckSuite } from '../checkRunner.js';
import { createIssue, type Issue } from '../issues.js';
import type { AuditSession } from '../session.js';
import type { CheckContext } from './context.js';

/**
 * Basic SEO collection (task 2-17).
 *
 * Only facts a page states about itself: the tags Google reads, the structured
 * data the theme emits, and whether robots.txt and a sitemap exist. Rankings and
 * traffic are not guessed at — those are neither observable nor honest to claim.
 */

/** Google truncates around here; far outside the range is a real defect. */
export const TITLE_MIN = 15;
export const TITLE_MAX = 65;
export const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 165;
/** Below this share of images with alt text it stops being an oversight. */
export const ALT_COVERAGE_MIN = 0.7;

export interface SeoFacts {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  h1Count: number;
  h1Text: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  noindex: boolean;
  lang: string | null;
  openGraph: boolean;
  /** `@type` values found in JSON-LD blocks. */
  schemaTypes: string[];
  images: number;
  imagesWithAlt: number;
}

export async function readSeo(page: Page): Promise<SeoFacts> {
  return page.evaluate(() => {
    // No local helper: `tsx` compiles nested functions with an esbuild name shim
    // that does not exist inside the page.
    const title = (document.title ?? '').trim() || null;
    const descriptionNode = document.querySelector('meta[name="description" i]');
    const description = descriptionNode
      ? (descriptionNode.getAttribute('content') ?? '').trim() || null
      : null;
    const robotsNode = document.querySelector('meta[name="robots" i]');
    const robotsMeta = robotsNode
      ? (robotsNode.getAttribute('content') ?? '').trim() || null
      : null;
    const canonicalNode = document.querySelector('link[rel="canonical"]');

    const schemaTypes: string[] = [];
    for (const script of Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).slice(0, 20)) {
      try {
        const parsed: unknown = JSON.parse(script.textContent ?? '');
        const queue: unknown[] = Array.isArray(parsed) ? [...(parsed as unknown[])] : [parsed];
        let guard = 0;
        while (queue.length > 0 && guard < 50) {
          guard += 1;
          const node = queue.shift();
          if (!node || typeof node !== 'object') continue;
          const record = node as Record<string, unknown>;
          const type = record['@type'];
          if (typeof type === 'string') schemaTypes.push(type);
          else if (Array.isArray(type)) {
            for (const t of type) if (typeof t === 'string') schemaTypes.push(t);
          }
          const graph: unknown = record['@graph'];
          if (Array.isArray(graph)) queue.push(...(graph as unknown[]));
        }
      } catch {
        // A theme shipping invalid JSON-LD simply contributes no types.
      }
    }

    const images = Array.from(document.images);
    let imagesWithAlt = 0;
    for (const img of images) {
      const alt = img.getAttribute('alt');
      // A decorative image declares itself with alt="", which is correct markup.
      if (alt !== null) imagesWithAlt += 1;
    }

    return {
      title,
      titleLength: title?.length ?? 0,
      description,
      descriptionLength: description?.length ?? 0,
      h1Count: document.querySelectorAll('h1').length,
      h1Text: (document.querySelector('h1')?.textContent ?? '').trim().slice(0, 120) || null,
      canonical: canonicalNode?.getAttribute('href') ?? null,
      robotsMeta,
      noindex: /noindex/i.test(robotsMeta ?? ''),
      lang: document.documentElement.getAttribute('lang'),
      openGraph: document.querySelector('meta[property^="og:"]') !== null,
      schemaTypes: [...new Set(schemaTypes)],
      images: images.length,
      imagesWithAlt,
    };
  });
}

export interface SiteSeoFacts {
  robotsTxt: boolean;
  /** True when robots.txt blocks every crawler from the whole site. */
  robotsBlocksAll: boolean;
  sitemap: boolean;
  sitemapUrls: number;
}

/** True for a robots.txt that tells every crawler to stay out of the whole site. */
export function blocksEverything(robotsTxt: string): boolean {
  const lines = robotsTxt.split('\n').map((line) => line.trim().toLowerCase());
  let inWildcardGroup = false;
  for (const line of lines) {
    if (line.startsWith('user-agent:')) {
      inWildcardGroup = line.slice('user-agent:'.length).trim() === '*';
      continue;
    }
    if (!inWildcardGroup) continue;
    if (line.replace(/\s+/g, '') === 'disallow:/') return true;
  }
  return false;
}

export async function readSiteSeo(
  session: AuditSession,
  page: Page,
  origin: string,
): Promise<SiteSeoFacts> {
  const request = page.context().request;
  const facts: SiteSeoFacts = {
    robotsTxt: false,
    robotsBlocksAll: false,
    sitemap: false,
    sitemapUrls: 0,
  };

  await session.throttle();
  try {
    const robots = await request.get(`${origin}/robots.txt`, { timeout: session.pageTimeoutMs });
    if (robots.ok()) {
      facts.robotsTxt = true;
      facts.robotsBlocksAll = blocksEverything(await robots.text());
    }
  } catch {
    // Treated as absent.
  }

  await session.throttle();
  try {
    const sitemap = await request.get(`${origin}/sitemap.xml`, { timeout: session.pageTimeoutMs });
    if (sitemap.ok()) {
      const body = await sitemap.text();
      facts.sitemap = true;
      facts.sitemapUrls = (body.match(/<loc>/gi) ?? []).length;
    }
  } catch {
    // Treated as absent.
  }

  return facts;
}

export function gradePageSeo(facts: SeoFacts, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const where = { url: ctx.url };
  const add = (item: Omit<Parameters<typeof createIssue>[0], 'page' | 'category'>) =>
    issues.push(createIssue({ page: ctx.target, category: 'seo', ...item }));

  if (facts.noindex) {
    add({
      severity: 'CRITICAL',
      title: 'Page is excluded from search engines',
      detail: 'A robots meta tag tells Google not to index this page',
      evidence: { ...where, text: facts.robotsMeta ?? 'noindex' },
    });
  }

  if (!facts.title) {
    add({ severity: 'MAJOR', title: 'Page has no title tag', evidence: where });
  } else if (facts.titleLength < TITLE_MIN || facts.titleLength > TITLE_MAX) {
    add({
      severity: 'MINOR',
      title: 'Page title is the wrong length',
      evidence: {
        ...where,
        text: facts.title,
        expected: `${TITLE_MIN}–${TITLE_MAX} characters`,
        actual: `${facts.titleLength}`,
      },
    });
  }

  if (!facts.description) {
    add({
      severity: 'MAJOR',
      title: 'Page has no meta description',
      detail: 'Google then invents the snippet shown in the results',
      evidence: where,
    });
  } else if (
    facts.descriptionLength < DESCRIPTION_MIN ||
    facts.descriptionLength > DESCRIPTION_MAX
  ) {
    add({
      severity: 'MINOR',
      title: 'Meta description is the wrong length',
      evidence: {
        ...where,
        text: facts.description,
        expected: `${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters`,
        actual: `${facts.descriptionLength}`,
      },
    });
  }

  if (facts.h1Count === 0) {
    add({ severity: 'MAJOR', title: 'Page has no H1 heading', evidence: where });
  } else if (facts.h1Count > 1) {
    add({
      severity: 'MINOR',
      title: 'Page has more than one H1',
      evidence: { ...where, actual: `${facts.h1Count} H1 headings` },
    });
  }

  if (!facts.canonical) {
    add({
      severity: 'MINOR',
      title: 'No canonical URL',
      detail: 'Filter and sort parameters then create duplicate pages in the index',
      evidence: where,
    });
  }

  if (!facts.lang) {
    add({ severity: 'MINOR', title: 'The page does not declare its language', evidence: where });
  }

  if (ctx.target === 'product' && !facts.schemaTypes.includes('Product')) {
    add({
      severity: 'MAJOR',
      title: 'Product page has no Product structured data',
      detail: 'Without it Google shows no price, availability or rating in the results',
      evidence: {
        ...where,
        expected: 'schema.org Product',
        actual: facts.schemaTypes.join(', ') || 'no structured data',
      },
    });
  }

  if (facts.images > 0) {
    const coverage = facts.imagesWithAlt / facts.images;
    if (coverage < ALT_COVERAGE_MIN) {
      add({
        severity: 'MINOR',
        title: 'Images have no alt text',
        detail: 'Alt text is what image search reads and what a screen reader speaks',
        evidence: {
          ...where,
          expected: `${Math.round(ALT_COVERAGE_MIN * 100)}% of images`,
          actual: `${facts.imagesWithAlt} of ${facts.images}`,
        },
      });
    }
  }

  return issues;
}

export function gradeSiteSeo(facts: SiteSeoFacts, ctx: CheckContext): Issue[] {
  const issues: Issue[] = [];
  const where = { url: new URL(ctx.url).origin };

  if (facts.robotsBlocksAll) {
    issues.push(
      createIssue({
        page: 'site',
        category: 'seo',
        severity: 'CRITICAL',
        title: 'robots.txt blocks the whole site',
        detail: 'Every crawler is told to stay out, so the shop cannot appear in search at all',
        evidence: { ...where, url: `${where.url}/robots.txt`, text: 'Disallow: /' },
      }),
    );
  }

  if (!facts.sitemap) {
    issues.push(
      createIssue({
        page: 'site',
        category: 'seo',
        severity: 'MAJOR',
        title: 'No sitemap.xml',
        evidence: { url: `${where.url}/sitemap.xml`, expected: 'an XML sitemap' },
      }),
    );
  }

  if (!facts.robotsTxt) {
    issues.push(
      createIssue({
        page: 'site',
        category: 'seo',
        severity: 'MINOR',
        title: 'No robots.txt',
        evidence: { url: `${where.url}/robots.txt` },
      }),
    );
  }

  return issues;
}

export async function runSeoChecks(
  ctx: CheckContext,
  options: { site?: boolean; suite?: CheckSuite } = {},
): Promise<{ suite: CheckSuite; page: SeoFacts | null; site: SiteSeoFacts | null }> {
  const suite = options.suite ?? new CheckSuite({ logger: ctx.logger });
  let pageFacts: SeoFacts | null = null;
  let siteFacts: SiteSeoFacts | null = null;

  await suite.run('seo.page', async () => {
    pageFacts = await readSeo(ctx.page);
    return gradePageSeo(pageFacts, ctx);
  });

  if (options.site) {
    await suite.run('seo.site', async () => {
      siteFacts = await readSiteSeo(ctx.session, ctx.page, new URL(ctx.url).origin);
      return gradeSiteSeo(siteFacts, ctx);
    });
  }

  return { suite, page: pageFacts, site: siteFacts };
}
