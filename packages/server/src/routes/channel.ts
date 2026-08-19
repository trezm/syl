import { Hono } from "hono";
import type { Finding } from "@syl/core";
import { sortFindings } from "@syl/core";
import type { Workspace } from "../projects/workspace.js";
import { fetchReplies, listSessions, push, setupHint } from "../channel/sessions.js";
import { findingPayload, questionPayload, withEvent } from "../channel/payloads.js";

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
 *
 * Every push is stamped with an event id, and `/replies` is where whatever
 * Claude filed against those ids with `syl_reply` comes back.
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

        const { payload, eventId } = withEvent(
          findingPayload(run.repo, run.number, run.meta, run.diff, finding)
        );
        await push(body.sessionId, payload);
        return c.json({ sent: "finding", title: finding.title, eventId });
      }

      const message = (body.message ?? "").trim();
      if (!message) return c.json({ error: "A message is required." }, 400);

      const { payload, eventId } = withEvent(
        questionPayload(
          run.repo,
          run.number,
          run.meta,
          run.diff,
          message,
          body.context ?? {}
        )
      );
      await push(body.sessionId, payload);
      return c.json({ sent: "question", eventId });
    } catch (e) {
      return c.json({ error: messageFor(e) }, 400);
    }
  });

  // GET /api/channel/replies?sessionId=&since= — reports filed since the cursor
  app.get("/replies", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    const since = Number(c.req.query("since") ?? 0);

    try {
      return c.json(
        await fetchReplies(sessionId, Number.isFinite(since) ? since : 0)
      );
    } catch (e) {
      // A session that has exited is the ordinary case here, not an outage —
      // the panel polls this and drops the cursor when it goes.
      return c.json({ error: messageFor(e) }, 404);
    }
  });

  return app;
}
