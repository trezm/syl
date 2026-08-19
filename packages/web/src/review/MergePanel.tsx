import { useCallback, useEffect, useState } from "react";
import {
  MERGE_METHODS,
  mergeBlockReason,
  mergeMethodLabel,
  mergeWarning,
  type MergeMethod,
  type PullRequestMergeStatus,
  type ReviewRun,
} from "@syl/core";
import { fetchMergeStatus, mergePullRequest } from "../api";
import { formatWhen } from "./time";

/** What the confirmation asks, in the same terms GitHub's own buttons use. */
function confirmQuestion(
  status: PullRequestMergeStatus,
  method: MergeMethod,
  repo: string,
  number: number
): string {
  const commits = `${status.commits} commit${status.commits === 1 ? "" : "s"}`;
  const branches = `${status.head} into ${status.base}`;
  return method === "squash"
    ? `Squash ${commits} from ${branches} as a single commit on ${repo} #${number}?`
    : `Merge ${commits} from ${branches} on ${repo} #${number}, keeping every commit?`;
}

/**
 * The merge bar: GitHub's two buttons, in the place you've just finished
 * reading the diff.
 *
 * Merging is the one action here that changes the repository rather than
 * commenting on it, so nothing happens on the first press — the button asks
 * first, naming the branches, the commit count and the pull request it is
 * about to merge. The state behind it comes from GitHub each time this panel
 * loads, and again at the moment the merge is sent, so a button that has been
 * sitting on screen can't act on an answer that has since changed.
 */
export default function MergePanel({
  run,
  onMerged,
}: {
  run: ReviewRun;
  /** Reloads the run, so the header catches up with what the merge did. */
  onMerged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<PullRequestMergeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchMergeStatus(run.id));
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [run.id]);

  // Re-read when the run's head commit moves: a **Refresh** in the header that
  // pulls in new commits has also changed the answer to every question here.
  useEffect(() => {
    void load();
  }, [load, run.meta?.headSha]);

  const merge = async (method: MergeMethod) => {
    if (!status) return;
    setBusy(true);
    setMergeError(null);
    try {
      const result = await mergePullRequest(run.id, {
        method,
        headSha: status.headSha,
      });
      setConfirming(null);
      setNote(
        `${mergeMethodLabel(method)} done${
          result.sha ? ` — ${result.sha.slice(0, 7)}` : ""
        }.`
      );
      await onMerged();
      await load();
    } catch (e: any) {
      setMergeError(e.message);
      // The failure may be the state having moved under the button, so the
      // next press is offered against what GitHub says now.
      await load();
    } finally {
      setBusy(false);
    }
  };

  const warning = status ? mergeWarning(status) : null;
  const merged = status?.state === "MERGED";

  return (
    <div className="border-t border-gray-800 bg-gray-950 px-4 py-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-300">Merge</span>

        {loading && !status ? (
          <span className="text-[11px] text-gray-500">
            Checking with GitHub…
          </span>
        ) : loadError ? (
          <>
            <span className="text-[11px] text-red-300">{loadError}</span>
            <button
              className="text-[11px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
              onClick={() => void load()}
            >
              Try again
            </button>
          </>
        ) : status ? (
          <>
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] border ${
                merged
                  ? "bg-violet-500/15 text-violet-300 border-violet-500/40"
                  : status.state === "CLOSED"
                    ? "bg-gray-800 text-gray-400 border-gray-700"
                    : status.mergeable === "conflicting"
                      ? "bg-red-500/10 text-red-300 border-red-500/40"
                      : "bg-emerald-500/10 text-emerald-300 border-emerald-500/40"
              }`}
            >
              {merged
                ? "merged"
                : status.state === "CLOSED"
                  ? "closed"
                  : status.mergeable === "conflicting"
                    ? "conflicts"
                    : status.mergeable === "unknown"
                      ? "checking"
                      : "mergeable"}
            </span>

            <span className="text-[11px] text-gray-500">
              {merged ? (
                <>
                  {status.head} is merged into {status.base}
                  {run.merged &&
                    ` — ${mergeMethodLabel(run.merged.method).toLowerCase()} from syl at ${formatWhen(
                      run.merged.mergedAt
                    )}`}
                </>
              ) : status.state === "CLOSED" ? (
                <>Closed without merging.</>
              ) : (
                <>
                  {status.commits} commit{status.commits === 1 ? "" : "s"} from{" "}
                  <span className="font-mono text-gray-400">{status.head}</span>{" "}
                  into{" "}
                  <span className="font-mono text-gray-400">{status.base}</span>
                </>
              )}
            </span>

            <button
              className="text-[11px] text-gray-500 hover:text-gray-300 disabled:opacity-40"
              title="Ask GitHub for this pull request's state again"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? "checking…" : "recheck"}
            </button>

            {status.state === "OPEN" && (
              <div className="ml-auto flex items-center gap-2">
                {confirming ? (
                  <>
                    <span className="text-[11px] text-amber-300">
                      {confirmQuestion(
                        status,
                        confirming,
                        run.repo,
                        run.number
                      )}
                    </span>
                    <button
                      className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40 disabled:hover:bg-violet-600"
                      disabled={busy}
                      onClick={() => void merge(confirming)}
                    >
                      {busy
                        ? "Merging…"
                        : `Yes, ${mergeMethodLabel(confirming).toLowerCase()}`}
                    </button>
                  </>
                ) : (
                  MERGE_METHODS.map((option) => {
                    const blocked = mergeBlockReason(status, option.value);
                    return (
                      <button
                        key={option.value}
                        className={`text-xs px-2 py-1 rounded border disabled:opacity-40 ${
                          option.value === "squash"
                            ? "border-violet-500/50 text-violet-200 hover:bg-violet-500/10"
                            : "border-gray-700 text-gray-300 hover:bg-gray-800"
                        }`}
                        title={blocked ?? option.hint}
                        disabled={blocked !== null || busy}
                        onClick={() => {
                          setMergeError(null);
                          setNote(null);
                          setConfirming(option.value);
                        }}
                      >
                        {option.label}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Everything GitHub might still refuse over. Said rather than enforced:
          whether a protected branch stops this merge depends on the rules and
          on who is pressing the button. */}
      {status?.state === "OPEN" && warning && (
        <div className="mt-1.5 text-[11px] text-amber-300">{warning}</div>
      )}
      {status?.state === "OPEN" &&
        status.mergeable === "conflicting" &&
        !warning && (
          <div className="mt-1.5 text-[11px] text-red-300">
            {mergeBlockReason(status, "squash")}
          </div>
        )}
      {confirming && (
        <p className="mt-1.5 text-[11px] text-gray-600">
          This merges on GitHub as your authenticated <code>gh</code> user and
          cannot be undone from Syl.
        </p>
      )}
      {note && <div className="mt-1.5 text-[11px] text-emerald-300">{note}</div>}
      {mergeError && (
        <div className="mt-1.5 text-[11px] text-red-300 whitespace-pre-wrap">
          {mergeError}
        </div>
      )}
    </div>
  );
}
