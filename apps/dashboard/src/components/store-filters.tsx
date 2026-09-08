"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

interface StoreFiltersProps {
  statuses: string[];
  emailStatuses: string[];
  /** Categories the classifier has actually produced (task 3-07). */
  categories: string[];
}

/**
 * Severity is "has at least one finding this bad", not "its worst is this bad":
 * a shop with a critical issue also has major ones, and the two filters must not
 * disagree about the same store.
 */
const SEVERITIES = ["CRITICAL", "MAJOR"] as const;

export function StoreFilters({ statuses, emailStatuses, categories }: StoreFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [domain, setDomain] = useState(
    searchParams.get("domain") ?? "",
  );

  const [rankMin, setRankMin] = useState(
    searchParams.get("rankMin") ?? "",
  );
  const [rankMax, setRankMax] = useState(
    searchParams.get("rankMax") ?? "",
  );

  const [scoreMin, setScoreMin] = useState(
    searchParams.get("scoreMin") ?? "",
  );
  const [scoreMax, setScoreMax] = useState(
    searchParams.get("scoreMax") ?? "",
  );

  const [revenueMin, setRevenueMin] = useState(
    searchParams.get("revenueMin") ?? "",
  );
  const [revenueMax, setRevenueMax] = useState(
    searchParams.get("revenueMax") ?? "",
  );

  const [issuesMin, setIssuesMin] = useState(
    searchParams.get("issuesMin") ?? "",
  );
  const [issuesMax, setIssuesMax] = useState(
    searchParams.get("issuesMax") ?? "",
  );

  const [status, setStatus] = useState(
    searchParams.get("status") ?? "",
  );

  const [email, setEmail] = useState(
    searchParams.get("email") ?? "",
  );

  const [category, setCategory] = useState(
    searchParams.get("category") ?? "",
  );
  const [severity, setSeverity] = useState(
    searchParams.get("severity") ?? "",
  );

  function applyFilters() {
    const params = new URLSearchParams(searchParams.toString());

    const filters = {
      domain,
      rankMin,
      rankMax,
      scoreMin,
      scoreMax,
      revenueMin,
      revenueMax,
      issuesMin,
      issuesMax,
      status,
      email,
      category,
      severity,
    };

    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    });

    params.delete("storesPage");

    router.push(`?${params.toString()}`);
  }

  function resetFilters() {
    const params = new URLSearchParams(searchParams.toString());

    [
      "domain",
      "rankMin",
      "rankMax",
      "scoreMin",
      "scoreMax",
      "revenueMin",
      "revenueMax",
      "issuesMin",
      "issuesMax",
      "status",
      "email",
      "category",
      "severity",
      "storesPage",
    ].forEach((key) => params.delete(key));

    setDomain("");
    setRankMin("");
    setRankMax("");
    setScoreMin("");
    setScoreMax("");
    setRevenueMin("");
    setRevenueMax("");
    setIssuesMin("");
    setIssuesMax("");
    setStatus("");
    setCategory("");
    setSeverity("");
    setEmail("");

    router.push(`?${params.toString()}`);
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Domain</label>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          />
        </div>

        <RangeFilter
          label="Rank"
          min={rankMin}
          max={rankMax}
          setMin={setRankMin}
          setMax={setRankMax}
        />

        <RangeFilter
          label="Score"
          min={scoreMin}
          max={scoreMax}
          setMin={setScoreMin}
          setMax={setScoreMax}
        />

        <RangeFilter
          label="Revenue"
          min={revenueMin}
          max={revenueMax}
          setMin={setRevenueMin}
          setMax={setRevenueMax}
          minPlaceholder="Min $"
          maxPlaceholder="Max $"
        />

        <RangeFilter
          label="Issues"
          min={issuesMin}
          max={issuesMax}
          setMin={setIssuesMin}
          setMax={setIssuesMax}
        />

        <div className="space-y-2">
          <label className="text-sm font-medium">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">All statuses</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Has issues</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">Any severity</option>
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                at least one {value.toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Email</label>
          <select
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          >
            <option value="">All email statuses</option>
            {emailStatuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={applyFilters}
          className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
        >
          Apply filters
        </button>

        <button
          type="button"
          onClick={resetFilters}
          className="border-input rounded-md border px-4 py-2 text-sm font-medium"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function RangeFilter({
                       label,
                       min,
                       max,
                       setMin,
                       setMax,
                       minPlaceholder = "Min",
                       maxPlaceholder = "Max",
                     }: {
  label: string;
  min: string;
  max: string;
  setMin: (value: string) => void;
  setMax: (value: string) => void;
  minPlaceholder?: string;
  maxPlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>

      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          value={min}
          onChange={(e) => setMin(e.target.value)}
          placeholder={minPlaceholder}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        />

        <input
          type="number"
          value={max}
          onChange={(e) => setMax(e.target.value)}
          placeholder={maxPlaceholder}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        />
      </div>
    </div>
  );
}
