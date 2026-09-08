import Link from "next/link";
import { Pagination } from "@/components/pagination";
import { RunControls } from "@/components/run-controls";
import { StatusBadge } from "@/components/status-badge";
import { SortableHeader } from "@/components/sortable-header";
import { StatusLegend } from "@/components/status-legend";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { parsePage, parsePageSize } from "@/lib/pagination";
import { parseDirection, parseSort, SORT_COLUMNS } from "@/lib/sorting";
import { getDashboardData, type StoreListItem } from "@/lib/queries";
import {
  EMAIL_STATUS_META,
  RUN_STATUS_META,
  SEVERITY_META,
  STORE_STATUS_META,
} from "@/lib/status-meta";
import { cn } from "@/lib/utils";
import { StoreFilters } from "@/components/store-filters";
import { PageSizeSelect } from "@/components/page-size-select";

type SearchParams = Record<string, string | string[] | undefined>;
function getParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getNumberParam(
  value: string | string[] | undefined,
): number | undefined {
  const param = getParam(value);

  if (!param) {
    return undefined;
  }

  const number = Number(param);

  return Number.isFinite(number) ? number : undefined;
}

/**
 * The three contact columns of Epic 4: a person to write to, a person to look
 * up, and the shared inbox to fall back on. They are separate columns rather
 * than one because they are three different decisions for whoever reviews a lead.
 */
function ContactCell({ store }: { store: StoreListItem }) {
  if (!store.contact_name && !store.contact_email) {
    return <span className="text-muted-foreground">—</span>;
  }
  const confidence =
    store.contact_confidence === null ? null : store.contact_confidence.toFixed(2);
  return (
    <span className="flex flex-col leading-tight">
      {store.contact_name && (
        <span className="font-medium">
          {store.contact_name}
          {store.contact_role && (
            <span className="text-muted-foreground font-normal"> · {store.contact_role}</span>
          )}
        </span>
      )}
      {store.contact_email ? (
        <a
          href={`mailto:${store.contact_email}`}
          className="text-muted-foreground hover:underline"
        >
          {store.contact_email}
        </a>
      ) : (
        <span className="text-muted-foreground text-xs">no address</span>
      )}
      {confidence && (
        <span className="text-muted-foreground text-xs tabular-nums">confidence {confidence}</span>
      )}
    </span>
  );
}

function LinkedInCell({ url }: { url: string | null }) {
  if (!url) return <span className="text-muted-foreground">—</span>;
  // `/in/` is a person, `/company/` is the shop — worth telling apart at a glance.
  const person = url.includes("/in/");
  const slug = url.split("/").filter(Boolean).pop();
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="hover:underline"
      title={url}
    >
      <span className="text-muted-foreground text-xs">{person ? "in" : "company"}</span>{" "}
      <span className={person ? "font-medium" : undefined}>{slug}</span>
    </a>
  );
}

function SharedInboxCell({ store }: { store: StoreListItem }) {
  const emails = store.generic_emails ? store.generic_emails.split(" ").filter(Boolean) : [];
  if (emails.length === 0) return <span className="text-muted-foreground">—</span>;

  const [first, ...rest] = emails;
  return (
    <span className="flex flex-col leading-tight" title={emails.join("\n")}>
      <a href={`mailto:${first}`} className="hover:underline">
        {first}
      </a>
      {rest.length > 0 && (
        <span className="text-muted-foreground text-xs">+{rest.length} more</span>
      )}
    </span>
  );
}

function IssueCounts({ store }: { store: StoreListItem }) {
  if (store.critical_issues === 0 && store.major_issues === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="flex gap-1">
      {store.critical_issues > 0 && (
        <span
          title={SEVERITY_META.CRITICAL.description}
          className={cn(
            "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
            SEVERITY_META.CRITICAL.className,
          )}
        >
          {store.critical_issues} critical
        </span>
      )}
      {store.major_issues > 0 && (
        <span
          title={SEVERITY_META.MAJOR.description}
          className={cn(
            "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
            SEVERITY_META.MAJOR.className,
          )}
        >
          {store.major_issues} major
        </span>
      )}
    </span>
  );
}

/** StoreLeads reports monthly sales in USD cents. */
function formatRevenue(cents: number | null): string {
  if (cents === null) return "—";
  const usd = cents / 100;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
}

