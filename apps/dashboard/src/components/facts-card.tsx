import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AppStackRow, PagespeedRow, ThemeRow } from "@/lib/queries";
import type { StoreRow } from "@core/db/types";

/**
 * The measured facts about one shop (task 6-04).
 *
 * These are the same facts the letter was allowed to draw on, which is the
 * point: a reviewer checking a draft against reality should not have to open
 * SQL to do it. Anything absent is shown as absent rather than omitted — "we
 * never measured this" and "this is fine" look identical when a row is simply
 * missing, and only one of them is a reason to trust the letter.
 */

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString("en-US");
}

/** PageSpeed's own bands: 90+ good, 50–89 needs work, below 50 poor. */
function scoreTone(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 90) return "text-emerald-700";
  if (score >= 50) return "text-amber-700";
  return "text-red-700";
}

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-32 shrink-0">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface FactsCardProps {
  store: StoreRow;
  pagespeed: PagespeedRow[];
  theme: ThemeRow | null;
  apps: AppStackRow | null;
  appNames: string[];
}

export function FactsCard({ store, pagespeed, theme, apps, appNames }: FactsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Facts</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            Business
          </h3>
          <dl className="space-y-1 text-sm">
            <Row label="Rank">{num(store.rank)}</Row>
            <Row label="Revenue est.">{num(store.revenue_estimate)}</Row>
            <Row label="Traffic est.">{num(store.traffic_estimate)}</Row>
            <Row label="Growth">
              {store.growth_rate === null ? "—" : `${(store.growth_rate * 100).toFixed(1)}%`}
            </Row>
            <Row label="Products">{num(store.products_count)}</Row>
            <Row label="Country">{store.country ?? "—"}</Row>
          </dl>
          <p className="text-muted-foreground mt-2 text-xs">
            Third-party estimates from StoreLeads. They never reach a letter — quoting a merchant
            their own numbers reads as surveillance, and these are often wrong.
          </p>
        </section>

        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            PageSpeed
          </h3>
          {pagespeed.length === 0 ? (
            <p className="text-muted-foreground text-sm">Not measured.</p>
          ) : (
            <div className="space-y-3">
              {pagespeed.map((row) => (
                <dl key={row.strategy} className="space-y-1 text-sm">
                  <Row label={row.strategy}>
                    <span className={`font-medium ${scoreTone(row.performance)}`}>
                      {row.performance ?? "—"}/100
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      · LCP {seconds(row.lcp_ms)} · CLS {row.cls ?? "—"} · INP{" "}
                      {row.inp_ms === null ? "—" : `${Math.round(row.inp_ms)}ms`}
                    </span>
                  </Row>
                  <Row label="">
                    <span className="text-muted-foreground text-xs">
                      a11y {row.accessibility ?? "—"} · best practices {row.best_practices ?? "—"} ·
                      seo {row.seo ?? "—"}
                    </span>
                  </Row>
                </dl>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            Theme
          </h3>
          {theme?.name ? (
            <dl className="space-y-1 text-sm">
              <Row label="Name">{theme.name}</Row>
              <Row label="Version">
                {theme.current_version ?? "—"}
                {theme.latest_version && (
                  <span className="text-muted-foreground"> (latest {theme.latest_version})</span>
                )}
              </Row>
              <Row label="Age">
                {theme.age_months === null ? "—" : `${theme.age_months} months behind`}
              </Row>
              <Row label="Freshness">{theme.freshness ?? "—"}</Row>
              <Row label="Architecture">{theme.architecture ?? "—"}</Row>
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">Not detected.</p>
          )}
        </section>

        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            Apps
          </h3>
          {apps?.total ? (
            <>
              <p className="text-sm">
                <span className="font-medium">{apps.total}</span> loaded
                {apps.size && (
                  <span className="text-muted-foreground"> — a {apps.size} stack for this segment</span>
                )}
              </p>
              {appNames.length > 0 && (
                <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                  {appNames.join(", ")}
                </p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Not detected.</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
