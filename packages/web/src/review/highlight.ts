import { useEffect, useState } from "react";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import type { Highlighter } from "@lezer/highlight";
import type { Language } from "@codemirror/language";
import type { DiffFile, DiffLine } from "@syl/core";
import { loadLanguage } from "../languages";

/** A run of characters within one diff line that share a highlight class. */
export interface Token {
  text: string;
  /** Empty for text the grammar didn't tag. */
  cls: string;
}

/** Tokens per line, keyed by the `DiffLine` objects the diff parser produced. */
export type DiffHighlight = Map<DiffLine, Token[]>;

/**
 * The same tag groups One Dark uses, so a file reads the same in the diff as it
 * does in the CodeMirror viewer. The colours themselves live in index.css.
 */
const HIGHLIGHTER: Highlighter = tagHighlighter([
  { tag: t.keyword, class: "tok-keyword" },
  {
    tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName],
    class: "tok-name",
  },
  { tag: [t.function(t.variableName), t.labelName], class: "tok-function" },
  {
    tag: [t.color, t.constant(t.name), t.standard(t.name)],
    class: "tok-constant",
  },
  { tag: [t.definition(t.name), t.separator], class: "tok-definition" },
  {
    tag: [
      t.typeName,
      t.className,
      t.number,
      t.changed,
      t.annotation,
      t.modifier,
      t.self,
      t.namespace,
    ],
    class: "tok-type",
  },
  {
    tag: [
      t.operator,
      t.operatorKeyword,
      t.url,
      t.escape,
      t.regexp,
      t.link,
      t.special(t.string),
    ],
    class: "tok-operator",
  },
  { tag: [t.meta, t.comment], class: "tok-comment" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], class: "tok-atom" },
  {
    tag: [t.processingInstruction, t.string, t.inserted],
    class: "tok-string",
  },
  { tag: t.invalid, class: "tok-invalid" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.emphasis, class: "tok-emphasis" },
  { tag: t.heading, class: "tok-heading" },
]);

/**
 * Parsing is synchronous, so one very large file is left unhighlighted rather
 * than locking the page up while the rest of the diff waits behind it.
 */
const MAX_CHARS = 200_000;

/**
 * The lines of one side of a diff, in file order. Reconstructing each side
 * separately is what makes the parse worth anything: a document interleaving
 * removed and added lines is not code anyone wrote, whereas each side on its
 * own is the real file with the untouched stretches missing.
 *
 * `extra` is context the reviewer has expanded into view. It belongs to both
 * sides, and folding it in here means an expanded stretch is parsed as part of
 * the file rather than on its own — and fills in gaps that were guesswork
 * before.
 */
function sideLines(
  file: DiffFile,
  side: "old" | "new",
  extra: DiffLine[]
): DiffLine[] {
  const dropped = side === "old" ? "add" : "delete";
  const lines: DiffLine[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type !== dropped) lines.push(line);
    }
  }
  if (extra.length === 0) return lines;

  // Both runs are already ascending and can't overlap — expanded lines are by
  // definition outside every hunk — so this only interleaves them.
  const number = (line: DiffLine) =>
    (side === "old" ? line.oldLine : line.newLine) ?? 0;
  return [...lines, ...extra].sort((a, b) => number(a) - number(b));
}

/** Parses one reconstructed side and splits its highlighting back onto lines. */
function highlightSide(
  lines: DiffLine[],
  language: Language,
  into: DiffHighlight
): void {
  if (lines.length === 0) return;
  const doc = lines.map((line) => line.text).join("\n");
  if (doc.length > MAX_CHARS) return;

  // Ordered and non-overlapping, but a range may span lines — a block comment
  // or a template literal is one range covering several of them.
  const ranges: { from: number; to: number; cls: string }[] = [];
  highlightTree(language.parser.parse(doc), HIGHLIGHTER, (from, to, cls) => {
    ranges.push({ from, to, cls });
  });

  let cursor = 0;
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    const end = start + line.text.length;
    offset = end + 1; // the newline joining it to the next line

    const tokens: Token[] = [];
    let pos = start;
    while (cursor < ranges.length && ranges[cursor].from < end) {
      const range = ranges[cursor];
      const from = Math.max(range.from, pos);
      const to = Math.min(range.to, end);
      if (from > pos) tokens.push({ text: doc.slice(pos, from), cls: "" });
      if (to > from) tokens.push({ text: doc.slice(from, to), cls: range.cls });
      pos = Math.max(pos, to);
      if (range.to > end) break; // continues onto the next line; leave it here
      cursor++;
    }
    if (pos < end) tokens.push({ text: doc.slice(pos, end), cls: "" });
    into.set(line, tokens);
  }
}

/**
 * Highlights every line of a file's diff, or resolves null when the language
 * isn't one we can parse. Highlighting is decoration: anything that goes wrong
 * falls back to the plain text the diff already renders.
 */
export async function highlightDiffFile(
  file: DiffFile,
  extra: DiffLine[] = []
): Promise<DiffHighlight | null> {
  if (file.binary || file.hunks.length === 0) return null;
  const language = await loadLanguage(file.path);
  if (!language) return null;

  const highlight: DiffHighlight = new Map();
  try {
    // Old side first: context lines belong to both, and the new side is the
    // one that reflects the file as it will land.
    highlightSide(sideLines(file, "old", extra), language, highlight);
    highlightSide(sideLines(file, "new", extra), language, highlight);
  } catch (e) {
    console.warn(`Failed to highlight ${file.path}`, e);
    return null;
  }
  return highlight;
}

/**
 * Highlighting for one file's diff, or null until it is ready — the grammar
 * arrives in its own chunk, so the diff renders as plain text first and gains
 * colour a moment later. Expanding the diff re-parses with the newly revealed
 * lines; the previous result stays up meanwhile, since tokens are keyed by line
 * and stale ones simply don't match.
 */
export function useDiffHighlight(
  file: DiffFile,
  extra: DiffLine[] = []
): DiffHighlight | null {
  const [highlight, setHighlight] = useState<DiffHighlight | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlightDiffFile(file, extra).then((result) => {
      if (!cancelled) setHighlight(result);
    });
    return () => {
      cancelled = true;
    };
  }, [file, extra]);

  return highlight;
}
