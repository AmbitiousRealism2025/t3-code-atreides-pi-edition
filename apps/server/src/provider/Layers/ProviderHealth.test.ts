import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { afterAll, it, vi } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  checkCodexProviderStatus,
  checkPiProviderStatus,
  parseAuthStatusFromOutput,
} from "./ProviderHealth";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────────────

it.effect("returns ready when codex is installed and authenticated", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus;
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "authenticated");
  }).pipe(
    Effect.provide(
      mockSpawnerLayer((_command, args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

it.effect("returns unavailable when codex is missing", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus;
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
  }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
);

it.effect("returns unauthenticated when auth probe reports login required", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus;
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unauthenticated");
    assert.strictEqual(
      status.message,
      "Codex CLI is not authenticated. Run `codex login` and try again.",
    );
  }).pipe(
    Effect.provide(
      mockSpawnerLayer((_command, args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

it.effect(
  "returns unauthenticated when login status output includes 'not logged in'",
  () =>
    Effect.gen(function* () {
      const status = yield* checkCodexProviderStatus;
      assert.strictEqual(status.provider, "codex");
      assert.strictEqual(status.status, "error");
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.authStatus, "unauthenticated");
      assert.strictEqual(
        status.message,
        "Codex CLI is not authenticated. Run `codex login` and try again.",
      );
    }).pipe(
      Effect.provide(
        mockSpawnerLayer((_command, args) => {
          const joined = args.join(" ");
          if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
          if (joined === "login status")
            return { stdout: "Not logged in\n", stderr: "", code: 1 };
          throw new Error(`Unexpected args: ${joined}`);
        }),
      ),
    ),
);

it.effect("returns warning when login status command is unsupported", () =>
  Effect.gen(function* () {
    const status = yield* checkCodexProviderStatus;
    assert.strictEqual(status.provider, "codex");
    assert.strictEqual(status.status, "warning");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(
      status.message,
      "Codex CLI authentication status command is unavailable in this Codex version.",
    );
  }).pipe(
    Effect.provide(
      mockSpawnerLayer((_command, args) => {
        const joined = args.join(" ");
        if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
        if (joined === "login status") {
          return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
        }
        throw new Error(`Unexpected args: ${joined}`);
      }),
    ),
  ),
);

it.effect("returns warning when pi is installed but the default model probe finds no match", () =>
  Effect.gen(function* () {
    const sharedAgentDir = makeTempDir("t3-pi-health-warning-");
    vi.stubEnv("PI_CODING_AGENT_DIR", sharedAgentDir);

    const status = yield* checkPiProviderStatus;
    assert.strictEqual(status.provider, "pi");
    assert.strictEqual(status.status, "warning");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(
      status.message,
      "Pi CLI is installed, but the Pi model `claude-sonnet-4-6` is not available. Configure a working Pi model or save a custom Pi model in Settings.",
    );

    vi.unstubAllEnvs();
  }).pipe(
    Effect.provide(
      mockSpawnerLayer((command, args) => {
        const joined = args.join(" ");
        if (command.endsWith("pi") && joined === "--version") {
          return { stdout: "0.56.2\n", stderr: "", code: 0 };
        }
        if (command.endsWith("pi") && joined === "--help") {
          return { stdout: "Usage: pi [options]\n", stderr: "", code: 0 };
        }
        if (command.endsWith("pi") && joined === `--list-models ${DEFAULT_MODEL_BY_PROVIDER.pi}`) {
          return {
            stdout: `No models matching "${DEFAULT_MODEL_BY_PROVIDER.pi}"\n`,
            stderr: "",
            code: 0,
          };
        }
        if (command.endsWith("pi") && joined === "--list-models claude-sonnet-4-6") {
          return {
            stdout: 'No models matching "claude-sonnet-4-6"\n',
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`Unexpected command: ${command} ${joined}`);
      }),
    ),
  ),
);

it.effect("returns ready when the saved Pi default model matches after stripping the provider prefix", () =>
  Effect.gen(function* () {
    const sharedAgentDir = makeTempDir("t3-pi-health-shared-");
    fs.writeFileSync(
      path.join(sharedAgentDir, "settings.json"),
      JSON.stringify({ defaultModel: "claude-sonnet-4-6" }),
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", sharedAgentDir);

    const status = yield* checkPiProviderStatus;
    assert.strictEqual(status.provider, "pi");
    assert.strictEqual(status.status, "ready");
    assert.strictEqual(status.available, true);
    assert.strictEqual(status.authStatus, "unknown");

    vi.unstubAllEnvs();
  }).pipe(
    Effect.provide(
      mockSpawnerLayer((command, args) => {
        const joined = args.join(" ");
        if (command.endsWith("pi") && joined === "--version") {
          return { stdout: "0.56.2\n", stderr: "", code: 0 };
        }
        if (command.endsWith("pi") && joined === "--help") {
          return { stdout: "Usage: pi [options]\n", stderr: "", code: 0 };
        }
        if (command.endsWith("pi") && joined === "--list-models claude-sonnet-4-6") {
          return {
            stdout: "provider      model\nanthropic    claude-sonnet-4-6\n",
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`Unexpected command: ${command} ${joined}`);
      }),
    ),
  ),
);

it.effect("returns unavailable when pi is missing", () =>
  Effect.gen(function* () {
    const status = yield* checkPiProviderStatus;
    assert.strictEqual(status.provider, "pi");
    assert.strictEqual(status.status, "error");
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.authStatus, "unknown");
    assert.strictEqual(status.message, "Pi CLI (`pi`) is not installed or not on PATH.");
  }).pipe(Effect.provide(failingSpawnerLayer("spawn pi ENOENT"))),
);

// ── Pure function tests ─────────────────────────────────────────────

it("parseAuthStatusFromOutput: exit code 0 with no auth markers is ready", () => {
  const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
  assert.strictEqual(parsed.status, "ready");
  assert.strictEqual(parsed.authStatus, "authenticated");
});

it("parseAuthStatusFromOutput: JSON with authenticated=false is unauthenticated", () => {
  const parsed = parseAuthStatusFromOutput({
    stdout: '[{"authenticated":false}]\n',
    stderr: "",
    code: 0,
  });
  assert.strictEqual(parsed.status, "error");
  assert.strictEqual(parsed.authStatus, "unauthenticated");
});

it("parseAuthStatusFromOutput: JSON without auth marker is warning", () => {
  const parsed = parseAuthStatusFromOutput({
    stdout: '[{"ok":true}]\n',
    stderr: "",
    code: 0,
  });
  assert.strictEqual(parsed.status, "warning");
  assert.strictEqual(parsed.authStatus, "unknown");
});
