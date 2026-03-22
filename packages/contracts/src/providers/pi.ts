/**
 * Pi provider manifest.
 *
 * Pi is the recommended spoke. Dynamic model discovery at runtime
 * supplements this static fallback catalog.
 */
import type { ProviderManifest } from "../providerManifest";

export const PI_MANIFEST = {
  id: "pi",
  name: "Pi",

  models: [
    { slug: "anthropic/claude-sonnet-4-6", name: "Anthropic Claude Sonnet 4.6" },
    { slug: "openai-codex/gpt-5.4", name: "GPT-5.4" },
  ], // fallback only -- runtime list served from GET /api/provider/pi/models

  defaultModel: "anthropic/claude-sonnet-4-6",

  modelAliases: {
    sonnet: "anthropic/claude-sonnet-4-6",
    "sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
    "5.4": "openai-codex/gpt-5.4",
    "gpt-5.4": "openai-codex/gpt-5.4",
  },

  reasoning: {
    options: [],
    default: null,
  },

  capabilities: {
    sessionModelSwitch: "in-session",
  },

  picker: {
    label: "Pi",
    available: true,
  },

  customModels: {
    settingsKey: "customPiModels",
    title: "Pi",
    description: "Save additional Pi model slugs for the picker. Pi also discovers models dynamically at runtime.",
    placeholder: "provider/model-slug",
    example: "google/gemini-2.5-pro",
  },

  startOptionFields: [
    { key: "binaryPath", type: "string", optional: true },
  ],
} as const satisfies ProviderManifest;
