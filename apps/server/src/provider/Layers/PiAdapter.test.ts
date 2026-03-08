import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { afterAll, it, vi } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import {
  makePiAdapterLive,
  DEFAULT_PI_SYSTEM_PROMPT,
  PI_ACTIVITY_BRIDGE_EXTENSION_PATH,
} from "./PiAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

class FakePiProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 123;
  readonly killSignals: string[] = [];

  private buffer = "";

  constructor(private readonly onCommand: (command: Record<string, unknown>) => void) {
    super();
    this.stdin.on("data", (chunk) => {
      this.buffer += chunk.toString();
      this.flushBufferedLines();
    });
  }

  kill = (signal?: NodeJS.Signals | number) => {
    this.killSignals.push(String(signal ?? ""));
    this.emit("exit", 0, typeof signal === "string" ? signal : null);
    return true;
  };

  emitStdoutJson(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  private flushBufferedLines(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      this.onCommand(JSON.parse(line) as Record<string, unknown>);
    }
  }
}

afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.effect("hydrates isolated pi runtime state from the shared agent directory", () =>
  Effect.gen(function* () {
    const sharedAgentDir = makeTempDir("t3-pi-shared-");
    const stateDir = makeTempDir("t3-pi-state-");
    const threadId = asThreadId("thread-seeded-runtime");

    fs.writeFileSync(
      path.join(sharedAgentDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
    );
    fs.writeFileSync(path.join(sharedAgentDir, "models.json"), JSON.stringify({ models: [] }));
    fs.writeFileSync(
      path.join(sharedAgentDir, "settings.json"),
      JSON.stringify({ enabledModels: ["gpt-5.4"] }),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", sharedAgentDir);

    let spawnedRuntimeDir: string | undefined;

    const adapter = yield* Effect.service(PiAdapter).pipe(
      Effect.provide(
        makePiAdapterLive({
          spawnProcess: (_command, _args, options) => {
            spawnedRuntimeDir = options.env.PI_CODING_AGENT_DIR;
            const process = new FakePiProcess((command) => {
              queueMicrotask(() => {
                process.emitStdoutJson({
                  id: String(command.id),
                  type: "response",
                  command: "prompt",
                  success: true,
                });
              });
            });

            return {
              stdout: process.stdout,
              stderr: process.stderr,
              stdin: process.stdin,
              pid: process.pid,
              kill: process.kill,
              once: process.once.bind(process),
            };
          },
        }).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    yield* adapter.startSession({
      provider: "pi",
      threadId,
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
    });

    if (!spawnedRuntimeDir) {
      assert.fail("Expected the Pi runtime directory to be captured.");
    }
    assert.notStrictEqual(spawnedRuntimeDir, sharedAgentDir);
    assert.strictEqual(
      fs.readFileSync(path.join(spawnedRuntimeDir, "auth.json"), "utf8"),
      fs.readFileSync(path.join(sharedAgentDir, "auth.json"), "utf8"),
    );
    assert.strictEqual(
      fs.readFileSync(path.join(spawnedRuntimeDir, "models.json"), "utf8"),
      fs.readFileSync(path.join(sharedAgentDir, "models.json"), "utf8"),
    );
    assert.strictEqual(
      fs.readFileSync(path.join(spawnedRuntimeDir, "settings.json"), "utf8"),
      fs.readFileSync(path.join(sharedAgentDir, "settings.json"), "utf8"),
    );

    vi.unstubAllEnvs();
  }),
);

it.effect("sanitizes stale provider-prefixed Pi enabled models inside the isolated runtime only", () =>
  Effect.gen(function* () {
    const sharedAgentDir = makeTempDir("t3-pi-shared-");
    const stateDir = makeTempDir("t3-pi-state-");
    const threadId = asThreadId("thread-sanitized-runtime");

    fs.writeFileSync(
      path.join(sharedAgentDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
    );
    fs.writeFileSync(
      path.join(sharedAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          "zai-coding": {
            models: [{ id: "glm-5" }],
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(sharedAgentDir, "settings.json"),
      JSON.stringify({
        enabledModels: [
          "gpt-5.4",
          "anthropic/claude-sonnet-4-6",
          "zai-org/GLM-5",
          "zai-coding/glm-5",
        ],
      }),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", sharedAgentDir);

    let spawnedRuntimeDir: string | undefined;

    const adapter = yield* Effect.service(PiAdapter).pipe(
      Effect.provide(
        makePiAdapterLive({
          spawnProcess: (_command, _args, options) => {
            spawnedRuntimeDir = options.env.PI_CODING_AGENT_DIR;
            const process = new FakePiProcess((command) => {
              queueMicrotask(() => {
                process.emitStdoutJson({
                  id: String(command.id),
                  type: "response",
                  command: "prompt",
                  success: true,
                });
              });
            });

            return {
              stdout: process.stdout,
              stderr: process.stderr,
              stdin: process.stdin,
              pid: process.pid,
              kill: process.kill,
              once: process.once.bind(process),
            };
          },
        }).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    yield* adapter.startSession({
      provider: "pi",
      threadId,
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
    });

    if (!spawnedRuntimeDir) {
      assert.fail("Expected the Pi runtime directory to be captured.");
    }

    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(spawnedRuntimeDir, "settings.json"), "utf8")),
      {
        enabledModels: ["gpt-5.4", "anthropic/claude-sonnet-4-6", "zai-coding/glm-5"],
      },
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(sharedAgentDir, "settings.json"), "utf8")),
      {
        enabledModels: [
          "gpt-5.4",
          "anthropic/claude-sonnet-4-6",
          "zai-org/GLM-5",
          "zai-coding/glm-5",
        ],
      },
    );

    vi.unstubAllEnvs();
  }),
);

it.effect("fails the turn when pi emits a late prompt error response", () =>
  Effect.gen(function* () {
    const stateDir = makeTempDir("t3-pi-state-");
    const threadId = asThreadId("thread-late-prompt-error");
    const processes: FakePiProcess[] = [];

    const adapter = yield* Effect.service(PiAdapter).pipe(
      Effect.provide(
        makePiAdapterLive({
          spawnProcess: () => {
            const process = new FakePiProcess((command) => {
              queueMicrotask(() => {
                process.emitStdoutJson({
                  id: String(command.id),
                  type: "response",
                  command: "prompt",
                  success: true,
                });
                process.emitStdoutJson({
                  id: String(command.id),
                  type: "response",
                  command: "prompt",
                  success: false,
                  error: "No API key found for anthropic.",
                });
              });
            });
            processes.push(process);

            return {
              stdout: process.stdout,
              stderr: process.stderr,
              stdin: process.stdin,
              pid: process.pid,
              kill: process.kill,
              once: process.once.bind(process),
            };
          },
        }).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    yield* adapter.startSession({
      provider: "pi",
      threadId,
      runtimeMode: "full-access",
    });
    yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
    });

    const events = Array.from(
      yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(7))),
    );

    assert.deepStrictEqual(
      events.map((event) => event.type),
      [
        "session.started",
        "session.state.changed",
        "session.state.changed",
        "turn.started",
        "runtime.error",
        "turn.completed",
        "session.state.changed",
      ],
    );

    const runtimeError = events.find((event) => event.type === "runtime.error");
    assert.strictEqual(runtimeError?.payload.message, "No API key found for anthropic.");

    const turnCompleted = events.find((event) => event.type === "turn.completed");
    if (!turnCompleted || turnCompleted.type !== "turn.completed") {
      assert.fail("Expected a turn.completed event.");
    }
    assert.strictEqual(turnCompleted.payload.state, "failed");
    assert.strictEqual(turnCompleted.payload.errorMessage, "No API key found for anthropic.");

    const latestSessionState = events
      .toReversed()
      .find((event) => event.type === "session.state.changed");
    if (!latestSessionState || latestSessionState.type !== "session.state.changed") {
      assert.fail("Expected a final session.state.changed event.");
    }
    assert.strictEqual(latestSessionState.payload.state, "error");

    assert.deepStrictEqual(processes[0]?.killSignals, ["SIGTERM"]);
  }),
);

it.effect("passes the selected pi thinking level through to the spawned cli process", () =>
  Effect.gen(function* () {
    const stateDir = makeTempDir("t3-pi-state-");
    const threadId = asThreadId("thread-thinking-level");
    let spawnedArgs: ReadonlyArray<string> | undefined;
    let spawnedEnv: NodeJS.ProcessEnv | undefined;

    const adapter = yield* Effect.service(PiAdapter).pipe(
      Effect.provide(
        makePiAdapterLive({
          spawnProcess: (_command, args, options) => {
            spawnedArgs = args;
            spawnedEnv = options.env;
            const process = new FakePiProcess((command) => {
              queueMicrotask(() => {
                process.emitStdoutJson({
                  id: String(command.id),
                  type: "response",
                  command: "prompt",
                  success: true,
                });
              });
            });

            return {
              stdout: process.stdout,
              stderr: process.stderr,
              stdin: process.stdin,
              pid: process.pid,
              kill: process.kill,
              once: process.once.bind(process),
            };
          },
        }).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), stateDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    yield* adapter.startSession({
      provider: "pi",
      threadId,
      runtimeMode: "full-access",
      model: "openai-codex/gpt-5.4",
    });
    yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
      modelOptions: {
        pi: {
          thinkingLevel: "medium",
        },
      },
    });

    assert.deepStrictEqual(spawnedArgs, [
      "--mode",
      "rpc",
      "--session",
      `${stateDir}/providers/pi/sessions/${threadId}.jsonl`,
      "--no-extensions",
      "--extension",
      PI_ACTIVITY_BRIDGE_EXTENSION_PATH,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--model",
      "openai-codex/gpt-5.4",
      "--thinking",
      "medium",
      "--append-system-prompt",
      DEFAULT_PI_SYSTEM_PROMPT,
    ]);
    assert.strictEqual(spawnedEnv?.PI_T3_THREAD_ID, threadId);
    assert.strictEqual(spawnedEnv?.PI_T3_TURN_ID?.startsWith("pi:turn:"), true);
    assert.strictEqual(spawnedEnv?.PI_T3_ACTIVITY_URL, undefined);
  }),
);
