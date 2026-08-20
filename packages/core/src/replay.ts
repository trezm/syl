import type { DiffFile, DiffLine } from "./diff.js";

/** One changed line of a diff, as numbered in the listing sent to the model. */
export interface ChangedLine {
  /** 1-based position in the diff-wide numbering. */
  index: number;
  file: DiffFile;
  line: DiffLine;
}

/**
 * Every added and deleted line of the diff, numbered from 1 in file-then-hunk
 * order. Replay chunks address lines by this numbering, so the server (which
 * builds the prompt and checks the answer) and the client (which renders the
 * timeline) must walk the parsed diff identically — which is why it lives here.
 */
export function enumerateChangedLines(files: DiffFile[]): ChangedLine[] {
  const changed: ChangedLine[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "context") continue;
        changed.push({ index: changed.length + 1, file, line });
      }
    }
  }
  return changed;
}

/**
 * One step of the replay: a contiguous run of changed lines in one file, with
 * the model's account of what that run does. `start` and `end` are inclusive
 * indices into `enumerateChangedLines` of the same diff.
 */
export interface ReplayChunk {
  file: string;
  start: number;
  end: number;
  title: string;
  description: string;
}

/** What the model actually returns — ranges it believes in, unchecked. */
export interface RawReplayChunk {
  start: number;
  end: number;
  title: string;
  description: string;
}

export type ReplayPhase = "running" | "done" | "failed";

/**
 * Bounds for the step-size guideline — the upper end of the "aim for 1-N
 * changed lines per chunk" instruction. Shared so the server validates the
 * same range the UI offers. The minimum is 2 because a guideline of "1-1"
 * reads as a hard limit, which it deliberately isn't.
 */
export const DEFAULT_REPLAY_CHUNK_LINES = 50;
export const MIN_REPLAY_CHUNK_LINES = 2;
export const MAX_REPLAY_CHUNK_LINES = 500;

/**
 * A replay of the pull request: the diff divided into small narrated steps in
 * a plausible build-up order. The order is a reconstruction — nothing here
 * knows how the work actually happened — which is the point of saying "might".
 */
export interface ReviewReplay {
  phase: ReplayPhase;
  model: string;
  /** "cli" or "sdk", recorded like the review stages' own. */
  backend: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /**
   * The run's `currentHash` when this replay was built. A refresh that moves
   * the diff on leaves this behind, which is how the UI knows the steps no
   * longer line up with the diff and offers a rebuild instead of nonsense.
   */
  diffHash: string | null;
  /** True when the diff was too large to send in full — later steps are the
   *  automatic sweep-up rather than the model's. */
  listingTruncated: boolean;
  /**
   * The step-size guideline this replay was asked for: the model was told to
   * aim for 1 to this many changed lines per chunk. Part of what makes a
   * stored replay reusable — asking again with a different size rebuilds.
   */
  chunkLines: number;
  /** Steps in playback order. Null until the model has answered. */
  chunks: ReplayChunk[] | null;
}

/** Title given to steps that sweep up lines the model's chunks didn't claim. */
export const REPLAY_SWEEP_TITLE = "Remaining changes";

/**
 * Turns the model's chunks into ones the player can trust: ranges clamped to
 * the diff, a range crossing a file boundary split at it, overlaps resolved in
 * favour of the earlier chunk, and every line no chunk claimed accounted for —
 * so scrubbing to the end always reproduces the whole diff. Unclaimed lines
 * join the chunk beside them when one abuts (a missed line is nearly always
 * part of the edit next to it); only truly orphaned stretches become closing
 * sweep steps of their own.
 */
export function normalizeReplayChunks(
  raw: RawReplayChunk[],
  changed: ChangedLine[]
): ReplayChunk[] {
  const total = changed.length;
  if (total === 0) return [];

  const claimed = new Array<boolean>(total + 1).fill(false);
  const chunks: ReplayChunk[] = [];

  const claim = (
    lo: number,
    hi: number,
    title: string,
    description: string
  ): void => {
    let segStart: number | null = null;
    const close = (endIndex: number) => {
      if (segStart === null) return;
      chunks.push({
        file: changed[segStart - 1].file.path,
        start: segStart,
        end: endIndex,
        title,
        description,
      });
      segStart = null;
    };
    for (let i = lo; i <= hi; i++) {
      if (claimed[i]) {
        close(i - 1);
        continue;
      }
      if (segStart !== null && changed[i - 1].file !== changed[segStart - 1].file) {
        close(i - 1);
      }
      claimed[i] = true;
      segStart ??= i;
    }
    close(hi);
  };

  for (const chunk of raw ?? []) {
    if (!chunk) continue;
    const a = Math.floor(Number(chunk.start));
    const b = Math.floor(Number(chunk.end));
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(total, Math.max(a, b));
    if (lo > hi) continue;
    claim(
      lo,
      hi,
      String(chunk.title ?? "").trim() || "Step",
      String(chunk.description ?? "").trim()
    );
  }

  // Maximal unclaimed runs, split at file boundaries like everything else.
  const runs: { start: number; end: number }[] = [];
  let runStart: number | null = null;
  const closeRun = (endIndex: number) => {
    if (runStart !== null) runs.push({ start: runStart, end: endIndex });
    runStart = null;
  };
  for (let i = 1; i <= total; i++) {
    if (claimed[i]) {
      closeRun(i - 1);
      continue;
    }
    if (runStart !== null && changed[i - 1].file !== changed[runStart - 1].file) {
      closeRun(i - 1);
    }
    runStart ??= i;
  }
  closeRun(total);

  for (const run of runs) {
    const file = changed[run.start - 1].file.path;
    // Chunk ranges never span files, so end/start adjacency within the same
    // file is real adjacency; extending over the run can't collide with
    // another chunk because the run is unclaimed and maximal.
    const before = chunks.find((c) => c.file === file && c.end === run.start - 1);
    if (before) {
      before.end = run.end;
      continue;
    }
    const after = chunks.find((c) => c.file === file && c.start === run.end + 1);
    if (after) {
      after.start = run.start;
      continue;
    }
    chunks.push({
      file,
      start: run.start,
      end: run.end,
      title: REPLAY_SWEEP_TITLE,
      description: "Changed lines the model's steps didn't account for.",
    });
  }

  return chunks;
}

/**
 * Which step each changed line lands at, keyed by the `DiffLine` objects of
 * the same parse the chunks were checked against. Steps are 0-based positions
 * in `chunks` — the playback order.
 */
export function replayStepByLine(
  files: DiffFile[],
  chunks: ReplayChunk[]
): Map<DiffLine, number> {
  const changed = enumerateChangedLines(files);
  const steps = new Map<DiffLine, number>();
  chunks.forEach((chunk, step) => {
    const lo = Math.max(1, chunk.start);
    const hi = Math.min(changed.length, chunk.end);
    for (let i = lo; i <= hi; i++) {
      steps.set(changed[i - 1].line, step);
    }
  });
  return steps;
}
