import type { DiffFile } from "./diff.js";

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export type FindingCategory =
  | "bug"
  | "security"
  | "performance"
  | "correctness"
  | "design"
  | "test";

export type RiskLevel = "high" | "medium" | "low";

export interface ScoutFocusArea {
  file: string;
  reason: string;
  risk: RiskLevel;
}

/** Stage one: cheap triage that tells the reviewer where to look. */
export interface ScoutResult {
  intent: string;
  focus_areas: ScoutFocusArea[];
}

export interface Finding {
  file: string;
  /** Best-guess line in the NEW version of the file. */
  line: number;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  description: string;
  suggestion: string;
}

/** Stage two: the actual review. */
export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

export interface GitRemote {
  name: string;
  url: string;
  /** "owner/repo", or null when the URL isn't a recognisable GitHub remote. */
  repo: string | null;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  state: string;
  /**
   * Who GitHub is still waiting on — logins for users, `team/slug` for teams.
   * A request disappears once that reviewer submits, so this is the pending
   * set rather than everyone who was ever asked.
   */
  reviewers: string[];
}

/**
 * How the viewer is connected to a pull request. The picker ORs the selected
 * ones together — a relation GitHub's search syntax can't express, since it
 * ANDs its terms — so the match is made from the listed fields instead.
 */
export type PullRequestInvolvement = "authored" | "assigned" | "review-requested";

export const PULL_REQUEST_INVOLVEMENTS: PullRequestInvolvement[] = [
  "authored",
  "assigned",
  "review-requested",
];

/** The states `gh pr list` accepts. "closed" includes merged, as GitHub's own. */
export type PullRequestStateFilter = "open" | "closed" | "merged" | "all";

export const PULL_REQUEST_STATE_FILTERS: PullRequestStateFilter[] = [
  "open",
  "closed",
  "merged",
  "all",
];

export interface PullRequestFilter {
  /** Empty matches every pull request, whoever it belongs to. */
  involvement: PullRequestInvolvement[];
  state: PullRequestStateFilter;
}

/** Yours, one way or another, and still open. */
export const DEFAULT_PULL_REQUEST_FILTER: PullRequestFilter = {
  involvement: [...PULL_REQUEST_INVOLVEMENTS],
  state: "open",
};

/**
 * A filter as it travels in a query string, so the picker and the route agree
 * on it. An absent `involvement` is the default set rather than none: only an
 * explicitly empty one means "everyone's".
 */
export function parsePullRequestFilter(params: {
  involvement?: string | null;
  state?: string | null;
}): PullRequestFilter {
  const involvement =
    params.involvement == null
      ? [...DEFAULT_PULL_REQUEST_FILTER.involvement]
      : params.involvement
          .split(",")
          .map((part) => part.trim())
          .filter((part): part is PullRequestInvolvement =>
            (PULL_REQUEST_INVOLVEMENTS as string[]).includes(part)
          );

  const state = PULL_REQUEST_STATE_FILTERS.find((s) => s === params.state);
  return {
    involvement,
    state: state ?? DEFAULT_PULL_REQUEST_FILTER.state,
  };
}

export function pullRequestFilterQuery(filter: PullRequestFilter): string {
  return new URLSearchParams({
    involvement: filter.involvement.join(","),
    state: filter.state,
  }).toString();
}

export interface PullRequestMeta {
  repo: string;
  number: number;
  title: string;
  body: string;
  base: string;
  /**
   * Commit the pull request is based on — the exact tree a file's "original"
   * version comes from. Null on runs stored before this was recorded, where the
   * base branch name is the only handle left.
   */
  baseSha: string | null;
  head: string;
  /**
   * Commit the head branch points at. Expanding the diff reads files at this
   * commit; null on runs stored before it was recorded, which are filled in on
   * demand.
   */
  headSha: string | null;
  author: string;
  url: string;
}

