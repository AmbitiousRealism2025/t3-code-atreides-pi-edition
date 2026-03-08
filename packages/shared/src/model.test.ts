import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";

import {
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelOptions,
  getPiThinkingLevelOptions,
  getReasoningEffortOptions,
  normalizeModelSlug,
  resolveModelSlug,
  supportsPiThinkingLevel,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet", "pi")).toBe("anthropic/claude-sonnet-4-6");
    expect(normalizeModelSlug("sonnet-4-6", "pi")).toBe("anthropic/claude-sonnet-4-6");
    expect(normalizeModelSlug("5.4", "pi")).toBe("openai-codex/gpt-5.4");
    expect(normalizeModelSlug("gpt-5.4", "pi")).toBe("openai-codex/gpt-5.4");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });

  it("resolves pi aliases to the built-in provider-qualified slug", () => {
    expect(resolveModelSlug("gpt-5.4", "pi")).toBe("openai-codex/gpt-5.4");
    expect(resolveModelSlug("openai-codex/gpt-5.4", "pi")).toBe("openai-codex/gpt-5.4");
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("returns no reasoning options for pi", () => {
    expect(getReasoningEffortOptions("pi")).toEqual([]);
  });
});

describe("getPiThinkingLevelOptions", () => {
  it("returns thinking options only for supported pi models", () => {
    expect(getPiThinkingLevelOptions("openai-codex/gpt-5.4")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getPiThinkingLevelOptions("anthropic/claude-sonnet-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getPiThinkingLevelOptions("custom/pi-model")).toEqual([]);
  });
});

describe("supportsPiThinkingLevel", () => {
  it("recognizes the supported built-in pi thinking models", () => {
    expect(supportsPiThinkingLevel("gpt-5.4")).toBe(true);
    expect(supportsPiThinkingLevel("sonnet")).toBe(true);
    expect(supportsPiThinkingLevel("custom/pi-model")).toBe(false);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
    expect(getDefaultReasoningEffort("pi")).toBeNull();
  });
});
