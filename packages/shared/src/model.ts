import {
  BUILT_IN_MODEL_SLUGS_BY_PROVIDER,
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

const MODEL_SLUG_SET_BY_PROVIDER = BUILT_IN_MODEL_SLUGS_BY_PROVIDER;
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
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as ReadonlyArray<CodexReasoningEffort>;
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
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider] as CodexReasoningEffort | null;
}

// ── Claude-specific helpers ─────────────────────────────────────────

export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): string | null {
  if (typeof effort !== "string") return null;
  const trimmed = effort.trim();
  if (!trimmed) return null;
  const options = REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as readonly string[];
  return options.includes(trimmed) ? trimmed : null;
}

const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";

export function supportsClaudeFastMode(model: string | null | undefined): boolean {
  return normalizeModelSlug(model, "claudeAgent") === CLAUDE_OPUS_4_6_MODEL;
}

export function supportsClaudeThinkingToggle(model: string | null | undefined): boolean {
  return normalizeModelSlug(model, "claudeAgent") === CLAUDE_HAIKU_4_5_MODEL;
}

export function supportsClaudeAdaptiveReasoning(model: string | null | undefined): boolean {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized === CLAUDE_OPUS_4_6_MODEL || normalized === CLAUDE_SONNET_4_6_MODEL;
}

export type ClaudeCodeEffort = "low" | "medium" | "high" | "max" | "ultrathink";

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | string | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) return null;
  return effort === "ultrathink" ? null : (effort as Exclude<ClaudeCodeEffort, "ultrathink">);
}

export { CODEX_REASONING_EFFORT_OPTIONS, PI_THINKING_LEVEL_OPTIONS };
