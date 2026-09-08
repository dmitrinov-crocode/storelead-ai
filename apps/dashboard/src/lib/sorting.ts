/**
 * Sorting for the stores table.
 *
 * The sort key arrives from the query string, so it is never interpolated into
 * SQL: it selects one of the expressions below. Anything unrecognised falls back
 * to the default rather than erroring, so a hand-edited URL cannot break the page.
 */

export type SortDirection = "asc" | "desc";

export interface SortColumn {
  /** Column expression(s) to order by, already qualified for the stores query. */
  expression: string;
  label: string;
  /** Most columns read best one way round on first click. */
  defaultDirection: SortDirection;
  /** Right-aligned numeric columns get a different header alignment. */
  numeric?: boolean;
}

export const SORT_KEYS = [
  "domain",
  "rank",
  "score",
  "revenue",
  "issues",
  "status",
  "contact",
  "linkedin",
  "shared",
  "email",
  "added",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_COLUMNS: Record<SortKey, SortColumn> = {
  domain: { expression: "s.domain", label: "Domain", defaultDirection: "asc" },
  rank: { expression: "s.rank", label: "Rank", defaultDirection: "asc", numeric: true },
  score: { expression: "a.lead_score", label: "Score", defaultDirection: "desc", numeric: true },
  revenue: {
    expression: "s.revenue_estimate",
    label: "Revenue",
    defaultDirection: "desc",
    numeric: true,
  },
  issues: {
    // Critical outranks major, so a store with one critical sorts above one with five majors.
    expression: "COALESCE(i.critical_issues, 0) * 1000 + COALESCE(i.major_issues, 0)",
    label: "Issues",
    defaultDirection: "desc",
  },
  status: { expression: "s.status", label: "Status", defaultDirection: "asc" },
  // A store with a named person sorts above one with only an address.
  contact: {
    expression: "COALESCE(c.name, c.email)",
    label: "Contact",
    defaultDirection: "asc",
  },
  linkedin: { expression: "li.linkedin_url", label: "LinkedIn", defaultDirection: "asc" },
  shared: {
    expression: "COALESCE(g.generic_count, 0)",
    label: "Shared inbox",
    defaultDirection: "desc",
  },
  email: { expression: "e.status", label: "Email", defaultDirection: "asc" },
  added: { expression: "s.id", label: "Added", defaultDirection: "desc", numeric: true },
};

export const DEFAULT_SORT: SortKey = "score";
export const DEFAULT_DIRECTION: SortDirection = "desc";

export function isSortKey(value: unknown): value is SortKey {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so "__proto__" and
  // "toString" would pass and then resolve to an expression of `undefined`.
  return typeof value === "string" && Object.hasOwn(SORT_COLUMNS, value);
}

export function parseSort(value: string | string[] | undefined): SortKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return isSortKey(raw) ? raw : DEFAULT_SORT;
}

export function parseDirection(
  value: string | string[] | undefined,
  fallback: SortDirection,
): SortDirection {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" || raw === "desc" ? raw : fallback;
}

/** The direction a header link should apply: flip if already sorted by it. */
export function nextDirection(
  key: SortKey,
  activeKey: SortKey,
  activeDirection: SortDirection,
): SortDirection {
  if (key !== activeKey) return SORT_COLUMNS[key].defaultDirection;
  return activeDirection === "asc" ? "desc" : "asc";
}

/**
 * Builds the ORDER BY clause. Rows with no value always sort last regardless of
 * direction — an unranked store is not "better" than rank 1.
 */
export function buildOrderBy(key: SortKey, direction: SortDirection): string {
  const expression = SORT_COLUMNS[key].expression;
  const dir = direction === "asc" ? "ASC" : "DESC";
  // s.id is the tiebreaker so paging is stable when values repeat.
  return `${expression} IS NULL, ${expression} ${dir}, s.id ASC`;
}
