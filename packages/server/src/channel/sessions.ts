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

/**
 * Hands a payload to one session's channel server. A 202 means it reached the
 * transport, not that Claude has read it: channel notifications aren't
 * acknowledged, and the event may sit queued until the session's next turn.
 */
export async function push(
  sessionId: string,
  payload: ChannelPayload
): Promise<void> {
  const entry = find(sessionId);

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${entry.port}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify(payload),
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
      `The channel server rejected the push (${response.status}). ${body}`.trim()
    );
  }
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
