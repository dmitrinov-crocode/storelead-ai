"use client";

import { useRouter, useSearchParams } from "next/navigation";

const PAGE_SIZES = [10, 25, 50, 100];

export function PageSizeSelect() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentSize = searchParams.get("storesPageSize") ?? "10";

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());

    params.set("storesPageSize", value);

    params.delete("storesPage");

    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="page-size"
        className="text-muted-foreground text-sm"
      >
        Sites per page
      </label>

      <select
        id="page-size"
        value={currentSize}
        onChange={(event) => handleChange(event.target.value)}
        className="border-input bg-background h-9 rounded-md border px-3 text-sm"
      >
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </div>
  );
}
