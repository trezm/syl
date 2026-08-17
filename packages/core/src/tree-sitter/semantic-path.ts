import type { Tree, Node } from "web-tree-sitter";
import { LanguagePathConfig } from "./language-config.js";
import { SemanticNode } from "../annotations/types.js";

export interface SemanticPathResult {
  /** Flat map: semantic path → node info */
  pathMap: Map<string, SemanticNode>;
  /** Hierarchical tree of semantic nodes */
  roots: SemanticNode[];
  /** Reverse lookup: line number → semantic paths covering that line */
  lineToPath: Map<number, string[]>;
}

export function buildSemanticPaths(
  tree: Tree,
  sourceCode: string,
  config: LanguagePathConfig
): SemanticPathResult {
  const pathMap = new Map<string, SemanticNode>();
  const roots: SemanticNode[] = [];
  const lineToPath = new Map<number, string[]>();

  function walk(
    node: Node,
    parentPath: string,
    siblingCounts: Map<string, number>,
    parentChildren: SemanticNode[]
  ): void {
    const isPathNode = config.pathNodeTypes.includes(node.type);

    let currentPath = parentPath;
    let currentChildren = parentChildren;
    let childSiblingCounts = siblingCounts;

    if (isPathNode) {
      const name = config.getNodeName(node as any);
      if (name) {
        // Track sibling disambiguation
        const count = (siblingCounts.get(name) ?? 0) + 1;
        siblingCounts.set(name, count);

        const segment = count > 1 ? `${name}[${count}]` : name;
        currentPath = parentPath ? `${parentPath}.${segment}` : segment;

        const semanticNode: SemanticNode = {
          path: currentPath,
          name,
          kind: node.type,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          children: [],
        };

        parentChildren.push(semanticNode);
        currentChildren = semanticNode.children;
        childSiblingCounts = new Map();

        pathMap.set(currentPath, semanticNode);

        // Map lines to paths
        for (let line = semanticNode.startLine; line <= semanticNode.endLine; line++) {
          const paths = lineToPath.get(line) ?? [];
          paths.push(currentPath);
          lineToPath.set(line, paths);
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        walk(child, currentPath, childSiblingCounts, currentChildren);
      }
    }
  }

  // After the initial walk, fix disambiguation:
  // If a name was only seen once, its path should not have [1]
  // Our logic already handles this — we only add [N] when count > 1,
  // but we need to retroactively fix the first occurrence when a second appears.
  // Simpler approach: two-pass. First count, then build.

  // Actually, let's do a cleaner two-pass approach:
  const result = buildTwoPass(tree, sourceCode, config);
  return result;
}

function buildTwoPass(
  tree: Tree,
  _sourceCode: string,
  config: LanguagePathConfig
): SemanticPathResult {
  const pathMap = new Map<string, SemanticNode>();
  const roots: SemanticNode[] = [];
  const lineToPath = new Map<number, string[]>();

  // Pass 1: Count sibling names at each level
  function countNames(node: Node, depth: number): Map<Node, Map<string, number>> {
    const result = new Map<Node, Map<string, number>>();

    function walkCount(n: Node, parent: Node | null): void {
      if (config.pathNodeTypes.includes(n.type)) {
        const name = config.getNodeName(n as any);
        if (name && parent) {
          if (!result.has(parent)) result.set(parent, new Map());
          const counts = result.get(parent)!;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        // For root-level nodes, use a synthetic key
        if (name && !parent) {
          const synth = tree.rootNode;
          if (!result.has(synth)) result.set(synth, new Map());
          const counts = result.get(synth)!;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        // Children of this path node have *this* node as parent
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          if (child) walkCount(child, n);
        }
      } else {
        // Not a path node, pass parent through
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          if (child) walkCount(child, parent);
        }
      }
    }

    walkCount(node, null);
    return result;
  }

  const nameCounts = countNames(tree.rootNode, 0);

  // Pass 2: Build paths with disambiguation only when needed
  function walk(
    node: Node,
    parentPath: string,
    parentPathNode: Node | null,
    seenCounts: Map<string, number>,
    parentChildren: SemanticNode[]
  ): void {
    const isPathNode = config.pathNodeTypes.includes(node.type);

    if (isPathNode) {
      const name = config.getNodeName(node as any);
      if (name) {
        const parentKey = parentPathNode ?? tree.rootNode;
        const totalCount = nameCounts.get(parentKey)?.get(name) ?? 1;
        const seen = (seenCounts.get(name) ?? 0) + 1;
        seenCounts.set(name, seen);

        const segment = totalCount > 1 ? `${name}[${seen}]` : name;
        const fullPath = parentPath ? `${parentPath}.${segment}` : segment;

        const semanticNode: SemanticNode = {
          path: fullPath,
          name,
          kind: node.type,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          children: [],
        };

        parentChildren.push(semanticNode);
        pathMap.set(fullPath, semanticNode);

        for (let line = semanticNode.startLine; line <= semanticNode.endLine; line++) {
          const paths = lineToPath.get(line) ?? [];
          paths.push(fullPath);
          lineToPath.set(line, paths);
        }

        // Recurse into children with this node as new parent
        const childSeen = new Map<string, number>();
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child) walk(child, fullPath, node, childSeen, semanticNode.children);
        }
        return;
      }
    }

    // Not a path node — pass through
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, parentPath, parentPathNode, seenCounts, parentChildren);
    }
  }

  const rootSeen = new Map<string, number>();
  for (let i = 0; i < tree.rootNode.childCount; i++) {
    const child = tree.rootNode.child(i);
    if (child) walk(child, "", null, rootSeen, roots);
  }

  return { pathMap, roots, lineToPath };
}
