import path from "node:path";
import { readEntries, registryDir, type ChannelEntry } from "@syl/channel";
import type { ChannelPayload } from "./payloads.js";

/**
 * Finding and talking to the channel servers Claude Code has spawned.
 *
 * Each running session that loaded syl's channel plugin has its own server
 * listening on a loopback port; the registry under `~/.claude/channels/syl` is
 * how syl discovers them. See `@syl/channel`'s registry module for the contract.
 */

/** What the UI needs to show a session, minus the token. */
export interface SessionSummary {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  /** The session is working in the same project syl is pointed at. */
  matchesProject: boolean;
  /** Last path segment of projectDir — enough to tell two sessions apart. */
  label: string;
}

function sameProject(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function listSessions(projectRoot: string): SessionSummary[] {
  return readEntries().map((entry) => ({
    sessionId: entry.sessionId,
    projectDir: entry.projectDir,
    startedAt: entry.startedAt,
    matchesProject: sameProject(entry.projectDir, projectRoot),
    label: path.basename(entry.projectDir) || entry.projectDir,
  }));
}

function find(sessionId: string): ChannelEntry {
  const entry = readEntries().find((e) => e.sessionId === sessionId);
  if (!entry) {
    throw new Error(
      "That Claude Code session is no longer listening — it may have exited."
    );
  }
  return entry;
}

/** Both directions talk to the same loopback server with the same bearer token. */
async function call(
  entry: ChannelEntry,
  path: string,
  init?: RequestInit
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${entry.port}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.token}`,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    throw new Error(
      `Couldn't reach that session's channel server on port ${entry.port}. ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `The channel server rejected the request (${response.status}). ${body}`.trim()
    );
  }
  return response;
}

/**
 * Hands a payload to one session's channel server. A 202 means it reached the
 * transport, not that Claude has read it: channel notifications aren't
 * acknowledged, and the event may sit queued until the session's next turn.
 * What confirms it landed is a later `syl_reply` against the same event id.
 */
export async function push(
  sessionId: string,
  payload: ChannelPayload
): Promise<void> {
  await call(find(sessionId), "/push", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** A report Claude filed with `syl_reply`, as the channel server stored it. */
export interface ChannelReply {
  seq: number;
  /** The event it answers, when Claude echoed the id back. */
  eventId: string | null;
  status: "done" | "blocked";
  text: string;
  at: string;
}

/**
 * Reports filed since `since`. The buffer lives in the channel process, so it
 * empties when the session exits, and a cursor only means anything within one.
 */
export async function fetchReplies(
  sessionId: string,
  since: number
): Promise<{ replies: ChannelReply[]; cursor: number }> {
  const response = await call(
    find(sessionId),
    `/replies?since=${encodeURIComponent(String(since))}`
  );
  const body = (await response.json()) as {
    replies?: ChannelReply[];
    cursor?: number;
  };
  return { replies: body.replies ?? [], cursor: body.cursor ?? since };
}

/** Shown when nothing is listening, so the panel can say how to fix it. */
export function setupHint(): {
  registryDir: string;
  serverPath: string;
  mcpConfig: string;
  command: string;
} {
  // Resolved from this module rather than cwd, so the path is right regardless
  // of where the server was started from.
  const serverPath = path.resolve(
    new URL("../../../channel/dist/server.js", import.meta.url).pathname
  );

  return {
    registryDir: registryDir(),
    serverPath,
    mcpConfig: JSON.stringify(
      { mcpServers: { syl: { command: "node", args: [serverPath] } } },
      null,
      2
    ),
    command: "claude --dangerously-load-development-channels server:syl",
  };
}
