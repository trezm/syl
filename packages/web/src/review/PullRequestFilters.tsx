import { useCallback, useState } from "react";
import type {
  PullRequestFilter,
  PullRequestInvolvement,
  PullRequestStateFilter,
} from "@syl/core";
import {
  DEFAULT_PULL_REQUEST_FILTER,
  PULL_REQUEST_INVOLVEMENTS,
  PULL_REQUEST_STATE_FILTERS,
  parsePullRequestFilter,
  pullRequestFilterQuery,
} from "@syl/core";

const FILTER_KEY = "syl-review-pr-filter";

const INVOLVEMENT_LABELS: Record<
  PullRequestInvolvement,
  { label: string; title: string }
> = {
  authored: { label: "Mine", title: "Pull requests you opened" },
  assigned: { label: "Assigned to me", title: "Pull requests assigned to you" },
  "review-requested": {
    label: "My review",
    title: "Review requested from you, or from a team you belong to",
  },
};

const STATE_LABELS: Record<PullRequestStateFilter, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  all: "Any state",
};

/**
 * The picker's filters, remembered between visits — which pull requests you
 * care about is a standing preference, not something to re-pick each review.
 * The stored form is the query string the server parses, so a value written by
 * an older build is read back through the same validation as a request.
 */
export function usePullRequestFilter() {
  const [filter, setFilter] = useState<PullRequestFilter>(() => {
    try {
      const stored = localStorage.getItem(FILTER_KEY);
      if (!stored) return DEFAULT_PULL_REQUEST_FILTER;
      const params = new URLSearchParams(stored);
      return parsePullRequestFilter({
        involvement: params.get("involvement"),
        state: params.get("state"),
      });
    } catch {
      return DEFAULT_PULL_REQUEST_FILTER;
    }
  });

  const updateFilter = useCallback((next: PullRequestFilter) => {
    setFilter(next);
    try {
      localStorage.setItem(FILTER_KEY, pullRequestFilterQuery(next));
    } catch {
      // ignore
    }
  }, []);

  return { filter, updateFilter };
}

export default function PullRequestFilters({
  filter,
  onChange,
  disabled,
}: {
  filter: PullRequestFilter;
  onChange: (filter: PullRequestFilter) => void;
  disabled?: boolean;
}) {
  const toggle = (involvement: PullRequestInvolvement) => {
    const selected = new Set(filter.involvement);
    if (!selected.delete(involvement)) selected.add(involvement);
    onChange({
      ...filter,
      // Rebuilt from the canonical order, so the stored value doesn't depend
      // on the order the chips were clicked in.
      involvement: PULL_REQUEST_INVOLVEMENTS.filter((i) => selected.has(i)),
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {PULL_REQUEST_INVOLVEMENTS.map((involvement) => {
        const on = filter.involvement.includes(involvement);
        return (
          <button
            key={involvement}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            title={INVOLVEMENT_LABELS[involvement].title}
            onClick={() => toggle(involvement)}
            className={`px-2 py-1 rounded border transition-colors disabled:opacity-40 ${
              on
                ? "border-blue-500/60 bg-blue-500/10 text-blue-200"
                : "border-gray-800 bg-gray-900/40 text-gray-500 hover:border-gray-700"
            }`}
          >
            {INVOLVEMENT_LABELS[involvement].label}
          </button>
        );
      })}

      <select
        value={filter.state}
        disabled={disabled}
        onChange={(e) =>
          onChange({
            ...filter,
            state: e.target.value as PullRequestStateFilter,
          })
        }
        title="Closed includes merged pull requests, as on GitHub."
        className="bg-gray-800 text-gray-300 text-xs border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-500 disabled:opacity-40"
      >
        {PULL_REQUEST_STATE_FILTERS.map((state) => (
          <option key={state} value={state}>
            {STATE_LABELS[state]}
          </option>
        ))}
      </select>

      {filter.involvement.length === 0 && (
        <span className="text-gray-600">Everyone's pull requests</span>
      )}
    </div>
  );
}
