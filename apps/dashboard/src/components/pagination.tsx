import Link from "next/link";
import { Button } from "@/components/ui/button";
import { pageHref, type PageInfo } from "@/lib/pagination";

interface PaginationProps {
  info: PageInfo;
  /** Query-string key for this table, e.g. "storesPage". */
  paramKey: string;
  searchParams: Record<string, string | string[] | undefined>;
  /** Plural noun for the range summary, e.g. "stores". */
  noun: string;
}

export function Pagination({ info, paramKey, searchParams, noun }: PaginationProps) {
  if (info.total === 0) return null;

  const prev = pageHref(searchParams, paramKey, info.page - 1);
  const next = pageHref(searchParams, paramKey, info.page + 1);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
      <p className="text-muted-foreground text-sm tabular-nums">
        {info.from}–{info.to} of {info.total} {noun}
        {info.totalPages > 1 && (
          <span className="ml-2">
            · page {info.page} of {info.totalPages}
          </span>
        )}
      </p>

      {info.totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button asChild={info.hasPrev} variant="outline" size="sm" disabled={!info.hasPrev}>
            {info.hasPrev ? <Link href={prev} scroll={false}>Previous</Link> : <span>Previous</span>}
          </Button>
          <Button asChild={info.hasNext} variant="outline" size="sm" disabled={!info.hasNext}>
            {info.hasNext ? <Link href={next} scroll={false}>Next</Link> : <span>Next</span>}
          </Button>
        </div>
      )}
    </div>
  );
}
