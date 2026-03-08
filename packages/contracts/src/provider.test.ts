import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("high");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts pi provider payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-pi",
      provider: "pi",
      model: "openai-codex/gpt-5.4",
      modelOptions: {
        pi: {
          thinkingLevel: "high",
        },
      },
      runtimeMode: "full-access",
    });

    expect(parsed.provider).toBe("pi");
    expect(parsed.model).toBe("openai-codex/gpt-5.4");
    expect(parsed.modelOptions?.pi?.thinkingLevel).toBe("high");
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
  });

  it("accepts pi thinking-level model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-pi",
      model: "anthropic/claude-sonnet-4-6",
      modelOptions: {
        pi: {
          thinkingLevel: "off",
        },
      },
    });

    expect(parsed.model).toBe("anthropic/claude-sonnet-4-6");
    expect(parsed.modelOptions?.pi?.thinkingLevel).toBe("off");
  });
});
