import type { DiffFile, PullRequestMeta } from "@syl/core";

/**
 * All properties required and `additionalProperties: false` throughout, so the
 * schema satisfies OpenAI strict mode as well as Anthropic — same rule as the
 * review schemas.
 */
export const REPLAY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chunks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: {
            type: "integer",
            description:
              "First changed-line number of this step — the [N] from the listing.",
          },
          end: {
            type: "integer",
            description: "Last changed-line number of this step, inclusive.",
          },
          title: {
            type: "string",
            description: "A few words naming the step.",
          },
          description: {
            type: "string",
            description:
              "One or two plain sentences: what this chunk does, and why it comes here in the story when that helps.",
          },
        },
        required: ["start", "end", "title", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["chunks"],
  additionalProperties: false,
};

export function replaySystem(chunkLines: number): string {
  return `You reconstruct how a pull request might have been written, so a
reviewer can watch the work land step by step instead of reading one wall of diff.

You are given the pull request and its changed lines, each numbered like [12].
Divide EVERY numbered line into small chunks, and order the chunks as a plausible
implementation sequence — foundations first (types, schemas, helpers), then the
logic built on them, then callers, wiring and UI, then tests and docs. The real
order is unknown; pick the order that is easiest to follow.

Rules:
- Aim for roughly 1-${chunkLines} changed lines per chunk. This is a guideline,
  not a limit — a chunk should be one coherent piece of the work, however many
  lines that takes, and never cut a statement or block in half to fit.
- A chunk is one contiguous range [start, end] of changed-line numbers within a
  single file. Related lines that are far apart go in separate chunks placed
  next to each other in your ordering.
- Together the chunks must cover every numbered line exactly once — no gaps, no
  overlaps.
- Deleted lines are numbered too, and belong to the step that removes or
  replaces them. Claim them alongside the additions — don't narrate only the
  new code and leave the removals unaccounted for.
- Describe what the chunk does in plain language, as if narrating the author's
  work; don't review it, judge it, or speculate beyond what the code shows.`;
}

/**
 * Characters of numbered listing sent to the model. Lines past the cap still
 * exist in the numbering — normalisation sweeps them into closing steps — so a
 * truncated replay narrates the start and lumps the tail, rather than lying.
 */
const MAX_LISTING_CHARS = 300_000;

/**
 * The diff as a numbered listing: every add/delete line carries the index that
 * `enumerateChangedLines` gives it, and context lines come along unnumbered for
 * readability. The numbering must match that function exactly, so this walks
 * files, hunks and lines in the same order and skips the same lines.
 */
export function replayListing(files: DiffFile[]): {
  text: string;
  truncated: boolean;
} {
  const parts: string[] = [];
  let length = 0;
  let index = 0;
  let truncated = false;

  const append = (part: string): boolean => {
    if (truncated) return false;
    if (length + part.length > MAX_LISTING_CHARS) {
      truncated = true;
      return false;
    }
    parts.push(part);
    length += part.length + 1;
    return true;
  };

  for (const file of files) {
    append(`\n== ${file.path} (${file.status}${file.binary ? ", binary" : ""})`);
    for (const hunk of file.hunks) {
      append(hunk.header);
      for (const line of hunk.lines) {
        if (line.type === "context") {
          append(`       ${line.text}`);
          continue;
        }
        // Numbered even when past the cap, so indices stay aligned with
        // enumerateChangedLines over the full diff.
        index++;
        append(`[${index}] ${line.type === "add" ? "+" : "-"} ${line.text}`);
      }
    }
  }

  return { text: parts.join("\n").trim(), truncated };
}

export function replayPrompt(meta: PullRequestMeta, listing: string): string {
  return `PR #${meta.number}: ${meta.title}
Repository: ${meta.repo}
Base: ${meta.base}   Head: ${meta.head}   Author: @${meta.author}

Description:
${meta.body || "(no description)"}

Changed lines, numbered:
${listing}`;
}
