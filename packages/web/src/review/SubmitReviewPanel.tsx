import { useState } from "react";
import {
  REVIEW_EVENTS,
  outdatedComments,
  type ReviewEvent,
  type ReviewRun,
} from "@syl/core";
import DraftCommentCard from "./DraftCommentCard";

/**
 * The bar that publishes staged comments to GitHub. Submitting is public and
 * can't be undone from here, so the button always states the exact payload —
 * repo, PR number, comment count and event — before it's pressed.
 */
export default function SubmitReviewPanel({
  run,
  onSubmit,
  onEditComment,
  onDeleteComment,
  onDiscardOutdated,
}: {
  run: ReviewRun;
  onSubmit: (input: { body: string; event: ReviewEvent }) => Promise<void>;
  onEditComment: (id: string, body: string) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
  /** Drops every stranded comment at once, which is what unblocks submitting. */
  onDiscardOutdated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const count = run.comments.length;
  const nothingToSend = count === 0 && !body.trim();
  const lastSubmission = run.submissions[run.submissions.length - 1];

  /**
   * Comments a refresh stranded. They have no row left in the diff, so this
   * bar is the only place they can still be seen — and GitHub would reject the
   * whole review over any one of them, so nothing goes until they're dealt with.
   */
  const outdated = outdatedComments(run);

  const discard = async () => {
    setDiscarding(true);
    setError(null);
    try {
      await onDiscardOutdated();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDiscarding(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ body: body.trim(), event });
      setBody("");
      setEvent("COMMENT");
      setOpen(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center gap-3 px-4 py-2">
        <button
          className="text-xs text-gray-300 hover:text-gray-100 flex items-center gap-1.5"
          onClick={() => setOpen((o) => !o)}
        >
          <span>{open ? "▾" : "▸"}</span>
          Review
          <span
            className={`px-1.5 py-0.5 rounded-full text-[10px] ${
              count > 0
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                : "bg-gray-800 text-gray-500 border border-gray-700"
            }`}
          >
            {count} pending
          </span>
          {outdated.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/40">
              {outdated.length} outdated
            </span>
          )}
        </button>

        {lastSubmission && (
          <a
            className="text-[11px] text-emerald-300 hover:underline"
            href={lastSubmission.url}
            target="_blank"
            rel="noreferrer"
          >
            Posted {lastSubmission.commentCount} comment
            {lastSubmission.commentCount === 1 ? "" : "s"} to GitHub ↗
          </a>
        )}

        <span className="ml-auto text-[11px] text-gray-600 font-mono">
          {run.repo} #{run.number}
        </span>
      </div>

      {open && (
        <div className="px-4 pb-3 space-y-3 border-t border-gray-800/70 pt-3">
          {outdated.length > 0 && (
            <div className="border border-amber-500/30 bg-amber-500/[0.06] rounded">
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-amber-300">
                <span>
                  {outdated.length} comment{outdated.length === 1 ? "" : "s"}{" "}
                  point{outdated.length === 1 ? "s" : ""} at{" "}
                  {outdated.length === 1 ? "a line" : "lines"} this pull request
                  no longer changes. GitHub rejects the whole review over{" "}
                  {outdated.length === 1 ? "it" : "them"}, so nothing can be sent
                  until {outdated.length === 1 ? "it goes" : "they go"}.
                </span>
                <button
                  className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded border border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-40"
                  disabled={discarding}
                  onClick={discard}
                >
                  {discarding ? "Discarding…" : "Discard them"}
                </button>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {outdated.map((comment) => (
                  <DraftCommentCard
                    key={comment.id}
                    comment={comment}
                    showLocation
                    onEdit={(text) => onEditComment(comment.id, text)}
                    onDelete={() => onDeleteComment(comment.id)}
                  />
                ))}
              </div>
            </div>
          )}

          <textarea
            className="w-full bg-gray-900 text-gray-200 border border-gray-700 rounded p-2 text-xs resize-y focus:outline-none focus:border-blue-500"
            rows={3}
            placeholder="Overall review comment (optional if you have inline comments)…"
            value={body}
            disabled={busy}
            onChange={(e) => setBody(e.target.value)}
          />

          <div className="space-y-1.5">
            {REVIEW_EVENTS.map((option) => (
              <label
                key={option.value}
                className="flex items-start gap-2 text-xs text-gray-300 cursor-pointer"
              >
                <input
                  type="radio"
                  name="review-event"
                  className="mt-0.5"
                  checked={event === option.value}
                  disabled={busy}
                  onChange={() => setEvent(option.value)}
                />
                <span>
                  <span className="text-gray-200">{option.label}</span>
                  <span className="block text-[11px] text-gray-500">
                    {option.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {error && (
            <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 whitespace-pre-wrap">
              {error}
            </div>
          )}

          <button
            className="px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white"
            disabled={nothingToSend || busy || outdated.length > 0}
            onClick={submit}
          >
            {busy
              ? "Submitting…"
              : `Submit ${count} comment${count === 1 ? "" : "s"} to ${run.repo} #${run.number}`}
          </button>
          <p className="text-[11px] text-gray-600">
            This posts publicly to GitHub as your authenticated <code>gh</code>{" "}
            user and cannot be undone from Syl.
          </p>
        </div>
      )}
    </div>
  );
}
