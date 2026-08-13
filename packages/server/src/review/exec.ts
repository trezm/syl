import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
    /**
     * What the command printed before failing. `gh api` writes GitHub's error
     * body here rather than to stderr, so this is where the reason for a 4xx
     * actually lives.
     */
    readonly stdout: string = "",
    readonly exitCode: number | null = null,
    readonly args: string[] = []
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Output is kept for diagnostics, so it is capped before it reaches a log. */
const MAX_CAPTURED_OUTPUT = 8 * 1024;

function captured(value: unknown): string {
  const text = (value ?? "").toString().trim();
  return text.length > MAX_CAPTURED_OUTPUT
    ? `${text.slice(0, MAX_CAPTURED_OUTPUT)}… (truncated)`
    : text;
}

/**
 * Everything known about a failure, for a server log rather than the UI —
 * the command as invoked plus both streams, since either one may hold the
 * reason.
 */
export function describeCommandFailure(e: unknown): string {
  if (!(e instanceof CommandError)) {
    return e instanceof Error ? (e.stack ?? e.message) : String(e);
  }
  return [
    `${[e.command, ...e.args].join(" ")} exited ${e.exitCode ?? "abnormally"}`,
    e.stderr && `stderr: ${e.stderr}`,
    e.stdout && `stdout: ${e.stdout}`,
  ]
    .filter(Boolean)
    .join("\n  ");
}

export interface RunOptions {
  cwd: string;
  /** Diffs can be large; default 32 MB. */
  maxBuffer?: number;
  /** Written to the child's stdin, for commands that read a payload there. */
  input?: string;
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions
): Promise<string> {
  try {
    const child = execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    });
    if (options.input !== undefined) {
      child.child.stdin?.end(options.input);
    }
    const { stdout } = await child;
    return stdout;
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new CommandError(
        `\`${command}\` was not found on PATH.`,
        command,
        "",
        "",
        null,
        args
      );
    }
    const stderr = captured(e?.stderr);
    const stdout = captured(e?.stdout);
    throw new CommandError(
      stderr || stdout || e?.message || `\`${command}\` failed`,
      command,
      stderr,
      stdout,
      typeof e?.code === "number" ? e.code : null,
      args
    );
  }
}
