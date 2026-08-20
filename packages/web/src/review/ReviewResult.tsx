import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseUnifiedDiff,
  diffTotals,
  sortFindings,
  diffCommentTargets,
  anchorForFinding,
  findingToCommentBody,
  isReviewStale,
  type LinkTarget,
  type ReviewRun,
  type Finding,
} from "@syl/core";
import DiffView, {
  findingDomId,
  type DiffViewMode,
  type CommentHandlers,
  type GenerateOriginal,
} from "./DiffView";
import type { FindingAnchorState } from "./FindingCard";
import SubmitReviewPanel from "./SubmitReviewPanel";
import MergePanel from "./MergePanel";
import ReplayView from "./ReplayView";
import SessionPanel, { useChannelSessions } from "./SessionPanel";
import { useDiffAnnotations } from "./useDiffAnnotations";
import {
  useSelectedModel,
  type AvailableModel,
} from "../components/ModelSelector";
import {
  addReviewComment,
  updateReviewComment,
  deleteReviewComment,
  submitReview,
  checkGenerateStatus,
  generateOriginalAnnotations,
  refreshReviewRun,
  discardOutdatedComments,
} from "../api";
import { SEVERITY_STYLE, SEVERITY_DOT, RISK_STYLE } from "./severity";
import { formatWhen } from "./time";

const VIEW_MODE_KEY = "syl-diff-view-mode";
const NOTES_COLLAPSED_KEY = "syl-diff-notes-collapsed";

