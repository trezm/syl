import { useEffect, useState, Fragment } from "react";
import { toSplitRows, getLanguageForFile } from "@syl/core";
import type {
  DiffFile,
  DiffLine,
  Finding,
  LinkTarget,
  DraftComment,
  ReviewCommentSide,
} from "@syl/core";
import FindingCard, { type FindingAnchorState } from "./FindingCard";
import GenerateButton from "../components/GenerateButton";
import AnnotationNote from "./AnnotationNote";
import CommentComposer from "./CommentComposer";
import DraftCommentCard from "./DraftCommentCard";
import type { DiffAnnotation, DiffAnnotationData } from "./useDiffAnnotations";
import type { ResolvedLinks } from "../components/AnnotationBody";
import { useDiffHighlight, type DiffHighlight, type Token } from "./highlight";
import {
  useDiffExpansion,
  type GapEnd,
  type GapView,
  type LineRange,
} from "./useDiffExpansion";
import { SEVERITY_DOT } from "./severity";

export type DiffViewMode = "unified" | "split";

const STATUS_STYLE: Record<string, string> = {
  added: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  deleted: "bg-red-500/15 text-red-300 border-red-500/40",
  renamed: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  modified: "bg-gray-500/15 text-gray-400 border-gray-500/40",
};

function lineClasses(type: DiffLine["type"]): string {
  if (type === "add") return "bg-emerald-500/10";
  if (type === "delete") return "bg-red-500/10";
  return "";
}

function marker(type: DiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "delete") return "-";
  return " ";
}

function markerClass(type: DiffLine["type"]): string {
  if (type === "add") return "text-emerald-400";
  if (type === "delete") return "text-red-400";
  return "text-gray-700";
}

function Gutter({
  value,
  type,
  onAdd,
}: {
  value: number | null;
  type?: DiffLine["type"];
  onAdd?: () => void;
}) {
  return (
    <td
      className={`relative select-none text-right align-top pr-2 pl-3 w-[1%] whitespace-nowrap text-[11px] text-gray-600 border-r border-gray-800/80 ${
        type ? lineClasses(type) : ""
      }`}
    >
      {onAdd && (
        <button
          className="absolute inset-0 opacity-0 group-hover/row:opacity-100 flex items-center justify-center bg-blue-500/30 text-blue-100 hover:bg-blue-500/60 transition-opacity"
          title="Comment on this line"
          onClick={onAdd}
        >
          +
        </button>
      )}
      {value ?? ""}
    </td>
  );
}

