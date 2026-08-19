import type {
  GitRemote,
  MergeMethod,
  PullRequestMerge,
  PullRequestMergeStatus,
  PullRequestSummary,
  PullRequestFilter,
  PullRequestInvolvement,
  PullRequestMeta,
  ReviewEvent,
  ReviewCommentSide,
} from "@syl/core";
import { DEFAULT_PULL_REQUEST_FILTER } from "@syl/core";
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

/**
 * A pending review request is either a user or a team, and the two arrive with
 * different fields — only the typename tells them apart.
 */
interface ReviewRequest {
  __typename?: string;
  login?: string;
  slug?: string;
  name?: string;
}

function describeReviewer(request: ReviewRequest): string {
  if (request.login) return request.login;
  const team = request.slug ?? request.name;
  return team ? `team/${team}` : "";
}

interface PullRequestListItem {
  number: number;
  title: string;
  author: { login: string } | null;
  headRefName: string;
  state: string;
  assignees: { login: string }[] | null;
  reviewRequests: ReviewRequest[] | null;
}

const LIST_FIELDS =
  "number,title,author,headRefName,state,assignees,reviewRequests";

/**
 * How far down the list to look when an involvement filter is on. The filter
 * is applied here rather than by GitHub (see `listPullRequests`), so the fetch
 * has to be wider than the answer — one page, which covers any repository
 * whose recent pull requests are worth picking from.
 */
const INVOLVEMENT_SCAN_LIMIT = 100;

/**
 * Successful identity lookups, cached for the life of the server: the logged-in
 * user doesn't change under it, and the alternative is two extra API calls on
 * every keystroke-free repo switch. A failure is never cached, so a
 * `gh auth login` part-way through a session takes effect on the next attempt.
 */
const viewerLogins = new Map<string, Promise<string>>();
const viewerTeams = new Map<string, Promise<GitHubTeam[]>>();

interface GitHubTeam {
  slug: string;
  organization?: { login: string } | null;
}

function cachedBy<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, pending);
  return pending;
}

interface Viewer {
  login: string;
  /** Lowercased slugs of the viewer's teams in the repository's org. */
  teamSlugs: Set<string>;
}

async function fetchViewer(repo: string, projectRoot: string): Promise<Viewer> {
  const org = repo.split("/")[0]?.toLowerCase() ?? "";

  const login = await cachedBy(viewerLogins, projectRoot, async () => {
    const user = await gh<{ login: string }>(["api", "user"], projectRoot);
    return user.login;
  });

  // Team membership needs the `read:org` scope, which `gh auth login` doesn't
  // always grant. Without it a team's review request simply doesn't match,
  // rather than the whole listing failing.
  const teams = await cachedBy(viewerTeams, projectRoot, () =>
    gh<GitHubTeam[]>(["api", "user/teams?per_page=100"], projectRoot).catch(
      () => []
    )
  );

  return {
    login: login.toLowerCase(),
    teamSlugs: new Set(
      teams
        .filter((t) => t.organization?.login?.toLowerCase() === org)
        .map((t) => t.slug.toLowerCase())
    ),
  };
}

function isInvolved(
  pr: PullRequestListItem,
  reviewers: string[],
  involvement: PullRequestInvolvement,
  viewer: Viewer
): boolean {
  switch (involvement) {
    case "authored":
      return pr.author?.login?.toLowerCase() === viewer.login;
    case "assigned":
      return (pr.assignees ?? []).some(
        (a) => a.login?.toLowerCase() === viewer.login
      );
    case "review-requested":
      // Reviewers arrive normalised: a login for a person, `team/slug` for a
      // team — so a request made to a team the viewer is in counts too.
      return reviewers.some((reviewer) => {
        const name = reviewer.toLowerCase();
        return name.startsWith("team/")
          ? viewer.teamSlugs.has(name.slice("team/".length))
          : name === viewer.login;
      });
  }
}

/**
 * Recent pull requests, narrowed to the ones the viewer selected.
 *
 * State is GitHub's to filter, but involvement is not: `gh pr list --author`
 * and its siblings go through the search index, which doesn't cover every
 * repository — an unindexed one answers an authored-by query with nothing at
 * all — and search ANDs its terms, where the picker ORs them. So the listing
 * is fetched plainly and matched here against the fields it already carries.
 */
