/**
 * ClaudeAgentAdapterLive - Claude Agent provider adapter.
 *
 * Wraps @anthropic-ai/claude-agent-sdk query sessions behind the generic
 * provider adapter contract. Uses Streaming Input Mode for full interactive
 * experience: image uploads, interruption, queued messages.
 *
 * Auth: spawns local `claude` CLI via SDK. No credential management.
 * The user's existing auth (OAuth, API key) is used automatically.
 *
 * @module ClaudeAgentAdapterLive
 */
import {
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type CanonicalItemType,
  type RuntimeContentStreamKind,
} from "@t3tools/contracts";
import {
  resolveReasoningEffortForProvider,
  getReasoningEffortOptions,
  getEffectiveClaudeCodeEffort,
  supportsClaudeFastMode,
  supportsClaudeThinkingToggle,
} from "@t3tools/shared/model";
import { Deferred, Effect, Layer, Queue, Random, Ref, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { ClaudeAgentAdapter, type ClaudeAgentAdapterShape } from "../Services/ClaudeAgentAdapter.ts";
import { ServerConfig } from "../../config.ts";

const PROVIDER = "claudeAgent" as const;

// ── Types ──────────────────────────────────────────────────────────

type PromptQueueItem =
  | { readonly type: "message"; readonly message: SDKUserMessage }
  | { readonly type: "terminate" };

interface ClaudeSessionContext {
  session: ProviderSession;
  promptQueue: Queue.Queue<PromptQueueItem>;
  queryRuntime: AsyncIterable<SDKMessage> & { abort?: () => void; setModel?: (model: string) => Promise<void> };
  turns: Array<{ id: TurnId; items: unknown[] }>;
  turnState: { turnId: TurnId; startedAt: string } | undefined;
  pendingApprovals: Map<ApprovalRequestId, { decision: Deferred.Deferred<ProviderApprovalDecision> }>;
  pendingUserInputs: Map<ApprovalRequestId, { answers: Deferred.Deferred<ProviderUserInputAnswers> }>;
  resumeSessionId: string | undefined;
  stopped: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

function toPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "plan") {
    return value as PermissionMode;
  }
  return undefined;
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "Read": case "Glob": case "Grep": case "LS": case "View":
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
      return "file_change";
    case "Bash": case "Execute":
      return "command_execution";
    case "WebSearch":
      return "web_search";
    case "ImageView":
      return "image_view";
    default:
      return toolName.startsWith("mcp__") ? "mcp_tool_call" : "mcp_tool_call";
  }
}

function classifyRequestType(toolName: string): "command" | "file-read" | "file-change" {
  switch (toolName) {
    case "Read": case "Glob": case "Grep": case "LS": case "View":
      return "file-read";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
      return "file-change";
    default:
      return "command";
  }
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "Execute") {
    return typeof input.command === "string" ? input.command.slice(0, 200) : toolName;
  }
  if (typeof input.file_path === "string") return `${toolName}: ${input.file_path}`;
  if (typeof input.path === "string") return `${toolName}: ${input.path}`;
  return toolName;
}

function extractTextFromMessage(message: SDKMessage): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b: unknown) => (b as Record<string, unknown>).text as string)
      .join("");
  }
  return "";
}

function turnStatusFromResult(result: SDKResultMessage): "completed" | "failed" | "interrupted" {
  if (result.is_error) return "failed";
  if (result.stop_reason === "stop_sequence" || result.stop_reason === "tool_use" || result.stop_reason === "end_turn" || !result.stop_reason) return "completed";
  return "completed";
}

// ── Adapter factory ─────────────────────────────────────────────────

export interface ClaudeAgentAdapterLiveOptions {
  readonly nativeEventLogger?: unknown;
}

