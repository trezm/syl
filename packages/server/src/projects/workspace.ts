import path from "node:path";
import type { Context } from "hono";
import { AnnotationStore } from "@syl/core";
import { ProjectIndex } from "../links/project-index.js";
import { ReviewRunner } from "../review/runner.js";
import { nodeFs } from "../util/node-fs.js";
import {
  ProjectNotFoundError,
  ProjectRegistry,
  type ProjectRecord,
} from "./registry.js";

/**
 * One project's server-side state: the symbol index behind annotation links,
 * the review runner and its cache, and the annotation store under `.syl/`.
 *
 * Everything here is built on first use rather than at startup — registering a
 * repository you don't open costs nothing, and a project's SQLite file is only
 * opened once you actually review something in it.
 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly index: ProjectIndex;
  readonly runner: ReviewRunner;
  readonly store: AnnotationStore;
}

/** The query parameter every project-scoped endpoint is addressed by. */
export const PROJECT_PARAM = "project";

class LoadedProject implements Project {
  private indexed: ProjectIndex | null = null;
  private reviews: ReviewRunner | null = null;
  private annotations: AnnotationStore | null = null;

  constructor(
    private record: ProjectRecord,
    private grammarWasmDir: string,
    private treeSitterWasmDir: string,
    /** True for the project syl was started in — see ProjectRegistry.primaryRoot. */
    private primary: boolean
  ) {}

  get id(): string {
    return this.record.id;
  }

  get name(): string {
    return this.record.name;
  }

  get root(): string {
    return this.record.root;
  }

  get index(): ProjectIndex {
    return (this.indexed ??= new ProjectIndex(
      this.root,
      this.grammarWasmDir,
      this.treeSitterWasmDir
    ));
  }

  get runner(): ReviewRunner {
    return (this.reviews ??= new ReviewRunner(this.root, {
      allowDbOverride: this.primary,
    }));
  }

  get store(): AnnotationStore {
    return (this.annotations ??= new AnnotationStore(
      path.join(this.root, ".syl"),
      nodeFs()
    ));
  }

  close(): void {
    this.reviews?.close();
  }
}

/**
 * The registry plus the live state each project needs, and the one place a
 * request is turned into the project it is about.
 */
export class Workspace {
  private loaded = new Map<string, LoadedProject>();

  constructor(
    private registry: ProjectRegistry,
    private grammarWasmDir: string,
    private treeSitterWasmDir: string
  ) {}

  list(): ProjectRecord[] {
    return this.registry.list();
  }

  defaultId(): string | null {
    return this.registry.default()?.id ?? null;
  }

  add(input: string): ProjectRecord {
    return this.registry.add(input);
  }

  remove(id: string): ProjectRecord {
    const removed = this.registry.remove(id);
    this.loaded.get(id)?.close();
    this.loaded.delete(id);
    return removed;
  }

  get(id: string): Project | null {
    const record = this.registry.get(id);
    if (!record) return null;

    const live = this.loaded.get(id);
    if (live) return live;

    const project = new LoadedProject(
      record,
      this.grammarWasmDir,
      this.treeSitterWasmDir,
      record.root === this.registry.primaryRoot
    );
    this.loaded.set(id, project);
    return project;
  }

  /**
   * The project a request is about, from `?project=<id>`. Omitting it falls
   * back to the project syl was started in, so the API stays usable by hand.
   *
   * Throws rather than returning null: every handler needs a project before it
   * can do anything, and the thrown error is turned into a 404 centrally.
   */
  require(c: Context): Project {
    const id = c.req.query(PROJECT_PARAM) ?? this.defaultId();
    if (!id) throw new ProjectNotFoundError(null);
    const project = this.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }
}

export { ProjectNotFoundError };
