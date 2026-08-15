import { Hono } from "hono";
import type { Finding } from "@syl/core";
import { sortFindings } from "@syl/core";
import type { Workspace } from "../projects/workspace.js";
import { listSessions, push, setupHint } from "../channel/sessions.js";
import { findingPayload, questionPayload } from "../channel/payloads.js";

function messageFor(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The channel endpoints: what Claude Code sessions are listening, and pushing a
 * review event into one. Payloads are built from the project's stored run
 * rather than from whatever the browser sends.
 *
 * Sessions themselves are machine-wide — every Claude Code session on this
 * machine is listed whichever project you are in, and it's `matchesProject`
 * that says which of them is working in the one you're looking at.
 */
export function channelRoutes(workspace: Workspace) {
  const app = new Hono();

  // GET /api/channel/sessions — sessions with syl's channel loaded, right now
  app.get("/sessions", (c) => {
    const sessions = listSessions(workspace.require(c).root);
    return c.json({
      sessions,
      // Setup only matters when there's nothing to push to; sending it always
      // would mean leaking an absolute path into every poll response.
      setup: sessions.length === 0 ? setupHint() : null,
    });
  });

  // POST /api/channel/push — send a finding or a question to one session
  app.post("/push", async (c) => {
    const { runner } = workspace.require(c);
    const body = await c.req.json<{
      sessionId?: string;
      runId?: string;
      kind?: "finding" | "question";
      findingIndex?: number;
      message?: string;
      context?: { file?: string | null; line?: number | null; finding?: string | null };
    }>();

    if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
    if (!body.runId) return c.json({ error: "runId is required" }, 400);

    const run = runner.get(body.runId);
    if (!run) return c.json({ error: "run not found" }, 404);

    try {
      if (body.kind === "finding") {
        // Findings are addressed by their position in the sorted list the UI
        // renders, so the index the user clicked is the one that gets sent.
        const findings: Finding[] = sortFindings(run.review?.findings ?? []);
        const finding = findings[body.findingIndex ?? -1];
        if (!finding) return c.json({ error: "finding not found" }, 404);

        await push(
          body.sessionId,
          findingPayload(run.repo, run.number, run.meta, run.diff, finding)
        );
        return c.json({ sent: "finding", title: finding.title });
      }

      const message = (body.message ?? "").trim();
      if (!message) return c.json({ error: "A message is required." }, 400);

      await push(
        body.sessionId,
        questionPayload(
          run.repo,
          run.number,
          run.meta,
          run.diff,
          message,
          body.context ?? {}
        )
      );
      return c.json({ sent: "question" });
    } catch (e) {
      return c.json({ error: messageFor(e) }, 400);
    }
  });

  return app;
}
