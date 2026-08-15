import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { parseRef, type AnnotationFile, type LinkTarget } from "@syl/core";
import type { Workspace } from "../projects/workspace.js";

const MAX_REFS = 200;

async function findAnnotation(
  sylDir: string,
  id: string
): Promise<{ file: string; semanticPath: string } | null> {
  async function walk(dir: string): Promise<{ file: string; semanticPath: string } | null> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(abs);
        if (found) return found;
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await fs.readFile(abs, "utf-8")
        ) as AnnotationFile;
        for (const [semanticPath, annotations] of Object.entries(
          parsed.annotations ?? {}
        )) {
          if (annotations.some((a) => a.id === id)) {
            return { file: parsed.sourceFile, semanticPath };
          }
        }
      } catch {
        // Skip malformed annotation files.
      }
    }
    return null;
  }

  return walk(sylDir);
}

export function linkRoutes(workspace: Workspace) {
  const app = new Hono();

  // POST /api/links/resolve — batch-resolve refs found in annotation bodies
  app.post("/resolve", async (c) => {
    const { root, index } = workspace.require(c);
    const sylDir = path.join(root, ".syl");
    const { file, refs } = await c.req.json<{
      file?: string;
      refs?: string[];
    }>();

    if (!Array.isArray(refs)) {
      return c.json({ error: "refs must be an array" }, 400);
    }

    await index.ensureFresh();

    const results: Record<string, LinkTarget | null> = {};
    for (const raw of refs.slice(0, MAX_REFS)) {
      const parsed = parseRef(raw);
      if (!parsed) {
        results[raw] = null;
        continue;
      }

      if (parsed.annotationId) {
        const found = await findAnnotation(sylDir, parsed.annotationId);
        if (!found) {
          results[raw] = null;
          continue;
        }
        const symbol = index
          .fileSymbols(found.file)
          .find((s) => s.path === found.semanticPath);
        results[raw] = {
          kind: "annotation",
          file: found.file,
          path: found.semanticPath,
          id: parsed.annotationId,
          startLine: symbol?.startLine ?? 1,
          endLine: symbol?.endLine ?? 1,
        };
        continue;
      }

      results[raw] = index.resolve(parsed, file ?? "");
    }

    return c.json({ results });
  });

  return app;
}
