import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  enumerateChangedLines,
  isReplayStale,
  replayStepByLine,
  type DiffFile,
  type DiffLine,
  type DraftComment,
  type ReplayChunk,
  type ReviewCommentSide,
  type ReviewReplay,
  type ReviewRun,
} from "@syl/core";
import { buildReplay } from "../api";
import ModelSelector, {
  useSelectedModel,
  type AvailableModel,
} from "../components/ModelSelector";
import CommentComposer from "./CommentComposer";
import DraftCommentCard from "./DraftCommentCard";
import { commentTargetFor, type CommentTarget } from "./DiffView";
import { useDiffHighlight, type DiffHighlight, type Token } from "./highlight";

/**
 * The slice of the review's comment handling the replay needs: staging,
 * editing and discarding drafts. Findings stay the diff view's business.
 */
export interface ReplayCommentHandlers {
  comments: DraftComment[];
  onAddComment: (input: {
    path: string;
    line: number;
    side: ReviewCommentSide;
    body: string;
  }) => Promise<void>;
  onEditComment: (id: string, body: string) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
}

/**
 * Replay is narration, not judgement, so it wants the quick models — the same
 * order the server's own default uses, resolved against what can actually run.
 */
const QUICK_MODEL_PREFERENCE = [
  "gpt-5.6-luna",
  "claude-haiku-4-5",
  "gpt-5-mini",
  "claude-sonnet-5",
  "gpt-4o",
];

function quickModelDefault(models: AvailableModel[]): string | null {
  const usable = models.filter((m) => m.available);
  return (
    QUICK_MODEL_PREFERENCE.find((id) => usable.some((m) => m.id === id)) ??
    usable[0]?.id ??
    null
  );
}

function LineText({ line, tokens }: { line: DiffLine; tokens?: Token[] }) {
  if (!tokens) return <>{line.text}</>;
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} className={token.cls || undefined}>
          {token.text}
        </span>
      ))}
    </>
  );
}

/**
 * One file's intermediate state at `step`: additions from later steps don't
 * exist yet, deletions from later steps are still ordinary lines, and the
 * current step's own lines are tinted — green landing, red leaving — so the
 * eye goes to what "just happened".
 *
 * Every rendered line takes comments by the diff view's rules — the anchors
 * are (side, line) pairs in the real diff, so a draft staged here is the same
 * draft the diff view and the submit bar show. A draft whose line isn't part
 * of this step's state (a not-yet-written addition, an already-removed
 * deletion) simply stays out of sight until the timeline reaches it.
 */
