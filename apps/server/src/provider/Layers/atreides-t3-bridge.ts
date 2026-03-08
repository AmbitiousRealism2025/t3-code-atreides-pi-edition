import http from "node:http";
import https from "node:https";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ActivityTone = "info" | "tool" | "approval" | "error";

interface BridgeActivity {
  id: string;
  tone: ActivityTone;
  kind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  createdAt: string;
}

interface BridgeEnvelope {
  threadId: string;
  activity: BridgeActivity;
}

const THREAD_ID = process.env.PI_T3_THREAD_ID?.trim() || "";
const TURN_ID = process.env.PI_T3_TURN_ID?.trim() || null;
const ACTIVITY_URL = process.env.PI_T3_ACTIVITY_URL?.trim() || "";

function truncate(value: string, max = 180): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractCommand(toolName: string, args: unknown): string | null {
  const input = asRecord(args);
  if (!input) return null;
  if (toolName === "bash") {
    return asString(input.command);
  }
  return null;
}

function extractPrimaryPath(args: unknown): string | null {
  const input = asRecord(args);
  if (!input) return null;
  return (
    asString(input.path) ??
    asString(input.relativePath) ??
    asString(input.filePath) ??
    asString(input.targetPath)
  );
}

function buildToolDetail(toolName: string, args: unknown): string | null {
  const command = extractCommand(toolName, args);
  if (command) return truncate(command);
  const primaryPath = extractPrimaryPath(args);
  if (primaryPath) return primaryPath;
  return null;
}

function postActivity(envelope: BridgeEnvelope): void {
  if (!THREAD_ID || !ACTIVITY_URL) {
    return;
  }

  try {
    const url = new URL(ACTIVITY_URL);
    const body = JSON.stringify(envelope);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
    });
    req.on("error", () => {
      // T3 server not running or bridge unavailable. Stay silent.
    });
    req.write(body);
    req.end();
  } catch {
    // Invalid URL or local transport issue. Stay silent.
  }
}

function emitActivity(activity: BridgeActivity): void {
  if (!THREAD_ID || !ACTIVITY_URL) return;
  postActivity({ threadId: THREAD_ID, activity });
}

function createActivity(input: {
  id: string;
  tone: ActivityTone;
  kind: string;
  summary: string;
  payload?: unknown;
}): BridgeActivity {
  return {
    id: input.id,
    tone: input.tone,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload ?? {},
    turnId: TURN_ID,
    createdAt: new Date().toISOString(),
  };
}

export default function atreidesT3Bridge(pi: ExtensionAPI) {
  pi.on("turn_start", async (event) => {
    emitActivity(
      createActivity({
        id: `pi-bridge:turn-start:${TURN_ID ?? "unknown"}:${event.turnIndex}`,
        tone: "info",
        kind: "pi.turn.started",
        summary: `Starting turn ${event.turnIndex + 1}`,
        payload: {
          detail: "Pi began working on the current request.",
          data: { turnIndex: event.turnIndex },
        },
      }),
    );
  });

  pi.on("tool_execution_start", async (event) => {
    const command = extractCommand(event.toolName, event.args);
    const detail = buildToolDetail(event.toolName, event.args);
    emitActivity(
      createActivity({
        id: `pi-bridge:tool-start:${TURN_ID ?? "unknown"}:${event.toolCallId}`,
        tone: "tool",
        kind: "pi.tool.started",
        summary: `Tool: ${event.toolName}`,
        payload: {
          ...(detail ? { detail } : {}),
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            item: {
              input: event.args,
              ...(command ? { command } : {}),
            },
            ...(command ? { command } : {}),
          },
        },
      }),
    );
  });

  pi.on("tool_execution_update", async (event) => {
    const partialText =
      typeof event.partialResult === "string"
        ? truncate(event.partialResult)
        : event.partialResult !== undefined
          ? truncate(JSON.stringify(event.partialResult))
          : null;
    if (!partialText) return;
    emitActivity(
      createActivity({
        id: `pi-bridge:tool-update:${TURN_ID ?? "unknown"}:${event.toolCallId}:${Date.now()}`,
        tone: "tool",
        kind: "pi.tool.updated",
        summary: `Tool update: ${event.toolName}`,
        payload: {
          detail: partialText,
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: event.partialResult,
          },
        },
      }),
    );
  });

  pi.on("tool_execution_end", async (event) => {
    const command = extractCommand(event.toolName, event.args);
    const detail = event.isError
      ? `Tool failed: ${event.toolName}`
      : `Tool complete: ${event.toolName}`;
    emitActivity(
      createActivity({
        id: `pi-bridge:tool-end:${TURN_ID ?? "unknown"}:${event.toolCallId}`,
        tone: event.isError ? "error" : "tool",
        kind: event.isError ? "pi.tool.failed" : "pi.tool.completed",
        summary: detail,
        payload: {
          detail: buildToolDetail(event.toolName, event.args) ?? detail,
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            item: {
              input: event.args,
              result: event.result,
              ...(command ? { command } : {}),
            },
            ...(command ? { command } : {}),
          },
        },
      }),
    );
  });

  pi.on("turn_end", async (event) => {
    const summary =
      typeof event.message?.content === "string" && event.message.content.trim().length > 0
        ? truncate(event.message.content.trim(), 120)
        : "Pi finished the current turn.";
    emitActivity(
      createActivity({
        id: `pi-bridge:turn-end:${TURN_ID ?? "unknown"}:${event.turnIndex}`,
        tone: "info",
        kind: "pi.turn.completed",
        summary: "Turn complete",
        payload: {
          detail: summary,
          data: { turnIndex: event.turnIndex, toolResults: event.toolResults },
        },
      }),
    );
  });
}
