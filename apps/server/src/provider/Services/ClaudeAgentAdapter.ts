/**
 * ClaudeAgentAdapter - Claude Agent implementation of the generic provider adapter contract.
 *
 * Wraps @anthropic-ai/claude-agent-sdk query sessions behind the generic
 * provider adapter contract and emits canonical provider runtime events.
 *
 * @module ClaudeAgentAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeAgent";
}

export class ClaudeAgentAdapter extends ServiceMap.Service<ClaudeAgentAdapter, ClaudeAgentAdapterShape>()(
  "t3/provider/Services/ClaudeAgentAdapter",
) {}
