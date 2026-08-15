import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ReviewRun, ReviewRunSummary } from "@syl/core";
import { summarizeRun } from "@syl/core";

type SqliteModule = typeof import("node:sqlite");
type Database = InstanceType<SqliteModule["DatabaseSync"]>;

/**
 * Bumped whenever the table shape changes. Everything here is a cache of work
 * that can be redone, so a mismatch drops the table rather than migrating it.
 */
const SCHEMA_VERSION = 1;

/** Rows kept on disk. Old runs are pruned oldest-first past this. */
export const MAX_STORED_RUNS = 200;

/**
 * `node:sqlite` is built into Node from 22.5. Node 20 — still supported for
 * running syl — has no SQLite at all, so this has to be allowed to fail.
 * `createRequire` rather than `await import` because the store is opened from
 * the synchronous route/runner constructors.
 */
function loadSqlite(): SqliteModule | null {
  try {
    return createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

/**
 * `SYL_REVIEW_DB` names one file, so it can only stand in for one project's
 * cache — the project syl was started in. Every other registered project keeps
 * its own, because a shared file would mix repositories together in one history.
 */
export function reviewDbPath(projectRoot: string, allowOverride = true): string {
  const override = process.env.SYL_REVIEW_DB;
  if (override && allowOverride) return path.resolve(override);
  return path.join(projectRoot, ".syl", "cache", "reviews.db");
}

/**
 * The cache sits under `.syl/`, which projects are meant to commit — so the
 * directory ignores itself rather than relying on every project's .gitignore.
 */
function prepareDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "# syl's local review cache — not source material\n*\n");
  }
}

/**
 * Persists review runs so they survive a server restart, and lets an identical
 * review be answered from disk instead of paying for the models again.
 *
 * The whole run is stored as JSON; the columns beside it exist only so history
 * and cache lookups don't have to parse every row.
 */
export class ReviewStore {
  private constructor(
    private db: Database,
    /** Where the cache lives, so the UI can name the file it's offering to clear. */
    readonly path: string
  ) {}

  /** Returns null when SQLite isn't available or the file can't be opened. */
  static open(projectRoot: string, allowDbOverride = true): ReviewStore | null {
    const sqlite = loadSqlite();
    if (!sqlite) {
      console.warn(
        "[syl] node:sqlite is unavailable (Node 22.5+ required) — review runs will be kept in memory only."
      );
      return null;
    }

    const dbPath = reviewDbPath(projectRoot, allowDbOverride);
    try {
      prepareDir(dbPath);
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");

      const row = db.prepare("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined;
      if ((row?.user_version ?? 0) !== SCHEMA_VERSION) {
        db.exec("DROP TABLE IF EXISTS runs");
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          number INTEGER NOT NULL,
          phase TEXT NOT NULL,
          input_hash TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          data TEXT NOT NULL
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS runs_by_input ON runs (input_hash, started_at DESC)"
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS runs_by_started ON runs (started_at DESC)"
      );

      return new ReviewStore(db, dbPath);
    } catch (e) {
      console.warn(
        `[syl] Could not open the review cache at ${dbPath} — runs will be kept in memory only.`,
        e
      );
      return null;
    }
  }

  save(run: ReviewRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, repo, number, phase, input_hash, started_at, finished_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           phase = excluded.phase,
           input_hash = excluded.input_hash,
           finished_at = excluded.finished_at,
           data = excluded.data`
      )
      .run(
        run.id,
        run.repo,
        run.number,
        run.phase,
        run.inputHash,
        run.startedAt,
        run.finishedAt,
        JSON.stringify(run)
      );
  }

  load(id: string): ReviewRun | null {
    const row = this.db
      .prepare("SELECT data FROM runs WHERE id = ?")
      .get(id) as { data: string } | undefined;
    return row ? this.parse(row.data) : null;
  }

  /**
   * The newest finished run whose inputs match — same diff, same PR metadata,
   * same models, same prompts. Failed and in-flight runs are never served.
   */
  findByInputHash(inputHash: string): ReviewRun | null {
    const row = this.db
      .prepare(
        `SELECT data FROM runs
         WHERE input_hash = ? AND phase = 'done'
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(inputHash) as { data: string } | undefined;
    return row ? this.parse(row.data) : null;
  }

  list(limit: number): ReviewRunSummary[] {
    const rows = this.db
      .prepare("SELECT data FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as { data: string }[];
    return rows
      .map((row) => this.parse(row.data))
      .filter((run): run is ReviewRun => run !== null)
      .map(summarizeRun);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  }

  /** Empties the cache. The file itself stays — SQLite reuses the pages. */
  clear(): number {
    const { count } = this.stats();
    this.db.exec("DELETE FROM runs");
    return count;
  }

  /** What the cache tab reports: where it is, and how much is in it. */
  stats(): { path: string; count: number; sizeBytes: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as
      | { n: number }
      | undefined;
    let sizeBytes = 0;
    try {
      // WAL and index files sit beside the database; the main file is close
      // enough for a "this is what it costs you" number.
      sizeBytes = fs.statSync(this.path).size;
    } catch {
      // Not yet flushed to disk, or gone — a zero reads better than a throw.
    }
    return { path: this.path, count: row?.n ?? 0, sizeBytes };
  }

  prune(max = MAX_STORED_RUNS): void {
    this.db
      .prepare(
        `DELETE FROM runs WHERE id IN (
           SELECT id FROM runs ORDER BY started_at DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(max);
  }

  close(): void {
    this.db.close();
  }

  /** A row written by an older build is treated as a miss, not a crash. */
  private parse(data: string): ReviewRun | null {
    try {
      const run = JSON.parse(data) as ReviewRun;
      // Fields added after this row was written. They're additive, so the run
      // is filled in rather than thrown away: an old review is exactly what
      // the cache is for. A run nobody has refreshed is current by definition,
      // which is what `currentHash = inputHash` says.
      run.refreshedAt ??= null;
      run.currentHash ??= run.inputHash;
      run.comments ??= [];
      for (const comment of run.comments) comment.outdatedAt ??= null;
      return run;
    } catch {
      return null;
    }
  }
}