/** GitHub anchors inline comments to a side of the diff: the new file or the old. */
export type ReviewCommentSide = "RIGHT" | "LEFT";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface DraftComment {
  id: string;
  path: string;
  /** Line number within the file on `side`. Must be a line the diff touches. */
  line: number;
  side: ReviewCommentSide;
  body: string;
  /** Title of the finding this came from, or null when hand-written. */
  fromFinding: string | null;
  createdAt: string;
  /**
   * When a refresh found that this comment's line is no longer part of the
   * diff — the pull request has been rewritten under it. GitHub would reject
   * the anchor, so an outdated comment can't be submitted. Null while it still
   * lands somewhere real, including after a refresh that puts the line back.
   */
  outdatedAt: string | null;
}

export interface SubmittedReview {
  url: string;
  event: ReviewEvent;
  commentCount: number;
  submittedAt: string;
}

export const REVIEW_EVENTS: { value: ReviewEvent; label: string; hint: string }[] =
  [
    {
      value: "COMMENT",
      label: "Comment",
      hint: "Submit general feedback without explicit approval.",
    },
    {
      value: "REQUEST_CHANGES",
      label: "Request changes",
      hint: "Submit feedback that must be addressed before merging.",
    },
    {
      value: "APPROVE",
      label: "Approve",
      hint: "Submit feedback and approve merging these changes.",
    },
  ];

export type ReviewPhase =
  | "fetching"
  | "scout"
  | "reviewer"
  | "done"
  | "failed";

/** Where a finished review's findings came from. */
export interface ReviewReuse {
  /** The earlier run whose scout + reviewer output this run adopted. */
  runId: string;
  /** When that run was started, so the UI can say how old the result is. */
  startedAt: string;
}

export interface ReviewRun {
  id: string;
  repo: string;
  remote: string;
  number: number;
  phase: ReviewPhase;
  scoutModel: string;
  reviewerModel: string;
  /** "cli" (subscription) or "sdk" (per-token API), recorded per stage. */
  scoutBackend: string | null;
  reviewerBackend: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  meta: PullRequestMeta | null;
  scout: ScoutResult | null;
  review: ReviewResult | null;
  /** Raw unified diff; the client parses it for display. */
  diff: string | null;
  /** Set when the diff was too large to send to the models in full. */
  diffTruncated: boolean;
  /**
   * Hash of everything the models were given — diff, PR metadata, model ids and
   * the prompts themselves. Two runs sharing it must produce the same review,
   * which is what makes the local cache safe. Null until the diff is fetched.
   *
   * Pinned to the findings, not to the diff on screen: a refresh that pulls in
   * new commits moves `currentHash` on and leaves this where the models left
   * it, so the cache never serves these findings for a diff they never saw.
   */
  inputHash: string | null;
  /**
   * The same hash over the pull request as it currently stands. Equal to
   * `inputHash` until a refresh finds the pull request has moved on.
   */
  currentHash: string | null;
  /** When the pull request was last re-fetched into this run. Null if never. */
  refreshedAt: string | null;
  /** Set when the models were skipped in favour of a cached review. */
  reusedFrom: ReviewReuse | null;
  /** Comments staged locally, not yet sent to GitHub. */
  comments: DraftComment[];
  /** Reviews already posted from this run, newest last. */
  submissions: SubmittedReview[];
}

/**
 * Whether the pull request has moved on since the models ran. Only a refresh
 * can discover this, so a run nobody has refreshed is never stale — it is
 * simply as old as it is.
 */
export function isReviewStale(run: ReviewRun): boolean {
  return (
    run.inputHash !== null &&
    run.currentHash !== null &&
    run.currentHash !== run.inputHash
  );
}

export function outdatedComments(run: ReviewRun): DraftComment[] {
  return run.comments.filter((c) => c.outdatedAt !== null);
}

