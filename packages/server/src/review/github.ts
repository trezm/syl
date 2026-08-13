import type {
  GitRemote,
  PullRequestSummary,
  PullRequestMeta,
  ReviewEvent,
  ReviewCommentSide,
} from "@syl/core";
import { run, CommandError } from "./exec.js";

/** Extract "owner/repo" from any of the URL shapes git remotes come in. */
export function parseRepoFromUrl(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const match = cleaned.match(/[/:]([^/:]+\/[^/:]+)$/);
  return match ? match[1] : null;
}

export async function listRemotes(projectRoot: string): Promise<GitRemote[]> {
  const stdout = await run("git", ["remote", "-v"], { cwd: projectRoot });
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (match) remotes.set(match[1], match[2]);
  }
  // Fall back to push URLs if a remote is push-only.
  if (remotes.size === 0) {
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(push\)$/);
      if (match) remotes.set(match[1], match[2]);
    }
  }
  return [...remotes].map(([name, url]) => ({
    name,
    url,
    repo: parseRepoFromUrl(url),
  }));
}

async function gh<T>(args: string[], projectRoot: string): Promise<T> {
  const stdout = await run("gh", args, { cwd: projectRoot });
  return JSON.parse(stdout) as T;
}

export async function listPullRequests(
  repo: string,
  projectRoot: string,
  limit = 30
): Promise<PullRequestSummary[]> {
  const prs = await gh<
    {
      number: number;
      title: string;
      author: { login: string } | null;
      headRefName: string;
      state: string;
    }[]
  >(
    [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "all",
      "--json",
      "number,title,author,headRefName,state",
      "--limit",
      String(limit),
    ],
    projectRoot
  );

  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? "unknown",
    headRefName: pr.headRefName,
    state: pr.state,
  }));
}

export async function fetchPullRequestMeta(
  repo: string,
  number: number,
  projectRoot: string
): Promise<PullRequestMeta> {
  const meta = await gh<{
    title: string;
    body: string | null;
    author: { login: string } | null;
    baseRefName: string;
    baseRefOid: string | null;
    headRefName: string;
    headRefOid: string | null;
    url: string;
  }>(
    [
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,url",
    ],
    projectRoot
  );

  return {
    repo,
    number,
    title: meta.title,
    body: meta.body ?? "",
    base: meta.baseRefName,
    baseSha: meta.baseRefOid ?? null,
    head: meta.headRefName,
    headSha: meta.headRefOid ?? null,
    author: meta.author?.login ?? "unknown",
    url: meta.url,
  };
}

/** The head commit on its own, for runs cached before it was recorded. */
export async function fetchPullRequestHeadSha(
  repo: string,
  number: number,
  projectRoot: string
): Promise<string | null> {
  const meta = await gh<{ headRefOid: string | null }>(
    ["pr", "view", String(number), "-R", repo, "--json", "headRefOid"],
    projectRoot
  );
  return meta.headRefOid ?? null;
}

