/**
 * Provider Registry — Single source of truth for all provider configuration.
 *
 * Collects manifests and produces derived maps, lookups, and types.
 * Adding a new provider = import the manifest here + add to MANIFESTS array.
 *
 * @module ProviderRegistry
 */
import type { ProviderManifest, ProviderModelOption, ProviderCustomModelConfig } from "../providerManifest";
import { CODEX_MANIFEST } from "./codex";
import { CLAUDE_MANIFEST } from "./claude";
import { PI_MANIFEST } from "./pi";

// ── All registered manifests ───────────────────────────────────────

/**
 * MANIFESTS: The single array of all provider manifests.
 * To add a new provider: import the manifest, add it here. That's it.
 */
export const MANIFESTS = [CODEX_MANIFEST, CLAUDE_MANIFEST, PI_MANIFEST] as const;

/**
 * PROVIDER_IDS: Union literal type of all registered provider IDs.
 * Automatically extends when a new manifest is added to MANIFESTS.
 */
export type RegisteredProviderId = (typeof MANIFESTS)[number]["id"];

/**
 * PROVIDER_ID_LIST: Runtime array of all provider IDs (for Schema.Literals, iteration).
 */
export const PROVIDER_ID_LIST = MANIFESTS.map((m) => m.id) as unknown as readonly [RegisteredProviderId, ...RegisteredProviderId[]];

// ── Derived maps (generated from manifests, never hand-maintained) ──

// Helper to type Object.fromEntries from manifest arrays
function fromManifests<V>(fn: (m: ProviderManifest) => [string, V]): Record<RegisteredProviderId, V> {
  return Object.fromEntries(MANIFESTS.map(fn)) as unknown as Record<RegisteredProviderId, V>;
}

/** Map of provider ID to manifest */
const MANIFEST_MAP = fromManifests<ProviderManifest>((m) => [m.id, m]);

/** Get a provider manifest by ID */
export function getManifest(id: RegisteredProviderId): ProviderManifest {
  return MANIFEST_MAP[id];
}

/** Model options by provider */
export const MODEL_OPTIONS_BY_PROVIDER = fromManifests<readonly ProviderModelOption[]>((m) => [m.id, m.models]);

/** Default model by provider */
export const DEFAULT_MODEL_BY_PROVIDER = fromManifests<string>((m) => [m.id, m.defaultModel]);

/** Model slug aliases by provider */
export const MODEL_SLUG_ALIASES_BY_PROVIDER = fromManifests<Readonly<Record<string, string>>>((m) => [m.id, m.modelAliases]);

/** Reasoning effort options by provider */
export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = fromManifests<readonly string[]>((m) => [m.id, m.reasoning.options]);

/** Default reasoning effort by provider */
export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = fromManifests<string | null>((m) => [m.id, m.reasoning.default]);

/** Provider picker options (for session-logic.ts PROVIDER_OPTIONS) */
export const PROVIDER_PICKER_OPTIONS = MANIFESTS.map((m) => ({
  value: m.id as RegisteredProviderId,
  label: m.picker.label,
  available: m.picker.available,
}));

/** Custom model configs by provider (only providers that have them) */
export const CUSTOM_MODEL_CONFIGS = Object.fromEntries(
  MANIFESTS.filter((m) => m.customModels != null).map((m) => [m.id, m.customModels!]),
) as Partial<Record<RegisteredProviderId, ProviderCustomModelConfig>>;

/** All custom model settings (for settings UI iteration) */
export const ALL_CUSTOM_MODEL_CONFIGS = MANIFESTS
  .filter((m) => m.customModels != null)
  .map((m) => ({ providerId: m.id as RegisteredProviderId, ...m.customModels! }));

/** Built-in model slug sets by provider (for slug validation) */
export const BUILT_IN_MODEL_SLUGS_BY_PROVIDER = fromManifests<ReadonlySet<string>>(
  (m) => [m.id, new Set(m.models.map((model) => model.slug))],
);

/** Check if a string is a valid registered provider ID */
export function isRegisteredProviderId(value: string): value is RegisteredProviderId {
  return PROVIDER_ID_LIST.includes(value as RegisteredProviderId);
}

/** Get the display name for a provider */
export function getProviderDisplayName(id: string): string {
  if (isRegisteredProviderId(id)) {
    return MANIFEST_MAP[id].name;
  }
  return id;
}
