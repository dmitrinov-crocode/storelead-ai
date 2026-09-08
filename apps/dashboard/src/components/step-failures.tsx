import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StepFailure } from "@/lib/queries";

/**
 * The steps that failed for this store (task 6-10).
 *
 * An empty PageSpeed block and a PageSpeed block that timed out look identical,
 * and only one of them means the shop is fine. Without this the reader's only
 * options are to trust the gap or open the logs, and the first is how a letter
 * gets approved on facts that were never gathered.
 *
 * Only the latest attempt of each step is shown: a step that failed on one run
 * and succeeded on the next is history, not a current problem.
 */
export function StepFailures({ failures }: { failures: StepFailure[] }) {
  if (failures.length === 0) return null;

  return (
    <Card className="border-amber-300 bg-amber-50/50">
      <CardHeader>
        <CardTitle className="text-amber-900">
          {failures.length === 1 ? "A step failed" : `${failures.length} steps failed`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {failures.map((failure) => (
            <li key={failure.step}>
              <span className="font-medium">{failure.step}</span>
              {failure.error && <span className="text-amber-900"> — {failure.error}</span>}
              {failure.finished_at && (
                <span className="text-muted-foreground"> · {failure.finished_at.slice(0, 16)}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-3 text-xs">
          Anything these steps would have gathered is missing below, not absent from the shop.
          Re-run with <code>npm run pipeline -- run --run &lt;id&gt; --force</code>.
        </p>
      </CardContent>
    </Card>
  );
}
