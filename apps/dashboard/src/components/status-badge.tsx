import { cn } from "@/lib/utils";
import { statusMeta, type StatusMeta } from "@/lib/status-meta";

interface StatusBadgeProps {
  status: string | null | undefined;
  table: Record<string, StatusMeta>;
  /** Rendered when the value is absent, e.g. a store with no email yet. */
  fallback?: string;
  title?: string;
}

export function StatusBadge({ status, table, fallback = "—", title }: StatusBadgeProps) {
  if (!status) return <span className="text-muted-foreground">{fallback}</span>;

  const meta = statusMeta(table, status);
  return (
    <span
      title={title ?? meta.description}
      className={cn(
        "inline-flex h-5 w-fit items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
        meta.className,
      )}
    >
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}
