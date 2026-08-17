import fs from "node:fs/promises";
import {
  getLanguageForFile,
  createParser,
  buildSemanticPaths,
  type LinkTarget,
  type ParsedRef,
} from "@syl/core";
import { walkProjectFiles } from "../util/project-files.js";

export interface SymbolLocation {
  file: string;
  path: string;
  name: string;
  startLine: number;
  endLine: number;
}

interface FileEntry {
  mtimeMs: number;
  symbols: SymbolLocation[];
  /** identifier → first line it appears on */
  tokens: Map<string, number>;
}

interface Aggregate {
  byPath: Map<string, SymbolLocation[]>;
  byName: Map<string, SymbolLocation[]>;
  byToken: Map<string, { file: string; line: number }[]>;
}

const MAX_FILE_BYTES = 512_000;
const RESCAN_INTERVAL_MS = 5_000;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const MIN_TOKEN_LENGTH = 3;
/** A token spread across more files than this is a common word, not a destination. */
const MAX_TOKEN_FILES = 3;

/**
 * Words that are identifiers but never a useful link destination. Without this,
 * a body mentioning `null` or `string` links to whichever line happens to
 * contain it first.
 */
const TOKEN_STOPLIST = new Set([
  "true", "false", "null", "undefined", "void", "this", "self", "super",
  "string", "number", "boolean", "object", "symbol", "bigint", "any",
  "unknown", "never", "const", "let", "var", "function", "class", "interface",
  "type", "enum", "return", "import", "export", "from", "default", "async",
  "await", "new", "typeof", "instanceof", "extends", "implements", "readonly",
  "public", "private", "protected", "static", "abstract", "yield",
  "if", "else", "for", "while", "switch", "case", "break", "continue", "try",
  "catch", "finally", "throw", "delete", "with", "def", "elif", "pass",
  "lambda", "None", "True", "False", "and", "or", "not", "in", "is",
]);

/**
 * Indexes every parseable file in the project so annotation refs can resolve
 * across files. Re-parses only files whose mtime changed.
 */
export class ProjectIndex {
  private files = new Map<string, FileEntry>();
  private aggregate: Aggregate | null = null;
  private lastScan = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private projectRoot: string,
    private grammarWasmDir: string,
    private treeSitterWasmDir: string
  ) {}

  private async scan(): Promise<void> {
    const walked = await walkProjectFiles(this.projectRoot);
    const seen = new Set<string>();
    let changed = false;

    for (const { relPath, absPath } of walked) {
      const langConfig = getLanguageForFile(relPath);
      if (!langConfig) continue;
      seen.add(relPath);

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      const cached = this.files.get(relPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) continue;

      try {
        const content = await fs.readFile(absPath, "utf-8");
        const wasmPath = `${this.grammarWasmDir}/${langConfig.wasmFile}`;
        const parser = await createParser(wasmPath, this.treeSitterWasmDir);
        const tree = parser.parse(content);
        if (!tree) continue;
        const pathResult = buildSemanticPaths(tree, content, langConfig);

        const symbols: SymbolLocation[] = [];
        for (const [semanticPath, node] of pathResult.pathMap) {
          symbols.push({
            file: relPath,
            path: semanticPath,
            name: node.name,
            startLine: node.startLine,
            endLine: node.endLine,
          });
        }

        const tokens = new Map<string, number>();
        content.split("\n").forEach((text, i) => {
          for (const match of text.matchAll(IDENTIFIER)) {
            if (!tokens.has(match[0])) tokens.set(match[0], i + 1);
          }
        });

        this.files.set(relPath, { mtimeMs: stat.mtimeMs, symbols, tokens });
        changed = true;
      } catch {
        // Unparseable file — skip it rather than failing the whole index.
      }
    }

    for (const known of this.files.keys()) {
      if (!seen.has(known)) {
        this.files.delete(known);
        changed = true;
      }
    }

    if (changed || !this.aggregate) this.rebuildAggregate();
  }

  private rebuildAggregate(): void {
    const byPath = new Map<string, SymbolLocation[]>();
    const byName = new Map<string, SymbolLocation[]>();
    const byToken = new Map<string, { file: string; line: number }[]>();

    const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };

    for (const [file, entry] of this.files) {
      for (const symbol of entry.symbols) {
        push(byPath, symbol.path, symbol);
        push(byName, symbol.name, symbol);
      }
      for (const [token, line] of entry.tokens) {
        push(byToken, token, { file, line });
      }
    }

    this.aggregate = { byPath, byName, byToken };
  }

  async ensureFresh(): Promise<void> {
    if (this.aggregate && Date.now() - this.lastScan < RESCAN_INTERVAL_MS) {
      return;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scan()
      .catch((e) => console.error("Index scan failed:", e))
      .finally(() => {
        this.lastScan = Date.now();
        this.inFlight = null;
      });
    return this.inFlight;
  }

  fileSymbols(file: string): SymbolLocation[] {
    return this.files.get(file)?.symbols ?? [];
  }

  hasFile(file: string): boolean {
    return this.files.has(file);
  }

  /**
   * Resolve a parsed reference. `fromFile` wins ties, so a bare symbol prefers
   * the file the annotation lives on before searching the rest of the project.
   */
  resolve(ref: ParsedRef, fromFile: string): LinkTarget | null {
    const agg = this.aggregate;
    if (!agg) return null;

    // Explicit line reference
    if (ref.file && ref.startLine !== undefined) {
      return {
        kind: "line",
        file: ref.file,
        startLine: ref.startLine,
        endLine: ref.endLine ?? ref.startLine,
      };
    }

    // Symbol inside a named file
    if (ref.file && ref.path) {
      const match =
        this.fileSymbols(ref.file).find((s) => s.path === ref.path) ??
        this.fileSymbols(ref.file).find((s) => s.name === ref.path);
      if (match) return toNode(match);
      return null;
    }

    // Bare file reference
    if (ref.file) {
      return { kind: "line", file: ref.file, startLine: 1, endLine: 1 };
    }

    if (!ref.path) return null;
    const needle = ref.path;

    // Same file first
    const local = this.fileSymbols(fromFile);
    const localMatch =
      local.find((s) => s.path === needle) ??
      local.find((s) => s.name === needle);
    if (localMatch) return toNode(localMatch);

    // Project-wide symbol, exact path then bare name. Ambiguity is not a link.
    for (const map of [agg.byPath, agg.byName]) {
      const matches = map.get(needle);
      if (matches && matches.length === 1) return toNode(matches[0]);
    }

    // Not a symbol (env vars, string constants). Fall back to a line link, but
    // only when the identifier is distinctive enough that one line is clearly
    // "the" definition — otherwise `null` or `available` would link somewhere
    // arbitrary.
    if (needle.length >= MIN_TOKEN_LENGTH && !TOKEN_STOPLIST.has(needle)) {
      const tokenHits = agg.byToken.get(needle);
      if (tokenHits && tokenHits.length <= MAX_TOKEN_FILES) {
        const hit =
          tokenHits.find((t) => t.file === fromFile) ?? tokenHits[0];
        return {
          kind: "line",
          file: hit.file,
          startLine: hit.line,
          endLine: hit.line,
        };
      }
    }

    return null;
  }
}

function toNode(symbol: SymbolLocation): LinkTarget {
  return {
    kind: "node",
    file: symbol.file,
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}
