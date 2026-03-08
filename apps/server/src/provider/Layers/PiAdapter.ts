/**
 * PiAdapterLive - Scoped live implementation for the Pi provider adapter.
 *
 * Uses a short-lived Pi RPC process per turn and stores Pi session files under
 * the server-managed state directory to keep session continuity predictable.
 *
 * @module PiAdapterLive
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  EventId,
  RuntimeItemId,
  TurnId,
  type ChatAttachment,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { createPiRuntimeEnv } from "./piRuntimeState.ts";

const PROVIDER = "pi" as const;
const DEFAULT_PI_BINARY_PATH = "/opt/homebrew/bin/pi";
const PROCESS_KILL_TIMEOUT_MS = 500;
export const PI_ACTIVITY_BRIDGE_EXTENSION_PATH = path.resolve(
  import.meta.dirname,
  "atreides-t3-bridge.ts",
);

/**
 * DEFAULT_PI_SYSTEM_PROMPT
 *
 * Behavioral baseline for all Pi sessions. Captures the communication style
 * and completion standards that make responses feel consistent and useful.
 * Full agent SOUL.md files override this when a named agent is active.
 * Anonymous sessions (no SOUL.md) get this as their foundation.
 */
export const DEFAULT_PI_SYSTEM_PROMPT = `You are a skilled, direct collaborator. You have agency -- you make decisions, take action, and complete work without unnecessary hand-holding.

## Communication Style

- Be direct and concise. Say what you mean. No corporate speak, no filler phrases.
- Casual tone unless the context demands otherwise.
- Warm but not soft. You care about quality and will say so when something is not right.
- No em dashes. Use commas, colons, or a new sentence instead.
- No excessive hedging. If something depends on context, say what it depends on and how you would decide.
- When you have an opinion, state it. Do not bury it in qualifications or present five options when you know which one is right.

## Completing Work

- Finish what was asked. Do not stop partway through a task and ask for permission to continue.
- When you use tools, use as many as needed to fully complete the task.
- After completing a task, always provide a brief summary of what you did and what the result was. One to three sentences. Never go silent after tool use.
- If you write files, confirm what was written and where.
- If you run commands, confirm what ran and what it produced.
- If something fails, say so clearly and explain what went wrong.

## Quality Standards

- Do not cut corners to finish faster. A complete answer done well beats a fast answer done poorly.
- If the request is ambiguous, make a reasonable assumption, state it, and proceed. Do not stall asking for clarification on things you can reasonably infer.
- Push back when you see something wrong. A collaborator who agrees with everything is not useful.

## Ending Responses

Every response ends with a clear closing signal:
- Task completed: one-line summary of what was done.
- Question answered: "Done." or a brief closing sentence.
- Blocked or needs input: state your question clearly as the final line.
Never end mid-thought or without a closing signal.`;


interface PiChildProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  readonly pid: number | undefined;
  kill: ChildProcess["kill"];
  once: ChildProcess["once"];
}

type PiProcessSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
) => PiChildProcess;

interface PiActiveTurn {
  readonly turnId: TurnId;
  readonly process: PiChildProcess;
  readonly assistantItemId: string;
  promptResponseSettled: boolean;
  turnStartedEmitted: boolean;
  turnCompletedEmitted: boolean;
  assistantItemCompleted: boolean;
  interrupted: boolean;
  assistantText: string;
  stderrLines: string[];
}

interface PiSessionState {
  readonly threadId: ThreadId;
  readonly createdAt: string;
  cwd: string;
  sessionFile: string;
  runtimeMode: ProviderSession["runtimeMode"];
  status: ProviderSession["status"];
  updatedAt: string;
  model?: string;
  lastError?: string;
  activeTurn: PiActiveTurn | undefined;
}

export interface PiAdapterLiveOptions {
  readonly binaryPath?: string;
  readonly spawnProcess?: PiProcessSpawner;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function defaultSpawnProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  },
): PiChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as PiChildProcess;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }

  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }
      if (part.type !== "text" || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("");
}

function extractThinkingText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!isRecord(part)) {
        return [];
      }
      if (part.type !== "thinking" || typeof part.thinking !== "string") {
        return [];
      }
      return [part.thinking];
    })
    .join("");
}

function extractAssistantMessage(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const message = isRecord(event.message) ? event.message : undefined;
  return message?.role === "assistant" ? message : undefined;
}

