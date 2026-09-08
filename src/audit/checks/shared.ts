import { collectBrokenImages } from '../pageCollector.js';
import { createIssue, type Evidence, type Issue } from '../issues.js';
import { escalateForPage, type CheckContext } from './context.js';

/**
 * Checks that mean the same thing on every page (task 2-10 and onwards).
 *
 * They read the facts the collectors gathered (task 2-03) and turn them into
 * issues; nothing here inspects the page a second time except the broken-image
 * check, which needs the DOM.
 */

/** A page slower than this is a problem a visitor feels, not a metric. */
export const SLOW_LOAD_MS = 8000;

export function checkJavaScriptErrors(ctx: CheckContext): Issue[] {
  const exceptions = ctx.observations.consoleErrors.filter((e) => e.kind === 'exception');
  const logged = ctx.observations.consoleErrors.filter((e) => e.kind === 'console');
  const issues: Issue[] = [];

  if (exceptions.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: escalateForPage('MAJOR', ctx.target),
        title: 'JavaScript errors break the page',
        detail: `${exceptions.length} uncaught error(s) while loading the page`,
        evidence: exceptions.map((e) => ({
          url: ctx.url,
          text: e.text,
          ...(e.count > 1 ? { count: e.count } : {}),
        })),
      }),
    );
  }

  if (logged.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: escalateForPage('MINOR', ctx.target),
        title: 'Scripts log errors to the console',
        detail: `${logged.length} console error(s)`,
        evidence: logged.map((e) => ({
          url: e.url ?? ctx.url,
          text: e.text,
          ...(e.line ? { actual: `line ${e.line}` } : {}),
          ...(e.count > 1 ? { count: e.count } : {}),
        })),
      }),
    );
  }

  return issues;
}

/** Assets and API calls the page asked for and did not get. */
/**
 * Shopify's own storefront endpoints that answer with an error as a matter of
 * course. `/sf_private_access_tokens` returns 401 on every shop that does not
 * use private access tokens — it appeared on both stores of the 2-24 run and
 * would appear on every Shopify store we ever audit.
 */
const PLATFORM_NOISE = [/\/sf_private_access_tokens\b/, /\/\.well-known\/shopify\/monorail/];

export function isPlatformNoise(url: string): boolean {
  return PLATFORM_NOISE.some((pattern) => pattern.test(url));
}

export function checkFailedResources(ctx: CheckContext): Issue[] {
  const blocking = new Set(['script', 'stylesheet', 'font', 'fetch', 'xhr']);
  const issues: Issue[] = [];

  const httpErrors = ctx.observations.httpErrors.filter((e) => e.url !== ctx.url);
  const refused = ctx.observations.failedRequests;

  const criticalResources = [...httpErrors, ...refused]
    .filter((r) => blocking.has(r.resourceType))
    .filter((r) => !isPlatformNoise(r.url));
  if (criticalResources.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: escalateForPage('MAJOR', ctx.target),
        title: 'Scripts or styles fail to load',
        detail: `${criticalResources.length} blocking resource(s) did not load`,
        evidence: criticalResources.map((r) => ({
          url: r.url,
          ...('status' in r ? { status: r.status } : { text: r.errorText }),
          actual: r.resourceType,
        })),
      }),
    );
  }

  const otherErrors = [...httpErrors, ...refused].filter((r) => !blocking.has(r.resourceType));
  if (otherErrors.length > 0) {
    issues.push(
      createIssue({
        page: ctx.target,
        category: 'technical',
        severity: 'MINOR',
        title: 'Some resources return errors',
        detail: `${otherErrors.length} resource(s) failed`,
        evidence: otherErrors.map((r) => ({
          url: r.url,
          ...('status' in r ? { status: r.status } : { text: r.errorText }),
          actual: r.resourceType,
        })),
      }),
    );
  }

  return issues;
}

export async function checkBrokenImages(ctx: CheckContext): Promise<Issue[]> {
  const broken = await collectBrokenImages(ctx.page);
  if (broken.length === 0) return [];

  return [
    createIssue({
      page: ctx.target,
      category: 'ux',
      severity: 'MAJOR',
      title: 'Images do not display',
      detail: `${broken.length} image(s) fail to render`,
      evidence: broken.map((img): Evidence => ({
        selector: img.selector,
        url: img.src,
        viewport: ctx.viewport,
        ...(img.alt ? { text: img.alt } : {}),
      })),
    }),
  ];
}

export function checkLoadTime(ctx: CheckContext): Issue[] {
  if (ctx.navigationMs < SLOW_LOAD_MS) return [];
  return [
    createIssue({
      page: ctx.target,
      category: 'performance',
      severity: 'MAJOR',
      title: 'Page takes too long to open',
      detail: `The page needed ${(ctx.navigationMs / 1000).toFixed(1)}s to become interactive`,
      evidence: {
        url: ctx.url,
        viewport: ctx.viewport,
        expected: `< ${SLOW_LOAD_MS / 1000}s`,
        actual: `${(ctx.navigationMs / 1000).toFixed(1)}s`,
      },
    }),
  ];
}
