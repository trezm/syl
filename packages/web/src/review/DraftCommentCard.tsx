import { useState } from "react";
import type { DraftComment } from "@syl/core";
import CommentComposer from "./CommentComposer";

/** A comment staged locally, shown where it will land on GitHub. */
export default function DraftCommentCard({
  comment,
  onEdit,
  onDelete,
  showLocation,
}: {
  comment: DraftComment;
  onEdit: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
  showLocation?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrap = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="my-2 mx-3">
        <CommentComposer
          initialBody={comment.body}
          submitLabel="Update"
          busy={busy}
          onSubmit={(body) =>
            wrap(async () => {
              await onEdit(body);
              setEditing(false);
            })
          }
          onCancel={() => setEditing(false)}
        />
        {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
      </div>
    );
  }

  // An outdated comment has no line left in the diff to sit against, so it
  // only ever renders in the review bar — where it has to read as a problem.
  const outdated = comment.outdatedAt !== null;

  return (
    <div
      className={`my-2 mx-3 rounded-md border ${
        outdated
          ? "border-gray-700 bg-gray-900/60"
          : "border-amber-500/40 bg-amber-500/[0.06]"
      }`}
    >
      <div
        className={`flex items-center gap-2 px-3 py-1.5 border-b ${
          outdated ? "border-gray-800" : "border-amber-500/20"
        }`}
      >
        <span
          className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
            outdated
              ? "border-gray-600 text-gray-400"
              : "border-amber-500/40 text-amber-300"
          }`}
          title={
            outdated
              ? "The pull request no longer changes this line, so GitHub won't take a comment on it."
              : undefined
          }
        >
          {outdated ? "Outdated" : "Pending"}
        </span>
        {comment.fromFinding && (
          <span className="text-[10px] text-gray-500 truncate">
            from finding · {comment.fromFinding}
          </span>
        )}
        {showLocation && (
          <span className="text-[10px] font-mono text-gray-500 truncate">
            {comment.path}:{comment.line}
            {comment.side === "LEFT" && " (old)"}
          </span>
        )}
        <span className="ml-auto flex gap-2 text-[10px] text-gray-500">
          <button
            className="hover:text-gray-200"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            className="hover:text-red-300"
            disabled={busy}
            onClick={() => wrap(onDelete)}
          >
            Delete
          </button>
        </span>
      </div>
      <p className="px-3 py-2 text-xs text-gray-200 whitespace-pre-wrap leading-relaxed">
        {comment.body}
      </p>
      {error && <p className="px-3 pb-2 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
