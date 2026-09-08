import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { StoreContactRow } from "@/lib/queries";

/**
 * The contacts of one store (task 6-07).
 *
 * Three things a reviewer needs before a letter can be judged: who this is, how
 * we know, and how sure we are. The last two matter more than they look. A
 * contact scored 0.9 from the shop's own About page and one scored 0.38 from a
 * search result are used differently — the second is a lead to verify, not a
 * person to address — and the source line is what lets somebody check in one
 * click rather than trusting the number.
 */

/** Where a contact came from, in words rather than a column value. */
const SOURCE_LABELS: Record<string, string> = {
  about_page: "the shop's About page",
  footer: "the shop's own markup",
  generic_email: "a shared mailbox on the site",
  web_search: "a web search",
  linkedin_serp: "a LinkedIn search result",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, " ");
}

/**
 * Confidence, banded.
 *
 * The bands are the weights of 4-09 read back: a searched contact tops out at
 * 0.50 by design, so anything above it was asserted by the storefront itself.
 */
function confidenceTone(confidence: number): string {
  if (confidence >= 0.7) return "bg-emerald-50 text-emerald-700 ring-emerald-600/20";
  if (confidence >= 0.45) return "bg-amber-50 text-amber-800 ring-amber-600/20";
  return "bg-slate-50 text-slate-600 ring-slate-500/20";
}

export function ContactCard({ contacts }: { contacts: StoreContactRow[] }) {
  const people = contacts.filter((contact) => contact.is_generic === 0);
  const shared = contacts.filter((contact) => contact.is_generic === 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Contacts
          <span className="text-muted-foreground text-sm font-normal">
            {contacts.length === 0 ? "none found" : `${contacts.length} found`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {contacts.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Neither the storefront nor the web search produced a contact for this shop.
          </p>
        )}

        {people.map((contact) => (
          <div key={contact.id} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{contact.name ?? "Unnamed contact"}</span>
              {contact.role && <Badge variant="secondary">{contact.role}</Badge>}
              {contact.is_primary === 1 && <Badge>primary</Badge>}
              <span
                title="How much the evidence supports this contact (task 4-09)"
                className={`ml-auto inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ring-1 ring-inset ${confidenceTone(
                  contact.confidence,
                )}`}
              >
                {contact.confidence.toFixed(2)}
              </span>
            </div>

            <dl className="mt-2 space-y-1 text-sm">
              {contact.email && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground w-20 shrink-0">Email</dt>
                  <dd>
                    <a className="underline underline-offset-2" href={`mailto:${contact.email}`}>
                      {contact.email}
                    </a>
                  </dd>
                </div>
              )}
              {contact.linkedin_url && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground w-20 shrink-0">LinkedIn</dt>
                  <dd>
                    <a
                      className="underline underline-offset-2"
                      href={contact.linkedin_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {contact.linkedin_url.replace("https://www.linkedin.com/", "")}
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-20 shrink-0">Found on</dt>
                <dd>
                  {contact.source_url ? (
                    <a
                      className="underline underline-offset-2"
                      href={contact.source_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {sourceLabel(contact.source)}
                    </a>
                  ) : (
                    sourceLabel(contact.source)
                  )}
                </dd>
              </div>
            </dl>
          </div>
        ))}

        {shared.length > 0 && (
          <div>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              Shared inboxes
            </h3>
            <ul className="space-y-1 text-sm">
              {shared.map((contact) => (
                <li key={contact.id} className="flex items-center gap-2">
                  <a className="underline underline-offset-2" href={`mailto:${contact.email}`}>
                    {contact.email}
                  </a>
                  <span className="text-muted-foreground text-xs">
                    {contact.confidence.toFixed(2)} · {sourceLabel(contact.source)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
