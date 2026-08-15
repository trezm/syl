import { Hono } from "hono";
import { registryPath } from "../projects/registry.js";
import type { Workspace } from "../projects/workspace.js";

function messageFor(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The repositories this server is pointed at. Everything else in the API is
 * scoped to one of them with `?project=<id>`; these endpoints are what decides
 * which ids exist.
 */
export function projectRoutes(workspace: Workspace) {
  const app = new Hono();

  // GET /api/projects — the switcher's contents
  app.get("/", (c) =>
    c.json({
      projects: workspace.list(),
      defaultId: workspace.defaultId(),
      registryPath: registryPath(),
    })
  );

  // POST /api/projects — { path } — register another checkout
  app.post("/", async (c) => {
    const body = await c.req
      .json<{ path?: string }>()
      .catch(() => ({}) as { path?: string });
    const input = (body.path ?? "").trim();
    if (!input) return c.json({ error: "A path is required." }, 400);

    try {
      return c.json({ project: workspace.add(input) }, 201);
    } catch (e) {
      return c.json({ error: messageFor(e) }, 400);
    }
  });

  // DELETE /api/projects/:id — forget a checkout. The directory is untouched:
  // its `.syl/` annotations and review cache are still there if it comes back.
  app.delete("/:id", (c) => {
    try {
      return c.json({ project: workspace.remove(c.req.param("id")) });
    } catch (e) {
      return c.json({ error: messageFor(e) }, 404);
    }
  });

  return app;
}
