import type {
  AnnotationFile,
  SemanticNode,
  Annotation,
  LinkTarget,
  GitRemote,
  ReviewCommentSide,
  ReviewEvent,
  DraftComment,
  SubmittedReview,
  PullRequestSummary,
  PullRequestFilter,
  ReviewRun,
  ReviewRunSummary,
} from "@syl/core";
import { pullRequestFilterQuery } from "@syl/core";
import type { AvailableModel } from "./components/ModelSelector";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface ResolveResponse {
  annotations: Record<string, Annotation[]>;
  nodes: SemanticNode[];
  orphans: { path: string; annotations: Annotation[] }[];
}

export async function fetchFileTree(): Promise<FileNode[]> {
  const res = await fetch("/api/files/tree");
  return res.json();
}

export async function fetchFileContent(
  path: string
): Promise<{ path: string; content: string }> {
  const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Failed to read file");
  return res.json();
}

export async function fetchAnnotations(
  file: string
): Promise<AnnotationFile> {
  const res = await fetch(`/api/annotations?file=${encodeURIComponent(file)}`);
  return res.json();
}

export async function resolveAnnotations(
  file: string
): Promise<ResolveResponse> {
  const res = await fetch(
    `/api/annotations/resolve?file=${encodeURIComponent(file)}`
  );
  return res.json();
}

export async function addAnnotation(
  file: string,
  semanticPath: string,
  body: string,
  author: string = "anonymous"
): Promise<Annotation> {
  const res = await fetch("/api/annotations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, path: semanticPath, body, author }),
  });
  return res.json();
}

export async function updateAnnotation(
  id: string,
  file: string,
  semanticPath: string,
  body: string
): Promise<Annotation> {
  const res = await fetch(`/api/annotations/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, path: semanticPath, body }),
  });
  return res.json();
}

export async function deleteAnnotation(
  id: string,
  file: string,
  semanticPath: string
): Promise<void> {
  await fetch(`/api/annotations/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, path: semanticPath }),
  });
}

export async function resolveLinks(
  file: string,
  refs: string[]
): Promise<Record<string, LinkTarget | null>> {
  if (refs.length === 0) return {};
  const res = await fetch("/api/links/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, refs }),
  });
  if (!res.ok) return {};
  const data = await res.json();
  return data.results ?? {};
}

// ---- Review ----

export async function fetchRemotes(): Promise<{
  remotes: GitRemote[];
  defaults: { scout: string | null; reviewer: string | null };
}> {
  const res = await fetch("/api/review/remotes");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to list git remotes");
  return data;
}