export default function ReviewResult({
  run,
  onBack,
  onRerun,
  onNavigate,
  onRefresh,
}: {
  run: ReviewRun;
  /** Leaves this run for the setup page, which lists past reviews. */
  onBack: () => void;
  /** Reviews this PR again, ignoring the cached result. */
  onRerun: () => void;
  onNavigate?: (target: LinkTarget) => void;
  onRefresh: () => Promise<void>;
}) {
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);
  const [showScout, setShowScout] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** What the last refresh did, or why it couldn't. Cleared by the next one. */
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const { sessions, setup } = useChannelSessions();
  const [viewMode, setViewMode] = useState<DiffViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "split"
        ? "split"
        : "unified";
    } catch {
      return "unified";
    }
  });

  const [notesCollapsed, setNotesCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NOTES_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const chooseViewMode = (mode: DiffViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // ignore
    }
  };

  const toggleNotes = () => {
    const next = !notesCollapsed;
    setNotesCollapsed(next);
    try {
      localStorage.setItem(NOTES_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // ignore
    }
  };

  const files = useMemo(
    () => (run.diff ? parseUnifiedDiff(run.diff) : []),
    [run.diff]
  );
  const totals = useMemo(() => diffTotals(files), [files]);
  const findings = useMemo(
    () => sortFindings(run.review?.findings ?? []),
    [run.review]
  );
  // Bumped after a generation run, so its annotations appear in the diff.
  const [annotationNonce, setAnnotationNonce] = useState(0);
  const annotationData = useDiffAnnotations(files, annotationNonce);
  const annotationCount = useMemo(
    () =>
      Object.values(annotationData.byFile).reduce(
        (total, entries) => total + entries.length,
        0
      ),
    [annotationData]
  );

  // The review tab has no model picker of its own; it follows whatever the
  // annotate tab is set to, which is where the picker lives.
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    checkGenerateStatus()
      .then((status) => {
        setModels(status.models ?? []);
        setDefaultModel(status.defaultModel ?? null);
      })
      .catch(() => {});
  }, []);
  const { model } = useSelectedModel(models, defaultModel);

  const generateOriginal: GenerateOriginal | undefined = useMemo(() => {
    if (!model) return undefined;
    return {
      modelLabel: models.find((m) => m.id === model)?.label ?? model,
      run: async (file) => {
        const { count } = await generateOriginalAnnotations(
          run.id,
          file.path,
          model
        );
        setAnnotationNonce((n) => n + 1);
        // The button has nowhere to report success, so an empty run — which
        // looks identical to a failure — is surfaced as the error it may be.
        if (count === 0) {
          throw new Error("The model returned no annotations.");
        }
      },
    };
  }, [model, models, run.id]);

  const commentTargets = useMemo(() => diffCommentTargets(files), [files]);

  /**
   * The finding the user last jumped to — what the channel panel offers to send.
   * Its index travels too: the push endpoint addresses findings by position in
   * this same sorted list rather than trusting the browser to send one back.
   */
  const activeFindingIndex = useMemo(() => {
    const index = findings.findIndex(
      (finding, i) => findingDomId(finding, i) === activeFindingId
    );
    return index === -1 ? null : index;
  }, [findings, activeFindingId]);
  const activeFinding =
    activeFindingIndex === null ? null : findings[activeFindingIndex];

  // A finding is "staged" when a comment already exists at its anchor, so the
  // same finding can't be queued twice.
  const findingAnchorState = useCallback(
    (finding: Finding): FindingAnchorState => {
      const anchor = anchorForFinding(commentTargets, finding);
      if (!anchor) return "unanchored";
      const staged = run.comments.some(
        (c) =>
          c.path === anchor.path &&
          c.line === anchor.line &&
          c.side === anchor.side &&
          c.fromFinding === finding.title
      );
      return staged ? "staged" : "ready";
    },
    [commentTargets, run.comments]
  );

  const commentHandlers: CommentHandlers = {
    comments: run.comments,
    findingAnchorState,
    onAddComment: async (input) => {
      await addReviewComment(run.id, input);
      await onRefresh();
    },
    onEditComment: async (id, body) => {
      await updateReviewComment(run.id, id, body);
      await onRefresh();
    },
    onDeleteComment: async (id) => {
      await deleteReviewComment(run.id, id);
      await onRefresh();
    },
    onAddFinding: async (finding) => {
      const anchor = anchorForFinding(commentTargets, finding);
      if (!anchor) throw new Error("This finding isn't on a line in the diff.");
      await addReviewComment(run.id, {
        ...anchor,
        body: findingToCommentBody(finding),
        fromFinding: finding.title,
      });
      await onRefresh();
    },
  };

  const readyFindings = useMemo(
    () => findings.filter((f) => findingAnchorState(f) === "ready"),
    [findings, findingAnchorState]
  );

  const [addingAll, setAddingAll] = useState(false);
  const [addAllError, setAddAllError] = useState<string | null>(null);

  const addAll = async () => {
    setAddingAll(true);
    setAddAllError(null);
    try {
      // Sequential on purpose: the run's comment list is mutated server-side,
      // and concurrent posts would race on it.
      for (const finding of readyFindings) {
        const anchor = anchorForFinding(commentTargets, finding);
        if (!anchor) continue;
        await addReviewComment(run.id, {
          ...anchor,
          body: findingToCommentBody(finding),
          fromFinding: finding.title,
        });
      }
      await onRefresh();
    } catch (e: any) {
      setAddAllError(e.message);
      await onRefresh();
    } finally {
      setAddingAll(false);
    }
  };

  /**
   * Catches the run up with GitHub without re-reviewing: the diff, the title
   * and the branches come back current, and anything the new diff strands is
   * marked rather than quietly left to fail at submission.
   */
  const doRefresh = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    setRefreshError(null);
    try {
      const result = await refreshReviewRun(run.id);
      await onRefresh();
      if (!result.changed) {
        setRefreshNote("Already up to date with GitHub.");
      } else if (result.adopted) {
        setRefreshNote(
          "Pulled in the latest commits — a review of them was already cached, so the findings are current too."
        );
      } else {
        setRefreshNote(
          `Pulled in the latest commits.${
            result.outdated > 0
              ? ` ${result.outdated} staged comment${
                  result.outdated === 1 ? "" : "s"
                } no longer land${result.outdated === 1 ? "s" : ""} on the diff.`
              : ""
          }`
        );
      }
    } catch (e: any) {
      setRefreshError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  const stale = isReviewStale(run);

  const diffPaneRef = useRef<HTMLElement>(null);

  // A big PR makes for a very tall scroll container, and `scrollIntoView` with
  // smooth behaviour doesn't reliably traverse tens of thousands of pixels.
  // Compute the offset against the pane and jump straight there.
  //
  // Done synchronously rather than in requestAnimationFrame: every finding is
  // already in the DOM (only the highlight depends on state), and rAF never
  // fires in a backgrounded tab, which would silently drop the jump.
  const jumpTo = (index: number) => {
    const id = findingDomId(findings[index], index);
    setActiveFindingId(id);
    const pane = diffPaneRef.current;
    const el = document.getElementById(id);
    if (!pane || !el) return;
    const offset =
      el.getBoundingClientRect().top -
      pane.getBoundingClientRect().top +
      pane.scrollTop;
    pane.scrollTo({ top: Math.max(0, offset - pane.clientHeight / 3) });
  };

  const meta = run.meta;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* PR header */}
      <div className="border-b border-gray-800 px-5 py-3 bg-gray-950">
        <div className="flex items-baseline gap-2 flex-wrap">
          <button
            className="self-center flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800"
            title="Back to the review list and your past reviews"
            onClick={onBack}
          >
            <span aria-hidden="true">←</span> Reviews
          </button>
          <h2 className="text-base text-gray-100 font-medium">
            {meta?.title ?? `Pull request #${run.number}`}
          </h2>
          <span className="text-gray-500 font-mono text-sm">#{run.number}</span>
          {meta && (
            <a
              className="text-xs text-blue-400 hover:underline"
              href={meta.url}
              target="_blank"
              rel="noreferrer"
            >
              view on GitHub ↗
            </a>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              className={`text-xs px-2 py-1 rounded border disabled:opacity-40 ${
                stale
                  ? "border-amber-500/50 text-amber-300 hover:bg-amber-500/10"
                  : "border-gray-700 text-gray-300 hover:bg-gray-800"
              }`}
              title="Fetch this pull request again — new commits, a new title — and mark anything that no longer lines up. Doesn't call the models."
              disabled={refreshing}
              onClick={doRefresh}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button
              className={`text-xs px-2 py-1 rounded border ${
                replayOpen
                  ? "border-blue-500/60 bg-blue-500/10 text-blue-200"
                  : "border-gray-700 text-gray-300 hover:bg-gray-800"
              }`}
              title="Watch the diff land as small narrated steps — a quick model's reconstruction of how the work might have gone"
              aria-pressed={replayOpen}
              onClick={() => setReplayOpen((o) => !o)}
            >
              Replay
            </button>
            {!sessionPanelOpen && (
              <button
                className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 flex items-center gap-1.5"
                title="Hand a finding or a question to a running Claude Code session"
                onClick={() => setSessionPanelOpen(true)}
              >
                {sessions.length > 0 && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-400"
                    aria-hidden="true"
                  />
                )}
                Send to session
              </button>
            )}
            <div className="flex items-center rounded border border-gray-700 overflow-hidden">
              {(
                [
                  ["unified", "Unified"],
                  ["split", "Split"],
                ] as [DiffViewMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`text-xs px-2 py-1 ${
                    viewMode === mode
                      ? "bg-gray-800 text-gray-100"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                  onClick={() => chooseViewMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-1 text-xs text-gray-500 flex items-center gap-3 flex-wrap">
          <span className="font-mono">{run.repo}</span>
          {meta && (
            <span>
              @{meta.author} wants to merge{" "}
              <span className="font-mono text-gray-400">{meta.head}</span> into{" "}
              <span className="font-mono text-gray-400">{meta.base}</span>
            </span>
          )}
          <span>
            {files.length} file{files.length === 1 ? "" : "s"}{" "}
            <span className="text-emerald-400">+{totals.additions}</span>{" "}
            <span className="text-red-400">−{totals.deletions}</span>
          </span>
          {annotationCount > 0 && (
            <button
              className="text-violet-300/80 hover:text-violet-200"
              title={
                notesCollapsed
                  ? "Expand every syl annotation in this diff"
                  : "Collapse every syl annotation in this diff"
              }
              aria-expanded={!notesCollapsed}
              onClick={toggleNotes}
            >
              {notesCollapsed ? "▸" : "▾"} {annotationCount} syl annotation
              {annotationCount === 1 ? "" : "s"} on these files
            </button>
          )}
          <span className="text-gray-600">
            scout {run.scoutModel}
            {run.scoutBackend && ` (${run.scoutBackend})`} · reviewer{" "}
            {run.reviewerModel}
            {run.reviewerBackend && ` (${run.reviewerBackend})`}
          </span>
          {run.refreshedAt && (
            <span title={`Last checked against GitHub at ${formatWhen(run.refreshedAt)}`}>
              refreshed {formatWhen(run.refreshedAt)}
            </span>
          )}
          {run.reusedFrom && (
            <span className="flex items-center gap-1.5 text-gray-400">
              <span
                className="text-[10px] px-1.5 py-0.5 rounded border border-gray-600 bg-gray-800/60"
                title="The diff, the pull request and the models were unchanged, so syl reused the stored findings instead of calling the models again."
              >
                cached
              </span>
              <span>from {formatWhen(run.reusedFrom.startedAt)}</span>
              <button
                className="text-blue-400 hover:underline"
                onClick={onRerun}
              >
                re-run
              </button>
            </span>
          )}
        </div>
        {run.diffTruncated && (
          <div className="mt-2 text-xs text-amber-300">
            The diff was too large to send in full — the models saw a truncated
            version, so coverage may be incomplete.
          </div>
        )}
        {/* The diff below is the pull request as it stands; the findings are
            from before it moved. Saying which is which is the whole job here. */}
        {stale && (
          <div className="mt-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 flex items-center gap-2 flex-wrap">
            <span>
              This pull request has changed since it was reviewed. The diff is
              current; the findings were written against the earlier version and
              may point at code that has moved or gone.
            </span>
            <button className="underline hover:text-amber-200" onClick={onRerun}>
              Review it again
            </button>
          </div>
        )}
        {refreshNote && (
          <div className="mt-2 text-xs text-gray-400">{refreshNote}</div>
        )}
        {refreshError && (
          <div className="mt-2 text-xs text-red-300 whitespace-pre-wrap">
            {refreshError}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex">
        {replayOpen ? (
          <ReplayView
            run={run}
            files={files}
            models={models}
            onRefresh={onRefresh}
            comments={run.comments}
            onAddComment={commentHandlers.onAddComment}
            onEditComment={commentHandlers.onEditComment}
            onDeleteComment={commentHandlers.onDeleteComment}
          />
        ) : (
          <>
        {/* Findings sidebar */}
        <aside className="w-80 flex-shrink-0 border-r border-gray-800 overflow-y-auto bg-gray-950">
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Review summary
            </div>
            <p className="mt-2 text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
              {run.review?.summary || "No summary returned."}
            </p>
          </div>

          {run.scout && (
            <div className="px-4 py-3 border-b border-gray-800">
              <button
                className="text-xs uppercase tracking-wide text-gray-500 hover:text-gray-300 flex items-center gap-1"
                onClick={() => setShowScout((s) => !s)}
              >
                <span>{showScout ? "▾" : "▸"}</span> Scout triage
              </button>
              {showScout && (
                <div className="mt-2 space-y-2">
                  <p className="text-xs text-gray-400 leading-relaxed">
                    {run.scout.intent}
                  </p>
                  {run.scout.focus_areas.map((area, i) => (
                    <div key={i} className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-[10px] px-1 py-0.5 rounded border ${
                            RISK_STYLE[area.risk] ?? RISK_STYLE.low
                          }`}
                        >
                          {area.risk}
                        </span>
                        <span className="font-mono text-gray-400 truncate">
                          {area.file}
                        </span>
                      </div>
                      <p className="text-gray-500 mt-0.5">{area.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="px-4 py-2 text-xs uppercase tracking-wide text-gray-500 border-b border-gray-800 flex items-center gap-2">
            <span>
              {findings.length} finding{findings.length === 1 ? "" : "s"}
            </span>
            {readyFindings.length > 0 && (
              <button
                className="ml-auto normal-case text-[10px] px-1.5 py-0.5 rounded border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 disabled:opacity-40"
                disabled={addingAll}
                title="Stage a comment for every finding that lands on a diff line"
                onClick={addAll}
              >
                {addingAll ? "Adding…" : `Add ${readyFindings.length} to review`}
              </button>
            )}
          </div>
          {addAllError && (
            <div className="px-4 py-2 text-[11px] text-red-300">{addAllError}</div>
          )}

          {findings.length === 0 ? (
            <div className="px-4 py-6 text-sm text-gray-500">
              No findings — the reviewer had nothing high-confidence to report.
            </div>
          ) : (
            <ul className="divide-y divide-gray-800/70">
              {findings.map((finding, index) => {
                const id = findingDomId(finding, index);
                return (
                  <li key={id}>
                    <button
                      className={`w-full text-left px-4 py-2.5 hover:bg-gray-900 ${
                        activeFindingId === id ? "bg-blue-500/10" : ""
                      }`}
                      onClick={() => jumpTo(index)}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            SEVERITY_DOT[finding.severity]
                          }`}
                        />
                        <span
                          className={`text-[10px] uppercase px-1 py-0.5 rounded border ${
                            SEVERITY_STYLE[finding.severity]
                          }`}
                        >
                          {finding.severity}
                        </span>
                        <span className="text-[10px] text-gray-500 uppercase">
                          {finding.category}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-gray-200 leading-snug">
                        {finding.title}
                      </div>
                      <div className="mt-0.5 text-[11px] font-mono text-gray-600 truncate">
                        {finding.file}:{finding.line}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Diff */}
        <main ref={diffPaneRef} className="flex-1 overflow-y-auto px-4 py-4">
          {files.length === 0 ? (
            <div className="text-sm text-gray-500">No diff to display.</div>
          ) : (
            <DiffView
              files={files}
              runId={run.id}
              findings={findings}
              activeFindingId={activeFindingId}
              viewMode={viewMode}
              annotationData={annotationData}
              notesCollapsed={notesCollapsed}
              generateOriginal={generateOriginal}
              onNavigate={onNavigate}
              {...commentHandlers}
            />
          )}
        </main>

        {sessionPanelOpen && (
          <SessionPanel
            run={run}
            activeFinding={activeFinding}
            activeFindingIndex={activeFindingIndex}
            sessions={sessions}
            setup={setup}
            onClose={() => setSessionPanelOpen(false)}
          />
        )}
          </>
        )}
      </div>

      <MergePanel run={run} onMerged={onRefresh} />

      <SubmitReviewPanel
        run={run}
        onSubmit={async (input) => {
          await submitReview(run.id, input);
          await onRefresh();
        }}
        onEditComment={commentHandlers.onEditComment}
        onDeleteComment={commentHandlers.onDeleteComment}
        onDiscardOutdated={async () => {
          await discardOutdatedComments(run.id);
          await onRefresh();
        }}
      />
    </div>
  );
}
