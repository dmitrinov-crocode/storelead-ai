import { buildCsv, exportFileName, UTF8_BOM } from "@/lib/csvExport";
import { getApprovedLetters } from "@/lib/queries";

/**
 * Downloads the approved letters as CSV (task 6-09).
 *
 * A route handler rather than a Server Action because this produces a file: an
 * action returns data to React, and turning that into a download means building
 * a blob in the browser. A GET with `Content-Disposition` is what a browser
 * already knows how to do, and the URL can be opened straight from a terminal or
 * a script when somebody wants the same file without the UI.
 *
 * Nothing is sent from here. The file is the hand-off to a human with an email
 * client, which is what the plan says outreach is.
 */
export async function GET(): Promise<Response> {
  const letters = await getApprovedLetters();

  return new Response(`${UTF8_BOM}${buildCsv(letters)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName()}"`,
      // A stale download would hand somebody yesterday's approvals.
      "Cache-Control": "no-store",
    },
  });
}
