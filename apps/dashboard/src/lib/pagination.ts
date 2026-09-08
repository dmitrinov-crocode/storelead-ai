/**
 * Page arithmetic for the dashboard tables.
 *
 * Pages are 1-based because they appear in the URL, where `?page=0` reads as
 * wrong to anyone editing it by hand. Out-of-range values are clamped rather
 * than rejected: a stale bookmark should show the last page, not an error.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_CHOICES = [10, 20, 50, 100] as const;
export const MAX_PAGE_SIZE = 200;

export interface PageInfo {
  page: number;
  pageSize: number;
  totalPages: number;
  total: number;
  /** SQL OFFSET for this page. */
  offset: number;
  /** 1-based index of the first and last row shown, for "21–40 of 137". */
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Reads a page number from a query string, tolerating anything. */
export function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function parsePageSize(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function paginate(total: number, page: number, pageSize: number): PageInfo {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeSize = Math.min(Math.max(1, Math.trunc(pageSize)), MAX_PAGE_SIZE);
  // An empty table still has one (empty) page, so the UI never shows "page 1 of 0".
  const totalPages = Math.max(1, Math.ceil(safeTotal / safeSize));
  const current = Math.min(Math.max(1, Math.trunc(page)), totalPages);
  const offset = (current - 1) * safeSize;

  return {
    page: current,
    pageSize: safeSize,
    totalPages,
    total: safeTotal,
    offset,
    from: safeTotal === 0 ? 0 : offset + 1,
    to: Math.min(offset + safeSize, safeTotal),
    hasPrev: current > 1,
    hasNext: current < totalPages,
  };
}

/** Builds a URL that changes one parameter and keeps the rest of the query. */
export function pageHref(
  current: Record<string, string | string[] | undefined>,
  key: string,
  value: number,
): string {
  const params = new URLSearchParams();
  for (const [name, raw] of Object.entries(current)) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (first !== undefined && name !== key) params.set(name, first);
  }
  // Page 1 is the default; leaving it out keeps the common URL clean.
  if (value > 1) params.set(key, String(value));
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
