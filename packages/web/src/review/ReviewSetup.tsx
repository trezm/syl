import { useEffect, useState } from "react";
import type {
  GitRemote,
  PullRequestSummary,
  ReviewRunSummary,
} from "@syl/core";
import {
  fetchRemotes,
  fetchPullRequests,
  fetchReviewRuns,
  checkGenerateStatus,
} from "../api";
import ModelSelector, {
  useSelectedModel,
  type AvailableModel,
} from "../components/ModelSelector";

interface ReviewSetupProps {
  onStart: (params: {
    remote: string;
    repo: string;
    number: number;
    refresh: boolean;
    scoutModel?: string;
    reviewerModel?: string;
  }) => void;
  /** Reopens a past run straight from the cache, without touching GitHub. */
  onOpenRun: (id: string) => void;
  busy: boolean;
}

const SCOUT_KEY = "syl-review-scout-model";
const REVIEWER_KEY = "syl-review-reviewer-model";

const STATE_STYLE: Record<string, string> = {
  OPEN: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  MERGED: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  CLOSED: "bg-gray-500/15 text-gray-400 border-gray-500/40",
};

/**
 * Who the pull request is waiting on, short enough to sit on one row. Two
 * names is the common case; beyond that the row keeps its shape and the rest
 * are counted, with the full list on hover.
 */
function requestedReviewers(reviewers: string[]): string {
  if (reviewers.length <= 2) return reviewers.map((r) => `@${r}`).join(", ");
  return `@${reviewers[0]}, @${reviewers[1]} +${reviewers.length - 2}`;
}