function ReplayFile({
  file,
  stepByLine,
  step,
  anchorLine,
  comments,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: {
  file: DiffFile;
  stepByLine: Map<DiffLine, number>;
  step: number;
  anchorLine: DiffLine | null;
} & ReplayCommentHandlers) {
  const highlight: DiffHighlight | null = useDiffHighlight(file);
  const [composing, setComposing] = useState<CommentTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  // Keyed by side so a comment on a deleted line doesn't surface against the
  // new-file line of the same number — the diff view's own rule.
  const draftsByTarget = new Map<string, DraftComment[]>();
  let pending = 0;
  for (const comment of comments) {
    if (comment.path !== file.path) continue;
    pending++;
    const key = `${comment.side}:${comment.line}`;
    const list = draftsByTarget.get(key) ?? [];
    list.push(comment);
    draftsByTarget.set(key, list);
  }

  const openComposer = (target: CommentTarget) => {
    setComposeError(null);
    setComposing(target);
  };

  const row = (
    line: DiffLine,
    key: string,
    kind: "plain" | "landing" | "leaving"
  ) => {
    const target = commentTargetFor(line);
    const targetKey = target ? `${target.side}:${target.line}` : null;
    const drafts = targetKey ? (draftsByTarget.get(targetKey) ?? []) : [];
    const composingHere =
      composing !== null &&
      targetKey !== null &&
      `${composing.side}:${composing.line}` === targetKey;

    return (
      <Fragment key={key}>
        <tr
          id={line === anchorLine ? "replay-current" : undefined}
          className={`group/row ${
            kind === "landing"
              ? "bg-emerald-500/10"
              : kind === "leaving"
                ? "bg-red-500/10"
                : ""
          }`}
        >
          <td className="relative select-none w-6 border-r border-gray-800/80">
            {target && (
              <button
                className="absolute inset-0 opacity-0 group-hover/row:opacity-100 flex items-center justify-center bg-blue-500/30 text-blue-100 hover:bg-blue-500/60 transition-opacity"
                title="Comment on this line"
                onClick={() => openComposer(target)}
              >
                +
              </button>
            )}
          </td>
          <td className="pl-2 pr-3 whitespace-pre-wrap break-all text-gray-300 align-top">
            <span
              className={
                kind === "landing"
                  ? "text-emerald-400"
                  : kind === "leaving"
                    ? "text-red-400"
                    : "text-gray-700"
              }
            >
              {kind === "landing" ? "+" : kind === "leaving" ? "-" : " "}
            </span>
            <LineText line={line} tokens={highlight?.get(line)} />
          </td>
        </tr>
        {(drafts.length > 0 || composingHere) && (
          <tr>
            <td colSpan={2} className="bg-gray-950">
              {drafts.map((comment) => (
                <DraftCommentCard
                  key={comment.id}
                  comment={comment}
                  onEdit={(body) => onEditComment(comment.id, body)}
                  onDelete={() => onDeleteComment(comment.id)}
                />
              ))}
              {composingHere && target && (
                <div className="my-2 mx-3">
                  <CommentComposer
                    submitLabel="Add comment"
                    busy={saving}
                    onSubmit={async (body) => {
                      setSaving(true);
                      setComposeError(null);
                      try {
                        await onAddComment({
                          path: file.path,
                          line: target.line,
                          side: target.side,
                          body,
                        });
                        setComposing(null);
                      } catch (e: any) {
                        setComposeError(e.message);
                      } finally {
                        setSaving(false);
                      }
                    }}
                    onCancel={() => {
                      setComposing(null);
                      setComposeError(null);
                    }}
                  />
                  {composeError && (
                    <p className="mt-1 text-[11px] text-red-300">
                      {composeError}
                    </p>
                  )}
                </div>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="border border-gray-800 rounded-md overflow-hidden mb-4 bg-gray-950">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900/70 border-b border-gray-800 sticky top-0 z-10">
        <span className="font-mono text-xs text-gray-200 truncate min-w-0">
          {file.status === "renamed" && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path}
        </span>
        {pending > 0 && (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 whitespace-nowrap">
            {pending} pending
          </span>
        )}
      </div>
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.5]">
        <tbody>
          {file.hunks.map((hunk, hunkIndex) => (
            <Fragment key={hunkIndex}>
              {hunkIndex > 0 && (
                <tr>
                  <td
                    colSpan={2}
                    className="px-3 py-0.5 text-[10px] text-gray-600 bg-gray-900/40 border-y border-gray-800/70 select-none"
                  >
                    ⋯
                  </td>
                </tr>
              )}
              {hunk.lines.map((line, lineIndex) => {
                const key = `${hunkIndex}-${lineIndex}`;
                if (line.type === "context") return row(line, key, "plain");
                const s = stepByLine.get(line) ?? 0;
                if (line.type === "add") {
                  if (s > step) return null; // not written yet
                  return row(line, key, s === step ? "landing" : "plain");
                }
                if (s < step) return null; // already removed
                return row(line, key, s === step ? "leaving" : "plain");
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Player({
  files,
  replay,
  chunks,
  onRebuild,
  rebuilding,
  ...commentHandlers
}: {
  files: DiffFile[];
  replay: ReviewReplay;
  chunks: ReplayChunk[];
  onRebuild: () => void;
  rebuilding: boolean;
} & ReplayCommentHandlers) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const currentItemRef = useRef<HTMLLIElement>(null);

  const changed = useMemo(() => enumerateChangedLines(files), [files]);
  const stepByLine = useMemo(
    () => replayStepByLine(files, chunks),
    [files, chunks]
  );

  /** The first step that touches each file — when it enters the story. */
  const firstStepByPath = useMemo(() => {
    const first = new Map<string, number>();
    chunks.forEach((chunk, i) => {
      if (!first.has(chunk.file)) first.set(chunk.file, i);
    });
    return first;
  }, [chunks]);

  const chunk = chunks[step];
  const anchorLine = chunk ? (changed[chunk.start - 1]?.line ?? null) : null;

  const counts = useMemo(() => {
    let adds = 0;
    let dels = 0;
    if (chunk) {
      const hi = Math.min(changed.length, chunk.end);
      for (let i = Math.max(1, chunk.start); i <= hi; i++) {
        if (changed[i - 1].line.type === "add") adds++;
        else dels++;
      }
    }
    return { adds, dels };
  }, [chunk, changed]);

  useEffect(() => {
    if (playing && step >= chunks.length - 1) setPlaying(false);
  }, [playing, step, chunks.length]);

  /**
   * When the last advance actually happened. The interval below can end up
   * duplicated in development (strict-mode remounts, HMR), and each copy would
   * advance the step; gating on wall-clock time makes extra timers harmless.
   */
  const lastAdvance = useRef(0);

  useEffect(() => {
    if (!playing) return;
    lastAdvance.current = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now - lastAdvance.current < 2000) return;
      lastAdvance.current = now;
      setStep((s) => Math.min(chunks.length - 1, s + 1));
    }, 2200);
    return () => window.clearInterval(timer);
  }, [playing, chunks.length]);

  // Jumped rather than smooth-scrolled, for the same reason the findings list
  // is: smooth behaviour doesn't reliably traverse a very tall pane.
  useEffect(() => {
    const pane = paneRef.current;
    const el = document.getElementById("replay-current");
    if (!pane || !el) return;
    const offset =
      el.getBoundingClientRect().top -
      pane.getBoundingClientRect().top +
      pane.scrollTop;
    pane.scrollTo({ top: Math.max(0, offset - pane.clientHeight / 3) });
  }, [step]);

  useEffect(() => {
    currentItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [step]);

  const goTo = (next: number) => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(chunks.length - 1, next)));
  };

  const visibleFiles = files.filter((file) => {
    const first = firstStepByPath.get(file.path);
    return first !== undefined && first <= step;
  });
  const pendingFiles =
    files.filter((f) => firstStepByPath.has(f.path)).length -
    visibleFiles.length;

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="border-b border-gray-800 px-4 py-2.5 bg-gray-950">
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
            title="Previous step"
            disabled={step === 0}
            onClick={() => goTo(step - 1)}
          >
            ◀
          </button>
          <button
            className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 w-14"
            title={playing ? "Pause" : "Play the steps in order"}
            disabled={chunks.length < 2}
            onClick={() => {
              if (playing) {
                setPlaying(false);
                return;
              }
              // Play from a finished timeline means "watch it again".
              if (step >= chunks.length - 1) setStep(0);
              setPlaying(true);
            }}
          >
            {playing ? "Pause" : "Play"}
          </button>
          <button
            className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
            title="Next step"
            disabled={step >= chunks.length - 1}
            onClick={() => goTo(step + 1)}
          >
            ▶
          </button>
          <input
            type="range"
            className="flex-1 accent-blue-500"
            min={0}
            max={Math.max(0, chunks.length - 1)}
            value={step}
            aria-label="Replay position"
            onChange={(e) => goTo(Number(e.target.value))}
          />
          <span className="text-xs text-gray-400 whitespace-nowrap">
            Step {step + 1} of {chunks.length}
          </span>
          <span
            className="text-xs text-gray-600 whitespace-nowrap"
            title="The step order is this model's reconstruction, not the real history"
          >
            replayed by {replay.model}
            {replay.backend && ` (${replay.backend})`}
          </span>
          <button
            className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:bg-gray-800 disabled:opacity-40"
            title="Ask the model to split the diff into steps again"
            disabled={rebuilding}
            onClick={onRebuild}
          >
            {rebuilding ? "Rebuilding…" : "Rebuild"}
          </button>
        </div>
        {replay.listingTruncated && (
          <div className="mt-2 text-xs text-amber-300">
            The diff was too large to send in full — the closing steps sweep up
            what the model never saw.
          </div>
        )}
        {chunk && (
          <div className="mt-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-sm text-gray-100 font-medium">
                {chunk.title}
              </span>
              <span className="text-[11px] font-mono text-gray-500 truncate">
                {chunk.file}
              </span>
              <span className="text-[11px] font-mono whitespace-nowrap">
                {counts.adds > 0 && (
                  <span className="text-emerald-400">+{counts.adds}</span>
                )}{" "}
                {counts.dels > 0 && (
                  <span className="text-red-400">−{counts.dels}</span>
                )}
              </span>
            </div>
            {chunk.description && (
              <p className="mt-1 text-xs text-gray-400 leading-relaxed max-w-3xl">
                {chunk.description}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex">
        <aside className="w-72 flex-shrink-0 border-r border-gray-800 overflow-y-auto bg-gray-950">
          <ol>
            {chunks.map((c, i) => (
              <li key={i} ref={i === step ? currentItemRef : undefined}>
                <button
                  className={`w-full text-left px-3 py-2 border-b border-gray-800/60 hover:bg-gray-900 ${
                    i === step ? "bg-blue-500/10" : ""
                  }`}
                  onClick={() => goTo(i)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-5 text-right text-[11px] font-mono flex-shrink-0 ${
                        i < step
                          ? "text-emerald-400"
                          : i === step
                            ? "text-blue-300"
                            : "text-gray-600"
                      }`}
                    >
                      {i < step ? "✓" : i + 1}
                    </span>
                    <span
                      className={`text-xs leading-snug ${
                        i === step
                          ? "text-gray-100"
                          : i < step
                            ? "text-gray-500"
                            : "text-gray-400"
                      }`}
                    >
                      {c.title}
                    </span>
                  </div>
                  <div className="ml-7 mt-0.5 text-[10px] font-mono text-gray-600 truncate">
                    {c.file}
                  </div>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <div ref={paneRef} className="flex-1 overflow-y-auto px-4 py-4">
          {visibleFiles.map((file) => (
            <ReplayFile
              key={file.path}
              file={file}
              stepByLine={stepByLine}
              step={step}
              anchorLine={anchorLine}
              {...commentHandlers}
            />
          ))}
          {pendingFiles > 0 && (
            <div className="text-xs text-gray-600 px-1 py-2">
              {pendingFiles} more file{pendingFiles === 1 ? "" : "s"} arrive
              {pendingFiles === 1 ? "s" : ""} later in the replay.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The replay pane of a finished review: the diff divided into small narrated
 * steps by a quick model, with a timeline to scrub through the work "landing".
 * Until a replay exists this is the form that asks for one.
 */
export default function ReplayView({
  run,
  files,
  models,
  onRefresh,
  ...commentHandlers
}: {
  run: ReviewRun;
  /** The run's diff, parsed once by ReviewResult — the same objects it renders. */
  files: DiffFile[];
  models: AvailableModel[];
  onRefresh: () => Promise<void>;
} & ReplayCommentHandlers) {
  const { model, selectModel } = useSelectedModel(
    models,
    quickModelDefault(models),
    "syl-replay-model"
  );
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const replay = run.replay;

  // The run's polling stops once the review is done, so the replay build keeps
  // itself fresh: poll while the model is working.
  useEffect(() => {
    if (replay?.phase !== "running") return;
    const timer = window.setInterval(() => void onRefresh(), 1500);
    return () => window.clearInterval(timer);
  }, [replay?.phase, onRefresh]);

  const start = async (refresh: boolean, withModel?: string) => {
    setStarting(true);
    setStartError(null);
    try {
      await buildReplay(run.id, {
        model: withModel ?? model ?? undefined,
        refresh,
      });
      await onRefresh();
    } catch (e: any) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  if (replay?.phase === "running") {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto py-16 px-6">
          <h3 className="text-lg font-semibold text-gray-200">
            Building the replay
          </h3>
          <p className="mt-3 text-sm text-gray-400 flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"
              aria-hidden="true"
            />
            {replay.model} is dividing the diff into steps…
          </p>
          <p className="mt-4 text-xs text-gray-600">
            This is one quick model call — usually well under a minute. Leaving
            this view doesn't cancel it.
          </p>
        </div>
      </div>
    );
  }

  if (replay?.phase === "done" && replay.chunks && replay.chunks.length > 0) {
    if (isReplayStale(run)) {
      return (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-xl mx-auto py-16 px-6">
            <h3 className="text-lg font-semibold text-gray-200">
              The pull request has moved on
            </h3>
            <p className="mt-3 text-sm text-gray-400 leading-relaxed">
              This replay was built against an earlier version of the diff, so
              its steps point at lines that may have changed or gone. Rebuild it
              to replay the pull request as it now stands.
            </p>
            {startError && (
              <div className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
                {startError}
              </div>
            )}
            <button
              className="mt-5 text-xs px-3 py-1.5 rounded border border-blue-500/50 text-blue-300 hover:bg-blue-500/10 disabled:opacity-40"
              disabled={starting}
              onClick={() => start(true, replay.model)}
            >
              {starting ? "Rebuilding…" : `Rebuild with ${replay.model}`}
            </button>
          </div>
        </div>
      );
    }
    return (
      <Player
        // A rebuild is a new story; the scrub position of the old one is noise.
        key={replay.startedAt}
        files={files}
        replay={replay}
        chunks={replay.chunks}
        onRebuild={() => start(true, replay.model)}
        rebuilding={starting}
        {...commentHandlers}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto py-16 px-6">
        <h3 className="text-lg font-semibold text-gray-200">
          Replay this pull request
        </h3>
        <p className="mt-3 text-sm text-gray-400 leading-relaxed">
          A quick model divides the diff into small steps — a few lines each —
          and puts them in a plausible build-up order: foundations first, then
          the logic on top, then the wiring. Scrub the timeline to watch the
          work land, with a note on what each step does.
        </p>
        <p className="mt-2 text-xs text-gray-600">
          The order is a reconstruction, not history — nothing here knows how
          the work actually happened.
        </p>
        {(startError || replay?.error) && (
          <div className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap">
            {startError ?? replay?.error}
          </div>
        )}
        <div className="mt-5 flex items-center gap-2">
          <ModelSelector models={models} model={model} onSelect={selectModel} />
          <button
            className="text-xs px-3 py-1.5 rounded border border-blue-500/50 text-blue-300 hover:bg-blue-500/10 disabled:opacity-40"
            disabled={starting || !model}
            onClick={() => start(replay?.phase === "failed")}
          >
            {starting
              ? "Starting…"
              : replay?.phase === "failed"
                ? "Try again"
                : "Build replay"}
          </button>
        </div>
        {models.filter((m) => m.available).length === 0 && (
          <p className="mt-3 text-xs text-amber-300">
            No model is available — install the claude or codex CLI, or set an
            API key.
          </p>
        )}
      </div>
    </div>
  );
}
