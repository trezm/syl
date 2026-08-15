import { useMemo, useState, type ReactNode } from "react";
import type { ReviewRunSummary } from "@syl/core";
import {
  deleteReviewRun,
  clearReviewCache,
  type ReviewCacheInfo,
} from "../api";
import { timeAgo, formatWhen } from "./time";

/**
 * Every review this machine has run, read off syl's local cache. Opening one
 * costs nothing, which is the whole reason the cache exists — so this is a
 * list of things you already have, not of work to do.
 */
export default function CachedReviews({
  runs,
  cache,
  loading,
  error,
  onOpen,
  onChanged,
}: {
  runs: ReviewRunSummary[];
  cache: ReviewCacheInfo | null;
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  /** Re-reads the list after something is deleted. */
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return runs;
    return runs.filter((run) =>
      [run.repo, run.title ?? "", `#${run.number}`, run.reviewerModel]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [runs, query]);

  // Grouped by repository: this is one project's cache, but a project can have
  // several remotes, and a fork's reviews shouldn't interleave with the
  // upstream's.
  const groups = useMemo(() => {
    const byRepo = new Map<string, ReviewRunSummary[]>();
    for (const run of matches) {
      const list = byRepo.get(run.repo) ?? [];
      list.push(run);
      byRepo.set(run.repo, list);
    }
    return [...byRepo.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);

  const remove = async (id: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await deleteReviewRun(id);
      onChanged();
    } catch (e: any) {
      setActionError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const clearAll = async () => {
    setActionError(null);
    try {
      await clearReviewCache();
      setConfirmingClear(false);
      onChanged();
    } catch (e: any) {
      setActionError(e.message);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-gray-200">Cached reviews</h2>
        <span className="text-xs text-gray-600">
          {runs.length} on this machine
        </span>
        {runs.length > 0 && (
          <input
            className="ml-auto w-56 bg-gray-900 text-gray-200 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
            placeholder="Filter by repo, title or number…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>
      <p className="text-sm text-gray-500 mt-1">
        Every review syl has run here, with its diff, findings and staged
        comments. Opening one reads from disk — no GitHub call, no model call.
      </p>

      {error && (
        <div className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}
      {actionError && (
        <div className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {actionError}
        </div>
      )}

      {cache && !cache.available && (
        <div className="mt-4 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
          This server has no <span className="font-mono">node:sqlite</span>{" "}
          (Node 22.5+ required), so reviews are only held in memory and are lost
          when it restarts.
        </div>
      )}

      {loading && runs.length === 0 ? (
        <div className="mt-8 text-sm text-gray-500">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="mt-8 text-sm text-gray-500">
          Nothing cached yet. Run a review and it lands here.
        </div>
      ) : matches.length === 0 ? (
        <div className="mt-8 text-sm text-gray-500">
          No cached review matches “{query}”.
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {groups.map(([repo, rows]) => (
            <section key={repo}>
              <h3 className="text-xs font-mono text-gray-500 mb-2">
                {repo}
                <span className="ml-2 text-gray-700">
                  {rows.length} review{rows.length === 1 ? "" : "s"}
                </span>
              </h3>
              <ul className="border border-gray-800 rounded divide-y divide-gray-800 overflow-hidden">
                {rows.map((run) => (
                  <li
                    key={run.id}
                    className="group flex items-start hover:bg-gray-800/40"
                  >
                    <button
                      className="flex-1 text-left px-3 py-2 min-w-0"
                      onClick={() => onOpen(run.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 font-mono text-sm">
                          #{run.number}
                        </span>
                        <span className="text-gray-200 text-sm truncate">
                          {run.title ?? "(title not recorded)"}
                        </span>
                        {run.phase === "failed" ? (
                          <Badge tone="red" title={run.error ?? undefined}>
                            failed
                          </Badge>
                        ) : run.phase !== "done" ? (
                          <Badge tone="blue">{run.phase}</Badge>
                        ) : null}
                        {run.stale && (
                          <Badge
                            tone="amber"
                            title="The pull request has changed since these findings were written."
                          >
                            stale
                          </Badge>
                        )}
                        {run.reused && (
                          <Badge
                            tone="gray"
                            title="This run reused an earlier review instead of calling the models."
                          >
                            cached
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-3 text-[11px] text-gray-600 flex-wrap">
                        <span title={formatWhen(run.startedAt)}>
                          {timeAgo(run.startedAt)}
                        </span>
                        {run.phase === "done" && (
                          <span>
                            {run.findingCount} finding
                            {run.findingCount === 1 ? "" : "s"}
                          </span>
                        )}
                        {run.pendingComments > 0 && (
                          <span className="text-amber-300/80">
                            {run.pendingComments} unsubmitted comment
                            {run.pendingComments === 1 ? "" : "s"}
                            {run.outdatedComments > 0 &&
                              ` (${run.outdatedComments} outdated)`}
                          </span>
                        )}
                        {run.submissionCount > 0 && (
                          <span className="text-emerald-300/70">
                            posted to GitHub
                          </span>
                        )}
                        {run.refreshedAt && (
                          <span title={formatWhen(run.refreshedAt)}>
                            refreshed {timeAgo(run.refreshedAt)}
                          </span>
                        )}
                        <span className="font-mono text-gray-700 truncate">
                          {run.reviewerModel}
                        </span>
                      </div>
                    </button>
                    <button
                      className="px-3 py-2 text-[11px] text-gray-700 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40"
                      title="Forget this review — its findings, diff and staged comments go with it"
                      disabled={busyId === run.id}
                      onClick={() => remove(run.id)}
                    >
                      {busyId === run.id ? "…" : "Delete"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {cache?.available && (
        <div className="mt-8 border-t border-gray-800 pt-3 text-[11px] text-gray-600 flex items-center gap-3 flex-wrap">
          <span className="font-mono truncate">{cache.path}</span>
          <span>{formatSize(cache.sizeBytes)}</span>
          <span>
            keeps the {cache.maxRuns} most recent; older ones are dropped
          </span>
          {cache.count > 0 &&
            (confirmingClear ? (
              <span className="ml-auto flex items-center gap-2">
                <span className="text-amber-300">
                  Delete all {cache.count}? Staged comments go too.
                </span>
                <button
                  className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                  onClick={clearAll}
                >
                  Delete
                </button>
                <button
                  className="hover:text-gray-300"
                  onClick={() => setConfirmingClear(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="ml-auto hover:text-red-300"
                onClick={() => setConfirmingClear(true)}
              >
                Clear cache
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

const TONE = {
  red: "border-red-500/40 bg-red-500/10 text-red-300",
  blue: "border-blue-500/40 bg-blue-500/10 text-blue-300",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  gray: "border-gray-600 bg-gray-800/60 text-gray-400",
};

function Badge({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONE;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${TONE[tone]}`}
      title={title}
    >
      {children}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