function summarizeAssistantText(message: Record<string, unknown>): string | undefined {
  const text = extractMessageText(message).trim();
  if (!text) {
    return undefined;
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function normalizeTurnState(input: {
  readonly stopReason?: string;
  readonly interrupted: boolean;
  readonly errorMessage?: string;
}): "completed" | "failed" | "interrupted" | "cancelled" {
  if (input.interrupted || input.stopReason === "aborted") {
    return "interrupted";
  }
  if (input.stopReason === "error" || input.errorMessage) {
    return "failed";
  }
  if (input.stopReason === "cancelled") {
    return "cancelled";
  }
  return "completed";
}

function truncateStderr(lines: ReadonlyArray<string>): string | undefined {
  const combined = lines.join("\n").trim();
  if (!combined) {
    return undefined;
  }
  return combined.length > 1_000 ? `${combined.slice(0, 997)}...` : combined;
}

function resolvePiBinaryPath(explicitPath: string | undefined): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitPath;
  }
  return fs.existsSync(DEFAULT_PI_BINARY_PATH) ? DEFAULT_PI_BINARY_PATH : "pi";
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function sessionFileFromResumeCursor(
  resumeCursor: unknown,
  fallbackPath: string,
): string {
  if (!isRecord(resumeCursor)) {
    return fallbackPath;
  }
  const sessionFile = asString(resumeCursor.sessionFile)?.trim();
  return sessionFile && sessionFile.length > 0 ? sessionFile : fallbackPath;
}

function toSession(state: PiSessionState): ProviderSession {
  return {
    provider: PROVIDER,
    status: state.status,
    runtimeMode: state.runtimeMode,
    cwd: state.cwd,
    ...(state.model ? { model: state.model } : {}),
    threadId: state.threadId,
    resumeCursor: {
      sessionFile: state.sessionFile,
    },
    ...(state.activeTurn ? { activeTurnId: state.activeTurn.turnId } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

function runtimeEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: string;
}): Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId"> {
  return {
    eventId: EventId.makeUnsafe(`pi:event:${randomUUID()}`),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
  };
}

function sendRpcCommand(process: PiChildProcess, command: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.stdin) {
      reject(new Error("Pi RPC stdin is unavailable."));
      return;
    }
    process.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function resolvePiPromptImages(
  input: {
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly stateDir: string;
    readonly threadId: ThreadId;
  },
): Promise<ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>> {
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  for (const attachment of input.attachments) {
    const attachmentPath = resolveAttachmentPath({
      stateDir: input.stateDir,
      attachment,
    });
    if (!attachmentPath || !fs.existsSync(attachmentPath)) {
      throw new Error(`Attachment '${attachment.id}' could not be resolved for thread '${input.threadId}'.`);
    }
    const data = fs.readFileSync(attachmentPath).toString("base64");
    images.push({
      type: "image",
      data,
      mimeType: attachment.mimeType,
    });
  }

  return images;
}

function scheduleForceKill(process: PiChildProcess): void {
  setTimeout(() => {
    try {
      process.kill("SIGKILL");
    } catch {
      // Best-effort cleanup only.
    }
  }, PROCESS_KILL_TIMEOUT_MS);
}

const makePiAdapter = (options?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* Effect.service(ServerConfig);
    const stateRoot = path.join(serverConfig.stateDir, "providers", PROVIDER);
    const agentDir = path.join(stateRoot, "agent");
    const sessionsDir = path.join(stateRoot, "sessions");
    const binaryPath = resolvePiBinaryPath(options?.binaryPath);
    const spawnProcess = options?.spawnProcess ?? defaultSpawnProcess;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    yield* Effect.sync(() => {
      ensureDirectory(agentDir);
      ensureDirectory(sessionsDir);
    });

    const sessionByThreadId = new Map<ThreadId, PiSessionState>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emitRuntimeEvent = (event: ProviderRuntimeEvent): void => {
      Effect.runFork(Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid));
    };

    const writeNativeEvent = (event: unknown, threadId: ThreadId): void => {
      if (!nativeEventLogger) {
        return;
      }
      Effect.runFork(nativeEventLogger.write(event, threadId));
    };

    const setSessionState = (
      state: PiSessionState,
      patch: Partial<
        Pick<PiSessionState, "status" | "model" | "lastError" | "activeTurn" | "cwd" | "sessionFile" | "runtimeMode">
      >,
    ): PiSessionState => {
      const next: PiSessionState = {
        ...state,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      sessionByThreadId.set(state.threadId, next);
      return next;
    };

    const emitSessionStateChanged = (
      state: PiSessionState,
      sessionState: "ready" | "running" | "stopped" | "error",
      reason?: string,
    ): void => {
      emitRuntimeEvent({
        type: "session.state.changed",
        ...runtimeEventBase({ threadId: state.threadId }),
        payload: {
          state: sessionState,
          ...(reason ? { reason } : {}),
        },
      });
    };

    const finishTurn = (
      state: PiSessionState,
      activeTurn: PiActiveTurn,
      options: {
        readonly stopReason?: string;
        readonly errorMessage?: string;
        readonly message?: Record<string, unknown>;
      },
    ): void => {
      if (activeTurn.turnCompletedEmitted) {
        return;
      }

      const assistantMessage = options.message;
      const assistantText = assistantMessage ? extractMessageText(assistantMessage) : activeTurn.assistantText;
      if (assistantText.length > activeTurn.assistantText.length) {
        const delta = assistantText.startsWith(activeTurn.assistantText)
          ? assistantText.slice(activeTurn.assistantText.length)
          : assistantText;
        if (delta.length > 0) {
          emitRuntimeEvent({
            type: "content.delta",
            ...runtimeEventBase({
              threadId: state.threadId,
              turnId: activeTurn.turnId,
              itemId: activeTurn.assistantItemId,
            }),
            payload: {
              streamKind: "assistant_text",
              delta,
            },
          });
        }
        activeTurn.assistantText = assistantText;
      }

      if (!activeTurn.assistantItemCompleted && assistantMessage) {
        activeTurn.assistantItemCompleted = true;
        emitRuntimeEvent({
          type: "item.completed",
          ...runtimeEventBase({
            threadId: state.threadId,
            turnId: activeTurn.turnId,
            itemId: activeTurn.assistantItemId,
          }),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(summarizeAssistantText(assistantMessage)
              ? { detail: summarizeAssistantText(assistantMessage) }
              : {}),
            data: assistantMessage,
          },
        });
      }

      activeTurn.turnCompletedEmitted = true;
      const errorMessage = options.errorMessage ?? truncateStderr(activeTurn.stderrLines);
      const stateValue = normalizeTurnState({
        interrupted: activeTurn.interrupted,
        ...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      });

      emitRuntimeEvent({
        type: "turn.completed",
        ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
        payload: {
          state: stateValue,
          ...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      });

      const nextStatus = stateValue === "failed" ? "error" : "ready";
      const nextState = setSessionState(state, {
        status: nextStatus,
        activeTurn: undefined,
        ...(errorMessage ? { lastError: errorMessage } : {}),
      });
      emitSessionStateChanged(nextState, nextStatus === "error" ? "error" : "ready");
    };

    const handlePiEvent = (state: PiSessionState, activeTurn: PiActiveTurn, message: unknown): void => {
      if (!isRecord(message)) {
        emitRuntimeEvent({
          type: "runtime.warning",
          ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
          payload: {
            message: "Pi RPC emitted a non-object event payload.",
            detail: message,
          },
          raw: {
            source: "pi.rpc.event",
            payload: message,
          },
        });
        return;
      }

      const type = asString(message.type);
      if (!type) {
        emitRuntimeEvent({
          type: "runtime.warning",
          ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
          payload: {
            message: "Pi RPC emitted an event without a type field.",
            detail: message,
          },
          raw: {
            source: "pi.rpc.event",
            payload: message,
          },
        });
        return;
      }

      switch (type) {
        case "agent_start": {
          emitSessionStateChanged(state, "running");
          return;
        }

        case "message_start": {
          // Pi emits message_start when a new message begins streaming -- content
          // arrives via message_update events. Silently acknowledge.
          return;
        }

        case "turn_start": {
          if (!activeTurn.turnStartedEmitted) {
            activeTurn.turnStartedEmitted = true;
            emitRuntimeEvent({
              type: "turn.started",
              ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
              payload: state.model ? { model: state.model } : {},
              raw: {
                source: "pi.rpc.event",
                messageType: type,
                payload: message,
              },
            });
          }
          return;
        }

        case "message_update":
        case "message_end": {
          const assistantMessage = extractAssistantMessage(message);
          if (!assistantMessage) {
            return;
          }

          // Emit thinking content BEFORE text at message_end (thinking arrives complete, not streamed).
          if (type === "message_end") {
            const thinkingText = extractThinkingText(assistantMessage);
            if (thinkingText.length >= 20) {
              emitRuntimeEvent({
                type: "content.delta",
                ...runtimeEventBase({
                  threadId: state.threadId,
                  turnId: activeTurn.turnId,
                  itemId: activeTurn.assistantItemId,
                }),
                payload: {
                  streamKind: "thinking",
                  delta: thinkingText,
                },
                raw: {
                  source: "pi.rpc.event",
                  messageType: type,
                  payload: message,
                },
              });
            }
          }

          const nextText = extractMessageText(assistantMessage);
          const delta = nextText.startsWith(activeTurn.assistantText)
            ? nextText.slice(activeTurn.assistantText.length)
            : nextText;
          if (delta.length > 0) {
            emitRuntimeEvent({
              type: "content.delta",
              ...runtimeEventBase({
                threadId: state.threadId,
                turnId: activeTurn.turnId,
                itemId: activeTurn.assistantItemId,
              }),
              payload: {
                streamKind: "assistant_text",
                delta,
              },
              raw: {
                source: "pi.rpc.event",
                messageType: type,
                payload: message,
              },
            });
            activeTurn.assistantText = nextText;
          }

          if (type === "message_end" && !activeTurn.assistantItemCompleted) {
            activeTurn.assistantItemCompleted = true;
            emitRuntimeEvent({
              type: "item.completed",
              ...runtimeEventBase({
                threadId: state.threadId,
                turnId: activeTurn.turnId,
                itemId: activeTurn.assistantItemId,
              }),
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(summarizeAssistantText(assistantMessage)
                  ? { detail: summarizeAssistantText(assistantMessage) }
                  : {}),
                data: assistantMessage,
              },
              raw: {
                source: "pi.rpc.event",
                messageType: type,
                payload: message,
              },
            });
          }
          return;
        }

        case "tool_execution_start": {
          const toolCallId = asString(message.toolCallId) ?? `tool:${randomUUID()}`;
          const toolName = asString(message.toolName);
          emitRuntimeEvent({
            type: "item.started",
            ...runtimeEventBase({
              threadId: state.threadId,
              turnId: activeTurn.turnId,
              itemId: toolCallId,
            }),
            payload: {
              itemType: toolName === "bash" ? "command_execution" : "dynamic_tool_call",
              status: "inProgress",
              ...(toolName ? { title: toolName } : {}),
              data: message,
            },
            raw: {
              source: "pi.rpc.event",
              messageType: type,
              payload: message,
            },
          });
          return;
        }

        case "tool_execution_update": {
          emitRuntimeEvent({
            type: "tool.progress",
            ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
            payload: {
              ...(asString(message.toolCallId) ? { toolUseId: asString(message.toolCallId) } : {}),
              ...(asString(message.toolName) ? { toolName: asString(message.toolName) } : {}),
              ...(asString(message.partialResult)
                ? { summary: asString(message.partialResult) }
                : {}),
            },
            raw: {
              source: "pi.rpc.event",
              messageType: type,
              payload: message,
            },
          });
          return;
        }

        case "tool_execution_end": {
          const toolCallId = asString(message.toolCallId) ?? `tool:${randomUUID()}`;
          const toolName = asString(message.toolName);
          const resultSummary = asString(message.result);
          emitRuntimeEvent({
            type: "item.completed",
            ...runtimeEventBase({
              threadId: state.threadId,
              turnId: activeTurn.turnId,
              itemId: toolCallId,
            }),
            payload: {
              itemType: toolName === "bash" ? "command_execution" : "dynamic_tool_call",
              status: message.isError === true ? "failed" : "completed",
              ...(toolName ? { title: toolName } : {}),
              ...(resultSummary ? { detail: resultSummary } : {}),
              data: message,
            },
            raw: {
              source: "pi.rpc.event",
              messageType: type,
              payload: message,
            },
          });
          return;
        }

        case "turn_end": {
          const assistantMessage = isRecord(message.message) ? message.message : undefined;
          const stopReason = assistantMessage ? asString(assistantMessage.stopReason) : undefined;
          const errorMessage = assistantMessage ? asString(assistantMessage.errorMessage) : undefined;
          finishTurn(state, activeTurn, {
            ...(stopReason !== undefined ? { stopReason } : {}),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
            ...(assistantMessage ? { message: assistantMessage } : {}),
          });
          return;
        }

        case "agent_end": {
          if (!activeTurn.turnCompletedEmitted) {
            finishTurn(state, activeTurn, {});
          }
          return;
        }

        case "auto_retry_start":
        case "auto_retry_end":
        case "auto_compaction_start":
        case "auto_compaction_end": {
          emitRuntimeEvent({
            type: "runtime.warning",
            ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
            payload: {
              message: `Pi emitted ${type.replaceAll("_", " ")}.`,
              detail: message,
            },
            raw: {
              source: "pi.rpc.event",
              messageType: type,
              payload: message,
            },
          });
          return;
        }

        default: {
          emitRuntimeEvent({
            type: "runtime.warning",
            ...runtimeEventBase({ threadId: state.threadId, turnId: activeTurn.turnId }),
            payload: {
              message: `Pi emitted an unhandled event type: ${type}.`,
              detail: message,
            },
            raw: {
              source: "pi.rpc.event",
              messageType: type,
              payload: message,
            },
          });
        }
      }
    };

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            }),
          );
        }

        const now = new Date().toISOString();
        const fallbackSessionFile = path.join(sessionsDir, `${input.threadId}.jsonl`);
        const existing = sessionByThreadId.get(input.threadId);
        const state: PiSessionState = existing ?? {
          threadId: input.threadId,
          createdAt: now,
          cwd: input.cwd ?? serverConfig.cwd,
          sessionFile: sessionFileFromResumeCursor(input.resumeCursor, fallbackSessionFile),
          runtimeMode: input.runtimeMode,
          status: "ready",
          updatedAt: now,
          activeTurn: undefined,
          ...(input.model ? { model: input.model } : {}),
        };

        const next = setSessionState(state, {
          cwd: input.cwd ?? state.cwd,
          sessionFile: sessionFileFromResumeCursor(input.resumeCursor, state.sessionFile),
          runtimeMode: input.runtimeMode,
          status: "ready",
          ...((input.model ?? state.model) !== undefined ? { model: input.model ?? state.model } : {}),
        });

        emitRuntimeEvent({
          type: "session.started",
          ...runtimeEventBase({ threadId: input.threadId }),
          payload: {
            message: "Pi session initialized.",
            resume: {
              sessionFile: next.sessionFile,
            },
          },
        });
        emitSessionStateChanged(next, "ready");

        return toSession(next);
      });

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: async (): Promise<ProviderTurnStartResult> => {
          const state = sessionByThreadId.get(input.threadId);
          if (!state) {
            throw new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          if (state.activeTurn) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Thread '${input.threadId}' already has an active Pi turn.`,
            });
          }

          const turnId = TurnId.makeUnsafe(`pi:turn:${randomUUID()}`);
          const assistantItemId = `pi:item:${turnId}:assistant`;
          const effectiveModel = input.model ?? state.model;
          const commandId = `prompt:${randomUUID()}`;
          const sessionFileExists = fs.existsSync(state.sessionFile);
          const args = [
            "--mode",
            "rpc",
            ...(sessionFileExists ? ["--continue"] : []),
            "--session",
            state.sessionFile,
            "--no-extensions",
            "--extension",
            PI_ACTIVITY_BRIDGE_EXTENSION_PATH,
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
          ];
          if (effectiveModel) {
            args.push("--model", effectiveModel);
          }
          if (input.modelOptions?.pi?.thinkingLevel) {
            args.push("--thinking", input.modelOptions.pi.thinkingLevel);
          }
          // Default behavioral baseline -- applies to all Pi sessions unless a
          // full agent SOUL.md overrides it. Keeps anonymous sessions from going
          // silent after tool use and sets communication standards.
          args.push(
            "--append-system-prompt",
            DEFAULT_PI_SYSTEM_PROMPT,
          );

          const child = spawnProcess(binaryPath, args, {
            cwd: state.cwd,
            env: {
              ...createPiRuntimeEnv(agentDir),
              PI_T3_THREAD_ID: state.threadId,
              PI_T3_TURN_ID: turnId,
              ...(serverConfig.port > 0
                ? { PI_T3_ACTIVITY_URL: `http://127.0.0.1:${serverConfig.port}/api/provider/pi/activity` }
                : {}),
            },
          });

          const activeTurn: PiActiveTurn = {
            turnId,
            process: child,
            assistantItemId,
            promptResponseSettled: false,
            turnStartedEmitted: false,
            turnCompletedEmitted: false,
            assistantItemCompleted: false,
            interrupted: false,
            assistantText: "",
            stderrLines: [],
          };

          const runningState = setSessionState(state, {
            status: "running",
            activeTurn,
            ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
          });
          emitSessionStateChanged(runningState, "running");

          writeNativeEvent(
            {
              source: "pi.rpc.stdout",
              args,
              cwd: state.cwd,
            },
            state.threadId,
          );

          const promptAck = new Promise<void>((resolve, reject) => {
            const stdoutReader = child.stdout
              ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
              : null;
            const stderrReader = child.stderr
              ? readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
              : null;

            const settlePromptAck = (handler: () => void) => {
              if (activeTurn.promptResponseSettled) {
                return;
              }
              activeTurn.promptResponseSettled = true;
              handler();
            };

            const failPromptTurn = (errorMessage: string, payload: Record<string, unknown>) => {
              settlePromptAck(() => reject(new Error(errorMessage)));

              const latestState = sessionByThreadId.get(state.threadId);
              if (!latestState?.activeTurn || latestState.activeTurn.turnId !== turnId) {
                return;
              }

              emitRuntimeEvent({
                type: "runtime.error",
                ...runtimeEventBase({ threadId: state.threadId, turnId }),
                payload: {
                  message: errorMessage,
                  class: "provider_error",
                },
                raw: {
                  source: "pi.rpc.response",
                  messageType: "response",
                  payload,
                },
              });

              finishTurn(latestState, latestState.activeTurn, {
                stopReason: "error",
                errorMessage,
              });

              try {
                child.kill("SIGTERM");
                scheduleForceKill(child);
              } catch {
                // Best-effort cleanup only.
              }
            };

            stdoutReader?.on("line", (line) => {
              writeNativeEvent({ source: "pi.rpc.stdout", line }, state.threadId);
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                emitRuntimeEvent({
                  type: "runtime.warning",
                  ...runtimeEventBase({ threadId: state.threadId, turnId }),
                  payload: {
                    message: "Pi RPC emitted malformed JSON.",
                    detail: line,
                  },
                  raw: {
                    source: "pi.rpc.stdout",
                    payload: line,
                  },
                });
                return;
              }

              if (!isRecord(parsed)) {
                return;
              }

              if (parsed.type === "response" && parsed.id === commandId) {
                if (parsed.success === true) {
                  if (!activeTurn.promptResponseSettled) {
                    if (!activeTurn.turnStartedEmitted) {
                      activeTurn.turnStartedEmitted = true;
                      emitRuntimeEvent({
                        type: "turn.started",
                        ...runtimeEventBase({ threadId: state.threadId, turnId }),
                        payload: effectiveModel ? { model: effectiveModel } : {},
                        raw: {
                          source: "pi.rpc.response",
                          messageType: "response",
                          payload: parsed,
                        },
                      });
                    }
                    settlePromptAck(resolve);
                  }
                } else {
                  const errorMessage =
                    asString(parsed.error) ?? "Pi rejected the prompt command.";
                  failPromptTurn(errorMessage, parsed);
                }
                return;
              }

              if (parsed.type === "response") {
                return;
              }

              if (parsed.type === "extension_ui_request") {
                emitRuntimeEvent({
                  type: "runtime.warning",
                  ...runtimeEventBase({ threadId: state.threadId, turnId }),
                  payload: {
                    message: "Pi requested RPC extension UI interaction, which is not supported by this adapter.",
                    detail: parsed,
                  },
                  raw: {
                    source: "pi.rpc.response",
                    messageType: "extension_ui_request",
                    payload: parsed,
                  },
                });
                return;
              }

              handlePiEvent(state, activeTurn, parsed);
            });

            stderrReader?.on("line", (line) => {
              writeNativeEvent({ source: "pi.rpc.stderr", line }, state.threadId);
              activeTurn.stderrLines.push(line);
              if (activeTurn.stderrLines.length > 20) {
                activeTurn.stderrLines.shift();
              }
            });

            child.once("error", (error) => {
              settlePromptAck(() => reject(error));
              emitRuntimeEvent({
                type: "runtime.error",
                ...runtimeEventBase({ threadId: state.threadId, turnId }),
                payload: {
                  message: toMessage(error, "Pi process failed to start."),
                  class: "transport_error",
                },
              });
            });

            child.once("exit", (code, signal) => {
              stdoutReader?.close();
              stderrReader?.close();
              const latestState = sessionByThreadId.get(state.threadId);
              if (!latestState?.activeTurn || latestState.activeTurn.turnId !== turnId) {
                return;
              }

              if (!latestState.activeTurn.turnCompletedEmitted) {
                const exitMessage =
                  signal === "SIGINT" || latestState.activeTurn.interrupted
                    ? undefined
                    : code && code !== 0
                      ? `Pi exited with code ${code}.`
                      : truncateStderr(latestState.activeTurn.stderrLines);
                finishTurn(latestState, latestState.activeTurn, {
                  ...(signal === "SIGINT" || latestState.activeTurn.interrupted
                    ? { stopReason: "aborted" }
                    : {}),
                  ...(exitMessage ? { errorMessage: exitMessage } : {}),
                });
              }
            });
          });

          const images = await resolvePiPromptImages({
            attachments: input.attachments ?? [],
            stateDir: serverConfig.stateDir,
            threadId: input.threadId,
          });

          await sendRpcCommand(child, {
            id: commandId,
            type: "prompt",
            message: input.input ?? "",
            ...(images.length > 0 ? { images } : {}),
          });
          await promptAck;

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: {
              sessionFile: state.sessionFile,
            },
          };
        },
        catch: (cause) =>
          cause instanceof ProviderAdapterSessionNotFoundError ||
          cause instanceof ProviderAdapterRequestError
            ? cause
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to start Pi turn."),
                cause,
              }),
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.sync(() => {
        const state = sessionByThreadId.get(threadId);
        if (!state?.activeTurn) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (turnId && state.activeTurn.turnId !== turnId) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "interruptTurn",
            detail: `Thread '${threadId}' does not have active turn '${turnId}'.`,
          });
        }

        state.activeTurn.interrupted = true;
        try {
          state.activeTurn.process.kill("SIGINT");
          scheduleForceKill(state.activeTurn.process);
        } catch (cause) {
          throw new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to interrupt Pi turn."),
            cause,
          });
        }
      });

    const unsupportedInteractiveMethod = (method: string, threadId: ThreadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Pi adapter does not support ${method} in this MVP.`,
          cause: { threadId },
        }),
      );

    const respondToRequest: PiAdapterShape["respondToRequest"] = (
      threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ) => unsupportedInteractiveMethod("respondToRequest", threadId);

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId: ThreadId,
      _requestId: string,
      _answers: ProviderUserInputAnswers,
    ) => unsupportedInteractiveMethod("respondToUserInput", threadId);

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      Effect.sync(() => {
        const state = sessionByThreadId.get(threadId);
        if (!state) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }

        if (state.activeTurn) {
          state.activeTurn.interrupted = true;
          try {
            state.activeTurn.process.kill("SIGTERM");
            scheduleForceKill(state.activeTurn.process);
          } catch {
            // Best-effort shutdown only.
          }
        }

        sessionByThreadId.delete(threadId);
        emitRuntimeEvent({
          type: "session.state.changed",
          ...runtimeEventBase({ threadId }),
          payload: {
            state: "stopped",
          },
        });
        emitRuntimeEvent({
          type: "session.exited",
          ...runtimeEventBase({ threadId }),
          payload: {
            exitKind: "graceful",
            reason: "Session stopped by adapter.",
          },
        });
      });

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessionByThreadId.values()].map((session) => toSession(session)));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.succeed(sessionByThreadId.has(threadId));

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.sync(() => {
        if (!sessionByThreadId.has(threadId)) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return {
          threadId,
          turns: [],
        };
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `Pi adapter does not support rollback for thread '${threadId}' in this MVP.`,
        }),
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        for (const [threadId, state] of sessionByThreadId.entries()) {
          if (state.activeTurn) {
            state.activeTurn.interrupted = true;
            try {
              state.activeTurn.process.kill("SIGTERM");
              scheduleForceKill(state.activeTurn.process);
            } catch {
              // Best-effort cleanup only.
            }
          }
          sessionByThreadId.delete(threadId);
        }
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies PiAdapterShape;
  });

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
