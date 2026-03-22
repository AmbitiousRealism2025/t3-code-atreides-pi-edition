import { Schema } from "effect";
import type { ProviderKind } from "./orchestration";
import {
  MODEL_OPTIONS_BY_PROVIDER as REGISTRY_MODEL_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER as REGISTRY_DEFAULT_MODEL,
  MODEL_SLUG_ALIASES_BY_PROVIDER as REGISTRY_ALIASES,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER as REGISTRY_REASONING_OPTIONS,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER as REGISTRY_REASONING_DEFAULT,
} from "./providers/registry";

// ── Provider-specific model option schemas ─────────────────────────
// These remain as explicit Schema definitions because the Effect Schema
// pipeline needs compile-time struct shapes for decode/encode.

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low", "max"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export const PI_THINKING_LEVEL_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVEL_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const PiModelOptions = Schema.Struct({
  thinkingLevel: Schema.optional(Schema.Literals(PI_THINKING_LEVEL_OPTIONS)),
});
export type PiModelOptions = typeof PiModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  pi: Schema.optional(PiModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

// ── Model catalog (registry-derived) ───────────────────────────────

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

// Re-export registry-derived maps under the same names consumers expect.
// When Claude is added, only the registry manifest changes. These re-exports stay the same.
export const MODEL_OPTIONS_BY_PROVIDER = REGISTRY_MODEL_OPTIONS as Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = string; // Widened from literal union since registry is dynamic
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER = REGISTRY_DEFAULT_MODEL as Record<ProviderKind, ModelSlug>;

// Backward compatibility for existing Codex-only call sites.
export const MODEL_OPTIONS = MODEL_OPTIONS_BY_PROVIDER.codex;
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = REGISTRY_ALIASES as Record<ProviderKind, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = REGISTRY_REASONING_OPTIONS as Record<ProviderKind, readonly string[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = REGISTRY_REASONING_DEFAULT as Record<ProviderKind, string | null>;
