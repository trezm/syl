import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ProjectSummary } from "@syl/core";
import {
  addProject,
  fetchProjects,
  removeProject,
  setActiveProject,
} from "../api";

/**
 * Which checkout the window is looking at.
 *
 * One syl server holds several projects at once, so the choice has to live
 * somewhere both the API layer and the UI can see. It's in the URL rather than
 * only in storage: two windows on two repositories is the whole point of not
 * running two servers, and that only works if the address says which is which.
 */

const STORAGE_KEY = "syl-active-project";
const URL_PARAM = "project";

interface ProjectContextValue {
  project: ProjectSummary;
  projects: ProjectSummary[];
  registryPath: string;
  select: (id: string) => void;
  add: (path: string) => Promise<ProjectSummary>;
  remove: (id: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject used outside ProjectProvider");
  return value;
}

/** A per-project localStorage key, so one repo's state can't answer for another's. */
export function projectKey(base: string, projectId: string): string {
  return `${base}:${projectId}`;
}

function readUrlProject(): string | null {
  return new URLSearchParams(window.location.search).get(URL_PARAM);
}

function readStoredProject(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberProject(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get(URL_PARAM) === id) return;
  url.searchParams.set(URL_PARAM, id);
  window.history.replaceState(null, "", url);
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-300">
      <div className="w-full max-w-md px-6">{children}</div>
    </div>
  );
}

/** The form the first run shows, and the one an empty registry falls back to. */
function FirstProject({
  onAdd,
  error,
}: {
  onAdd: (path: string) => void;
  error: string | null;
}) {
  const [path, setPath] = useState("");
  return (
    <div>
      <h1 className="text-sm font-semibold text-gray-200">syl</h1>
      <p className="mt-2 text-xs text-gray-500">
        No projects registered yet. Point syl at a checkout to annotate or
        review it — you can add more later, and switch between them without
        restarting the server.
      </p>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) onAdd(path.trim());
        }}
      >
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/dev/my-project"
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono text-gray-200 focus:outline-none focus:border-purple-500"
        />
        <button
          type="submit"
          className="text-xs px-3 py-1.5 rounded border border-gray-700 text-gray-200 hover:bg-gray-800"
        >
          Add
        </button>
      </form>
      {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
    </div>
  );
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [registryPath, setRegistryPath] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Picks up the server's list and settles on a project: the one in the URL if
   * it still exists, else the last one used here, else the one syl was started
   * in. `preferred` is how a just-added project becomes the active one.
   */
  const load = useCallback(async (preferred?: string) => {
    const list = await fetchProjects();
    setProjects(list.projects);
    setRegistryPath(list.registryPath);

    const known = (id: string | null | undefined) =>
      id && list.projects.some((p) => p.id === id) ? id : null;

    setActiveId(
      (current) =>
        known(preferred) ??
        known(readUrlProject()) ??
        known(current) ??
        known(readStoredProject()) ??
        known(list.defaultId) ??
        list.projects[0]?.id ??
        null
    );
  }, []);

  useEffect(() => {
    load()
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (activeId) rememberProject(activeId);
  }, [activeId]);

  const add = useCallback(
    async (path: string) => {
      const project = await addProject(path);
      await load(project.id);
      return project;
    },
    [load]
  );

  const remove = useCallback(
    async (id: string) => {
      await removeProject(id);
      await load();
    },
    [load]
  );

  const project = projects.find((p) => p.id === activeId) ?? null;

  // Before children render, so the first request they make is already tagged
  // with the project it is about.
  setActiveProject(project?.id ?? null);

  const value = useMemo<ProjectContextValue | null>(
    () =>
      project
        ? {
            project,
            projects,
            registryPath,
            select: setActiveId,
            add,
            remove,
          }
        : null,
    [project, projects, registryPath, add, remove]
  );

  if (loading) {
    return (
      <Centered>
        <p className="text-xs text-gray-600">Loading projects…</p>
      </Centered>
    );
  }

  if (!value) {
    return (
      <Centered>
        <FirstProject
          error={error}
          onAdd={(path) => {
            setError(null);
            add(path).catch((e: any) => setError(e.message));
          }}
        />
      </Centered>
    );
  }

  // Keyed on the project, so switching starts the app over rather than showing
  // one repository's open file, review and scroll position against another's.
  return (
    <ProjectContext.Provider value={value}>
      <Fragment key={value.project.id}>{children}</Fragment>
    </ProjectContext.Provider>
  );
}
