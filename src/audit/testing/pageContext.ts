import type { Browser } from 'playwright';
import { silentLogger } from '../../lib/logger.js';
import type { IssuePage } from '../../db/types.js';
import type { ViewportProfile } from '../browser.js';
import { attachPageCollectors } from '../pageCollector.js';
import { AuditSession } from '../session.js';
import type { CheckContext } from '../checks/context.js';
import {
  startFixtureServer,
  type FixtureServer,
  type FixtureRoute,
  type RouteHandler,
} from './fixtureServer.js';

/** Opens a fixture page and assembles the CheckContext the page checks expect. */
export interface OpenedFixture {
  ctx: CheckContext;
  server: FixtureServer;
  close: () => Promise<void>;
}

export async function openFixturePage(
  browser: Browser,
  routes: Record<string, FixtureRoute | RouteHandler>,
  options: {
    path?: string;
    target?: IssuePage;
    viewport?: ViewportProfile;
    /** Time to let late scripts and images settle before checks read the page. */
    settleMs?: number;
  } = {},
): Promise<OpenedFixture> {
  const server = await startFixtureServer(routes);
  const session = new AuditSession({ browser, requestDelayMs: 0, pageTimeoutMs: 10_000 });
  const page = await session.newPage(options.viewport ?? 'desktop');
  const collector = attachPageCollectors(page);
  const url = `${server.url}${options.path ?? '/'}`;
  const result = await session.goto(page, url, { waitUntil: 'load' });
  await page.waitForTimeout(options.settleMs ?? 150);

  const ctx: CheckContext = {
    page,
    session,
    url,
    target: options.target ?? 'homepage',
    viewport: options.viewport ?? 'desktop',
    observations: collector.observations,
    navigationMs: result.durationMs,
    logger: silentLogger(),
  };

  return {
    ctx,
    server,
    close: async () => {
      collector.stop();
      await session.close();
      await server.close();
    },
  };
}
