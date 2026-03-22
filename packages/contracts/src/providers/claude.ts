/**
 * Claude Agent provider manifest.
 *
 * Uses @anthropic-ai/claude-agent-sdk to spawn the local `claude` CLI.
 * We do not handle credentials. The user's existing Claude Code auth
 * (OAuth, API key) is used automatically by the SDK.
 *
 * Branding: "Claude Agent" not "Claude Code" per Anthropic requirements.
 */
import type { ProviderManifest } from "../providerManifest";

export const CLAUDE_MANIFEST = {
  id: "claudeAgent",
  name: "Claude Agent",

  models: [
    { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { slug: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { slug: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ],

  defaultModel: "claude-sonnet-4-6",

  modelAliases: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
  },

  reasoning: {
    options: ["low", "medium", "high", "max"],
    default: "high",
  },

  capabilities: {
    sessionModelSwitch: "in-session",
  },

  picker: {
    label: "Claude Agent",
    available: true,
  },

  customModels: {
    settingsKey: "customClaudeModels",
    title: "Claude Agent",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },

  startOptionFields: [
    { key: "binaryPath", type: "string", optional: true },
    { key: "permissionMode", type: "string", optional: true },
    { key: "maxThinkingTokens", type: "number", optional: true },
  ],
} as const satisfies ProviderManifest;
