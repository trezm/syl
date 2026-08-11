import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The contract between a channel server and syl.
 *
 * Claude Code spawns one channel server per session, so there is no single
 * well-known port to talk to — and hardcoding one (as the fakechat demo does)
 * breaks the moment you have two sessions open. Instead each instance binds an
 * ephemeral port and drops a file here saying who it is and how to reach it.
 * syl reads the directory to find out which sessions are available to push to.
 *
 * This module is deliberately free of the MCP SDK: syl's server imports it to
 * read the directory, and only the channel process itself needs the protocol.
 */

export interface ChannelEntry {
  /** The Claude Code session this server was spawned by. */
  sessionId: string;
  /** That session's project directory, for matching against syl's project. */
  projectDir: string;
  /** Ephemeral loopback port this instance is listening on. */
  port: number;
  /** Liveness check — a hard kill leaves the file behind. */
  pid: number;
  /** Bearer token required to push. The file is 0600; the token is the gate. */
  token: string;
  startedAt: string;
}

/** Alongside the other channel plugins' state, under `~/.claude/channels`. */
export function registryDir(): string {
  return (
    process.env.SYL_CHANNEL_DIR ??
    path.join(os.homedir(), ".claude", "channels", "syl")
  );
}

function entryPath(sessionId: string): string {
  // Session ids are UUIDs, but this is a filename built from an env var, so
  // anything that could climb out of the directory is flattened first.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(registryDir(), `${safe}.json`);
}

export function writeEntry(entry: ChannelEntry): string {
  const dir = registryDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = entryPath(entry.sessionId);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
  return file;
}

export function removeEntry(sessionId: string): void {
  try {
    fs.unlinkSync(entryPath(sessionId));
  } catch {
    // Already gone, or never written.
  }
}

/** Signal 0 tests for existence without delivering anything. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Every channel server currently running. Entries whose process has died are
 * dropped and their files cleaned up, so a `kill -9`'d session doesn't linger
 * in syl's picker forever.
 */
export function readEntries(): ChannelEntry[] {
  const dir = registryDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const live: ChannelEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let entry: ChannelEntry;
    try {
      entry = JSON.parse(fs.readFileSync(file, "utf8")) as ChannelEntry;
    } catch {
      continue;
    }
    if (!entry?.sessionId || !entry.port || !entry.pid) continue;
    if (!isAlive(entry.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Someone else got there first.
      }
      continue;
    }
    live.push(entry);
  }

  return live.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
