import { Parser, Language } from "web-tree-sitter";

let initialized = false;
let storedLocateDir: string | undefined;

export async function initTreeSitter(locateDir?: string): Promise<void> {
  if (initialized) return;
  if (locateDir) storedLocateDir = locateDir;
  await Parser.init({
    locateFile: (scriptName: string) => {
      if (storedLocateDir) return `${storedLocateDir}/${scriptName}`;
      return scriptName;
    },
  });
  initialized = true;
}

/**
 * Compiled grammars, keyed by wasm path.
 *
 * Loading a grammar compiles a whole wasm module, and the project index calls
 * this once per file — so without a cache, indexing a repo of N Kotlin files
 * meant N compiles of a 3.3 MB module. A `Language` is immutable and shareable,
 * so only the cheap `Parser` wrapper needs creating per call. Caching the
 * promise (not the resolved value) also collapses concurrent loads of the same
 * grammar into a single compile.
 */
const languageCache = new Map<string, Promise<Language>>();

export async function createParser(
  wasmPath: string,
  treeSitterWasmDir?: string
): Promise<Parser> {
  await initTreeSitter(treeSitterWasmDir);

  let language = languageCache.get(wasmPath);
  if (!language) {
    language = Language.load(wasmPath);
    languageCache.set(wasmPath, language);
    // Don't cache a failure — a transient read error shouldn't poison the
    // grammar for the life of the process.
    language.catch(() => languageCache.delete(wasmPath));
  }

  const parser = new Parser();
  parser.setLanguage(await language);
  return parser;
}

export { Parser, Language };
