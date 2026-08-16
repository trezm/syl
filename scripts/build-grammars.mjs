#!/usr/bin/env node
/**
 * Compiles the grammars listed in grammars.json to wasm, into grammars/.
 *
 * syl used to take its grammars from tree-sitter-wasms, which still builds with
 * tree-sitter-cli 0.20. Those are emscripten side modules, and loading several
 * of them kills newer V8 outright — a fatal "out of memory: Zone" while
 * compiling wasm, at a few hundred MB RSS. Building them here with a current
 * CLI produces ordinary modules that don't, and pins the whole set to one
 * toolchain we control.
 *
 * This is deliberately NOT a postinstall hook. The first build downloads a
 * ~106 MB wasi-sdk into ~/.cache/tree-sitter, and putting that on the critical
 * path of `npm install` would cost every contributor — including anyone who
 * only touches the web app — several minutes and a silent stall. The wasm is
 * committed instead, so a normal install needs none of this.
 *
 *   npm run grammars:build              all of them
 *   npm run grammars:build -- swift go  just these
 *   npm run grammars:build -- --check   verify, build nothing (for CI)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "grammars");
/** Grammar sources are downloaded here rather than into the workspace. */
const srcDir = path.join(root, ".grammar-src");
const cli = path.join(root, "node_modules", ".bin", "tree-sitter");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const wanted = args.filter((a) => !a.startsWith("--"));

const { grammars } = JSON.parse(
  fs.readFileSync(path.join(root, "grammars.json"), "utf-8")
);

const selected = wanted.length
  ? grammars.filter((g) => wanted.includes(g.id))
  : grammars;

const unknown = wanted.filter((id) => !grammars.some((g) => g.id === id));
if (unknown.length) {
  console.error(`Not in grammars.json: ${unknown.join(", ")}`);
  process.exit(1);
}

function wasmPathFor(grammar) {
  return path.join(outDir, `tree-sitter-${grammar.id}.wasm`);
}

// --check is what CI runs: it answers "is the committed wasm the build product
// of the current grammars.json?" without needing the toolchain at all.
if (checkOnly) {
  const missing = grammars.filter((g) => !fs.existsSync(wasmPathFor(g)));
  if (missing.length) {
    console.error(
      `Missing grammars: ${missing.map((g) => g.id).join(", ")}\n` +
        `Run: npm run grammars:build -- ${missing.map((g) => g.id).join(" ")}`
    );
    process.exit(1);
  }
  console.log(`All ${grammars.length} grammars present in grammars/.`);
  process.exit(0);
}

if (!fs.existsSync(cli)) {
  console.error(
    "tree-sitter-cli is not installed. Run `npm install` at the repo root first."
  );
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const built = [];
for (const grammar of selected) {
  const { id, package: pkg, version, dir } = grammar;
  // Each grammar is installed under its own prefix. They peer-depend on
  // different tree-sitter versions, so a shared node_modules would make npm
  // resolve one against another's peers and fail.
  const prefix = path.join(srcDir, id);
  fs.mkdirSync(prefix, { recursive: true });

  process.stdout.write(`${id}: fetching ${pkg}@${version}… `);
  execFileSync(
    "npm",
    [
      "install",
      `${pkg}@${version}`,
      "--prefix", prefix,
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--loglevel", "error",
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );

  const grammarDir = path.join(prefix, "node_modules", pkg, dir ?? "");
  if (!fs.existsSync(grammarDir)) {
    console.error(`\n${id}: ${grammarDir} is not in the published package.`);
    process.exit(1);
  }

  const out = wasmPathFor(grammar);
  process.stdout.write("building… ");
  execFileSync(cli, ["build", "--wasm", grammarDir, "-o", out], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`${size} MB`);
  built.push(id);
}

console.log(
  `\nBuilt ${built.length} grammar${built.length === 1 ? "" : "s"} into grammars/.` +
    `\nCommit the .wasm files — they are what a plain \`npm install\` relies on.`
);
