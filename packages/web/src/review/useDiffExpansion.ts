import { useCallback, useEffect, useMemo, useState } from "react";
import { diffGaps, gapContextLines } from "@syl/core";
import type { DiffFile, DiffGap, DiffLine } from "@syl/core";
import { fetchReviewFileContext } from "../api";

/** Lines one arrow reveals. */
export const EXPAND_STEP = 20;
/** Largest gap "expand all" will pull in one go; matches the server's cap. */
const EXPAND_ALL_LIMIT = 2_000;

export interface LineRange {
  start: number;
  end: number;
}

/** Which end of a gap a fetch fills in. */
export type GapEnd = "head" | "tail";

interface GapState {
  /** Revealed lines at the top of the gap, below the hunk above it. */
  head: DiffLine[];
  /** Revealed lines at the bottom of the gap, above the hunk below it. */
  tail: DiffLine[];
  loading: boolean;
  error: string | null;
}

const EMPTY: GapState = { head: [], tail: [], loading: false, error: null };

export interface GapView extends GapState {
  gap: DiffGap;
  /** Lines still hidden, or null until the length of the file is known. */
  remaining: number | null;
  /** What each control would fetch; null when it has nothing left to offer. */
  down: LineRange | null;
  up: LineRange | null;
  all: LineRange | null;
}

export interface DiffExpansion {
  /** Gaps by the index of the hunk below them, so a row can look its own up. */
  gaps: Map<number, GapView>;
  /** Every revealed line, for the syntax highlighter. */
  extraLines: DiffLine[];
  expand: (gap: DiffGap, range: LineRange, end: GapEnd) => void;
}

/**
 * Reveals the parts of a file the diff left out. State is per file and lives
 * only as long as the review is open — expanding is a way of reading around a
 * change, not something worth persisting.
 */
export function useDiffExpansion(
  runId: string,
  file: DiffFile
): DiffExpansion {
  const [state, setState] = useState<Record<number, GapState>>({});
  const [totalLines, setTotalLines] = useState<number | null>(null);

  // Keyed on the path rather than the object: re-fetching the run re-parses the
  // diff, and the same file coming back as a new object shouldn't collapse
  // everything the reviewer has opened.
  useEffect(() => {
    setState({});
    setTotalLines(null);
  }, [file.path]);

  // A deleted file has no content at the head commit to expand into, and an
  // added one is already shown in full — neither has anything hidden.
  const gaps = useMemo(
    () =>
      file.status === "deleted" || file.status === "added"
        ? []
        : diffGaps(file),
    [file]
  );

  const expand = useCallback(
    async (gap: DiffGap, range: LineRange, end: GapEnd) => {
      setState((prev) => ({
        ...prev,
        [gap.index]: { ...(prev[gap.index] ?? EMPTY), loading: true, error: null },
      }));
      try {
        const result = await fetchReviewFileContext(
          runId,
          file.path,
          range.start,
          range.end
        );
        const lines = gapContextLines(gap, result.start, result.lines);
        setTotalLines(result.totalLines);
        setState((prev) => {
          const current = prev[gap.index] ?? EMPTY;
          return {
            ...prev,
            [gap.index]: {
              head: end === "head" ? [...current.head, ...lines] : current.head,
              tail: end === "tail" ? [...lines, ...current.tail] : current.tail,
              loading: false,
              error: null,
            },
          };
        });
      } catch (e: any) {
        setState((prev) => ({
          ...prev,
          [gap.index]: {
            ...(prev[gap.index] ?? EMPTY),
            loading: false,
            error: e.message,
          },
        }));
      }
    },
    [runId, file.path]
  );

  const views = useMemo(() => {
    const map = new Map<number, GapView>();
    for (const gap of gaps) {
      const current = state[gap.index] ?? EMPTY;
      // What's left of the gap, once what has already been revealed at either
      // end is taken off it.
      const gapEnd = gap.end ?? totalLines;
      const hiddenStart = gap.start + current.head.length;
      const hiddenEnd = gapEnd === null ? null : gapEnd - current.tail.length;
      const remaining =
        hiddenEnd === null ? null : Math.max(0, hiddenEnd - hiddenStart + 1);

      const capped = (to: number) =>
        hiddenEnd === null ? to : Math.min(to, hiddenEnd);

      // One click covers a small gap, so it gets a single control rather than
      // two arrows that would each swallow the whole thing.
      const wholeGap =
        remaining !== null && remaining > 0 && remaining <= EXPAND_STEP;
      const exhausted = remaining === 0;

      map.set(gap.index, {
        ...current,
        gap,
        remaining,
        down:
          exhausted || wholeGap
            ? null
            : { start: hiddenStart, end: capped(hiddenStart + EXPAND_STEP - 1) },
        up:
          exhausted || wholeGap || hiddenEnd === null
            ? null
            : {
                start: Math.max(hiddenStart, hiddenEnd - EXPAND_STEP + 1),
                end: hiddenEnd,
              },
        all:
          exhausted ||
          hiddenEnd === null ||
          remaining === null ||
          remaining > EXPAND_ALL_LIMIT
            ? null
            : { start: hiddenStart, end: hiddenEnd },
      });
    }
    return map;
  }, [gaps, state, totalLines]);

  const extraLines = useMemo(() => {
    const lines: DiffLine[] = [];
    for (const gap of gaps) {
      const current = state[gap.index];
      if (current) lines.push(...current.head, ...current.tail);
    }
    return lines;
  }, [gaps, state]);

  return { gaps: views, extraLines, expand };
}
