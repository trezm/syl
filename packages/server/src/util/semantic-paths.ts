import path from "node:path";
import {
  getLanguageForFile,
  createParser,
  buildSemanticPaths,
  type SemanticPathResult,
} from "@syl/core";

/**
 * Semantic paths for `content`, parsed with the grammar `file`'s extension maps
 * to. The content is passed in rather than read, so a version of the file that
 * isn't the one on disk — a pull request's base version, say — can be parsed the
 * same way.
 *
 * Throws for a file type with no tree-sitter config, which is the same thing
 * that hides the generate buttons in the UI.
 */
export async function semanticPathsFor(
  file: string,
  content: string,
  wasmDir: string,
  treeSitterWasmDir: string
): Promise<SemanticPathResult> {
  const langConfig = getLanguageForFile(file);
  if (!langConfig) {
    throw new Error("Unsupported file type for annotation generation");
  }
  const wasmPath = path.join(wasmDir, langConfig.wasmFile);
  const parser = await createParser(wasmPath, treeSitterWasmDir);
  // parse() returns null only when the parser is cancelled or times out —
  // neither of which syl asks for, so this is a "can't happen" made explicit.
  const tree = parser.parse(content);
  if (!tree) throw new Error(`Parsing ${file} produced no syntax tree.`);
  return buildSemanticPaths(tree, content, langConfig);
}