function makeClaudeAgentAdapter(_options?: ClaudeAgentAdapterLiveOptions) {
  return Effect.gen(function* () {
    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = () => new Date().toISOString();
    const nextEventId = () => Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }));
      }
      return Effect.succeed(ctx);
    };

    // ── Core: run the SDK stream ────────────────────────────────────

    function runSdkStream(context: ClaudeSessionContext): Effect.Effect<void> {
      return Effect.async<void, never>((resume) => {
        (async () => {
          try {
            for await (const message of context.queryRuntime) {
              if (context.stopped) break;

              const messageType = (message as Record<string, unknown>).type as string | undefined;

              // Text deltas
              if (messageType === "assistant" && "content" in message) {
                const text = extractTextFromMessage(message);
                if (text) {
                  await Effect.runPromise(Effect.gen(function* () {
                    const eid = yield* nextEventId();
                    const itemId = RuntimeItemId.makeUnsafe(crypto.randomUUID());
                    yield* offerRuntimeEvent({
                      type: "content.delta",
                      eventId: eid,
                      provider: PROVIDER,
                      createdAt: nowIso(),
                      threadId: context.session.threadId,
                      turnId: context.turnState?.turnId ?? TurnId.makeUnsafe("unknown"),
                      itemId,
                      payload: { streamKind: "assistant_text" as RuntimeContentStreamKind, delta: text },
                      providerRefs: {},
                    });
                  }));
                }
              }

              // Result message (turn complete)
              if (messageType === "result") {
                const result = message as unknown as SDKResultMessage;
                const status = turnStatusFromResult(result);
                const text = extractTextFromMessage(message);

                await Effect.runPromise(Effect.gen(function* () {
                  if (text) {
                    const eid = yield* nextEventId();
                    yield* offerRuntimeEvent({
                      type: "content.delta",
                      eventId: eid,
                      provider: PROVIDER,
                      createdAt: nowIso(),
                      threadId: context.session.threadId,
                      turnId: context.turnState?.turnId ?? TurnId.makeUnsafe("unknown"),
                      itemId: RuntimeItemId.makeUnsafe(crypto.randomUUID()),
                      payload: { streamKind: "assistant_text" as RuntimeContentStreamKind, delta: text },
                      providerRefs: {},
                    });
                  }

                  // Emit turn completed
                  if (context.turnState) {
                    const eid = yield* nextEventId();
                    yield* offerRuntimeEvent({
                      type: "turn.completed",
                      eventId: eid,
                      provider: PROVIDER,
                      createdAt: nowIso(),
                      threadId: context.session.threadId,
                      turnId: context.turnState.turnId,
                      payload: { status },
                      providerRefs: {},
                    });

                    context.turns.push({
                      id: context.turnState.turnId,
                      items: [],
                    });
                    context.turnState = undefined;
                  }

                  // Session back to ready
                  const readyEid = yield* nextEventId();
                  yield* offerRuntimeEvent({
                    type: "session.state.changed",
                    eventId: readyEid,
                    provider: PROVIDER,
                    createdAt: nowIso(),
                    threadId: context.session.threadId,
                    payload: { state: "ready" },
                    providerRefs: {},
                  });
                }));
              }
            }
          } catch (error) {
            if (!context.stopped) {
              await Effect.runPromise(Effect.gen(function* () {
                const eid = yield* nextEventId();
                yield* offerRuntimeEvent({
                  type: "session.state.changed",
                  eventId: eid,
                  provider: PROVIDER,
                  createdAt: nowIso(),
                  threadId: context.session.threadId,
                  payload: { state: "error" },
                  providerRefs: {},
                });
              }));
            }
          }
          resume(Effect.void);
        })();
      });
    }

    // ── ProviderAdapterShape implementation ──────────────────────────

    const startSession: ClaudeAgentAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = nowIso();
        const threadId = input.threadId;
        const sessionId = crypto.randomUUID();

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => (item as { type: "message"; message: SDKUserMessage }).message),
          Stream.toAsyncIterable,
        );

        // canUseTool: handle permission requests
        const pendingApprovals = new Map<ApprovalRequestId, { decision: Deferred.Deferred<ProviderApprovalDecision> }>();
        const pendingUserInputs = new Map<ApprovalRequestId, { answers: Deferred.Deferred<ProviderUserInputAnswers> }>();

        const canUseTool = (toolName: string, toolInput: Record<string, unknown>, callbackOptions: { signal: AbortSignal; toolUseID?: string }) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const runtimeMode = input.runtimeMode ?? "full-access";
              if (runtimeMode === "full-access") {
                return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
              }

              // Approval mode: emit request and wait for decision
              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();

              pendingApprovals.set(requestId, { decision: decisionDeferred });

              const eid = yield* nextEventId();
              yield* offerRuntimeEvent({
                type: "request.opened",
                eventId: eid,
                provider: PROVIDER,
                createdAt: nowIso(),
                threadId,
                ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                requestId: requestId as unknown as string,
                payload: { requestType, detail, args: { toolName, input: toolInput } },
                providerRefs: {},
                raw: { source: "claude.sdk.permission" as const, method: "canUseTool/request", payload: { toolName, input: toolInput } },
              } as unknown as ProviderRuntimeEvent);

              callbackOptions.signal.addEventListener("abort", () => {
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              }, { once: true });

              const decision = yield* Deferred.await(decisionDeferred);
              pendingApprovals.delete(requestId);

              if (decision === "accept" || decision === "acceptForSession") {
                return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
              }
              return { behavior: "deny", message: "User declined tool execution." } satisfies PermissionResult;
            }),
          );

        // Build query options
        const providerOptions = input.providerOptions?.claudeAgent;
        const effort = getEffectiveClaudeCodeEffort(
          resolveReasoningEffortForProvider("claudeAgent", input.modelOptions?.claudeAgent?.effort ?? null) as any,
        );
        const fastMode = input.modelOptions?.claudeAgent?.fastMode === true && supportsClaudeFastMode(input.model);
        const thinking = typeof input.modelOptions?.claudeAgent?.thinking === "boolean" && supportsClaudeThinkingToggle(input.model)
          ? input.modelOptions.claudeAgent.thinking : undefined;
        const permissionMode = toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);

        const settings: Record<string, unknown> = {};
        if (typeof thinking === "boolean") settings.alwaysThinkingEnabled = thinking;
        if (fastMode) settings.fastMode = true;

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          ...(effort ? { effort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined ? { maxThinkingTokens: providerOptions.maxThinkingTokens } : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          sessionId,
          includePartialMessages: true,
          canUseTool,
          env: process.env,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        let queryRuntime: AsyncIterable<SDKMessage> & { abort?: () => void; setModel?: (model: string) => Promise<void> };
        try {
          queryRuntime = query({ prompt, options: queryOptions }) as typeof queryRuntime;
        } catch (cause) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: cause instanceof Error ? cause.message : "Failed to start Claude runtime session.",
            cause,
          });
        }

        const session: ProviderSession = {
          threadId,
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          queryRuntime,
          turns: [],
          turnState: undefined,
          pendingApprovals,
          pendingUserInputs,
          resumeSessionId: sessionId,
          stopped: false,
        };
        sessions.set(threadId, context);

        // Emit session events
        const startEid = yield* nextEventId();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: startEid,
          provider: PROVIDER,
          createdAt: startedAt,
          threadId,
          payload: {},
          providerRefs: {},
        });

        const readyEid = yield* nextEventId();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyEid,
          provider: PROVIDER,
          createdAt: startedAt,
          threadId,
          payload: { state: "ready" },
          providerRefs: {},
        });

        // Start streaming in the background
        Effect.runFork(runSdkStream(context));

        return { ...session };
      });

    const sendTurn: ClaudeAgentAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);

        const turnId = TurnId.makeUnsafe(`claude:turn:${crypto.randomUUID()}`);
        context.turnState = { turnId, startedAt: nowIso() };

        // Update session to running
        context.session = { ...context.session, status: "running", updatedAt: nowIso() };

        const runningEid = yield* nextEventId();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: runningEid,
          provider: PROVIDER,
          createdAt: nowIso(),
          threadId: input.threadId,
          payload: { state: "running" },
          providerRefs: {},
        });

        // Build user message and enqueue
        const userMessage: SDKUserMessage = {
          role: "user",
          content: input.input ?? "",
        };
        yield* Queue.offer(context.promptQueue, { type: "message", message: userMessage });

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn: ClaudeAgentAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.queryRuntime && "abort" in context.queryRuntime && typeof context.queryRuntime.abort === "function") {
          context.queryRuntime.abort();
        }
      });

    const respondToRequest: ClaudeAgentAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (pending) {
          yield* Deferred.succeed(pending.decision, decision);
          context.pendingApprovals.delete(requestId);
        }
      });

    const respondToUserInput: ClaudeAgentAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (pending) {
          yield* Deferred.succeed(pending.answers, answers);
          context.pendingUserInputs.delete(requestId);
        }
      });

    const stopSession: ClaudeAgentAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        context.stopped = true;
        yield* Queue.offer(context.promptQueue, { type: "terminate" });
        yield* Queue.shutdown(context.promptQueue);
        sessions.delete(threadId);

        const eid = yield* nextEventId();
        yield* offerRuntimeEvent({
          type: "session.exited",
          eventId: eid,
          provider: PROVIDER,
          createdAt: nowIso(),
          threadId,
          payload: { exitKind: "graceful" },
          providerRefs: {},
        });
      });

    const readThread: ClaudeAgentAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return {
          threadId,
          turns: context.turns.map((t) => ({ id: t.id, items: [...t.items] })),
        };
      });

    const rollbackThread: ClaudeAgentAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (numTurns > 0 && numTurns <= context.turns.length) {
          context.turns.splice(context.turns.length - numTurns, numTurns);
        }
        return {
          threadId,
          turns: context.turns.map((t) => ({ id: t.id, items: [...t.items] })),
        };
      });

    const listSessions: ClaudeAgentAdapterShape["listSessions"] = () =>
      Effect.succeed(Array.from(sessions.values()).map((ctx) => ctx.session));

    const hasSession: ClaudeAgentAdapterShape["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId));

    const stopAll: ClaudeAgentAdapterShape["stopAll"] = () =>
      Effect.forEach(
        Array.from(sessions.keys()),
        (threadId) => stopSession(threadId),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue)));

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAgentAdapterShape;
  });
}

export const ClaudeAgentAdapterLive = Layer.effect(ClaudeAgentAdapter, makeClaudeAgentAdapter());

export function makeClaudeAgentAdapterLive(options?: ClaudeAgentAdapterLiveOptions) {
  return Layer.effect(ClaudeAgentAdapter, makeClaudeAgentAdapter(options));
}