function EmptyState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No data yet</CardTitle>
        <CardDescription>
          The database has not been created. Run the migrations, then fetch stores or
          seed demo data.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="bg-muted overflow-x-auto rounded-md p-4 text-sm">
          {`npm run pipeline -- db migrate
npm run pipeline -- run --limit 10`}
        </pre>
      </CardContent>
    </Card>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const pageSize = parsePageSize(params.pageSize);
  const storesPageSize = parsePageSize(params.storesPageSize);
  const sort = parseSort(params.sort);
  const direction = parseDirection(params.dir, SORT_COLUMNS[sort].defaultDirection);

  const filters = {
    domain: getParam(params.domain),

    rankMin: getNumberParam(params.rankMin),
    rankMax: getNumberParam(params.rankMax),

    scoreMin: getNumberParam(params.scoreMin),
    scoreMax: getNumberParam(params.scoreMax),

    revenueMin: getNumberParam(params.revenueMin),
    revenueMax: getNumberParam(params.revenueMax),

    issuesMin: getNumberParam(params.issuesMin),
    issuesMax: getNumberParam(params.issuesMax),

    status: getParam(params.status),
    email: getParam(params.email),
    category: getParam(params.category),
    severity: getParam(params.severity),
  };

  const {
    ready,
    runs,
    runsPage,
    stores,
    storesPage,
    runStatuses,
    storeStatuses,
    storeCategories,
    running,
    approved,
  } = await getDashboardData({
    runsPage: parsePage(params.runsPage),
    storesPage: parsePage(params.storesPage),
    pageSize,
    storesPageSize,
    sort,
    direction,
    filters,
  });

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 p-6 md:p-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">StoreLead AI</h1>
        <p className="text-muted-foreground text-sm">
          Local lead discovery pipeline — runs, audits and outreach review.
        </p>
      </header>

      {ready && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RunControls running={running} />
          {approved > 0 ? (
            <a
              href="/api/emails/export"
              // A plain link, not a button: the browser already knows how to
              // save a file, and this URL works from a terminal too.
              className="border-input hover:bg-accent inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium"
            >
              Export {approved} approved {approved === 1 ? "letter" : "letters"} (CSV)
            </a>
          ) : (
            <span className="text-muted-foreground text-sm">
              No approved letters to export yet.
            </span>
          )}
        </div>
      )}

      {!ready ? (
        <EmptyState />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Runs</CardTitle>
              <CardDescription>Every pipeline run, newest first.</CardDescription>
              <div className="pt-3">
                <StatusLegend table={RUN_STATUS_META} present={runStatuses} />
              </div>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No runs yet — press <span className="font-medium">Fetch stores</span> above.
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Country</TableHead>
                          <TableHead className="text-right">Batch</TableHead>
                          <TableHead>Started</TableHead>
                          <TableHead>Error</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {runs.map((run) => (
                          <TableRow key={run.id}>
                            <TableCell className="font-medium tabular-nums">{run.id}</TableCell>
                            <TableCell>
                              <StatusBadge status={run.status} table={RUN_STATUS_META} />
                            </TableCell>
                            <TableCell>{run.country}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {run.batch_size}
                            </TableCell>
                            <TableCell className="text-muted-foreground whitespace-nowrap">
                              {run.started_at.replace("T", " ").slice(0, 19)}
                            </TableCell>
                            <TableCell
                              className="text-muted-foreground max-w-[18rem] truncate text-xs"
                              title={run.error ?? undefined}
                            >
                              {run.error ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <Pagination
                    info={runsPage}
                    paramKey="runsPage"
                    searchParams={params}
                    noun="runs"
                  />
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Stores</CardTitle>
              <CardDescription>
                Click a column heading to sort. Detail pages arrive with Epic 6.
              </CardDescription>
              <div className="pt-3">
                <StatusLegend table={STORE_STATUS_META} present={storeStatuses} />
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <StoreFilters
                categories={storeCategories}
                statuses={Array.from(storeStatuses)}
                emailStatuses={Object.keys(EMAIL_STATUS_META)}
              />
              <div className="flex justify-end">
                <PageSizeSelect />
              </div>

              {stores.length === 0 ? (
                <p className="text-muted-foreground text-sm">No stores collected yet.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {(
                            [
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
                            ] as const
                          ).map((column) => (
                            <SortableHeader
                              key={column}
                              column={column}
                              activeKey={sort}
                              activeDirection={direction}
                              searchParams={params}
                            />
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {stores.map((store) => (
                          <TableRow key={store.id}>
                            <TableCell className="font-medium">
                              <Link
                                href={`/stores/${store.id}`}
                                className="underline-offset-2 hover:underline"
                              >
                                {store.domain}
                              </Link>
                            </TableCell>
                            <TableCell className="text-muted-foreground text-right tabular-nums">
                              {store.rank ?? "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {store.lead_score ?? "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatRevenue(store.revenue_estimate)}
                            </TableCell>
                            <TableCell>
                              <IssueCounts store={store} />
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={store.status} table={STORE_STATUS_META} />
                            </TableCell>
                            <TableCell className="text-sm">
                              <ContactCell store={store} />
                            </TableCell>
                            <TableCell className="text-sm">
                              <LinkedInCell url={store.contact_linkedin} />
                            </TableCell>
                            <TableCell className="text-sm">
                              <SharedInboxCell store={store} />
                            </TableCell>
                            <TableCell>
                              <StatusBadge
                                status={store.email_status}
                                table={EMAIL_STATUS_META}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <Pagination
                    info={storesPage}
                    paramKey="storesPage"
                    searchParams={params}
                    noun="stores"
                  />
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
