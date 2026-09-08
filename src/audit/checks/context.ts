import type { Page } from 'playwright';
import type { IssuePage, IssueSeverity } from '../../db/types.js';
import type { Logger } from '../../lib/logger.js';
import type { ViewportProfile } from '../browser.js';
import type { PageObservations } from '../pageCollector.js';
import type { AuditSession } from '../session.js';

/** Everything a page check is allowed to look at. */
export interface CheckContext {
  page: Page;
  session: AuditSession;
  /** URL the page was opened at, used as evidence. */
  url: string;
  /** Which funnel step this page is, so issues land in the right bucket. */
  target: IssuePage;
  viewport: ViewportProfile;
  /** What the collectors saw while the page loaded. */
  observations: PageObservations;
  navigationMs: number;
  logger: Logger;
}

/**
 * The same defect is worth more money the closer it sits to the money.
 * A JS error on the homepage is untidy; on checkout it is lost revenue.
 */
export function escalateForPage(base: IssueSeverity, target: IssuePage): IssueSeverity {
  if (target !== 'cart' && target !== 'checkout') return base;
  if (base === 'MINOR') return 'MAJOR';
  return 'CRITICAL';
}
