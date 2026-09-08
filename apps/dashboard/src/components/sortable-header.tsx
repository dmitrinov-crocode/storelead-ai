import Link from "next/link";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { pageHref } from "@/lib/pagination";
import {
  DEFAULT_DIRECTION,
  DEFAULT_SORT,
  nextDirection,
  SORT_COLUMNS,
  type SortDirection,
  type SortKey,
} from "@/lib/sorting";

interface SortableHeaderProps {
  column: SortKey;
  activeKey: SortKey;
  activeDirection: SortDirection;
  searchParams: Record<string, string | string[] | undefined>;
}

/**
 * A column header that links to the same page sorted by this column.
 * Changing the sort returns to page one — staying on page 7 of a different
 * ordering shows an unrelated slice of rows.
 */
export function SortableHeader({
  column,
  activeKey,
  activeDirection,
  searchParams,
}: SortableHeaderProps) {
  const meta = SORT_COLUMNS[column];
  const active = column === activeKey;
  const direction = nextDirection(column, activeKey, activeDirection);

  const params: Record<string, string | string[] | undefined> = {
    ...searchParams,
    sort: column === DEFAULT_SORT && direction === DEFAULT_DIRECTION ? undefined : column,
    dir: column === DEFAULT_SORT && direction === DEFAULT_DIRECTION ? undefined : direction,
  };
  const href = pageHref(params, "storesPage", 1);

  return (
    <TableHead className={cn(meta.numeric && "text-right")}>
      <Link
        href={href}
        scroll={false}
        aria-sort={active ? (activeDirection === "asc" ? "ascending" : "descending") : "none"}
        className={cn(
          "hover:text-foreground inline-flex items-center gap-1 transition-colors",
          active ? "text-foreground font-medium" : "text-muted-foreground",
        )}
      >
        {meta.label}
        <span aria-hidden className={cn("text-xs", !active && "opacity-0")}>
          {activeDirection === "asc" ? "↑" : "↓"}
        </span>
      </Link>
    </TableHead>
  );
}