export async function listPullRequests(
  repo: string,
  projectRoot: string,
  filter: PullRequestFilter = DEFAULT_PULL_REQUEST_FILTER,
  limit = 30
): Promise<PullRequestSummary[]> {
  const narrowing = filter.involvement.length > 0;

  const prs = await gh<PullRequestListItem[]>(
    [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      filter.state,
      "--json",
      LIST_FIELDS,
      "--limit",
      String(narrowing ? Math.max(limit, INVOLVEMENT_SCAN_LIMIT) : limit),
    ],
    projectRoot
  );

  const viewer = narrowing ? await fetchViewer(repo, projectRoot) : null;
  const summaries: PullRequestSummary[] = [];

  for (const pr of prs) {
    if (summaries.length >= limit) break;
    const reviewers = (pr.reviewRequests ?? [])
      .map(describeReviewer)
      .filter(Boolean);
    if (
      viewer &&
      !filter.involvement.some((i) => isInvolved(pr, reviewers, i, viewer))
    ) {
      continue;
    }
    summaries.push({
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? "unknown",
      headRefName: pr.headRefName,
      state: pr.state,
      reviewers,
    });
  }

  return summaries;
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

/**
 * The single-pull-request REST endpoint, which answers everything the merge
 * buttons need in one call — where the pull request stands, whether the
 * branches combine, and what the branch actually is. `gh pr view` would need
 * GraphQL's `mergeStateStatus`, which GitHub only serves to users with push
 * access; this shape comes back to anyone who can read the repository.
 */
interface PullRequestApi {
  state: string;
  merged: boolean;
  draft: boolean;
  /** True, false, or null while GitHub is still working it out. */
  mergeable: boolean | null;
  mergeable_state: string;
  commits: number;
  base: { ref: string };
  head: { ref: string; sha: string | null };
  html_url: string;
}

interface RepoApi {
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
}

/** Which buttons the repository's own settings permit. */
function allowedMethods(settings: RepoApi | null): MergeMethod[] {
  // No answer means no reason to grey anything out — GitHub still refuses a
  // method it doesn't allow, and says so plainly when it does.
  if (!settings) return ["squash", "merge"];
  const allowed: MergeMethod[] = [];
  if (settings.allow_squash_merge !== false) allowed.push("squash");
  if (settings.allow_merge_commit !== false) allowed.push("merge");
  return allowed;
}

export async function fetchMergeStatus(
  repo: string,
  number: number,
  projectRoot: string
): Promise<PullRequestMergeStatus> {
  const [pr, settings] = await Promise.all([
    gh<PullRequestApi>(["api", `repos/${repo}/pulls/${number}`], projectRoot),
    // Repository settings are a nicety, not a prerequisite: a token that can
    // read pull requests but not the repository record still gets buttons.
    gh<RepoApi>(["api", `repos/${repo}`], projectRoot).catch(() => null),
  ]);

  return {
    state: pr.merged ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: pr.draft === true,
    mergeable:
      pr.mergeable === null || pr.mergeable === undefined
        ? "unknown"
        : pr.mergeable
          ? "mergeable"
          : "conflicting",
    mergeStateStatus: pr.mergeable_state ?? "unknown",
    commits: pr.commits ?? 0,
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? null,
    allowed: allowedMethods(settings),
    url: pr.html_url,
  };
}

/**
 * Merges the pull request, the way pressing the button on github.com does.
 *
 * `sha` is the commit the caller was looking at when they pressed it: GitHub
 * rejects the merge outright if the branch has moved since, so a push that
 * lands between reading the state and merging can't be merged unseen.
 */
export async function mergePullRequest(
  repo: string,
  number: number,
  input: { method: MergeMethod; sha: string | null },
  projectRoot: string
): Promise<PullRequestMerge> {
  const payload: Record<string, string> = { merge_method: input.method };
  if (input.sha) payload.sha = input.sha;

  const stdout = await run(
    "gh",
    ["api", `repos/${repo}/pulls/${number}/merge`, "-X", "PUT", "--input", "-"],
    { cwd: projectRoot, input: JSON.stringify(payload) }
  );

  const result = JSON.parse(stdout) as {
    merged?: boolean;
    sha?: string;
    message?: string;
  };
  if (result.merged === false) {
    throw new Error(result.message || "GitHub did not merge the pull request.");
  }
  return {
    method: input.method,
    sha: result.sha ?? null,
    mergedAt: new Date().toISOString(),
  };
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
  if (/head branch was modified/i.test(full)) {
    return "The branch moved after syl read its state — refresh the review and try the merge again.";
  }
  if (/not mergeable|pull request is not mergeable/i.test(full)) {
    return "GitHub refused the merge: the pull request isn't mergeable as it stands — conflicts, or a required review or check that hasn't passed.";
  }
  if (/must be part of the diff/i.test(full)) {
    return `A comment was anchored to a line GitHub doesn't consider part of the diff. (${details.join("; ") || summary})`;
  }
  return details.length
    ? [summary, ...details.map((d) => `• ${d}`)].join("\n")
    : full;
}
