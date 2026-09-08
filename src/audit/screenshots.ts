import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { getConfig } from '../config/index.js';
import { saveScreenshot } from '../db/repositories/audits.js';
import type { Database } from '../db/client.js';
import type { IssuePage, ScreenshotRow } from '../db/types.js';
import { silentLogger, type Logger } from '../lib/logger.js';
import type { ViewportProfile } from './browser.js';

/**
 * Screenshot capture and naming (task 2-04).
 *
 * Paths are stored relative to SCREENSHOTS_DIR and grouped per audit, so the
 * whole evidence set for one audit is one folder that can be attached to a
 * report, and the folder can be moved without invalidating the database.
 *
 *   <domain>/audit-<auditId>/<page>-<viewport>[-full].png
 */

export interface CaptureOptions {
  storeId: number;
  auditId: number | null;
  domain: string;
  page: IssuePage;
  viewport: ViewportProfile;
  /** Whole scroll height instead of just the fold. */
  fullPage?: boolean;
  db?: Database | undefined;
  logger?: Logger | undefined;
  /** Overrides SCREENSHOTS_DIR; tests write into a temp folder. */
  baseDir?: string | undefined;
}

/** Domains are safe enough for a folder name, but never trust one unescaped. */
export function safeSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || 'unknown';
}

export function screenshotPath(options: {
  domain: string;
  auditId: number | null;
  page: IssuePage;
  viewport: ViewportProfile;
  fullPage?: boolean;
}): string {
  const folder = options.auditId === null ? 'manual' : `audit-${options.auditId}`;
  const suffix = options.fullPage ? '-full' : '';
  return path.posix.join(
    safeSegment(options.domain),
    folder,
    `${options.page}-${options.viewport}${suffix}.png`,
  );
}

/**
 * Reads the pixel size out of a PNG header (IHDR is always the first chunk),
 * so the stored dimensions describe the file rather than what we asked for —
 * a full-page capture is taller than the viewport.
 */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  const PNG_MAGIC = '89504e470d0a1a0a';
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString('hex') !== PNG_MAGIC) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export interface CaptureResult {
  /** Null when the capture failed; a missing screenshot never fails an audit. */
  row: ScreenshotRow | null;
  relativePath: string;
  absolutePath: string;
  error: Error | null;
}

export async function captureScreenshot(
  page: Page,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const logger = options.logger ?? silentLogger();
  const baseDir = options.baseDir ?? getConfig().paths.screenshots;
  const relativePath = screenshotPath(options);
  const absolutePath = path.join(baseDir, relativePath);

  try {
    const buffer = await page.screenshot({
      fullPage: options.fullPage ?? false,
      type: 'png',
      // Storefront hero videos and carousels otherwise keep the page "busy".
      animations: 'disabled',
      caret: 'hide',
    });
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer);

    const size = pngSize(buffer);
    const row = saveScreenshot(
      {
        storeId: options.storeId,
        auditId: options.auditId,
        page: options.page,
        viewport: options.viewport,
        path: relativePath,
        width: size?.width ?? null,
        height: size?.height ?? null,
      },
      options.db,
    );
    return { row, relativePath, absolutePath, error: null };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn({ path: relativePath, err: err.message }, 'screenshot failed');
    return { row: null, relativePath, absolutePath, error: err };
  }
}
