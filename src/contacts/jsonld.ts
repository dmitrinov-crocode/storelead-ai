/**
 * Reading the structured data a shop publishes about itself.
 *
 * Shopify themes emit JSON-LD for the organisation, and some merchants describe
 * their people there too. It is the only source on a storefront that states
 * "this string is an email" or "this person is the founder" rather than leaving
 * it to be inferred from prose, so both 4-02 and 4-04 start here.
 */

const BLOCK_PATTERN = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const MAX_DEPTH = 8;

/** Parsed `application/ld+json` payloads. One broken block never fails the rest. */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  let match = BLOCK_PATTERN.exec(html);
  while (match) {
    const raw = match[1];
    if (raw !== undefined) {
      try {
        out.push(JSON.parse(raw));
      } catch {
        // Shops ship invalid JSON-LD; the other sources still apply.
      }
    }
    match = BLOCK_PATTERN.exec(html);
  }
  BLOCK_PATTERN.lastIndex = 0;
  return out;
}

/** Every string value under `key`, anywhere in the graph. */
export function valuesByKey(node: unknown, key: string, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    for (const item of node) valuesByKey(item, key, out, depth + 1);
    return out;
  }

  for (const [name, value] of Object.entries(node)) {
    if (name.toLowerCase() === key.toLowerCase() && typeof value === 'string') {
      out.push(value.trim());
    } else {
      valuesByKey(value, key, out, depth + 1);
    }
  }
  return out;
}

/** Objects whose `@type` is `type`, anywhere in the graph. */
export function nodesByType(
  node: unknown,
  type: string,
  out: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return out;

  if (Array.isArray(node)) {
    for (const item of node) nodesByType(item, type, out, depth + 1);
    return out;
  }

  const record = node as Record<string, unknown>;
  const declared = record['@type'];
  const types = Array.isArray(declared) ? declared : [declared];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === type.toLowerCase())) {
    out.push(record);
  }

  for (const value of Object.values(record)) nodesByType(value, type, out, depth + 1);
  return out;
}
