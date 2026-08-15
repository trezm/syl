import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { isIgnoredEntry } from "../util/project-files.js";
import type { Workspace } from "../projects/workspace.js";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
  ".ttf", ".eot", ".zip", ".tar", ".gz", ".pdf", ".wasm",
]);

async function buildTree(dirPath: string, relativeTo: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isIgnoredEntry(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(relativeTo, fullPath);

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath, relativeTo);
      nodes.push({ name: entry.name, path: relPath, type: "directory", children });
    } else {
      nodes.push({ name: entry.name, path: relPath, type: "file" });
    }
  }

  // Sort directories first, then files
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function fileRoutes(workspace: Workspace) {
  const app = new Hono();

  app.get("/tree", async (c) => {
    const { root } = workspace.require(c);
    const tree = await buildTree(root, root);
    return c.json(tree);
  });

  app.get("/read", async (c) => {
    const { root: projectRoot } = workspace.require(c);
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);

    // Prevent path traversal
    const resolved = path.resolve(projectRoot, filePath);
    if (!resolved.startsWith(path.resolve(projectRoot))) {
      return c.json({ error: "invalid path" }, 403);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return c.json({ error: "binary file", binary: true }, 400);
    }

    try {
      const content = await fs.readFile(resolved, "utf-8");
      return c.json({ path: filePath, content });
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  return app;
}
