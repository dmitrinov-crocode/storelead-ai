import type { ConsoleMessage, Page, Request, Response } from 'playwright';

/**
 * Page-level evidence collection (task 2-03).
 *
 * Everything here is a *fact* the browser reported: a console error with its
 * source location, a request the network stack refused, a 404 on an asset the
 * page asked for. Findings are derived from these later (task 2-05), so a claim
 * in an email can always be traced back to one of these records.
 */

/** Guards against a page that logs in a loop turning an audit into a memory leak. */
export const MAX_RECORDS = 100;

export interface ConsoleErrorRecord {
  /** `console.error` vs an uncaught exception — the second is far more serious. */
  kind: 'console' | 'exception';
  text: string;
  url: string | null;
  line: number | null;
  count: number;
}

export interface FailedRequestRecord {
  url: string;
  method: string;
  resourceType: string;
  /** Chromium's error text, e.g. `net::ERR_NAME_NOT_RESOLVED`. */
  errorText: string;
  count: number;
}

export interface HttpErrorRecord {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  count: number;
}

export interface PageObservations {
  consoleErrors: ConsoleErrorRecord[];
  failedRequests: FailedRequestRecord[];
  httpErrors: HttpErrorRecord[];
  requestCount: number;
  /** True when any list hit MAX_RECORDS and stopped growing. */
  truncated: boolean;
}

export interface BrokenImage {
  src: string;
  alt: string | null;
  /** Where it sits in the document, for the screenshot annotation and the email. */
  selector: string;
}

export interface PageCollector {
  readonly observations: PageObservations;
  /** Detaches the listeners; safe to call more than once. */
  stop(): void;
}

/**
 * Console lines that add nothing.
 *
 * Chromium logs every failed request to the console as well, so keeping those
 * would report each broken asset twice — once here with a vague message, once
 * in `httpErrors`/`failedRequests` with the URL, status and resource type.
 */
const IGNORED_CONSOLE = [/^Failed to load resource/i, /favicon/i, /\[GSI_LOGGER\]/i];

export function isIgnorableConsoleError(text: string): boolean {
  return IGNORED_CONSOLE.some((re) => re.test(text));
}

/** Same message from the same place is one problem, however often it repeats. */
function tally<T extends { count: number }>(
  list: T[],
  key: (item: T) => string,
  item: T,
  state: { truncated: boolean },
): void {
  const wanted = key(item);
  const existing = list.find((candidate) => key(candidate) === wanted);
  if (existing) {
    existing.count += 1;
    return;
  }
  if (list.length >= MAX_RECORDS) {
    state.truncated = true;
    return;
  }
  list.push(item);
}

export function attachPageCollectors(page: Page): PageCollector {
  const observations: PageObservations = {
    consoleErrors: [],
    failedRequests: [],
    httpErrors: [],
    requestCount: 0,
    truncated: false,
  };

  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (isIgnorableConsoleError(text)) return;
    const location = message.location();
    tally(
      observations.consoleErrors,
      (r) => `${r.kind}|${r.text}|${r.url ?? ''}|${r.line ?? ''}`,
      {
        kind: 'console',
        text,
        url: location.url || null,
        line: location.lineNumber || null,
        count: 1,
      },
      observations,
    );
  };

  const onPageError = (error: Error): void => {
    tally(
      observations.consoleErrors,
      (r) => `${r.kind}|${r.text}`,
      {
        kind: 'exception',
        text: `${error.name}: ${error.message}`,
        url: null,
        line: null,
        count: 1,
      },
      observations,
    );
  };

  const onRequest = (): void => {
    observations.requestCount += 1;
  };

  const onRequestFailed = (request: Request): void => {
    // Navigations aborted by a redirect are not failures worth reporting.
    const errorText = request.failure()?.errorText ?? 'unknown';
    if (errorText === 'net::ERR_ABORTED') return;
    tally(
      observations.failedRequests,
      (r) => `${r.url}|${r.errorText}`,
      {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        errorText,
        count: 1,
      },
      observations,
    );
  };

  const onResponse = (response: Response): void => {
    const status = response.status();
    if (status < 400) return;
    const request = response.request();
    tally(
      observations.httpErrors,
      (r) => `${r.url}|${r.status}`,
      {
        url: response.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status,
        count: 1,
      },
      observations,
    );
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  let stopped = false;
  return {
    observations,
    stop: () => {
      if (stopped) return;
      stopped = true;
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('request', onRequest);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

/**
 * Builds a human-readable selector from the parts an element reports.
 *
 * It is built here rather than inside the page because `tsx` compiles nested
 * function declarations with an esbuild name helper that does not exist in the
 * browser, so in-page callbacks stay free of local helpers.
 */
export function cssSelector(part: ElementIdentity): string {
  if (part.id) return `#${part.id}`;
  const classes = part.classes
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join('');
  const nth = part.nthChild > 0 ? `:nth-child(${part.nthChild})` : '';
  return `${part.tag}${classes}${nth}`;
}

export interface ElementIdentity {
  tag: string;
  id: string | null;
  classes: string[];
  nthChild: number;
}

/**
 * Images the browser tried and failed to paint. Network events alone miss the
 * case of a 200 response carrying something that is not a decodable image, so
 * this is read from the DOM after the page settled.
 */
export async function collectBrokenImages(page: Page): Promise<BrokenImage[]> {
  const found = await page.evaluate((limit) => {
    const out: {
      src: string;
      alt: string | null;
      tag: string;
      id: string | null;
      classes: string[];
      nthChild: number;
    }[] = [];
    for (const img of Array.from(document.images)) {
      if (out.length >= limit) break;
      // `complete` with zero natural width means the load finished and failed.
      if (!img.complete || img.naturalWidth !== 0 || img.getAttribute('src') === null) continue;
      // Tracking beacons are 1x1 images nobody was ever meant to see; a failed
      // one is not a broken picture on the shop (task 2-24: a Bing UET beacon
      // was reported as an image that does not display).
      const box = img.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue;
      const parent = img.parentElement;
      out.push({
        src: img.currentSrc || img.src,
        alt: img.getAttribute('alt'),
        tag: 'img',
        id: img.id || null,
        classes: (img.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean),
        nthChild: parent ? Array.from(parent.children).indexOf(img) + 1 : 0,
      });
    }
    return out;
  }, MAX_RECORDS);

  return found.map((f) => ({ src: f.src, alt: f.alt, selector: cssSelector(f) }));
}
