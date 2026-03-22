/**
 * Codex provider manifest.
 *
 * All Codex-specific configuration in one place. Values extracted from
 * the 34 hardcoded locations identified in the research brief.
 */
import type { ProviderManifest } from "../providerManifest";

export const CODEX_MANIFEST = {
  id: "codex",
  name: "Codex",

  models: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],

  defaultModel: "gpt-5.4",

  modelAliases: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },

  reasoning: {
    options: ["xhigh", "high", "medium", "low"],
    default: "high",
  },

  capabilities: {
    sessionModelSwitch: "restart-session",
  },

  picker: {
    label: "Codex",
    available: true,
  },

  customModels: {
    settingsKey: "customCodexModels",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },

  startOptionFields: [
    { key: "binaryPath", type: "string", optional: true },
    { key: "homePath", type: "string", optional: true },
  ],
} as const satisfies ProviderManifest;
