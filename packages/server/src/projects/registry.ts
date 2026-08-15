import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectSummary } from "@syl/core";

/**
 * The set of repositories one syl instance is pointed at.
 *
 * syl used to resolve a single project root at startup, so a second repository
 * meant a second server on a second port. The registry replaces that: projects
 * are added and removed while the server runs, and every request names the one
 * it is about. The file below is what survives a restart.
 */

const FILE_VERSION = 1;

export interface ProjectRecord extends ProjectSummary {
  addedAt: string;
}

interface RegistryFile {
  version: number;
  projects: ProjectRecord[];
}

/** Alongside syl's other machine-local state. */
export function configDir(): string {
  return process.env.SYL_HOME ?? path.join(os.homedir(), ".syl");
}

export function registryPath(): string {
  return path.join(configDir(), "projects.json");
}

/** `~/dev/syl` is what you'd type; the rest of the server wants it absolute. */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  const home =
    trimmed === "~" || trimmed.startsWith("~/")
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  return path.resolve(home);
}

/**
 * A URL-safe handle for a project, derived from its directory name. Ids are
 * stored rather than recomputed, so renaming a checkout doesn't strand the
 * links and localStorage keys that already name it.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Seed roots for a machine that has never run this build before. */
function seedRoots(): string[] {
  const listed = (process.env.SYL_PROJECTS ?? "")
    .split(/[:,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (listed.length > 0) return listed.map(expandPath);

  // npm runs workspace scripts with cwd set to the workspace dir, so
  // process.cwd() would resolve to packages/server. INIT_CWD is where npm was
  // actually invoked.
  return [
    expandPath(
      process.env.SYL_PROJECT_ROOT || process.env.INIT_CWD || process.cwd()
    ),
  ];
}

/** A request naming a project this server doesn't have, or naming none at all. */
export class ProjectNotFoundError extends Error {
  constructor(id: string | null) {
    super(
      id
        ? `No project "${id}" is registered with this syl server.`
        : "No projects are registered yet — add one to get started."
    );
  }
}

export class ProjectRegistry {
  private projects: ProjectRecord[] = [];

  /**
   * The project syl was started in. `SYL_REVIEW_DB` points at one file, so it
   * can only mean one project — this one.
   */
  readonly primaryRoot: string;

  private constructor(projects: ProjectRecord[], primaryRoot: string) {
    this.projects = projects;
    this.primaryRoot = primaryRoot;
  }

  /**
   * Reads the stored registry, adding the roots this process was started with.
   * A first run therefore behaves exactly as the old single-project server did.
   */
  static load(): ProjectRegistry {
    const stored = readFile();
    const registry = new ProjectRegistry(stored, seedRoots()[0]);

    let added = false;
    for (const root of seedRoots()) {
      if (!registry.byRoot(root) && isDirectory(root)) {
        registry.append(root);
        added = true;
      }
    }
    if (added || stored.length !== registry.projects.length) registry.save();

    return registry;
  }

  list(): ProjectRecord[] {
    return [...this.projects];
  }

  get(id: string): ProjectRecord | null {
    return this.projects.find((p) => p.id === id) ?? null;
  }

  /** What a request with no project named gets: the one syl was started in. */
  default(): ProjectRecord | null {
    return this.byRoot(this.primaryRoot) ?? this.projects[0] ?? null;
  }

  byRoot(root: string): ProjectRecord | null {
    const resolved = path.resolve(root);
    return this.projects.find((p) => p.root === resolved) ?? null;
  }

  /** Adding a directory already registered returns it rather than duplicating it. */
  add(input: string): ProjectRecord {
    const root = expandPath(input);
    const existing = this.byRoot(root);
    if (existing) return existing;

    if (!fs.existsSync(root)) {
      throw new Error(`${root} doesn't exist.`);
    }
    if (!isDirectory(root)) {
      throw new Error(`${root} is not a directory.`);
    }

    const record = this.append(root);
    this.save();
    return record;
  }

  /** Forgets a project. Nothing on disk is touched — `.syl/` stays where it is. */
  remove(id: string): ProjectRecord {
    const index = this.projects.findIndex((p) => p.id === id);
    if (index === -1) throw new ProjectNotFoundError(id);
    const [removed] = this.projects.splice(index, 1);
    this.save();
    return removed;
  }

  private append(root: string): ProjectRecord {
    const record: ProjectRecord = {
      id: uniqueId(
        slugify(path.basename(root)),
        new Set(this.projects.map((p) => p.id))
      ),
      name: path.basename(root) || root,
      root,
      addedAt: new Date().toISOString(),
    };
    this.projects.push(record);
    return record;
  }

  /** Best-effort: a read-only home directory shouldn't stop the server. */
  private save(): void {
    const file: RegistryFile = {
      version: FILE_VERSION,
      projects: this.projects,
    };
    try {
      fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(registryPath(), JSON.stringify(file, null, 2));
    } catch (e) {
      console.warn(
        `[syl] Could not write ${registryPath()} — projects added in this session won't survive a restart.`,
        e
      );
    }
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Rows whose directory has since been deleted are dropped on load: a project
 * pointing at nothing can only produce errors in every tab that uses it.
 */
function readFile(): ProjectRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath(), "utf-8");
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!Array.isArray(parsed.projects)) return [];
    const seen = new Set<string>();
    return parsed.projects.filter((record) => {
      if (typeof record?.id !== "string" || typeof record?.root !== "string") {
        return false;
      }
      if (seen.has(record.id) || !isDirectory(record.root)) return false;
      seen.add(record.id);
      return true;
    });
  } catch {
    console.warn(`[syl] ${registryPath()} is not readable JSON — ignoring it.`);
    return [];
  }
}
