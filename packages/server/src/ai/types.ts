import type { ToolContext, SaveAnnotationEntry } from "./tool-executor.js";

export interface ProviderRunOptions {
  model: string;
  systemPrompt: string;
  context: ToolContext;
}

/**
 * A provider drives its own tool-calling loop and returns every annotation the
 * model asked to save. Persisting them is the caller's job.
 */
export type ProviderRun = (
  options: ProviderRunOptions
) => Promise<SaveAnnotationEntry[]>;

export const MAX_ITERATIONS = 15;
export const MAX_OUTPUT_TOKENS = 16000;

export interface JsonCompletionOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** JSON Schema the response is constrained to. */
  schema: Record<string, unknown>;
  /** Schema name — OpenAI requires one; Anthropic and Gemini ignore it. */
  schemaName: string;
}

/** A single structured-output call, no tools and no loop. */
export type ProviderCompleteJson = (
  options: JsonCompletionOptions
) => Promise<unknown>;
