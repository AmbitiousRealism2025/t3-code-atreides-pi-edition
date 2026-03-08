import {
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  PI_THINKING_LEVEL_OPTIONS,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type CodexReasoningEffort,
  type ModelSlug,
  type PiThinkingLevel,
  type ProviderKind,
} from "@t3tools/contracts";

type CatalogProvider = keyof typeof MODEL_OPTIONS_BY_PROVIDER;

const MODEL_SLUG_SET_BY_PROVIDER: Record<CatalogProvider, ReadonlySet<ModelSlug>> = {
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  pi: new Set(MODEL_OPTIONS_BY_PROVIDER.pi.map((option) => option.slug)),
};
// Providers whose models support Pi's --thinking flag.
// Stage 3 TODO: replace with capability metadata from Pi SDK ModelDefinition.capabilities.reasoning.
// For now: all Anthropic and OpenAI Codex models support thinking via Pi.
const PI_THINKING_SUPPORTED_PROVIDER_PREFIXES = ["anthropic/", "openai-codex/"];

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = aliases[trimmed];
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
): ReadonlyArray<CodexReasoningEffort> {
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function supportsPiThinkingLevel(
  model: string | null | undefined,
  supportsThinking?: boolean,
): boolean {
  // Use SDK capability metadata as primary source when available.
  if (supportsThinking !== undefined) return supportsThinking;
  // Fall back to provider prefix check when model list hasn't loaded yet.
  const normalized = normalizeModelSlug(model, "pi");
  if (normalized === null) return false;
  return PI_THINKING_SUPPORTED_PROVIDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function getPiThinkingLevelOptions(
  model: string | null | undefined,
  supportsThinking?: boolean,
): ReadonlyArray<PiThinkingLevel> {
  return supportsPiThinkingLevel(model, supportsThinking) ? PI_THINKING_LEVEL_OPTIONS : [];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(provider: ProviderKind): CodexReasoningEffort | null;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
): CodexReasoningEffort | null {
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export { CODEX_REASONING_EFFORT_OPTIONS, PI_THINKING_LEVEL_OPTIONS };
