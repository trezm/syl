import { execFile } from "node:child_process";
import type { ModelProvider } from "@syl/core";
import type { JsonCompletionOptions } from "./types.js";

export type CliTool = "claude" | "codex" | "gemini";

/** Which CLI fronts which provider. */
export const CLI_FOR_PROVIDER: Record<ModelProvider, CliTool> = {
  anthropic: "claude",
  openai: "codex",
  gemini: "gemini",
};

function commandFor(tool: CliTool): string {
  switch (tool) {
    case "claude":
      return process.env.SYL_CLAUDE_COMMAND ?? "claude";
    case "codex":
      return process.env.SYL_CODEX_COMMAND ?? "codex";
    case "gemini":
      return process.env.SYL_GEMINI_COMMAND ?? "gemini";
  }
}

const MAX_BUFFER = 32 * 1024 * 1024;
/** Reviewer passes on a large diff genuinely take minutes. */
const TIMEOUT_MS = 15 * 60 * 1000;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function exec(
  command: string,
  args: string[],
  input: string,
  cwd: string
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`\`${command}\` was not found on PATH.`));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error ? ((error as any).code ?? 1) : 0,
        });
      }
    );
    child.stdin?.end(input);
  });
}

// ---- availability ----

const detectionCache = new Map<CliTool, Promise<boolean>>();

export function detectCli(tool: CliTool): Promise<boolean> {
  // An installed gemini CLI says nothing about whether it can sign in — Google
  // has dropped it for individual accounts — so it is only used when asked for.
  if (tool === "gemini" && process.env.SYL_GEMINI_CLI !== "1") {
    return Promise.resolve(false);
  }
  const cached = detectionCache.get(tool);
  if (cached) return cached;
  const probe = exec(commandFor(tool), ["--version"], "", process.cwd())
    .then((r) => r.code === 0)
    .catch(() => false);
  detectionCache.set(tool, probe);
  return probe;
}

/** Testing hook — forget probe results so a newly installed CLI is picked up. */
export function resetCliDetection(): void {
  detectionCache.clear();
}

// ---- JSON extraction ----

/** Last balanced {...} in a string — for CLIs that wrap output in chatter. */
export function extractLastJsonObject(text: string): unknown {
  for (let end = text.lastIndexOf("}"); end !== -1; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = end; i >= 0; i--) {
      const c = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (c === "\\") {
          // Count preceding backslashes to know if this quote is escaped.
          let slashes = 0;
          let j = i;
          while (j >= 0 && text[j] === "\\") {
            slashes++;
            j--;
          }
          if (slashes % 2 === 1) escaped = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "}") depth++;
      else if (c === "{") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, end + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error("No JSON object found in CLI output.");
}

// ---- per-tool invocation ----

export interface CliJsonOptions extends JsonCompletionOptions {
  cwd: string;
  /**
   * Let the CLI use its own file-reading tools. Off for the review flow (the
   * diff is in the prompt); on for annotation, where reading the repo helps.
   */
  allowFileTools?: boolean;
}

async function runClaude(options: CliJsonOptions): Promise<unknown> {
  const args = [
    "-p",
    "--model",
    options.model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(options.schema),
    "--system-prompt",
    options.systemPrompt,
    "--tools",
    options.allowFileTools ? "Read,Glob,Grep" : "",
  ];

  const { stdout, stderr, code } = await exec(
    commandFor("claude"),
    args,
    options.userPrompt,
    options.cwd
  );

  if (!stdout.trim()) {
    throw new Error(
      `claude CLI produced no output (exit ${code}): ${stderr.trim().slice(0, 400)}`
    );
  }

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // Shouldn't happen with --output-format json, but don't fail hard on it.
    return extractLastJsonObject(stdout);
  }

  if (envelope.is_error) {
    throw new Error(
      `claude CLI error: ${String(envelope.result ?? envelope.subtype ?? "unknown").slice(0, 400)}`
    );
  }
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  if (typeof envelope.result === "string") return JSON.parse(envelope.result);
  throw new Error("claude CLI returned no structured output.");
}

/**
 * Codex has no structured-output flag, so the schema goes in the prompt and the
 * JSON object is recovered from stdout. Both the subcommand and its flags are
 * overridable via SYL_CODEX_ARGS (space-separated, `{model}` is substituted)
 * because the CLI's interface moves faster than this file.
 */
async function runCodex(options: CliJsonOptions): Promise<unknown> {
  const template =
    process.env.SYL_CODEX_ARGS ??
    "exec --model {model} --skip-git-repo-check -";
  const args = template
    .split(/\s+/)
    .filter(Boolean)
    .map((arg) => arg.replace("{model}", options.model));

  const prompt = `${options.systemPrompt}

Respond with ONLY a JSON object matching this JSON Schema — no markdown fence, no prose:
${JSON.stringify(options.schema)}

${options.userPrompt}`;

  const { stdout, stderr, code } = await exec(
    commandFor("codex"),
    args,
    prompt,
    options.cwd
  );

  if (!stdout.trim()) {
    throw new Error(
      `codex CLI produced no output (exit ${code}): ${stderr.trim().slice(0, 400)}`
    );
  }
  return extractLastJsonObject(stdout);
}

/**
 * Gemini's CLI has no schema flag either, so this mirrors codex: schema in the
 * prompt (on stdin, which `-p` appends to), JSON recovered from the reply. Plan
 * mode keeps its tools read-only. SYL_GEMINI_ARGS overrides the flags, with
 * `{model}` substituted.
 */
async function runGemini(options: CliJsonOptions): Promise<unknown> {
  const template =
    process.env.SYL_GEMINI_ARGS ??
    "--model {model} --output-format json --approval-mode plan --skip-trust";
  const args = [
    ...template
      .split(/\s+/)
      .filter(Boolean)
      .map((arg) => arg.replace("{model}", options.model)),
    "-p",
    options.allowFileTools
      ? "Read files as needed, then reply with the JSON object only."
      : "Do not use any tools. Reply with the JSON object only.",
  ];

  const prompt = `${options.systemPrompt}

Respond with ONLY a JSON object matching this JSON Schema — no markdown fence, no prose:
${JSON.stringify(options.schema)}

${options.userPrompt}`;

  const { stdout, stderr, code } = await exec(
    commandFor("gemini"),
    args,
    prompt,
    options.cwd
  );

  if (!stdout.trim()) {
    throw new Error(
      `gemini CLI produced no output (exit ${code}): ${stderr.trim().slice(0, 400)}`
    );
  }

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return extractLastJsonObject(stdout);
  }
  if (envelope.error) {
    throw new Error(
      `gemini CLI error: ${String(envelope.error.message ?? envelope.error).slice(0, 400)}`
    );
  }
  if (typeof envelope.response === "string") {
    return extractLastJsonObject(envelope.response);
  }
  return extractLastJsonObject(stdout);
}

export function completeJsonViaCli(
  tool: CliTool,
  options: CliJsonOptions
): Promise<unknown> {
  switch (tool) {
    case "claude":
      return runClaude(options);
    case "codex":
      return runCodex(options);
    case "gemini":
      return runGemini(options);
  }
}
