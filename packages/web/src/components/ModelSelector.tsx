import { useState, useCallback, useMemo } from "react";
import {
  PROVIDER_LABELS,
  PROVIDER_ENV_KEYS,
  type ModelInfo,
  type ModelProvider,
} from "@syl/core";

export interface AvailableModel extends ModelInfo {
  available: boolean;
  /** "cli" runs on your Claude/Codex subscription; "sdk" bills per token. */
  backend?: "cli" | "sdk" | null;
  cli?: boolean;
  sdk?: boolean;
}

const CLI_FOR_PROVIDER: Record<ModelProvider, string> = {
  anthropic: "claude",
  openai: "codex",
};

const STORAGE_KEY = "syl-selected-model";

const PROVIDER_ORDER: ModelProvider[] = ["anthropic", "openai"];

/**
 * Tracks the selected model against the server's model list. A stored id that
 * the server no longer offers (a retired model, or one whose API key was
 * removed) falls back rather than sticking around and failing at generate time.
 *
 * `storageKey` separates the independent choices — annotation, review scout and
 * review reviewer each remember their own model.
 */
export function useSelectedModel(
  models: AvailableModel[],
  defaultModel: string | null,
  storageKey: string = STORAGE_KEY
) {
  const [stored, setStored] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });

  const model = useMemo(() => {
    const usable = models.filter((m) => m.available);
    if (usable.length === 0) return null;
    if (stored && usable.some((m) => m.id === stored)) return stored;
    if (defaultModel && usable.some((m) => m.id === defaultModel)) {
      return defaultModel;
    }
    return usable[0].id;
  }, [models, defaultModel, stored]);

  const selectModel = useCallback(
    (id: string) => {
      setStored(id);
      try {
        localStorage.setItem(storageKey, id);
      } catch {
        // ignore
      }
    },
    [storageKey]
  );

  return { model, selectModel };
}

export default function ModelSelector({
  models,
  model,
  onSelect,
}: {
  models: AvailableModel[];
  model: string | null;
  onSelect: (model: string) => void;
}) {
  const groups = PROVIDER_ORDER.map((provider) => ({
    provider,
    models: models.filter((m) => m.provider === provider),
  })).filter((g) => g.models.length > 0);

  return (
    <select
      value={model ?? ""}
      onChange={(e) => onSelect(e.target.value)}
      className="bg-gray-800 text-gray-300 text-xs border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-purple-500"
    >
      {groups.map((group) => (
        <optgroup key={group.provider} label={PROVIDER_LABELS[group.provider]}>
          {group.models.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {m.available
                ? `${m.label}${m.backend === "cli" ? " · cli" : m.backend === "sdk" ? " · api" : ""}`
                : `${m.label} — install ${CLI_FOR_PROVIDER[group.provider]} or set ${PROVIDER_ENV_KEYS[group.provider]}`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