/** Compact relative age — past reviews are usually hours or days old. */
function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function ReviewSetup({
  onStart,
  onOpenRun,
  busy,
}: ReviewSetupProps) {
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [remote, setRemote] = useState<GitRemote | null>(null);
  const [prs, setPrs] = useState<PullRequestSummary[]>([]);
  const [prsLoading, setPrsLoading] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [refresh, setRefresh] = useState(false);
  const [past, setPast] = useState<ReviewRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The two passes are chosen independently, so each remembers its own model —
  // and neither is the annotation model, which is a different kind of job.
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [defaults, setDefaults] = useState<{
    scout: string | null;
    reviewer: string | null;
  }>({ scout: null, reviewer: null });
  const scout = useSelectedModel(models, defaults.scout, SCOUT_KEY);
  const reviewer = useSelectedModel(models, defaults.reviewer, REVIEWER_KEY);

  // Past runs come from the server's cache, so they outlive a restart.
  useEffect(() => {
    fetchReviewRuns()
      .then(setPast)
      .catch(() => setPast([]));
  }, []);

  useEffect(() => {
    fetchRemotes()
      .then(({ remotes, defaults }) => {
        setRemotes(remotes);
        // One remote is the common case — preselect it but still show it.
        const usable = remotes.filter((r) => r.repo);
        if (usable.length === 1) setRemote(usable[0]);
        setDefaults(defaults);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Same list the annotate tab uses: every model syl knows about, flagged with
  // whether a CLI or an API key can actually run it.
  useEffect(() => {
    checkGenerateStatus()
      .then((s) => setModels(s.models ?? []))
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (!remote?.repo) {
      setPrs([]);
      return;
    }
    let cancelled = false;
    setPrsLoading(true);
    setPrError(null);
    fetchPullRequests(remote.repo)
      .then((list) => {
        if (!cancelled) setPrs(list);
      })
      .catch((e) => {
        if (!cancelled) setPrError(e.message);
      })
      .finally(() => {
        if (!cancelled) setPrsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [remote]);

  const submit = () => {
    if (!remote?.repo) return;
    const parsed = parseInt(number, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError("Enter a pull request number.");
      return;
    }
    setError(null);
    onStart({
      remote: remote.name,
      repo: remote.repo,
      number: parsed,
      refresh,
      // Omitted rather than nulled when nothing is runnable, so the server
      // still gets to report which model is missing.
      scoutModel: scout.model ?? undefined,
      reviewerModel: reviewer.model ?? undefined,
    });
  };

  return (
    <div className="max-w-2xl mx-auto py-10 px-6">
      <h2 className="text-lg font-semibold text-gray-200">Review a pull request</h2>
      <p className="text-sm text-gray-500 mt-1">
        A cheap scout model triages the diff, then a stronger reviewer produces
        findings.
      </p>

      {/* Which model runs each pass. Sits with the description of the two
          passes rather than in the numbered steps: it carries over between
          reviews, so it isn't something you set every time. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border border-gray-800 rounded px-3 py-2 bg-gray-900/40">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Scout
          <ModelSelector
            models={models}
            model={scout.model}
            onSelect={scout.selectModel}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-500">
          Reviewer
          <ModelSelector
            models={models}
            model={reviewer.model}
            onSelect={reviewer.selectModel}
          />
        </label>
        <span className="text-xs text-gray-600">
          <span className="font-mono">cli</span> runs on your Claude or Codex
          subscription; <span className="font-mono">api</span> bills per token.
        </span>
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Past reviews — cached on disk, so they open without a model call.
          Above the form on purpose: this is the landing page the review's back
          button returns to, and picking up an earlier review is the likelier
          intent there. Capped in height so the form stays reachable. */}
      {past.length > 0 && (
        <section className="mt-8">
          <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            Past reviews
          </h3>
          <ul className="border border-gray-800 rounded divide-y divide-gray-800 overflow-hidden overflow-y-auto max-h-64">
            {past.map((run) => (
              <li key={run.id}>
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-800/60 flex items-center gap-2"
                  onClick={() => onOpenRun(run.id)}
                >
                  <span className="text-gray-500 font-mono">#{run.number}</span>
                  <span className="text-gray-200 truncate flex-1">
                    {run.title ?? run.repo}
                  </span>
                  {run.phase === "failed" ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-300">
                      failed
                    </span>
                  ) : run.phase === "done" ? (
                    <span className="text-xs text-gray-500">
                      {run.findingCount} finding
                      {run.findingCount === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300">
                      {run.phase}
                    </span>
                  )}
                  <span className="text-gray-600 text-xs w-16 text-right">
                    {timeAgo(run.startedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-600">
            Opening one costs nothing — it's read from syl's local cache.
          </p>
        </section>
      )}

      {/* Step 1 — remote */}
      <section className="mt-8">
        <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
          1 · Remote
        </h3>
        {remotes.length === 0 ? (
          <div className="text-sm text-gray-500">No git remotes found.</div>
        ) : (
          <div className="space-y-1">
            {remotes.map((r) => (
              <button
                key={r.name}
                disabled={!r.repo}
                onClick={() => setRemote(r)}
                className={`w-full text-left px-3 py-2 rounded border text-sm transition-colors ${
                  remote?.name === r.name
                    ? "border-blue-500/60 bg-blue-500/10"
                    : "border-gray-800 hover:border-gray-700 bg-gray-900/40"
                } ${!r.repo ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span className="font-mono text-gray-200">{r.name}</span>
                <span className="ml-2 text-gray-500">
                  {r.repo ?? "not a recognisable GitHub remote"}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Step 2 — PR */}
      <section className="mt-8">
        <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
          2 · Pull request
        </h3>

        <div className="flex gap-2 items-center">
          <span className="text-gray-500 text-sm">#</span>
          <input
            className="w-28 bg-gray-900 text-gray-200 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
            placeholder="number"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            disabled={!remote?.repo}
          />
          <button
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white"
            onClick={submit}
            disabled={!remote?.repo || !number || busy}
          >
            {busy ? "Starting…" : "Start review"}
          </button>
          <label
            className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none"
            title="Reviewing the same commits with the same models normally reuses the stored result instead of calling the models again."
          >
            <input
              type="checkbox"
              className="accent-blue-500"
              checked={refresh}
              onChange={(e) => setRefresh(e.target.checked)}
            />
            Ignore cached result
          </label>
        </div>

        {remote?.repo && (
          <div className="mt-4">
            {prsLoading && (
              <div className="text-sm text-gray-500">Loading pull requests…</div>
            )}
            {prError && (
              <div className="text-sm text-amber-300">
                {prError} — you can still enter a number above.
              </div>
            )}
            {!prsLoading && !prError && prs.length > 0 && (
              <ul className="border border-gray-800 rounded divide-y divide-gray-800 overflow-hidden">
                {prs.map((pr) => (
                  <li key={pr.number}>
                    <button
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-800/60 flex items-center gap-2 ${
                        String(pr.number) === number ? "bg-blue-500/10" : ""
                      }`}
                      onClick={() => setNumber(String(pr.number))}
                    >
                      <span className="text-gray-500 font-mono">#{pr.number}</span>
                      <span className="text-gray-200 truncate flex-1">
                        {pr.title}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${
                          STATE_STYLE[pr.state] ?? STATE_STYLE.CLOSED
                        }`}
                      >
                        {pr.state.toLowerCase()}
                      </span>
                      <span className="text-gray-600 text-xs">@{pr.author}</span>
                      {/* Who GitHub is still waiting on. Kept last and dimmed
                          — it's a reason to pick a pull request, not part of
                          identifying one. */}
                      {pr.reviewers.length > 0 && (
                        <span
                          className="text-xs text-gray-500 whitespace-nowrap"
                          title={`Review requested from ${pr.reviewers
                            .map((r) => `@${r}`)
                            .join(", ")}`}
                        >
                          <span className="text-gray-700">→ </span>
                          {requestedReviewers(pr.reviewers)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!prsLoading && !prError && prs.length === 0 && (
              <div className="text-sm text-gray-500">
                No pull requests listed — enter a number above.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