/** A line's text, syntax-highlighted once its grammar has loaded. */
function CodeText({ line, tokens }: { line: DiffLine; tokens?: Token[] }) {
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

/** One code cell; `divider` draws the rule between the panes in split mode. */
function CodeCell({
  line,
  tokens,
  divider,
}: {
  line: DiffLine | null;
  tokens?: Token[];
  divider?: boolean;
}) {
  if (!line) {
    return (
      <td
        className={`bg-gray-900/40 ${divider ? "border-r border-gray-800/80" : ""}`}
      />
    );
  }
  return (
    <td
      className={`pl-2 pr-3 whitespace-pre-wrap break-all text-gray-300 align-top ${lineClasses(
        line.type
      )} ${divider ? "border-r border-gray-800/80" : ""}`}
    >
      <span className={markerClass(line.type)}>{marker(line.type)}</span>
      <CodeText line={line} tokens={tokens} />
    </td>
  );
}

/** A line from outside the diff, pulled in by expanding a gap. */
function ContextRow({
  line,
  tokens,
  viewMode,
}: {
  line: DiffLine;
  tokens?: Token[];
  viewMode: DiffViewMode;
}) {
  // Tinted, so it stays clear which lines this pull request actually touched.
  return (
    <tr className="bg-gray-900/40">
      <Gutter value={line.oldLine} />
      {viewMode === "split" ? (
        <>
          <CodeCell line={line} tokens={tokens} divider />
          <Gutter value={line.newLine} />
        </>
      ) : (
        <Gutter value={line.newLine} />
      )}
      <CodeCell line={line} tokens={tokens} />
    </tr>
  );
}

interface GapControl {
  key: string;
  label: string;
  title: string;
  range: LineRange;
  end: GapEnd;
}

function gapControls(view: GapView): GapControl[] {
  const controls: GapControl[] = [];
  const size = (range: LineRange) => range.end - range.start + 1;
  if (view.up) {
    controls.push({
      key: "up",
      label: "↑",
      title: `Show ${size(view.up)} lines above`,
      range: view.up,
      end: "tail",
    });
  }
  if (view.all) {
    controls.push({
      key: "all",
      label: "↕",
      title: `Show all ${size(view.all)} hidden lines`,
      range: view.all,
      end: "head",
    });
  }
  if (view.down) {
    controls.push({
      key: "down",
      label: "↓",
      title: `Show ${size(view.down)} lines below`,
      range: view.down,
      end: "head",
    });
  }
  return controls;
}

/**
 * Stands in for the code between two hunks: the hunk header, plus controls for
 * pulling the lines it hides into view.
 */
function GapRow({
  columns,
  header,
  view,
  onExpand,
}: {
  columns: number;
  /** The `@@` line of the hunk below, or null past the last hunk. */
  header: string | null;
  view?: GapView;
  onExpand?: (range: LineRange, end: GapEnd) => void;
}) {
  const controls = view && !view.loading ? gapControls(view) : [];

  return (
    <tr className="bg-sky-500/5">
      <td
        colSpan={columns}
        className="px-3 py-1 text-[11px] text-sky-300/70 border-y border-gray-800"
      >
        <div className="flex items-center gap-2">
          {controls.length > 0 && (
            <span className="flex items-center gap-0.5">
              {controls.map((control) => (
                <button
                  key={control.key}
                  className="px-1.5 leading-4 rounded border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/25"
                  title={control.title}
                  aria-label={control.title}
                  onClick={() => onExpand?.(control.range, control.end)}
                >
                  {control.label}
                </button>
              ))}
            </span>
          )}
          {view?.loading && <span className="text-gray-500">Expanding…</span>}
          {header && <span className="font-mono truncate">{header}</span>}
          {view && view.remaining !== null && view.remaining > 0 && (
            <span className="text-gray-600 whitespace-nowrap">
              {view.remaining} hidden line{view.remaining === 1 ? "" : "s"}
            </span>
          )}
          {view?.error && (
            <span className="text-red-300 truncate">{view.error}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Tokens for a line, or undefined while the file's grammar is still loading. */
function tokensFor(
  highlight: DiffHighlight | null,
  line: DiffLine | null
): Token[] | undefined {
  if (!highlight || !line) return undefined;
  return highlight.get(line);
}

/** findingKey identifies a finding globally so the sidebar can scroll to it. */
export function findingDomId(finding: Finding, index: number): string {
  return `finding-${index}-${finding.file.replace(/[^\w]/g, "_")}-${finding.line}`;
}

/** First diff line at or after `from` that still falls inside `to`, else null. */
function firstLineInRange(
  sortedLines: number[],
  from: number,
  to: number
): number | null {
  let lo = 0;
  let hi = sortedLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedLines[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  const candidate = sortedLines[lo];
  return candidate !== undefined && candidate <= to ? candidate : null;
}

export interface CommentTarget {
  line: number;
  side: ReviewCommentSide;
}

/**
 * Where a "+" on a unified row places a comment. New-file lines (adds and
 * context) go on the right, deletions on the left — the side GitHub expects for
 * code that no longer exists. The replay view anchors by the same rule, which
 * is why this is exported.
 */
export function commentTargetFor(line: DiffLine): CommentTarget | null {
  if (line.newLine !== null) return { line: line.newLine, side: "RIGHT" };
  if (line.oldLine !== null) return { line: line.oldLine, side: "LEFT" };
  return null;
}

function targetKey(target: CommentTarget): string {
  return `${target.side}:${target.line}`;
}

/** Generating annotations for a file as it was before the pull request. */
export interface GenerateOriginal {
  /** Which model will run, for the button's tooltip. */
  modelLabel: string;
  run: (file: DiffFile) => Promise<void>;
}

/**
 * Only a modified file has an original version to annotate — an added file had
 * none — and only a language with a tree-sitter config has semantic paths to
 * hang annotations on, the same condition that hides "Generate File".
 */
function hasAnnotatableOriginal(file: DiffFile): boolean {
  return (
    file.status === "modified" &&
    !file.binary &&
    getLanguageForFile(file.path) !== undefined
  );
}

export interface CommentHandlers {
  comments: DraftComment[];
  onAddComment: (input: {
    path: string;
    line: number;
    side: ReviewCommentSide;
    body: string;
  }) => Promise<void>;
  onEditComment: (id: string, body: string) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
  findingAnchorState: (finding: Finding) => FindingAnchorState;
  onAddFinding: (finding: Finding) => Promise<void>;
}

interface FileDiffProps extends CommentHandlers {
  file: DiffFile;
  /** The review this diff belongs to; expanding reads files through it. */
  runId: string;
  findings: { finding: Finding; index: number }[];
  annotations: DiffAnnotation[];
  links: ResolvedLinks;
  activeFindingId: string | null;
  viewMode: DiffViewMode;
  notesCollapsed: boolean;
  generateOriginal?: GenerateOriginal;
  onNavigate?: (target: LinkTarget) => void;
}

function FileDiff({
  file,
  runId,
  findings,
  annotations,
  links,
  activeFindingId,
  viewMode,
  notesCollapsed,
  generateOriginal,
  onNavigate,
  comments,
  onAddComment,
  onEditComment,
  onDeleteComment,
  findingAnchorState,
  onAddFinding,
}: FileDiffProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showOffDiff, setShowOffDiff] = useState(false);
  // Seeded from the review-wide setting, then owned by this file until that
  // setting changes again — so one noisy file can be quietened on its own.
  const [notesFolded, setNotesFolded] = useState(notesCollapsed);
  useEffect(() => setNotesFolded(notesCollapsed), [notesCollapsed]);
  const [composing, setComposing] = useState<CommentTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const expansion = useDiffExpansion(runId, file);
  const highlight = useDiffHighlight(file, expansion.extraLines);

  const columns = viewMode === "split" ? 4 : 3;

  // Anchor findings to the new-file line they name; anything that doesn't land
  // on a line in the diff is shown at the top of the file instead of dropped.
  const byLine = new Map<number, { finding: Finding; index: number }[]>();
  const unanchored: { finding: Finding; index: number }[] = [];
  const linesInFile = new Set<number>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) linesInFile.add(line.newLine);
    }
  }
  for (const entry of findings) {
    if (linesInFile.has(entry.finding.line)) {
      const list = byLine.get(entry.finding.line) ?? [];
      list.push(entry);
      byLine.set(entry.finding.line, list);
    } else {
      unanchored.push(entry);
    }
  }

  // An annotation covers a whole node, so anchor it to the first line of that
  // node the diff actually shows — a note on a function is worth seeing next to
  // the changed line inside it, not only when the signature itself changed.
  const sortedLines = [...linesInFile].sort((a, b) => a - b);
  const notesByLine = new Map<number, DiffAnnotation[]>();
  const offDiffNotes: DiffAnnotation[] = [];
  for (const entry of annotations) {
    const line = firstLineInRange(sortedLines, entry.startLine, entry.endLine);
    if (line === null) {
      offDiffNotes.push(entry);
      continue;
    }
    const list = notesByLine.get(line) ?? [];
    list.push(entry);
    notesByLine.set(line, list);
  }

  // Staged comments hang off the same rows, keyed by side so a comment on a
  // deleted line doesn't surface against the new-file line of the same number.
  const draftsByTarget = new Map<string, DraftComment[]>();
  let fileDraftCount = 0;
  for (const comment of comments) {
    if (comment.path !== file.path) continue;
    fileDraftCount++;
    const key = `${comment.side}:${comment.line}`;
    const list = draftsByTarget.get(key) ?? [];
    list.push(comment);
    draftsByTarget.set(key, list);
  }

  /**
   * Cards that hang under a rendered row: findings, then annotations, then any
   * staged comments and the open composer. `targets` is what the row can be
   * commented on — one entry in unified mode, up to two in split.
   */
  const attachedRows = (newLine: number | null, targets: CommentTarget[]) => {
    const findingsHere = newLine === null ? undefined : byLine.get(newLine);
    const notesHere = newLine === null ? undefined : notesByLine.get(newLine);
    const drafts = targets.flatMap((t) => draftsByTarget.get(targetKey(t)) ?? []);
    const composeTarget = composing
      ? targets.find((t) => targetKey(t) === targetKey(composing))
      : undefined;

    if (!findingsHere && !notesHere && drafts.length === 0 && !composeTarget) {
      return null;
    }

    return (
      <>
        {findingsHere?.map((entry) => (
          <tr key={`f-${entry.index}`}>
            <td colSpan={columns} className="bg-gray-950">
              <FindingCard
                finding={entry.finding}
                id={findingDomId(entry.finding, entry.index)}
                highlighted={
                  activeFindingId === findingDomId(entry.finding, entry.index)
                }
                anchorState={findingAnchorState(entry.finding)}
                onAddToReview={() => onAddFinding(entry.finding)}
              />
            </td>
          </tr>
        ))}
        {notesHere?.map((entry) => (
          <tr key={`a-${entry.path}`}>
            <td colSpan={columns} className="bg-gray-950">
              <AnnotationNote
                entry={entry}
                links={links}
                defaultCollapsed={notesFolded}
                onNavigate={onNavigate}
              />
            </td>
          </tr>
        ))}
        {drafts.map((comment) => (
          <tr key={comment.id}>
            <td colSpan={columns} className="bg-gray-950">
              <DraftCommentCard
                comment={comment}
                onEdit={(body) => onEditComment(comment.id, body)}
                onDelete={() => onDeleteComment(comment.id)}
              />
            </td>
          </tr>
        ))}
        {composeTarget && (
          <tr>
            <td colSpan={columns} className="bg-gray-950">
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
                        line: composeTarget.line,
                        side: composeTarget.side,
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
                  <p className="mt-1 text-[11px] text-red-300">{composeError}</p>
                )}
              </div>
            </td>
          </tr>
        )}
      </>
    );
  };

  const openComposer = (target: CommentTarget) => {
    setComposeError(null);
    setComposing(target);
  };

  const expandedRows = (lines: DiffLine[], prefix: string) =>
    lines.map((line) => (
      <ContextRow
        key={`${prefix}-${line.newLine}`}
        line={line}
        tokens={tokensFor(highlight, line)}
        viewMode={viewMode}
      />
    ));

  /**
   * Everything between two hunks: lines already expanded from the top of the
   * gap, the control row, then lines expanded from the bottom of it — so a
   * revealed stretch always sits against the hunk it was opened from. `header`
   * is null for the gap past the last hunk, which has no hunk to head.
   */
  const gapSection = (index: number, header: string | null) => {
    const view = expansion.gaps.get(index);
    if (!view) return header ? <GapRow columns={columns} header={header} /> : null;

    const hasControls =
      view.loading ||
      view.error !== null ||
      gapControls(view).length > 0;
    if (!header && !hasControls && view.head.length === 0 && view.tail.length === 0) {
      return null;
    }

    return (
      <>
        {expandedRows(view.head, `gap-head-${index}`)}
        {(header || hasControls) && (
          <GapRow
            columns={columns}
            header={header}
            view={view}
            onExpand={(range, end) => expansion.expand(view.gap, range, end)}
          />
        )}
        {expandedRows(view.tail, `gap-tail-${index}`)}
      </>
    );
  };

  return (
    <div className="border border-gray-800 rounded-md overflow-hidden mb-4 bg-gray-950">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900/70 border-b border-gray-800 sticky top-0 z-10">
        <button
          className="text-gray-500 hover:text-gray-300 text-xs w-4"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="font-mono text-xs text-gray-200 truncate min-w-0">
          {file.status === "renamed" && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path}
        </span>
        {generateOriginal && hasAnnotatableOriginal(file) && (
          <GenerateButton
            label="Annotate original"
            className="whitespace-nowrap"
            title={`Generate syl annotations for ${file.path} as it was before this pull request, with ${generateOriginal.modelLabel}, and save them to .syl/`}
            onClick={() => generateOriginal.run(file)}
          />
        )}
        <span className="flex-1" />
        {fileDraftCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 whitespace-nowrap">
            {fileDraftCount} pending
          </span>
        )}
        {annotations.length > 0 && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 whitespace-nowrap"
            title={
              notesFolded
                ? "Expand this file's syl annotations"
                : "Collapse this file's syl annotations"
            }
            aria-expanded={!notesFolded}
            onClick={() => setNotesFolded((f) => !f)}
          >
            {notesFolded ? "▸" : "▾"} {annotations.length} syl
          </button>
        )}
        {findings.length > 0 && (
          <span className="flex items-center gap-1">
            {findings.map((f) => (
              <span
                key={f.index}
                className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[f.finding.severity]}`}
              />
            ))}
          </span>
        )}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${
            STATUS_STYLE[file.status] ?? STATUS_STYLE.modified
          }`}
        >
          {file.status}
        </span>
        <span className="text-[11px] font-mono whitespace-nowrap">
          <span className="text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-red-400">−{file.deletions}</span>
        </span>
      </div>

      {!collapsed && (
        <>
          {unanchored.map((entry) => (
            <FindingCard
              key={entry.index}
              finding={entry.finding}
              id={findingDomId(entry.finding, entry.index)}
              highlighted={
                activeFindingId === findingDomId(entry.finding, entry.index)
              }
              anchorState={findingAnchorState(entry.finding)}
              onAddToReview={() => onAddFinding(entry.finding)}
            />
          ))}

          {offDiffNotes.length > 0 && (
            <div className="border-b border-gray-800/70">
              <button
                className="w-full text-left px-3 py-1.5 text-[11px] text-gray-500 hover:text-gray-300"
                onClick={() => setShowOffDiff((s) => !s)}
              >
                {showOffDiff ? "▾" : "▸"} {offDiffNotes.length} annotation
                {offDiffNotes.length === 1 ? "" : "s"} elsewhere in this file
              </button>
              {showOffDiff &&
                offDiffNotes.map((entry) => (
                  <AnnotationNote
                    key={entry.path}
                    entry={entry}
                    links={links}
                    defaultCollapsed={notesFolded}
                    onNavigate={onNavigate}
                  />
                ))}
            </div>
          )}

          {file.binary ? (
            <div className="px-3 py-3 text-xs text-gray-500">Binary file</div>
          ) : file.hunks.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500">
              No textual changes
            </div>
          ) : (
            <table
              className={`w-full border-collapse font-mono text-[12px] leading-[1.5] ${
                viewMode === "split" ? "table-fixed" : ""
              }`}
            >
              {/* Fixed layout keeps the two panes at equal width regardless of
                  how long the longest line in either of them is. */}
              {viewMode === "split" && (
                <colgroup>
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "calc(50% - 3.5rem)" }} />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "calc(50% - 3.5rem)" }} />
                </colgroup>
              )}
              <tbody>
                {file.hunks.map((hunk, hunkIndex) => (
                  <Fragment key={hunkIndex}>
                    {gapSection(hunkIndex, hunk.header)}
                    {viewMode === "split"
                      ? toSplitRows(hunk.lines).map((row, rowIndex) => {
                          // A context line is the same object on both sides, so
                          // only offer the left "+" for genuine deletions —
                          // otherwise one line would get two competing targets.
                          const leftTarget: CommentTarget | null =
                            row.left && row.left.type === "delete" && row.left.oldLine !== null
                              ? { line: row.left.oldLine, side: "LEFT" }
                              : null;
                          const rightTarget: CommentTarget | null =
                            row.right && row.right.newLine !== null
                              ? { line: row.right.newLine, side: "RIGHT" }
                              : null;
                          const targets = [leftTarget, rightTarget].filter(
                            (t): t is CommentTarget => t !== null
                          );

                          return (
                            <Fragment key={rowIndex}>
                              <tr className="group/row">
                                <Gutter
                                  value={row.left?.oldLine ?? null}
                                  type={row.left?.type}
                                  onAdd={
                                    leftTarget
                                      ? () => openComposer(leftTarget)
                                      : undefined
                                  }
                                />
                                <CodeCell
                                  line={row.left}
                                  tokens={tokensFor(highlight, row.left)}
                                  divider
                                />
                                <Gutter
                                  value={row.right?.newLine ?? null}
                                  type={row.right?.type}
                                  onAdd={
                                    rightTarget
                                      ? () => openComposer(rightTarget)
                                      : undefined
                                  }
                                />
                                <CodeCell
                                  line={row.right}
                                  tokens={tokensFor(highlight, row.right)}
                                />
                              </tr>
                              {attachedRows(row.right?.newLine ?? null, targets)}
                            </Fragment>
                          );
                        })
                      : hunk.lines.map((line, lineIndex) => {
                          const target = commentTargetFor(line);
                          return (
                            <Fragment key={lineIndex}>
                              <tr className="group/row">
                                <Gutter value={line.oldLine} type={line.type} />
                                <Gutter
                                  value={line.newLine}
                                  type={line.type}
                                  onAdd={
                                    target
                                      ? () => openComposer(target)
                                      : undefined
                                  }
                                />
                                <CodeCell
                                  line={line}
                                  tokens={tokensFor(highlight, line)}
                                />
                              </tr>
                              {attachedRows(line.newLine, target ? [target] : [])}
                            </Fragment>
                          );
                        })}
                  </Fragment>
                ))}
                {gapSection(file.hunks.length, null)}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

export default function DiffView({
  files,
  runId,
  findings,
  activeFindingId,
  viewMode,
  annotationData,
  notesCollapsed,
  generateOriginal,
  onNavigate,
  ...handlers
}: {
  files: DiffFile[];
  runId: string;
  findings: Finding[];
  activeFindingId: string | null;
  viewMode: DiffViewMode;
  annotationData: DiffAnnotationData;
  notesCollapsed: boolean;
  generateOriginal?: GenerateOriginal;
  onNavigate?: (target: LinkTarget) => void;
} & CommentHandlers) {
  const indexed = findings.map((finding, index) => ({ finding, index }));
  const byFile = new Map<string, { finding: Finding; index: number }[]>();
  for (const entry of indexed) {
    const list = byFile.get(entry.finding.file) ?? [];
    list.push(entry);
    byFile.set(entry.finding.file, list);
  }

  const diffPaths = new Set(files.map((f) => f.path));
  const orphaned = indexed.filter((e) => !diffPaths.has(e.finding.file));

  return (
    <div>
      {files.map((file) => (
        <FileDiff
          key={file.path}
          file={file}
          runId={runId}
          findings={byFile.get(file.path) ?? []}
          annotations={annotationData.byFile[file.path] ?? []}
          links={annotationData.linksByFile[file.path] ?? {}}
          activeFindingId={activeFindingId}
          viewMode={viewMode}
          notesCollapsed={notesCollapsed}
          generateOriginal={generateOriginal}
          onNavigate={onNavigate}
          {...handlers}
        />
      ))}

      {orphaned.length > 0 && (
        <div className="border border-gray-800 rounded-md overflow-hidden mb-4 bg-gray-950">
          <div className="px-3 py-2 bg-gray-900/70 border-b border-gray-800 text-xs text-gray-400">
            Findings outside the diff ({orphaned.length}) — the reviewer named a
            file that isn&apos;t in this pull request
          </div>
          {orphaned.map((entry) => (
            <FindingCard
              key={entry.index}
              finding={entry.finding}
              id={findingDomId(entry.finding, entry.index)}
              highlighted={
                activeFindingId === findingDomId(entry.finding, entry.index)
              }
              anchorState={handlers.findingAnchorState(entry.finding)}
              onAddToReview={() => handlers.onAddFinding(entry.finding)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