/** A row in the run history — everything the picker shows, without the diff. */
export interface ReviewRunSummary {
  id: string;
  repo: string;
  remote: string;
  number: number;
  title: string | null;
  phase: ReviewPhase;
  startedAt: string;
  finishedAt: string | null;
  refreshedAt: string | null;
  scoutModel: string;
  reviewerModel: string;
  findingCount: number;
  /** Comments staged against this run and not yet posted, outdated ones included. */
  pendingComments: number;
  /** Of those, the ones a refresh found no longer anchored to the diff. */
  outdatedComments: number;
  submissionCount: number;
  reused: boolean;
  /** The pull request has changed since this review's findings were written. */
  stale: boolean;
  error: string | null;
}

export function summarizeRun(run: ReviewRun): ReviewRunSummary {
  return {
    id: run.id,
    repo: run.repo,
    remote: run.remote,
    number: run.number,
    title: run.meta?.title ?? null,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    refreshedAt: run.refreshedAt,
    scoutModel: run.scoutModel,
    reviewerModel: run.reviewerModel,
    findingCount: run.review?.findings.length ?? 0,
    pendingComments: run.comments.length,
    outdatedComments: outdatedComments(run).length,
    submissionCount: run.submissions.length,
    reused: run.reusedFrom !== null,
    stale: isReviewStale(run),
    error: run.error,
  };
}

export const SEVERITY_ORDER: FindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

export function severityRank(severity: FindingSeverity): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
}

/** Where syl lives, for the attribution on anything it writes to GitHub. */
export const SYL_REPO_URL = "https://github.com/trezm/syl";

/**
 * The line that marks a comment as machine-written. Every finding syl posts
 * carries it, so nobody reading the pull request has to guess whether a human
 * wrote it — and the link says which tool did.
 */
export const SYL_ATTRIBUTION = `<sub>Generated by [syl](${SYL_REPO_URL}).</sub>`;

/**
 * Pre-fills a review comment from a finding, in GitHub-flavoured markdown.
 *
 * The attribution is on by default: anything headed for a pull request should
 * say where it came from. Callers keeping the text inside syl — the channel
 * payloads, say — pass `attribution: false`.
 */
export function findingToCommentBody(
  finding: Finding,
  options: { attribution?: boolean } = {}
): string {
  const parts = [
    `**${finding.severity.toUpperCase()} · ${finding.category}** — ${finding.title}`,
    "",
    finding.description,
  ];
  if (finding.suggestion) {
    parts.push("", "**Suggestion**", "", finding.suggestion);
  }
  if (options.attribution ?? true) {
    parts.push("", SYL_ATTRIBUTION);
  }
  return parts.join("\n").trim();
}

export function commentTargetKey(
  side: ReviewCommentSide,
  line: number
): string {
  return `${side}:${line}`;
}

/**
 * The (side, line) pairs GitHub will accept an inline comment on — i.e. lines
 * the diff actually touches. Posting outside this set is rejected by the API,
 * so both the UI and the server check against it first.
 */
export function diffCommentTargets(files: DiffFile[]): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const file of files) {
    const keys = new Set<string>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== null) {
          keys.add(commentTargetKey("RIGHT", line.newLine));
        }
        if (line.oldLine !== null) {
          keys.add(commentTargetKey("LEFT", line.oldLine));
        }
      }
    }
    targets.set(file.path, keys);
  }
  return targets;
}

export function canCommentOn(
  targets: Map<string, Set<string>>,
  path: string,
  line: number,
  side: ReviewCommentSide
): boolean {
  return targets.get(path)?.has(commentTargetKey(side, line)) ?? false;
}

/**
 * Where a finding's comment should hang. Findings name a line in the new file,
 * so they anchor to the RIGHT side; one that isn't in the diff can't be posted
 * inline and returns null.
 */
export function anchorForFinding(
  targets: Map<string, Set<string>>,
  finding: Finding
): { path: string; line: number; side: ReviewCommentSide } | null {
  if (canCommentOn(targets, finding.file, finding.line, "RIGHT")) {
    return { path: finding.file, line: finding.line, side: "RIGHT" };
  }
  return null;
}
