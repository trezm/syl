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
import { ProjectIndex } from "./links/project-index.js";

// Import language registrations
import "@syl/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// npm runs workspace scripts with cwd set to the workspace dir, so process.cwd()
// would resolve to packages/server. INIT_CWD is where npm was actually invoked.
const projectRoot = path.resolve(
  process.env.SYL_PROJECT_ROOT || process.env.INIT_CWD || process.cwd()
);
const port = parseInt(process.env.PORT || "3000", 10);

// Resolve WASM directories
const grammarWasmDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const treeSitterWasmDir = path.dirname(require.resolve("web-tree-sitter/tree-sitter.wasm"));

const app = new Hono();

app.use("*", cors());

const projectIndex = new ProjectIndex(
  projectRoot,
  grammarWasmDir,
  treeSitterWasmDir
);

// API routes
app.route("/api/files", fileRoutes(projectRoot));
app.route("/api/annotations", annotationRoutes(projectRoot, grammarWasmDir, treeSitterWasmDir));
app.route("/api/generate", generateRoutes(projectRoot, grammarWasmDir, treeSitterWasmDir));
app.route("/api/links", linkRoutes(projectRoot, projectIndex));
app.route(
  "/api/review",
  reviewRoutes(projectRoot, grammarWasmDir, treeSitterWasmDir)
);

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

console.log(`Syl server running on http://localhost:${port}`);
console.log(`Project root: ${projectRoot}`);

serve({ fetch: app.fetch, port });