/** A ref that names a commit directly, rather than a branch that can move. */
function isCommitish(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** `contents` takes a path, not a query value — each segment is escaped alone. */
function encodePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

/**
 * The contents of `filePath` as of the first of `refs` that resolves.
 *
 * The local checkout is tried first — the base commit of a pull request is
 * usually already fetched, and `git show` costs nothing — with GitHub as the
 * fallback for a clone that has never seen it. Branch names are also tried
 * under the remote, since a base branch often has no local ref at all. The
 * fallback carries the head side: a fork's branch isn't fetchable by name at
 * all, but its head commit is always readable from the base repository.
 */
export async function fetchFileAtRef(options: {
  repo: string;
  remote: string;
  /** Candidate refs, most exact first (base commit, then base branch). */
  refs: string[];
  filePath: string;
  projectRoot: string;
}): Promise<string> {
  const { repo, remote, refs, filePath, projectRoot } = options;
  const localRefs = refs.flatMap((ref) =>
    isCommitish(ref) ? [ref] : [ref, `${remote}/${ref}`]
  );

  for (const ref of localRefs) {
    try {
      return await run("git", ["show", `${ref}:${filePath}`], {
        cwd: projectRoot,
      });
    } catch {
      // Ref or path not in this clone — try the next candidate.
    }
  }

  let lastError: unknown = null;
  for (const ref of refs) {
    try {
      return await run(
        "gh",
        [
          "api",
          "-H",
          "Accept: application/vnd.github.raw",
          `repos/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`,
        ],
        { cwd: projectRoot }
      );
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(
    `Could not read "${filePath}" at ${refs.join(" or ")} — neither this checkout nor GitHub has it.${
      lastError ? ` (${describeGhError(lastError)})` : ""
    }`
  );
}

export async function fetchPullRequestDiff(
  repo: string,
  number: number,
  projectRoot: string
): Promise<string> {
  return run("gh", ["pr", "diff", String(number), "-R", repo], {
    cwd: projectRoot,
  });
}

export interface SubmitReviewInput {
  body: string;
  event: ReviewEvent;
  comments: { path: string; line: number; side: ReviewCommentSide; body: string }[];
}

/**
 * Posts one GitHub review carrying every staged comment, which is what the
 * web UI's "Submit review" button does — the same shape as reviewing on
 * github.com, rather than a scattering of standalone comments.
 */
export async function submitReview(
  repo: string,
  number: number,
  input: SubmitReviewInput,
  projectRoot: string
): Promise<{ url: string; id: number }> {
  const payload = {
    body: input.body,
    event: input.event,
    comments: input.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    })),
  };

  let stdout: string;
  try {
    stdout = await run(
      "gh",
      ["api", `repos/${repo}/pulls/${number}/reviews`, "-X", "POST", "--input", "-"],
      { cwd: projectRoot, input: JSON.stringify(payload) }
    );
  } catch (e) {
    // The payload goes over stdin, so a rejection names neither the review nor
    // the comment it tripped over. Log the anchors that were sent alongside it.
    console.error(
      `Review of ${repo}#${number} (${input.event}) was rejected; anchors sent:${
        payload.comments
          .map((c) => `\n  ${c.path}:${c.line} (${c.side})`)
          .join("") || " none"
      }`
    );
    throw e;
  }

  const result = JSON.parse(stdout) as { html_url: string; id: number };
  return { url: result.html_url, id: result.id };
}

/**
 * GitHub's rejection reasons, as `gh api` leaves them. The one-line summary
 * ("gh: Validation Failed (HTTP 422)") goes to stderr, but the `errors` array
 * naming the offending field lands on stdout with the rest of the body — so a
 * failure read from stderr alone never says what was actually wrong.
 */
interface GitHubApiError {
  message: string;
  details: string[];
}

const FIELD_ERROR_CODES: Record<string, string> = {
  missing: "is missing",
  missing_field: "is required",
  invalid: "is invalid",
  already_exists: "already exists",
  unprocessable: "could not be processed",
};

function describeFieldError(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const { message, resource, field, code } = error as Record<string, unknown>;
  if (typeof message === "string" && message) return message;
  const subject = [resource, field].filter((p) => typeof p === "string").join(".");
  const reason =
    typeof code === "string"
      ? (FIELD_ERROR_CODES[code] ?? `was rejected (${code})`)
      : "was rejected";
  return subject ? `\`${subject}\` ${reason}` : reason;
}

function parseGitHubApiError(stdout: string): GitHubApiError | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body.message !== "string") return null;
  const details = Array.isArray(body.errors)
    ? body.errors.map(describeFieldError).filter(Boolean)
    : [];
  return { message: body.message, details };
}

/** Turn raw command failures into something worth showing a user. */
export function describeGhError(e: unknown): string {
  if (!(e instanceof CommandError)) {
    return e instanceof Error ? e.message : String(e);
  }

  if (e.command === "gh" && e.message.includes("not found on PATH")) {
    return "The GitHub CLI (`gh`) is not installed or not on PATH. Install it from cli.github.com.";
  }
  if (/auth|logged in|authentication/i.test(e.stderr || e.message)) {
    return `GitHub CLI is not authenticated — run \`gh auth login\`. (${e.message})`;
  }

  const api = parseGitHubApiError(e.stdout);
  const summary = e.stderr || api?.message || e.message;
  const details = api?.details ?? [];
  const full = [summary, ...details].join("\n");

  if (/can not approve your own pull request/i.test(full)) {
    return "GitHub does not allow approving your own pull request — submit as a comment instead.";
  }
  if (/must be part of the diff/i.test(full)) {
    return `A comment was anchored to a line GitHub doesn't consider part of the diff. (${details.join("; ") || summary})`;
  }
  return details.length
    ? [summary, ...details.map((d) => `• ${d}`)].join("\n")
    : full;
}
