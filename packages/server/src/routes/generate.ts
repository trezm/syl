import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { getLanguageForFile } from "@syl/core";
import { semanticPathsFor } from "../util/semantic-paths.js";
import { generateAnnotations } from "../ai/generate.js";
import { listModels, defaultModelId, resolveModel } from "../ai/models.js";
import type { Workspace } from "../projects/workspace.js";

export function generateRoutes(
  workspace: Workspace,
  wasmDir: string,
  treeSitterWasmDir: string
) {
  const app = new Hono();

  // GET /api/generate/status — which models are runnable, and on which backend.
  // Model availability is a property of the server, not of any one project, so
  // this is the one endpoint here that needs no project.
  app.get("/status", async (c) => {
    const models = await listModels();
    const defaultModel = await defaultModelId();
    return c.json({
      available: models.some((m) => m.available),
      defaultModel,
      models,
    });
  });

  // POST /api/generate — generate annotations via the selected model
  app.post("/", async (c) => {
    const { root: projectRoot, store } = workspace.require(c);
    const { file, model, semanticPath } = await c.req.json<{
      file: string;
      model: string;
      semanticPath?: string;
    }>();

    if (!file || !model) {
      return c.json({ error: "file and model are required" }, 400);
    }

    if (!resolveModel(model)) {
      return c.json({ error: `Unknown model "${model}"` }, 400);
    }

    const langConfig = getLanguageForFile(file);
    if (!langConfig) {
      return c.json({ error: "Unsupported file type for annotation generation" }, 400);
    }

    try {
      const filePath = path.resolve(projectRoot, file);
      const fileContent = await fs.readFile(filePath, "utf-8");
      const pathResult = await semanticPathsFor(
        file,
        fileContent,
        wasmDir,
        treeSitterWasmDir
      );

      if (semanticPath && !pathResult.pathMap.has(semanticPath)) {
        return c.json({ error: `Semantic path "${semanticPath}" not found in file` }, 404);
      }

      const result = await generateAnnotations({
        model,
        filePath: file,
        fileContent,
        pathResult,
        projectRoot,
        store,
        semanticPath,
      });

      return c.json({ ok: true, count: result.count });
    } catch (e: any) {
      console.error("Generation error:", e);
      return c.json({ error: e.message || "Generation failed" }, 500);
    }
  });

  return app;
}
