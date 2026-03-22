/**
 * ProviderManifest — Single-source-of-truth interface for provider configuration.
 *
 * Each provider declares one manifest file satisfying this interface.
 * The registry collects manifests and produces all derived types, maps,
 * and lookups. Adding a new provider = one manifest file + one import.
 *
 * @module ProviderManifest
 */

// ── Model catalog ──────────────────────────────────────────────────

export interface ProviderModelOption {
  readonly slug: string;
  readonly name: string;
}

// ── Reasoning / effort options ─────────────────────────────────────

export interface ProviderReasoningConfig {
  /** Ordered list of reasoning effort options (e.g. ["low", "medium", "high"]) */
  readonly options: readonly string[];
  /** Default reasoning effort level, or null if the provider has none */
  readonly default: string | null;
}

// ── Custom model settings ──────────────────────────────────────────

export interface ProviderCustomModelConfig {
  /** Key used in AppSettings to store custom model slugs */
  readonly settingsKey: string;
  /** Display title for the settings UI */
  readonly title: string;
  /** Description text for the settings UI */
  readonly description: string;
  /** Placeholder text for the input field */
  readonly placeholder: string;
  /** Example custom model slug */
  readonly example: string;
}

// ── Provider start options schema descriptor ───────────────────────

export interface ProviderStartOptionField {
  readonly key: string;
  readonly type: "string" | "number" | "boolean";
  readonly optional: boolean;
}

// ── Provider capabilities ──────────────────────────────────────────

export type ProviderSessionModelSwitchMode = "in-session" | "restart-session" | "unsupported";

export interface ProviderCapabilities {
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
}

// ── Provider picker / UI metadata ──────────────────────────────────

export interface ProviderPickerConfig {
  /** Display label in the provider picker */
  readonly label: string;
  /** Whether this provider is available for selection */
  readonly available: boolean;
}

// ── The manifest ───────────────────────────────────────────────────

export interface ProviderManifest {
  /** Unique provider identifier (must match the ProviderKind literal) */
  readonly id: string;

  /** Display name for UI (e.g. "Claude Agent", not "Claude Code") */
  readonly name: string;

  /** Static model catalog (fallback for providers with dynamic discovery) */
  readonly models: readonly ProviderModelOption[];

  /** Default model slug */
  readonly defaultModel: string;

  /** Model slug aliases (shorthand to canonical slug mapping) */
  readonly modelAliases: Readonly<Record<string, string>>;

  /** Reasoning / effort configuration */
  readonly reasoning: ProviderReasoningConfig;

  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities;

  /** Provider picker configuration */
  readonly picker: ProviderPickerConfig;

  /** Custom model settings configuration (optional, some providers don't need it) */
  readonly customModels?: ProviderCustomModelConfig;

  /** Provider start option fields (for typed ProviderStartOptions schema generation) */
  readonly startOptionFields?: readonly ProviderStartOptionField[];
}

// ── Registry type ──────────────────────────────────────────────────

/**
 * ProviderRegistryMap — Type-safe mapping of provider IDs to their manifests.
 * Built by the registry factory from individual manifest imports.
 */
export type ProviderRegistryMap<T extends readonly ProviderManifest[]> = {
  readonly [M in T[number] as M["id"]]: M;
};

/**
 * Extract provider IDs as a union type from a registry map.
 */
export type ProviderIds<T extends Record<string, ProviderManifest>> = keyof T & string;
