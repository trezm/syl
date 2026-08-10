import { useEffect, useState } from "react";
import { collectRefs } from "@syl/core";
import type { Annotation, DiffFile, SemanticNode } from "@syl/core";
import {
  fetchAnnotations,
  resolveAnnotations,
  resolveLinks,
} from "../api";
import type { ResolvedLinks } from "../components/AnnotationBody";

/** A file's annotations for one semantic path, placed on the lines it covers. */
export interface DiffAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  annotations: Annotation[];
}

export interface DiffAnnotationData {
  /** Diff file path → annotations found in the working copy of that file. */
  byFile: Record<string, DiffAnnotation[]>;
  /** Diff file path → resolved `code span` / [[ref]] targets for its bodies. */
  linksByFile: Record<string, ResolvedLinks>;
}

const EMPTY: DiffAnnotationData = { byFile: {}, linksByFile: {} };

function flatten(nodes: SemanticNode[], into: Map<string, SemanticNode>) {
  for (const node of nodes) {
    into.set(node.path, node);
    flatten(node.children, into);
  }
}

/** Runs `worker` over `items` a few at a time so a 50-file PR can't stampede the server. */
async function pooled<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  });
  await Promise.all(runners);
}

/**
 * Loads the Syl annotations for every file in a diff so they can be shown inline
 * alongside the review's findings.
 *
 * Annotations live in the working copy, not in the pull request, so this is
 * best-effort: a file the local checkout doesn't have (or a semantic path that
 * has moved since) simply contributes nothing.
 *
 * Bumping `nonce` reloads them — the diff generates annotations of its own.
 */
export function useDiffAnnotations(
  files: DiffFile[],
  nonce = 0
): DiffAnnotationData {
  const [data, setData] = useState<DiffAnnotationData>(EMPTY);

  useEffect(() => {
    const paths = files
      .filter((f) => !f.binary && f.status !== "deleted")
      .map((f) => f.path);

    if (paths.length === 0) {
      setData(EMPTY);
      return;
    }

    let cancelled = false;

    (async () => {
      // Two stages on purpose: the plain load is a JSON read, while `resolve`
      // parses the file with tree-sitter. Only pay for the parse where there is
      // actually something to anchor.
      const annotated: string[] = [];
      await pooled(paths, 8, async (path) => {
        try {
          const file = await fetchAnnotations(path);
          if (Object.keys(file?.annotations ?? {}).length > 0) annotated.push(path);
        } catch {
          // No annotations for this file.
        }
      });
      if (cancelled || annotated.length === 0) return;

      const byFile: Record<string, DiffAnnotation[]> = {};
      const linksByFile: Record<string, ResolvedLinks> = {};

      await pooled(annotated, 4, async (path) => {
        try {
          const resolved = await resolveAnnotations(path);
          if (!resolved?.nodes) return;

          const nodes = new Map<string, SemanticNode>();
          flatten(resolved.nodes, nodes);

          const entries: DiffAnnotation[] = [];
          const refs = new Set<string>();
          for (const [semanticPath, annotations] of Object.entries(
            resolved.annotations ?? {}
          )) {
            if (!annotations || annotations.length === 0) continue;
            for (const annotation of annotations) {
              for (const ref of collectRefs(annotation.body)) refs.add(ref);
            }
            // An orphaned path has no node to anchor to — skip it rather than
            // guessing a line the reader would then mistrust.
            const node = nodes.get(semanticPath);
            if (!node) continue;
            entries.push({
              path: semanticPath,
              startLine: node.startLine,
              endLine: node.endLine,
              annotations,
            });
          }

          if (entries.length === 0) return;
          entries.sort((a, b) => a.startLine - b.startLine);
          byFile[path] = entries;

          if (refs.size > 0) {
            linksByFile[path] = await resolveLinks(path, [...refs]);
          }
        } catch {
          // File isn't in this checkout, or tree-sitter couldn't parse it.
        }
      });

      if (!cancelled) setData({ byFile, linksByFile });
    })();

    return () => {
      cancelled = true;
    };
  }, [files, nonce]);

  return data;
}
