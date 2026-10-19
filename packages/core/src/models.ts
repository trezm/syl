export type ModelProvider = "anthropic" | "openai" | "gemini";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ModelProvider;
}

/**
 * Anthropic models. IDs are complete as written — they take no date suffix.
 */
export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", provider: "anthropic" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic" },
];

/**
 * OpenAI models. Availability varies by account and tier, so the server lets
 * this be overridden with SYL_OPENAI_MODELS (comma-separated ids).
 */
export const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "openai" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "openai" },
];

/** Gemini models, by the IDs the Gemini API takes. */
export const GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-4-argon", label: "Gemini 4 Argon", provider: "gemini" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "gemini" },
];

export const DEFAULT_MODELS: ModelInfo[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GEMINI_MODELS,
];

export const DEFAULT_MODEL_ID = "claude-opus-5-5";

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  gemini: "Gemini",
};

/** Author recorded on annotations this provider generates. */
export const PROVIDER_AUTHORS: Record<ModelProvider, string> = {
  anthropic: "claude",
  openai: "chatgpt",
  gemini: "gemini",
};

/** Environment variable holding each provider's API key. */
export const PROVIDER_ENV_KEYS: Record<ModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function findModel(
  id: string,
  models: ModelInfo[] = DEFAULT_MODELS
): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}