export async function fetchPullRequests(
  repo: string,
  filter: PullRequestFilter
): Promise<PullRequestSummary[]> {
  const res = await fetch(
    `/api/review/prs?repo=${encodeURIComponent(repo)}&${pullRequestFilterQuery(filter)}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to list pull requests");
  return data.pullRequests ?? [];
}

export async function startReview(params: {
  remote: string;
  repo: string;
  number: number;
  scoutModel?: string;
  reviewerModel?: string;
  /** Skip the local cache and pay for the models again. */
  refresh?: boolean;
}): Promise<string> {
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to start review");
  return data.id;
}

/** Past runs from the server's local cache — survives a restart. */
export async function fetchReviewRuns(
  limit?: number
): Promise<ReviewRunSummary[]> {
  const res = await fetch(
    `/api/review/runs${limit ? `?limit=${limit}` : ""}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load past reviews");
  return data.runs ?? [];
}

export interface ReviewCacheInfo {
  /** False when the server has no SQLite, so runs only live in its memory. */
  available: boolean;
  path: string | null;
  count: number;
  sizeBytes: number;
  maxRuns: number;
}

export async function fetchReviewCacheInfo(): Promise<ReviewCacheInfo> {
  const res = await fetch("/api/review/cache");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to read the review cache");
  return data;
}

export async function deleteReviewRun(id: string): Promise<void> {
  const res = await fetch(`/api/review/runs/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete the review");
  }
}

export async function clearReviewCache(): Promise<number> {
  const res = await fetch("/api/review/runs", { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to clear the cache");
  return data.removed ?? 0;
}

export interface ReviewRefreshResult {
  run: ReviewRun;
  /** False when the pull request is exactly where the review left it. */
  changed: boolean;
  /** Staged comments the new diff no longer has a line for. */
  outdated: number;
  /** A cached review of the new diff existed, so the findings caught up too. */
  adopted: boolean;
}

/**
 * Pulls the pull request's current state into an existing run — new commits, a
 * new title — without calling the models again.
 */
export async function refreshReviewRun(
  id: string
): Promise<ReviewRefreshResult> {
  const res = await fetch(`/api/review/${id}/refresh`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to refresh the review");
  return data;
}

export async function discardOutdatedComments(id: string): Promise<number> {
  const res = await fetch(`/api/review/${id}/comments/discard-outdated`, {
    method: "POST",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to discard the comments");
  return data.removed ?? 0;
}

export async function fetchReviewRun(id: string): Promise<ReviewRun> {
  const res = await fetch(`/api/review/${id}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load review");
  return data.run;
}

export interface FileContext {
  path: string;
  start: number;
  end: number;
  lines: string[];
  totalLines: number;
}

/** Lines the diff leaves out, read at the commit under review. */
export async function fetchReviewFileContext(
  runId: string,
  path: string,
  start: number,
  end: number
): Promise<FileContext> {
  const query = new URLSearchParams({
    path,
    start: String(start),
    end: String(end),
  });
  const res = await fetch(`/api/review/${runId}/context?${query}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to expand the diff");
  return data;
}

export async function addReviewComment(
  runId: string,
  input: {
    path: string;
    line: number;
    side: ReviewCommentSide;
    body: string;
    fromFinding?: string | null;
  }
): Promise<DraftComment> {
  const res = await fetch(`/api/review/${runId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to add comment");
  return data.comment;
}

export async function updateReviewComment(
  runId: string,
  commentId: string,
  body: string
): Promise<DraftComment> {
  const res = await fetch(`/api/review/${runId}/comments/${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to update comment");
  return data.comment;
}

export async function deleteReviewComment(
  runId: string,
  commentId: string
): Promise<void> {
  const res = await fetch(`/api/review/${runId}/comments/${commentId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete comment");
  }
}

export async function submitReview(
  runId: string,
  input: { body: string; event: ReviewEvent }
): Promise<SubmittedReview> {
  const res = await fetch(`/api/review/${runId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to submit review");
  return data.submission;
}

// ---- Channel: pushing review events into a Claude Code session ----

export interface ChannelSession {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  matchesProject: boolean;
  label: string;
}

export interface ChannelSetup {
  registryDir: string;
  serverPath: string;
  mcpConfig: string;
  command: string;
}

export async function fetchChannelSessions(): Promise<{
  sessions: ChannelSession[];
  setup: ChannelSetup | null;
}> {
  const res = await fetch("/api/channel/sessions");
  if (!res.ok) return { sessions: [], setup: null };
  return res.json();
}

export async function pushToSession(input: {
  sessionId: string;
  runId: string;
  kind: "finding" | "question";
  findingIndex?: number;
  message?: string;
  context?: { file?: string | null; line?: number | null; finding?: string | null };
}): Promise<void> {
  const res = await fetch("/api/channel/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to send to the session");
  }
}

export interface GenerateStatus {
  available: boolean;
  defaultModel: string | null;
  models: AvailableModel[];
}

export async function checkGenerateStatus(): Promise<GenerateStatus> {
  const res = await fetch("/api/generate/status");
  return res.json();
}

export async function generateAnnotation(
  file: string,
  model: string,
  semanticPath: string
): Promise<{ ok: boolean; count: number }> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, model, semanticPath }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Generation failed");
  }
  return res.json();
}

/**
 * Annotates a file in a review as it was *before* the pull request. The result
 * lands in `.syl/` under the file's current path, like any other generation.
 */
export async function generateOriginalAnnotations(
  runId: string,
  file: string,
  model: string
): Promise<{ ok: boolean; count: number }> {
  const res = await fetch(`/api/review/${runId}/generate-original`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, model }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Generation failed");
  return data;
}

export async function generateFileAnnotations(
  file: string,
  model: string
): Promise<{ ok: boolean; count: number }> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, model }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Generation failed");
  }
  return res.json();
}
