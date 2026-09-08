/**
 * `robots.txt`, obeyed rather than merely noted.
 *
 * The audit does not use this: it visits as a shopper, and a shopper is not
 * governed by robots.txt — obeying it there would also make the cart and
 * checkout checks impossible, since Shopify's default file disallows `/cart`
 * and `/checkout`. The contact scraper is the opposite case. It says who it is
 * in the User-Agent, and something that identifies itself as a crawler has to
 * honour the file (task 7-06).
 *
 * Deliberately small: group selection, Allow/Disallow with longest-match wins,
 * and Crawl-delay. Sitemap lines and wildcards beyond `*` and `$` are ignored,
 * which is the conservative direction — an unparsed rule never grants access.
 */

export interface RobotsRules {
  /** True when the path may be fetched. */
  isAllowed(path: string): boolean;
  /** Seconds the site asked crawlers to wait between requests, if it did. */
  crawlDelaySeconds: number | null;
}

interface Rule {
  /** Path pattern as written, `*` and `$` included. */
  pattern: string;
  allow: boolean;
}

/** Everything is permitted: no file, an empty file, or one we could not read. */
export const ALLOW_ALL: RobotsRules = {
  isAllowed: () => true,
  crawlDelaySeconds: null,
};

/**
 * Parses the file from the point of view of one user agent.
 *
 * A group naming our agent wins outright over the `*` group, as the standard
 * requires — a site that singles us out must be obeyed literally.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = userAgentToken(userAgent);

  // Grouped by the agent(s) each block applies to.
  const groups = new Map<string, { rules: Rule[]; crawlDelay: number | null }>();
  let currentAgents: string[] = [];
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (!lastLineWasAgent) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      lastLineWasAgent = true;
      for (const agent of currentAgents) {
        if (!groups.has(agent)) groups.set(agent, { rules: [], crawlDelay: null });
      }
      continue;
    }
    lastLineWasAgent = false;
    if (currentAgents.length === 0) continue;

    for (const agent of currentAgents) {
      const group = groups.get(agent);
      if (!group) continue;

      if (field === 'disallow') {
        // An empty Disallow is the explicit "everything is allowed".
        if (value !== '') group.rules.push({ pattern: value, allow: false });
      } else if (field === 'allow') {
        if (value !== '') group.rules.push({ pattern: value, allow: true });
      } else if (field === 'crawl-delay') {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) group.crawlDelay = seconds;
      }
    }
  }

  const group = groups.get(token) ?? groups.get('*');
  if (!group) return ALLOW_ALL;

  const rules = [...group.rules].sort((a, b) => b.pattern.length - a.pattern.length);

  return {
    crawlDelaySeconds: group.crawlDelay,
    isAllowed(path: string): boolean {
      for (const rule of rules) {
        if (matches(rule.pattern, path)) return rule.allow;
      }
      return true;
    },
  };
}

/** The product token: `StoreLeadBot/0.1 (+https://…)` -> `storeleadbot`. */
export function userAgentToken(userAgent: string): string {
  const first = userAgent.trim().split(/[\s/]/)[0] ?? userAgent;
  return first.toLowerCase();
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');

  let index = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '') continue;

    if (i === 0) {
      if (!path.startsWith(part)) return false;
      index = part.length;
      continue;
    }
    const found = path.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }

  if (anchored) {
    const tail = parts[parts.length - 1] ?? '';
    return tail === '' ? true : path.endsWith(tail);
  }
  return true;
}
