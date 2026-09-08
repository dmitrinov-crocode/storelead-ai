import type { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PAGE_RANK, SEVERITY_RANK } from '../audit/issues.js';
import { getConfig } from '../config/index.js';
import type { Database } from '../db/client.js';
import { listIssues, listScreenshots } from '../db/repositories/audits.js';
import type { AuditIssueRow, IssuePage, ScreenshotRow } from '../db/types.js';
import { silentLogger, type Logger } from '../lib/logger.js';

/**
 * Which screenshots the Store Analyst gets to look at (task 3-02).
 *
 * A vision prompt is the most expensive part of the AI step, and the cost is
 * per image, not per shop — so the choice of what to attach is a budget
 * decision, not a formality. Three rules make it:
 *
 *   - Only the fold. A full-page capture of a long homepage is mostly footer,
 *     and it is billed by area. What a visitor judges in the first seconds is
 *     the viewport, which is also what the audit's own checks measured.
 *   - Mobile before desktop, and pages carrying real findings before quiet
 *     ones. The segment's problems are mobile problems; a screenshot of a page
 *     nothing was found on teaches the model the least.
 *   - Hard ceilings on both the number of images and their total bytes, so one
 *     pathological store cannot cost fifty times what a healthy one costs.
 *
 * Resizing is deliberately not done here. Doing it locally would mean adding an
 * image codec (a native dependency an order of magnitude larger than the saving)
 * to re-compress what the API already meters: OpenAI downsamples every image and
 * charges by tile, and `detail: 'low'` fixes the cost at one flat tile. So the
 * lever we pull is `detail`, chosen per image below.
 */

/** How many images one analysis may carry. */
export const DEFAULT_SCREENSHOT_LIMIT = 4;
/**
 * Total attached bytes. Base64 inflates by a third on the wire, so this is a
 * ceiling on the request body as much as on the token bill.
 */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 4_000_000;
/**
 * Above this a capture is a scrolling banner or an infinite-scroll collection
 * rather than a page. Tall images are billed by area and read badly at any
 * detail level.
 */
export const MAX_SCREENSHOT_HEIGHT_PX = 4000;

/** Mobile is where this segment's problems are, so it is read first. */
const VIEWPORT_RANK: Record<ScreenshotRow['viewport'], number> = { mobile: 0, desktop: 1 };

export interface PromptImage {
  screenshotId: number;
  page: IssuePage;
  viewport: ScreenshotRow['viewport'];
  /** Relative to SCREENSHOTS_DIR, as stored. */
  path: string;
  bytes: number;
  /**
   * `high` lets the model read a layout; `low` is one flat tile and is enough to
   * answer "is there a page here at all". Pages with findings earn `high`.
   */
  detail: 'low' | 'high';
  /** `data:image/png;base64,…`, ready for the message content. */
  dataUrl: string;
}

export interface ScreenshotSelection {
  images: PromptImage[];
  /** Screenshots the audit took that this prompt does not carry, and why. */
  skipped: { screenshotId: number; reason: SkipReason }[];
  totalBytes: number;
}

export type SkipReason = 'full-page' | 'too-tall' | 'over-limit' | 'over-budget' | 'unreadable';

interface Ranked {
  row: ScreenshotRow;
  /** Worst severity found on that page, or null when the page is quiet. */
  worstSeverity: number | null;
}

/**
 * Ordering only — no file access, so the policy can be tested without a disk.
 * Exported for that reason.
 */
export function rankScreenshots(
  rows: readonly ScreenshotRow[],
  issues: readonly AuditIssueRow[],
): { ranked: ScreenshotRow[]; skipped: { screenshotId: number; reason: SkipReason }[] } {
  const skipped: { screenshotId: number; reason: SkipReason }[] = [];
  const worstByPage = new Map<IssuePage, number>();
  for (const issue of issues) {
    const rank = SEVERITY_RANK[issue.severity];
    const seen = worstByPage.get(issue.page);
    if (seen === undefined || rank < seen) worstByPage.set(issue.page, rank);
  }

  const eligible: Ranked[] = [];
  for (const row of rows) {
    if (row.path.endsWith('-full.png')) {
      skipped.push({ screenshotId: row.id, reason: 'full-page' });
      continue;
    }
    if (row.height !== null && row.height > MAX_SCREENSHOT_HEIGHT_PX) {
      skipped.push({ screenshotId: row.id, reason: 'too-tall' });
      continue;
    }
    eligible.push({ row, worstSeverity: worstByPage.get(row.page) ?? null });
  }

  // A page with a CRITICAL finding outranks a quiet page of any kind; within the
  // same severity band the shopper's own order decides.
  eligible.sort(
    (a, b) =>
      (a.worstSeverity ?? SEVERITY_RANK.MINOR + 1) - (b.worstSeverity ?? SEVERITY_RANK.MINOR + 1) ||
      VIEWPORT_RANK[a.row.viewport] - VIEWPORT_RANK[b.row.viewport] ||
      PAGE_RANK[a.row.page] - PAGE_RANK[b.row.page] ||
      a.row.id - b.row.id,
  );

  return { ranked: eligible.map((e) => e.row), skipped };
}

export interface SelectScreenshotsOptions {
  db?: Database | undefined;
  /** Overrides SCREENSHOTS_DIR; tests read from a temp folder. */
  baseDir?: string | undefined;
  limit?: number | undefined;
  maxTotalBytes?: number | undefined;
  logger?: Logger | undefined;
}

/**
 * Picks the screenshots for one audit and loads them as data URLs.
 *
 * A screenshot that cannot be read is dropped rather than thrown: the file may
 * have been moved or the disk pruned, and an analysis with three images is
 * worth more than a failed step.
 */
export async function selectScreenshots(
  auditId: number,
  options: SelectScreenshotsOptions = {},
): Promise<ScreenshotSelection> {
  const logger = options.logger ?? silentLogger();
  const baseDir = options.baseDir ?? getConfig().paths.screenshots;
  const limit = options.limit ?? DEFAULT_SCREENSHOT_LIMIT;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES;

  const { ranked, skipped } = rankScreenshots(
    listScreenshots(auditId, options.db),
    listIssues(auditId, options.db),
  );

  const images: PromptImage[] = [];
  let totalBytes = 0;

  for (const row of ranked) {
    if (images.length >= limit) {
      skipped.push({ screenshotId: row.id, reason: 'over-limit' });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(baseDir, row.path));
    } catch (error) {
      logger.warn(
        { screenshotId: row.id, path: row.path, err: (error as Error).message },
        'screenshot missing, not attached to the prompt',
      );
      skipped.push({ screenshotId: row.id, reason: 'unreadable' });
      continue;
    }

    if (totalBytes + buffer.byteLength > maxTotalBytes) {
      skipped.push({ screenshotId: row.id, reason: 'over-budget' });
      continue;
    }

    totalBytes += buffer.byteLength;
    images.push({
      screenshotId: row.id,
      page: row.page,
      viewport: row.viewport,
      path: row.path,
      bytes: buffer.byteLength,
      // The first image is the one the model reasons hardest about, and a page
      // with nothing found on it only needs to be confirmed as present.
      detail: images.length === 0 || row.viewport === 'mobile' ? 'high' : 'low',
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    });
  }

  return { images, skipped, totalBytes };
}

/**
 * How an image is announced to the model. The page and viewport have to travel
 * with the picture — otherwise a phone screenshot gets judged as a desktop
 * layout, which is exactly the mistake the audit exists to avoid.
 */
export function describeImage(image: PromptImage): string {
  return `${image.page} (${image.viewport}), screenshot id ${image.screenshotId}`;
}
