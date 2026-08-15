import { useEffect, useRef, useState } from "react";
import { useProject } from "./ProjectContext";

/**
 * The header control for "which repository am I in". The select switches; the
 * panel behind the ⋯ is where checkouts are added and forgotten, so the common
 * case stays one click and managing the list doesn't crowd the header.
 */
export default function ProjectSwitcher() {
  const { project, projects, registryPath, select, add, remove } = useProject();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (!container.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const run = async (action: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action;
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex items-center gap-1" ref={container}>
      <select
        value={project.id}
        onChange={(e) => select(e.target.value)}
        title={project.root}
        className="bg-gray-800 text-gray-300 text-xs border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-purple-500 max-w-[14rem]"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Add or remove projects"
        aria-label="Manage projects"
        className={`text-xs px-1.5 py-1 rounded border ${
          open
            ? "border-gray-600 bg-gray-800 text-gray-200"
            : "border-gray-700 text-gray-500 hover:text-gray-300"
        }`}
      >
        ⋯
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-96 z-30 bg-gray-900 border border-gray-700 rounded shadow-xl p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-500">
            Projects
          </div>
          <ul className="mt-2 space-y-1">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`flex items-center gap-2 rounded px-2 py-1 ${
                  p.id === project.id ? "bg-gray-800" : "hover:bg-gray-800/60"
                }`}
              >
                <button
                  className="flex-1 text-left min-w-0"
                  onClick={() => {
                    select(p.id);
                    setOpen(false);
                  }}
                >
                  <div className="text-xs text-gray-200">{p.name}</div>
                  <div className="text-[11px] text-gray-500 font-mono truncate">
                    {p.root}
                  </div>
                </button>
                <button
                  disabled={busy}
                  onClick={() => void run(remove(p.id))}
                  title="Forget this project — its .syl/ directory is left alone"
                  className="text-[11px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 hover:text-red-300 hover:border-red-500/40 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <form
            className="mt-3 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!path.trim() || busy) return;
              if (await run(add(path.trim()))) {
                setPath("");
                setOpen(false);
              }
            }}
          >
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/dev/another-project"
              className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200 focus:outline-none focus:border-purple-500"
            />
            <button
              type="submit"
              disabled={busy || !path.trim()}
              className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-50"
            >
              Add
            </button>
          </form>

          {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
          <p className="mt-2 text-[11px] text-gray-600 font-mono truncate" title={registryPath}>
            {registryPath}
          </p>
        </div>
      )}
    </div>
  );
}
