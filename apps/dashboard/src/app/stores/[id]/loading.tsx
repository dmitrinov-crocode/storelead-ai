import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while a store page is read (task 6-10).
 *
 * This one earns its place more than the list's: the page fires six queries and
 * the screenshots are hundreds of kilobytes each, so the gap after clicking a
 * domain is long enough to be doubted.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-64" />

      {[3, 6, 4, 2, 5].map((rows, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: rows }, (_, row) => (
              <Skeleton key={row} className="h-5 w-full" />
            ))}
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
