/**
 * Raw StoreLeads API shapes (https://storeleads.app/api).
 *
 * Everything is optional: the API only returns the fields requested via `fields`,
 * and omits attributes it has no data for. The mapper is the only place allowed
 * to assume anything about these values.
 */

/** Theme fields use the literal string 'Unknown' where the value is not known. */
export interface StoreLeadsTheme {
  name?: string | null;
  style?: string | null;
  cost?: number | null;
  vendor?: string | null;
  version?: string | null;
}

export interface StoreLeadsApp {
  name?: string | null;
  token?: string | null;
  platform?: string | null;
  /** Observed values: 'Active' and 'Inactive' — not 'installed'/'uninstalled'. */
  state?: string | null;
  /** StoreLeads already classifies apps, e.g. ['order tracking', 'shipping']. */
  categories?: string[] | null;
  average_rating?: number | string | null;
  installed_at?: string | null;
  installs?: number | null;
}

export interface StoreLeadsTechnology {
  name?: string | null;
  description?: string | null;
  vendor_url?: string | null;
}

export interface StoreLeadsContactInfo {
  value?: string | null;
  source?: string | null;
  type?: string | null;
}

export interface StoreLeadsDomain {
  /** DNS domain name, e.g. "www.aloyoga.com" — this is the identity, not a title. */
  name?: string | null;
  /** Platform-specific domain, e.g. "merchant.myshopify.com". */
  platform_domain?: string | null;
  /** Human-readable merchant name. */
  merchant_name?: string | null;
  title?: string | null;
  description?: string | null;

  platform?: string | null;
  country_code?: string | null;
  currency_code?: string | null;
  language_code?: string | null;
  city?: string | null;

  rank?: number | null;
  rank_percentile?: number | null;
  platform_rank?: number | null;
  platform_rank_percentile?: number | null;

  /** Monthly sales in USD cents. */
  estimated_sales?: number | null;
  /** Yearly sales in USD cents. */
  estimated_sales_yearly?: number | null;
  estimated_visits?: number | null;
  estimated_page_views?: number | null;

  product_count?: number | null;
  avg_price_usd?: number | null;

  theme?: StoreLeadsTheme | string | null;
  apps?: StoreLeadsApp[] | null;
  technologies?: StoreLeadsTechnology[] | null;
  categories?: string[] | null;
  contact_info?: StoreLeadsContactInfo[] | null;

  created_at?: string | null;
  last_updated_at?: string | null;
}

/**
 * `GET /all/domain` — list envelope, verified against the live API on 2026-08-28.
 * There is no nested `pagination` object; the fields sit at the top level.
 */
export interface StoreLeadsListResponse {
  domains?: StoreLeadsDomain[] | null;
  /** Total matching the filter, not the page. */
  total?: number | null;
  page_size?: number | null;
  has_next_page?: boolean | null;
  /** Opaque cursor for the next page; `page` paging returns identical results. */
  next_cursor?: string | null;
}
