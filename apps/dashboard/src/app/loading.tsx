import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while the list page reads the database (task 6-10).
 *
 * The page is dynamic and the queries are synchronous SQLite, so on a large
 * database the browser otherwise sits on the previous page with nothing to say
 * it heard the click. The shape mirrors the real page — two tables — so the
 * layout does not jump when the rows arrive.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-9 w-72" />

      {[6, 10].map((rows) => (
        <Card key={rows}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: rows }, (_, row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
