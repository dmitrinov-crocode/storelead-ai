"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ScreenshotRow } from "@/lib/queries";

/**
 * The audit's screenshots, by page and viewport (task 6-06).
 *
 * Mobile first within each page, because that is where these shops lose money
 * and where the audit finds most of what it finds. Clicking a thumbnail opens
 * the full image over the page — a mobile capture is nearly two thousand pixels
 * tall, and judging a layout from a thumbnail is not judging it.
 *
 * The images are served by `/api/screenshots/[id]`, keyed by row id: the file
 * path is never in a URL.
 */

const VIEWPORT_ORDER: Record<string, number> = { mobile: 0, desktop: 1 };

export function ScreenshotGallery({ screenshots }: { screenshots: ScreenshotRow[] }) {
  const [open, setOpen] = useState<ScreenshotRow | null>(null);

  const pages = [...new Set(screenshots.map((shot) => shot.page))];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Screenshots
          <span className="text-muted-foreground text-sm font-normal">
            {screenshots.length === 0 ? "none" : `${screenshots.length} from the latest audit`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {screenshots.length === 0 && (
          <p className="text-muted-foreground text-sm">
            The audit took no screenshots of this shop.
          </p>
        )}

        {pages.map((page) => (
          <section key={page}>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              {page}
            </h3>
            <div className="flex flex-wrap gap-3">
              {screenshots
                .filter((shot) => shot.page === page)
                .sort(
                  (a, b) =>
                    (VIEWPORT_ORDER[a.viewport] ?? 9) - (VIEWPORT_ORDER[b.viewport] ?? 9),
                )
                .map((shot) => (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => setOpen(shot)}
                    className="hover:border-foreground/40 group rounded-md border p-1 text-left"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/screenshots/${shot.id}`}
                      alt={`${page} on ${shot.viewport}`}
                      loading="lazy"
                      className="h-40 w-auto rounded-sm object-cover object-top"
                    />
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {shot.viewport}
                      {shot.width && shot.height && ` · ${shot.width}×${shot.height}`}
                    </span>
                  </button>
                ))}
            </div>
          </section>
        ))}
      </CardContent>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${open.page} on ${open.viewport}`}
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-50 overflow-auto bg-black/70 p-6"
        >
          <div className="mx-auto w-fit">
            <div className="mb-2 flex items-center gap-3 text-sm text-white">
              <span>
                {open.page} · {open.viewport}
                {open.width && open.height && ` · ${open.width}×${open.height}`}
              </span>
              <button type="button" className="ml-auto underline" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/screenshots/${open.id}`}
              alt={`${open.page} on ${open.viewport}, full size`}
              onClick={(event) => event.stopPropagation()}
              className="max-w-full rounded-md bg-white"
            />
          </div>
        </div>
      )}
    </Card>
  );
}
