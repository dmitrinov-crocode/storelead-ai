import { cn } from "@/lib/utils";
import { legendEntries, type StatusMeta } from "@/lib/status-meta";

interface StatusLegendProps {
  table: Record<string, StatusMeta>;
  /** Statuses present in the data, shown first and at full strength. */
  present?: ReadonlySet<string>;
}

/**
 * Every status the table can show, with a one-line meaning. Statuses that are
 * not currently in the data are dimmed rather than hidden, so the legend also
 * doubles as a map of where a store can end up.
 */
export function StatusLegend({ table, present }: StatusLegendProps) {
  const entries = legendEntries(table);

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
      {entries.map(({ status, description, className }) => {
        const inUse = !present || present.has(status);
        return (
          <li
            key={status}
            className={cn("flex items-center gap-1.5", !inUse && "opacity-45")}
          >
            <span
              className={cn(
                "inline-flex h-5 shrink-0 items-center rounded-full px-2 font-medium whitespace-nowrap",
                className,
              )}
            >
              {status.replace(/_/g, " ").toLowerCase()}
            </span>
            <span className="text-muted-foreground">{description}</span>
          </li>
        );
      })}
    </ul>
  );
}
