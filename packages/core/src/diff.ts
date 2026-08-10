export type DiffLineType = "context" | "add" | "delete";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file, or null for added lines. */
  oldLine: number | null;
  /** Line number in the new file, or null for deleted lines. */
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  /** Path in the new tree (or the old one for deletions). */
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

/**
 * Parses `git diff` / `gh pr diff` output. Tolerant by design: anything it
 * doesn't recognise is skipped rather than throwing, so one odd file header
 * can't blank out an entire review.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  const closeFile = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      closeFile();
      const match = raw.match(/^diff --git (.+?) (.+)$/);
      const oldPath = match ? stripPrefix(match[1]) : "";
      const newPath = match ? stripPrefix(match[2]) : "";
      file = {
        path: newPath || oldPath,
        oldPath: oldPath || null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      continue;
    }

    if (!file) continue;

    if (raw.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      file.oldPath = raw.slice("rename from ".length).trim();
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("rename to ")) {
      file.path = raw.slice("rename to ".length).trim();
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const p = stripPrefix(raw.slice(4).trim());
      if (p !== "/dev/null") file.oldPath = p;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const p = stripPrefix(raw.slice(4).trim());
      if (p !== "/dev/null") file.path = p;
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("similarity index")) {
      continue;
    }

    const hunkMatch = raw.match(HUNK_HEADER);
    if (hunkMatch) {
      hunk = {
        header: raw,
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      file.hunks.push(hunk);
      oldCursor = hunk.oldStart;
      newCursor = hunk.newStart;
      continue;
    }

    if (!hunk) continue;

    // "\ No newline at end of file" annotates the previous line.
    if (raw.startsWith("\\")) continue;

    const marker = raw[0];
    const text = raw.slice(1);

    if (marker === "+") {
      hunk.lines.push({ type: "add", oldLine: null, newLine: newCursor, text });
      newCursor++;
      file.additions++;
    } else if (marker === "-") {
      hunk.lines.push({
        type: "delete",
        oldLine: oldCursor,
        newLine: null,
        text,
      });
      oldCursor++;
      file.deletions++;
    } else if (marker === " " || raw === "") {
      hunk.lines.push({
        type: "context",
        oldLine: oldCursor,
        newLine: newCursor,
        text,
      });
      oldCursor++;
      newCursor++;
    }
  }

  closeFile();
  return files;
}

/**
 * A hunk's footprint in one side of the file. Empty ranges — a hunk that only
 * adds lines has no old-side content — are written `start = end + 1`, which
 * keeps the arithmetic below working without a special case at every use.
 */
interface LineRange {
  start: number;
  end: number;
}

function rangeOf(start: number, count: number): LineRange {
  return count === 0
    ? { start: start + 1, end: start }
    : { start, end: start + count - 1 };
}

/**
 * A stretch of the file that lies between two hunks and so isn't in the diff.
 * Line numbers are in the new file; `delta` converts them to the old file,
 * which is exact because everything in a gap is unchanged by definition.
 */
export interface DiffGap {
  /**
   * Index of the hunk below the gap — 0 for the gap above the first hunk, and
   * `hunks.length` for the one that runs to the end of the file.
   */
  index: number;
  /** First hidden line in the new file. */
  start: number;
  /** Last hidden line, or null for the trailing gap: the file's end is unknown. */
  end: number | null;
  /** `oldLine - newLine` for every line in the gap. */
  delta: number;
}

/**
 * The hidden stretches of a file, in order, so the UI can offer to expand them.
 * Gaps that turn out to be empty (hunks that abut, or a hunk starting at line
 * one) are dropped; the trailing gap is always reported, since nothing in the
 * diff says whether the last hunk reaches the end of the file.
 */
export function diffGaps(file: DiffFile): DiffGap[] {
  if (file.binary || file.hunks.length === 0) return [];

  const gaps: DiffGap[] = [];
  const ranges = file.hunks.map((hunk) => ({
    old: rangeOf(hunk.oldStart, hunk.oldLines),
    new: rangeOf(hunk.newStart, hunk.newLines),
  }));

  file.hunks.forEach((_, index) => {
    const current = ranges[index];
    const previous = index === 0 ? null : ranges[index - 1];
    const start = previous ? previous.new.end + 1 : 1;
    const end = current.new.start - 1;
    if (start <= end) {
      gaps.push({
        index,
        start,
        end,
        delta: current.old.start - current.new.start,
      });
    }
  });

  const last = ranges[ranges.length - 1];
  gaps.push({
    index: file.hunks.length,
    start: last.new.end + 1,
    end: null,
    delta: last.old.end - last.new.end,
  });

  return gaps;
}

/** Turns lines fetched for a gap into context lines the diff can render. */
export function gapContextLines(
  gap: DiffGap,
  startLine: number,
  texts: string[]
): DiffLine[] {
  return texts.map((text, i) => ({
    type: "context" as const,
    oldLine: startLine + i + gap.delta,
    newLine: startLine + i,
    text,
  }));
}

/** One row of a side-by-side diff: old file on the left, new file on the right. */
export interface DiffSplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Rearranges a hunk's lines into side-by-side rows. Runs of deletions and
 * additions are paired positionally, which is what makes a rewritten line read
 * as one row rather than two; a leftover on either side gets an empty cell.
 */
export function toSplitRows(lines: DiffLine[]): DiffSplitRow[] {
  const rows: DiffSplitRow[] = [];
  let deletes: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    const pairs = Math.max(deletes.length, adds.length);
    for (let i = 0; i < pairs; i++) {
      rows.push({ left: deletes[i] ?? null, right: adds[i] ?? null });
    }
    deletes = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.type === "delete") {
      deletes.push(line);
    } else if (line.type === "add") {
      adds.push(line);
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();

  return rows;
}

/** Total added/removed lines across a parsed diff. */
export function diffTotals(files: DiffFile[]): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}
