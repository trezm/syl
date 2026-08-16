import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getLanguageForFile,
  createParser,
  buildSemanticPaths,
  resolveAnnotations,
  detectOrphans,
} from "@syl/core";
import type { Workspace } from "../projects/workspace.js";

export function annotationRoutes(
  workspace: Workspace,
  wasmDir: string,
  treeSitterWasmDir: string
) {
  const app = new Hono();

  // GET /api/annotations?file=src/parser.ts
  app.get("/", async (c) => {
    const { store } = workspace.require(c);
    const file = c.req.query("file");
    if (!file) return c.json({ error: "file required" }, 400);
    const data = await store.load(file);
    return c.json(data);
  });

  // POST /api/annotations — { file, path, body, author }
  app.post("/", async (c) => {
    const { store } = workspace.require(c);
    const { file, path: semanticPath, body, author } = await c.req.json();
    if (!file || !semanticPath || !body) {
      return c.json({ error: "file, path, and body required" }, 400);
    }
    const annotation = await store.add(file, semanticPath, body, author || "anonymous");
    return c.json(annotation, 201);
  });

  // PUT /api/annotations/:id — { file, path, body }
  app.put("/:id", async (c) => {
    const { store } = workspace.require(c);
    const id = c.req.param("id");
    const { file, path: semanticPath, body } = await c.req.json();
    if (!file || !semanticPath || !body) {
      return c.json({ error: "file, path, and body required" }, 400);
    }
    const annotation = await store.update(file, semanticPath, id, body);
    if (!annotation) return c.json({ error: "not found" }, 404);
    return c.json(annotation);
  });

  // DELETE /api/annotations/:id — { file, path }
  app.delete("/:id", async (c) => {
    const { store } = workspace.require(c);
    const id = c.req.param("id");
    const { file, path: semanticPath } = await c.req.json();
    if (!file || !semanticPath) {
      return c.json({ error: "file and path required" }, 400);
    }
    const removed = await store.remove(file, semanticPath, id);
    if (!removed) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // GET /api/annotations/resolve?file=src/parser.ts
  app.get("/resolve", async (c) => {
    const { root: projectRoot, store } = workspace.require(c);
    const file = c.req.query("file");
    if (!file) return c.json({ error: "file required" }, 400);

    const langConfig = getLanguageForFile(file);
    if (!langConfig) {
      // No tree-sitter support — return annotations without resolution
      const data = await store.load(file);
      return c.json({ annotations: data.annotations, nodes: [], orphans: [] });
    }

    try {
      const filePath = path.resolve(projectRoot, file);
      const content = await fs.readFile(filePath, "utf-8");
      const wasmPath = path.join(wasmDir, langConfig.wasmFile);
      const parser = await createParser(wasmPath, treeSitterWasmDir);
      const tree = parser.parse(content);
      if (!tree) return c.json({ error: `Could not parse ${file}` }, 500);

      const pathResult = buildSemanticPaths(tree, content, langConfig);
      const annotationFile = await store.load(file);
      const resolved = resolveAnnotations(annotationFile, pathResult);
      const orphanReport = detectOrphans(resolved);

      return c.json({
        annotations: annotationFile.annotations,
        nodes: pathResult.roots,
        orphans: orphanReport.orphans.map((o) => ({
          path: o.path,
          annotations: annotationFile.annotations[o.path],
        })),
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  return app;
}
