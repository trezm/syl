import { backendFor, providerEnvKey, resolveModel } from "./models.js";
import { CLI_FOR_PROVIDER, completeJsonViaCli } from "./cli.js";
import type { ProviderCompleteJson } from "./types.js";
import { completeJsonAnthropic } from "./providers/anthropic.js";
import { completeJsonOpenAI } from "./providers/openai.js";
import { completeJsonGemini } from "./providers/gemini.js";

const SDK_COMPLETERS: Record<string, ProviderCompleteJson> = {
  anthropic: completeJsonAnthropic,
  openai: completeJsonOpenAI,
  gemini: completeJsonGemini,
};

/** Which backend a given model would run on right now, for reporting. */
export async function backendForModel(
  modelId: string
): Promise<"cli" | "sdk" | null> {
  const info = resolveModel(modelId);
  return info ? backendFor(info.provider) : null;
}

export interface CompleteJsonRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
  schemaName: string;
  /** Working directory for the CLI backend. */
  cwd: string;
  /** Let the CLI read repo files itself; ignored by the SDK backend. */
  allowFileTools?: boolean;
}

/**
 * One schema-constrained call, routed to the CLI when it's installed (rides the
 * user's subscription) and to the SDK otherwise (per-token API billing).
 */
export async function completeJson(
  request: CompleteJsonRequest
): Promise<unknown> {
  const info = resolveModel(request.model);
  if (!info) throw new Error(`Unknown model "${request.model}"`);

  const backend = await backendFor(info.provider);
  if (!backend) {
    const cli = CLI_FOR_PROVIDER[info.provider];
    throw new Error(
      `${info.label} is unavailable — install the \`${cli}\` CLI or set ${providerEnvKey(info.provider)}.`
    );
  }

  if (backend === "cli") {
    return completeJsonViaCli(CLI_FOR_PROVIDER[info.provider], {
      model: info.id,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      schema: request.schema,
      schemaName: request.schemaName,
      cwd: request.cwd,
      allowFileTools: request.allowFileTools,
    });
  }

  return SDK_COMPLETERS[info.provider]({
    model: info.id,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    schema: request.schema,
    schemaName: request.schemaName,
  });
}
