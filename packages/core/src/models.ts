export type ModelProvider = "anthropic" | "openai";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ModelProvider;
}

/**
 * Anthropic models. IDs are complete as written — they take no date suffix.
 */
export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic" },
];

/**
 * OpenAI models. Availability varies by account and tier, so the server lets
 * this be overridden with SYL_OPENAI_MODELS (comma-separated ids).
 */
export const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai" },
  { id: "gpt-5", label: "GPT-5", provider: "openai" },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai" },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
];

export const DEFAULT_MODELS: ModelInfo[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
];

export const DEFAULT_MODEL_ID = "claude-opus-5";

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
};

/** Author recorded on annotations this provider generates. */
export const PROVIDER_AUTHORS: Record<ModelProvider, string> = {
  anthropic: "claude",
  openai: "chatgpt",
};

/** Environment variable holding each provider's API key. */
export const PROVIDER_ENV_KEYS: Record<ModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function findModel(
  id: string,
  models: ModelInfo[] = DEFAULT_MODELS
): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}
