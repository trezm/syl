import { Hono } from "hono";
import path from "node:path";
import type { ReviewCommentSide, ReviewEvent } from "@syl/core";
import {
  AnnotationStore,
  getLanguageForFile,
  parseUnifiedDiff,
} from "@syl/core";
import {
  listRemotes,
  listPullRequests,
  fetchFileAtRef,
  describeGhError,
} from "../review/github.js";
import { describeCommandFailure } from "../review/exec.js";
import { ReviewRunner, MAX_CONTEXT_LINES } from "../review/runner.js";
import { defaultReviewModels, resolveModel } from "../ai/models.js";
import { generateAnnotations } from "../ai/generate.js";
import { nodeFs } from "../util/node-fs.js";
import { semanticPathsFor } from "../util/semantic-paths.js";

function messageFor(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "not found" is the only 404 the comment endpoints raise; the rest are 400s. */
function statusFor(e: unknown): 400 | 404 {
  return /not found/i.test(messageFor(e)) ? 404 : 400;
}

/**
 * A failed request is worth a server log as well as a response — the response
 * carries the reader-facing summary, the log the whole command failure.
 */
function logFailure(what: string, e: unknown): void {
  console.error(`${what} failed:\n  ${describeCommandFailure(e)}`);
}

/** The runner is owned by the caller, so the channel routes can share it. */
export function reviewRoutes(
  projectRoot: string,
  runner: ReviewRunner,
  wasmDir: string,
  treeSitterWasmDir: string
) {
  const app = new Hono();
  const store = new AnnotationStore(path.join(projectRoot, ".syl"), nodeFs());

  // GET /api/review/remotes — git remotes of the project syl is pointed at
  app.get("/remotes", async (c) => {
    try {
      const remotes = await listRemotes(projectRoot);
      return c.json({ remotes, defaults: await defaultReviewModels() });
    } catch (e) {
      logFailure("Listing git remotes", e);
      return c.json({ error: describeGhError(e) }, 500);
    }
  });

  // GET /api/review/prs?repo=owner/name — recent PRs, for the picker
  app.get("/prs", async (c) => {
    const repo = c.req.query("repo");
    if (!repo) return c.json({ error: "repo is required" }, 400);
    try {
      const pullRequests = await listPullRequests(repo, projectRoot);
      return c.json({ pullRequests });
    } catch (e) {
      logFailure(`Listing pull requests for ${repo}`, e);
      return c.json({ error: describeGhError(e) }, 500);
    }
  });

  // POST /api/review — kick off a scout + reviewer run
  app.post("/", async (c) => {
    const body = await c.req.json<{
      remote?: string;
      repo?: string;
      number?: number;
      scoutModel?: string;
      reviewerModel?: string;
      refresh?: boolean;
    }>();

    const number = Number(body.number);
    if (!body.repo || !Number.isInteger(number) || number <= 0) {
      return c.json({ error: "repo and a positive PR number are required" }, 400);
    }

    const defaults = await defaultReviewModels();
    const scoutModel = body.scoutModel ?? defaults.scout;
    const reviewerModel = body.reviewerModel ?? defaults.reviewer;

    if (!scoutModel || !reviewerModel) {
      return c.json(
        { error: "No model is available — set ANTHROPIC_API_KEY or OPENAI_API_KEY." },
        400
      );
    }
    for (const model of [scoutModel, reviewerModel]) {
      if (!resolveModel(model)) {
        return c.json({ error: `Unknown model "${model}"` }, 400);
      }
    }

    const run = runner.start({
      remote: body.remote ?? "origin",
      repo: body.repo,
      number,
      scoutModel,
      reviewerModel,
      refresh: body.refresh === true,
    });

    return c.json({ id: run.id });
  });

  // GET /api/review/runs — past runs, newest first, from the local cache
  app.get("/runs", (c) => {
    const limit = Number(c.req.query("limit"));
    return c.json({
      runs: runner.list(
        Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : undefined
      ),
    });
  });

  // GET /api/review/:id — full run, including the diff once fetched
  app.get("/:id", (c) => {
    const run = runner.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json({ run });
  });

  // GET /api/review/:id/context?path&start&end — lines the diff leaves out, so
  // the reviewer can expand around a hunk
  app.get("/:id/context", async (c) => {
    const path = c.req.query("path");
    const start = Number(c.req.query("start"));
    const end = Number(c.req.query("end"));

    if (!path) return c.json({ error: "path is required" }, 400);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1) {
      return c.json({ error: "start and end must be line numbers" }, 400);
    }
    if (end - start + 1 > MAX_CONTEXT_LINES) {
      return c.json(
        { error: `At most ${MAX_CONTEXT_LINES} lines can be expanded at once.` },
        400
      );
    }

    try {
      return c.json(await runner.fileContext(c.req.param("id"), path, start, end));
    } catch (e) {
      logFailure(`Expanding context in ${path}`, e);
      return c.json({ error: describeGhError(e) }, statusFor(e));
    }
  });

  // POST /api/review/:id/comments — stage an inline comment locally
  app.post("/:id/comments", async (c) => {
    const body = await c.req.json<{
      path?: string;
      line?: number;
      side?: ReviewCommentSide;
      body?: string;
      fromFinding?: string | null;
    }>();

    const line = Number(body.line);
    if (!body.path || !Number.isInteger(line) || line <= 0) {
      return c.json({ error: "path and a positive line are required" }, 400);
    }
    const side: ReviewCommentSide = body.side === "LEFT" ? "LEFT" : "RIGHT";

    try {
      const comment = runner.addComment(c.req.param("id"), {
        path: body.path,
        line,
        side,
        body: body.body ?? "",
        fromFinding: body.fromFinding ?? null,
      });
      return c.json({ comment });
    } catch (e) {
      return c.json({ error: messageFor(e) }, statusFor(e));
    }
  });

  // PATCH /api/review/:id/comments/:commentId — edit a staged comment
  app.patch("/:id/comments/:commentId", async (c) => {
    const body = await c.req.json<{ body?: string }>();
    try {
      const comment = runner.updateComment(
        c.req.param("id"),
        c.req.param("commentId"),
        body.body ?? ""
      );
      return c.json({ comment });
    } catch (e) {
      return c.json({ error: messageFor(e) }, statusFor(e));
    }
  });

  // DELETE /api/review/:id/comments/:commentId — discard a staged comment
  app.delete("/:id/comments/:commentId", (c) => {
    try {
      runner.deleteComment(c.req.param("id"), c.req.param("commentId"));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: messageFor(e) }, statusFor(e));
    }
  });

  // POST /api/review/:id/generate-original — annotate a file as it was before
  // this pull request. Annotations are saved to .syl/ under the file's current
  // path, exactly like a generation run from the annotate tab.
  app.post("/:id/generate-original", async (c) => {
    const body = await c.req.json<{ file?: string; model?: string }>();

    const run = runner.get(c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    if (!body.file || !body.model) {
      return c.json({ error: "file and model are required" }, 400);
    }
    if (!resolveModel(body.model)) {
      return c.json({ error: `Unknown model "${body.model}"` }, 400);
    }
    if (!run.diff) {
      return c.json({ error: "The diff for this run is not available yet." }, 400);
    }

    const file = parseUnifiedDiff(run.diff).find((f) => f.path === body.file);
    if (!file) {
      return c.json(
        { error: `"${body.file}" is not part of this pull request's diff.` },
        400
      );
    }
    // Only a modified file has an original worth annotating: an added one had
    // none, and a deleted one has nothing left for the annotations to hang on.
    if (file.status !== "modified" || file.binary) {
      return c.json(
        {
          error: `"${file.path}" is ${file.binary ? "binary" : file.status}, so it has no original version to annotate.`,
        },
        400
      );
    }

    if (!getLanguageForFile(file.path)) {
      return c.json(
        { error: "Unsupported file type for annotation generation" },
        400
      );
    }

    // Prefer the exact base commit; the branch name is the fallback for runs
    // stored before syl recorded it.
    const refs = [run.meta?.baseSha, run.meta?.base].filter(
      (ref): ref is string => typeof ref === "string" && ref.length > 0
    );
    if (refs.length === 0) {
      return c.json(
        { error: "This run has no base ref recorded — re-run the review." },
        400
      );
    }

    try {
      const content = await fetchFileAtRef({
        repo: run.repo,
        remote: run.remote,
        refs,
        filePath: file.oldPath ?? file.path,
        projectRoot,
      });

      const pathResult = await semanticPathsFor(
        file.path,
        content,
        wasmDir,
        treeSitterWasmDir
      );
      if (pathResult.roots.length === 0) {
        return c.json(
          { error: `No annotatable declarations in the original ${file.path}.` },
          400
        );
      }

      const result = await generateAnnotations({
        model: body.model,
        filePath: file.path,
        fileContent: content,
        pathResult,
        projectRoot,
        store,
        contentNote: `You are annotating ${file.path} as it was before pull request #${run.number}, not as it is now. Describe what that version does, without mentioning the pull request or what it changes.`,
      });

      return c.json({ ok: true, count: result.count });
    } catch (e) {
      logFailure(`Original-file generation for run ${run.id}`, e);
      return c.json({ error: describeGhError(e) }, 500);
    }
  });

  // POST /api/review/:id/submit — publish the staged comments to GitHub
  app.post("/:id/submit", async (c) => {
    const body = await c.req.json<{ body?: string; event?: ReviewEvent }>();
    const event: ReviewEvent =
      body.event === "APPROVE" || body.event === "REQUEST_CHANGES"
        ? body.event
        : "COMMENT";

    try {
      const submission = await runner.submit(c.req.param("id"), {
        body: body.body ?? "",
        event,
      });
      return c.json({ submission });
    } catch (e) {
      logFailure(`Submitting review for run ${c.req.param("id")}`, e);
      return c.json({ error: describeGhError(e) }, statusFor(e));
    }
  });

  return app;
}
