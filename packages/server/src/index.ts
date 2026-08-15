import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { fileRoutes } from "./routes/files.js";
import { annotationRoutes } from "./routes/annotations.js";
import { generateRoutes } from "./routes/generate.js";
import { linkRoutes } from "./routes/links.js";
import { reviewRoutes } from "./routes/review.js";
import { channelRoutes } from "./routes/channel.js";
import { projectRoutes } from "./routes/projects.js";
import {
  ProjectNotFoundError,
  ProjectRegistry,
  registryPath,
} from "./projects/registry.js";
import { Workspace } from "./projects/workspace.js";

// Import language registrations
import "@syl/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const port = parseInt(process.env.PORT || "3000", 10);

// Resolve WASM directories
const grammarWasmDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const treeSitterWasmDir = path.dirname(require.resolve("web-tree-sitter/tree-sitter.wasm"));

const app = new Hono();

app.use("*", cors());

// One server, any number of checkouts: the workspace holds each project's index,
// review runner and annotation store, and every route below picks one out of it
// by the request's `?project=` — see Workspace.require.
const workspace = new Workspace(
  ProjectRegistry.load(),
  grammarWasmDir,
  treeSitterWasmDir
);

// A request naming a project this server doesn't have is a 404 wherever it is
// raised, so the routes throw it and it's answered once, here.
app.onError((err, c) => {
  if (err instanceof ProjectNotFoundError) {
    return c.json({ error: err.message, unknownProject: true }, 404);
  }
  console.error(err);
  return c.json({ error: err.message || "Internal error" }, 500);
});

// API routes
app.route("/api/projects", projectRoutes(workspace));
app.route("/api/files", fileRoutes(workspace));
app.route("/api/annotations", annotationRoutes(workspace, grammarWasmDir, treeSitterWasmDir));
app.route("/api/generate", generateRoutes(workspace, grammarWasmDir, treeSitterWasmDir));
app.route("/api/links", linkRoutes(workspace));
app.route("/api/review", reviewRoutes(workspace, grammarWasmDir, treeSitterWasmDir));
app.route("/api/channel", channelRoutes(workspace));

// Serve WASM files — check tree-sitter runtime dir first, then grammar dir
app.get("/wasm/:file", async (c) => {
  const file = c.req.param("file");
  for (const dir of [treeSitterWasmDir, grammarWasmDir]) {
    const filePath = path.join(dir, file);
    try {
      const data = fs.readFileSync(filePath);
      return new Response(data, {
        headers: { "Content-Type": "application/wasm" },
      });
    } catch {
      // try next directory
    }
  }
  return c.json({ error: "wasm file not found" }, 404);
});

const projects = workspace.list();
console.log(`Syl server running on http://localhost:${port}`);
console.log(
  projects.length > 0
    ? `Projects (${registryPath()}):\n${projects
        .map((p) => `  ${p.id} → ${p.root}`)
        .join("\n")}`
    : `No projects registered yet — add one in the UI. (${registryPath()})`
);

serve({ fetch: app.fetch, port });
