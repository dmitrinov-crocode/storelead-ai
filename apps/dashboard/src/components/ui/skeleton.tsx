import { cn } from "@/lib/utils";

/** A grey block standing in for content that is still being read. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("bg-muted animate-pulse rounded-md", className)} {...props} />;
}
