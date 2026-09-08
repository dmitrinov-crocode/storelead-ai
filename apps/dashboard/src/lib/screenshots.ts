import path from "node:path";

/**
 * Where one screenshot lives on disk (task 6-06).
 *
 * Kept free of Next imports so the root test suite can exercise it, because this
 * is the one piece of the gallery whose mistakes are expensive.
 *
 * The URL carries a row id, never a path: a caller can ask for screenshot 7, not
 * for `../../.env`. This function is the second line — the path it joins comes
 * from the database, and a stored path is still data that something else wrote.
 * A row pointing outside the screenshots directory resolves to null rather than
 * to a file.
 */
export function resolveScreenshot(root: string, stored: string): string | null {
  if (root.trim() === "" || stored.trim() === "") return null;

  const base = path.resolve(root);
  const resolved = path.resolve(base, stored);

  // `startsWith` on the bare prefix would accept a sibling called
  // `screenshots-evil`; the separator is what makes it containment.
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

/**
 * The row id from a URL segment, or null when it is not one.
 *
 * Digits only, rather than `Number()`: that would accept `1e3`, `0x10`, `+5` and
 * ` 5 ` as ids. None of them is dangerous — the value is only ever a lookup key —
 * but a URL that means something other than what it says is a bad habit to build
 * a route on.
 */
export function parseScreenshotId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}
