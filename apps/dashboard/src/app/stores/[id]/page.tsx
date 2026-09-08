import Link from "next/link";
import { notFound } from "next/navigation";
import { ContactCard } from "@/components/contact-card";
import { EmailCard } from "@/components/email-card";
import { FactsCard } from "@/components/facts-card";
import { IssuesCard } from "@/components/issues-card";
import { ScreenshotGallery } from "@/components/screenshot-gallery";
import { StepFailures } from "@/components/step-failures";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { STORE_STATUS_META } from "@/lib/status-meta";
import { getStoreDetail } from "@/lib/queries";

/**
 * One store's page (tasks 6-07, 6-08).
 *
 * It exists so the output of the pipeline can be acted on. Until now a finished
 * letter was reachable only through SQL, which makes the review pass of 5-09 —
 * twenty letters judged by a human — far harder than the work it is measuring.
 *
 * The order is the order a reviewer works in: why this shop is a lead, what was
 * measured, what was found, what it looked like, who to write to, and only then
 * the letter. Judging a draft before seeing its evidence is how an invented
 * claim gets approved.
 */

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const storeId = Number(id);
  if (!Number.isInteger(storeId) || storeId <= 0) notFound();

  const detail = await getStoreDetail(storeId);
  if (!detail) notFound();

  const { store } = detail;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="space-y-2">
        <Link href="/" className="text-muted-foreground text-sm underline underline-offset-2">
          ← All stores
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
          {store.name ?? store.domain}
          <StatusBadge status={store.status} table={STORE_STATUS_META} />
        </h1>
        <a
          href={store.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground text-sm underline underline-offset-2"
        >
          {store.domain}
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Why this shop is a lead</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {detail.category ? (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{detail.category.replace(/_/g, " ")}</span>
                {detail.priority && (
                  <span className="text-muted-foreground">priority {detail.priority}</span>
                )}
                {detail.leadScore !== null && (
                  <span className="text-muted-foreground">lead score {detail.leadScore}/100</span>
                )}
              </p>
              {detail.reason && <p className="text-muted-foreground">{detail.reason}</p>}
            </>
          ) : (
            <p className="text-muted-foreground">
              This shop has not been classified yet, so no letter can be written for it.
            </p>
          )}
        </CardContent>
      </Card>

      <StepFailures failures={detail.failures} />

      <FactsCard
        store={store}
        pagespeed={detail.pagespeed}
        theme={detail.theme}
        apps={detail.apps}
        appNames={detail.appNames}
      />

      <IssuesCard issues={detail.issues} />

      <ScreenshotGallery screenshots={detail.screenshots} />

      <ContactCard contacts={detail.contacts} />

      <EmailCard
        emails={detail.emails}
        storeId={store.id}
        domain={store.domain}
        runId={detail.runId}
        running={detail.running}
      />
    </main>
  );
}
