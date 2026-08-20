import {
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  DEFAULT_MODEL_ID,
  PROVIDER_ENV_KEYS,
  type ModelInfo,
  type ModelProvider,
} from "@syl/core";
import { CLI_FOR_PROVIDER, detectCli } from "./cli.js";

/** How a model call is executed. CLI rides the user's subscription; SDK bills per token. */
export type Backend = "cli" | "sdk";

export interface AvailableModel extends ModelInfo {
  available: boolean;
  /** The backend that would actually be used. */
  backend: Backend | null;
  cli: boolean;
  sdk: boolean;
}

export function providerEnvKey(provider: ModelProvider): string {
  return PROVIDER_ENV_KEYS[provider];
}

/** True when an API key is configured for this provider. */
export function sdkAvailable(provider: ModelProvider): boolean {
  return !!process.env[PROVIDER_ENV_KEYS[provider]];
}

export function cliAvailable(provider: ModelProvider): Promise<boolean> {
  return detectCli(CLI_FOR_PROVIDER[provider]);
}

/**
 * Prefer the CLI: it runs on the user's Claude/Codex subscription rather than
 * per-token API billing. SYL_PREFER_SDK=1 flips the order.
 */
export async function backendFor(
  provider: ModelProvider
): Promise<Backend | null> {
  const [cli, sdk] = [await cliAvailable(provider), sdkAvailable(provider)];
  const preferSdk = process.env.SYL_PREFER_SDK === "1";
  if (preferSdk) return sdk ? "sdk" : cli ? "cli" : null;
  return cli ? "cli" : sdk ? "sdk" : null;
}

/**
 * OpenAI model availability varies by account and tier, so SYL_OPENAI_MODELS
 * (comma-separated ids) can replace the built-in list.
 */
function openaiModels(): ModelInfo[] {
  const override = process.env.SYL_OPENAI_MODELS;
  if (!override) return OPENAI_MODELS;
  const ids = override
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return OPENAI_MODELS;
  return ids.map((id) => ({ id, label: id, provider: "openai" as const }));
}

/** Every model syl knows about, regardless of whether it can run right now. */
export function knownModels(): ModelInfo[] {
  return [...ANTHROPIC_MODELS, ...openaiModels()];
}

export async function listModels(): Promise<AvailableModel[]> {
  const providers: ModelProvider[] = ["anthropic", "openai"];
  const state = new Map<
    ModelProvider,
    { cli: boolean; sdk: boolean; backend: Backend | null }
  >();
  for (const provider of providers) {
    state.set(provider, {
      cli: await cliAvailable(provider),
      sdk: sdkAvailable(provider),
      backend: await backendFor(provider),
    });
  }

  return knownModels().map((model) => {
    const s = state.get(model.provider)!;
    return {
      ...model,
      cli: s.cli,
      sdk: s.sdk,
      backend: s.backend,
      available: s.backend !== null,
    };
  });
}

export function resolveModel(id: string): ModelInfo | undefined {
  return knownModels().find((m) => m.id === id);
}

/**
 * Two-stage review wants a cheap triage model and a strong reviewer. Prefer the
 * canonical pair, then fall back to whatever is actually runnable.
 */
export async function defaultReviewModels(): Promise<{
  scout: string | null;
  reviewer: string | null;
}> {
  const usable = (await listModels()).filter((m) => m.available);
  const pick = (preferred: string[]) =>
    preferred.find((id) => usable.some((m) => m.id === id)) ??
    usable[0]?.id ??
    null;

  return {
    scout: pick([
      "claude-haiku-4-5",
      "gpt-5.6-luna",
      "gpt-5-mini",
      "claude-sonnet-5",
      "gpt-4o",
    ]),
    reviewer: pick([
      "claude-opus-5",
      "gpt-5.6-sol",
      "gpt-5",
      "claude-sonnet-5",
      "gpt-4.1",
    ]),
  };
}

/**
 * Replay wants speed over depth — the diff is being narrated, not judged — so
 * the quick models come first, Luna as the canonical pick.
 */
export async function defaultReplayModel(): Promise<string | null> {
  const usable = (await listModels()).filter((m) => m.available);
  return (
    [
      "gpt-5.6-luna",
      "claude-haiku-4-5",
      "gpt-5-mini",
      "claude-sonnet-5",
      "gpt-4o",
    ].find((id) => usable.some((m) => m.id === id)) ??
    usable[0]?.id ??
    null
  );
}

/** The default the UI should preselect: the usual default if runnable, else the first usable model. */
export async function defaultModelId(): Promise<string | null> {
  const models = await listModels();
  const preferred = models.find((m) => m.id === DEFAULT_MODEL_ID && m.available);
  return (preferred ?? models.find((m) => m.available))?.id ?? null;
}
