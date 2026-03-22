/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ServerProviderAuthStatus,
  type ServerProviderStatus,
  type ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import { createPiRuntimeEnv, getPiModelProbeCandidates } from "./piRuntimeState.ts";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const PI_PROVIDER = "pi" as const;
const DEFAULT_PI_BINARY_PATH = "/opt/homebrew/bin/pi";
const DEFAULT_PI_MODEL = DEFAULT_MODEL_BY_PROVIDER.pi;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown, commandName?: string): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    (commandName ? lower.includes(`command not found: ${commandName.toLowerCase()}`) : false) ||
    (commandName ? lower.includes(`spawn ${commandName.toLowerCase()} enoent`) : false) ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runCommand = (
  commandName: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
  },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(commandName, [...args], {
      shell: process.platform === "win32",
      ...(options?.env ? { env: options.env } : {}),
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCodexCommand = (args: ReadonlyArray<string>) => runCommand("codex", args);

function resolvePiBinaryPath(): string {
  return fs.existsSync(DEFAULT_PI_BINARY_PATH) ? DEFAULT_PI_BINARY_PATH : "pi";
}

function createPiProbeEnv(): { readonly dir: string; readonly env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pi-health-"));
  return {
    dir,
    env: createPiRuntimeEnv(dir),
  };
}

function parsePiModelProbe(
  result: CommandResult,
  probedModel: string,
): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
  readonly reason: "ready" | "auth_error" | "lock_conflict" | "no_match" | "unexpected";
} {
  const output = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = output.toLowerCase();

  if (
    lowerOutput.includes("no api key found") ||
    lowerOutput.includes("authentication failed") ||
    lowerOutput.includes("credentials may have expired") ||
    lowerOutput.includes("use /login") ||
    lowerOutput.includes("set an api key environment variable")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      reason: "auth_error",
      message:
        "Pi CLI could not access provider credentials. Configure the relevant API key or authenticate Pi before using this provider.",
    };
  }

  if (lowerOutput.includes("lock file is already being held")) {
    return {
      status: "warning",
      authStatus: "unknown",
      reason: "lock_conflict",
      message:
        "Pi CLI reported a lock-file conflict. T3 Code isolates Pi session state at runtime, but another Pi process may still be using the same global state.",
    };
  }

  if (lowerOutput.includes("no models matching")) {
    return {
      status: "warning",
      authStatus: "unknown",
      reason: "no_match",
      message: `Pi CLI is installed, but the Pi model \`${probedModel}\` is not available. Configure a working Pi model or save a custom Pi model in Settings.`,
    };
  }

  if (result.code === 0) {
    return {
      status: "ready",
      authStatus: "unknown",
      reason: "ready",
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    reason: "unexpected",
    message: detail ? `Pi model probe returned an unexpected result. ${detail}` : "Pi model probe returned an unexpected result.",
  };
}

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: `codex --version` — is the CLI reachable?
  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error, "codex")
        ? "Codex CLI (`codex`) is not installed or not on PATH."
        : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Codex CLI is installed but failed to run. Timed out while running command.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Codex CLI is installed but failed to run. ${detail}`
        : "Codex CLI is installed but failed to run.",
    };
  }

  const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    return {
      provider: CODEX_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: formatCodexCliUpgradeMessage(parsedVersion),
    };
  }

  // Probe 2: `codex login status` — is the user authenticated?
  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message:
        error instanceof Error
          ? `Could not verify Codex authentication status: ${error.message}.`
          : "Could not verify Codex authentication status.",
    };
  }

  if (Option.isNone(authProbe.success)) {
    return {
      provider: CODEX_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Could not verify Codex authentication status. Timed out while running command.",
    };
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  return {
    provider: CODEX_PROVIDER,
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

export const checkPiProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();
  const binaryPath = resolvePiBinaryPath();
  const probe = yield* Effect.acquireRelease(
    Effect.sync(createPiProbeEnv),
    ({ dir }) =>
      Effect.sync(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      }),
  );

  const versionProbe = yield* runCommand(binaryPath, ["--version"], { env: probe.env }).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return {
      provider: PI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error, "pi")
        ? "Pi CLI (`pi`) is not installed or not on PATH."
        : `Failed to execute Pi CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: PI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Pi CLI is installed but failed to run. Timed out while running command.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: PI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Pi CLI is installed but failed to run. ${detail}`
        : "Pi CLI is installed but failed to run.",
    };
  }

  const helpProbe = yield* runCommand(binaryPath, ["--help"], { env: probe.env }).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(helpProbe)) {
    const error = helpProbe.failure;
    return {
      provider: PI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message:
        error instanceof Error
          ? `Pi CLI is installed but failed to initialize: ${error.message}.`
          : "Pi CLI is installed but failed to initialize.",
    };
  }

  if (Option.isNone(helpProbe.success)) {
    return {
      provider: PI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Pi CLI is installed but timed out while loading help output.",
    };
  }

  const help = helpProbe.success.value;
  if (help.code !== 0) {
    const detail = detailFromResult(help);
    return {
      provider: PI_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Pi CLI is installed but failed to initialize. ${detail}`
        : "Pi CLI is installed but failed to initialize.",
    };
  }

  const probeCandidates = getPiModelProbeCandidates(probe.dir, DEFAULT_PI_MODEL);
  let lastNoMatchProbe:
    | {
        readonly status: ServerProviderStatusState;
        readonly authStatus: ServerProviderAuthStatus;
        readonly message?: string;
        readonly reason: "no_match";
      }
    | undefined;

  for (const probeModel of probeCandidates) {
    const modelProbe = yield* runCommand(binaryPath, ["--list-models", probeModel], {
      env: probe.env,
    }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(modelProbe)) {
      const error = modelProbe.failure;
      return {
        provider: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          error instanceof Error
            ? `Pi CLI is installed, but its model probe failed: ${error.message}.`
            : "Pi CLI is installed, but its model probe failed.",
      };
    }

    if (Option.isNone(modelProbe.success)) {
      return {
        provider: PI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Pi CLI is installed, but its model probe timed out.",
      };
    }

    const parsed = parsePiModelProbe(modelProbe.success.value, probeModel);
    if (parsed.reason === "ready") {
      return {
        provider: PI_PROVIDER,
        status: parsed.status,
        available: true,
        authStatus: parsed.authStatus,
        checkedAt,
        ...(parsed.message ? { message: parsed.message } : {}),
      } satisfies ServerProviderStatus;
    }

    if (parsed.reason === "no_match") {
      lastNoMatchProbe = parsed;
      continue;
    }

    return {
      provider: PI_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  }

  return {
    provider: PI_PROVIDER,
    status: lastNoMatchProbe?.status ?? "warning",
    available: true,
    authStatus: lastNoMatchProbe?.authStatus ?? "unknown",
    checkedAt,
    ...(lastNoMatchProbe?.message
      ? { message: lastNoMatchProbe.message }
      : {
          message:
            "Pi CLI is installed, but no probeable Pi model could be resolved from runtime settings.",
        }),
  } satisfies ServerProviderStatus;
}).pipe(Effect.scoped);

// ── Claude health check ─────────────────────────────────────────────

const runClaudeCommand = (args: ReadonlyArray<string>) => runCommand("claude", args);

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (output.includes("logged in") || output.includes("authenticated")) {
    return { status: "ready", authStatus: "authenticated" };
  }

  if (output.includes("not logged in") || output.includes("not authenticated") || output.includes("unauthenticated")) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude Agent CLI is not authenticated. Run `claude auth login` and try again.",
    };
  }

  return { status: "warning", authStatus: "unknown" };
}

export const checkClaudeProviderStatus: Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const checkedAt = new Date().toISOString();

  // Probe 1: claude --version
  const versionProbe = yield* runClaudeCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: isCommandMissingCause(error)
        ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
        : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(versionProbe.success)) {
    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Claude Agent CLI is installed but timed out while running command.",
    };
  }

  const version = versionProbe.success.value;
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
      checkedAt,
      message: detail
        ? `Claude Agent CLI is installed but failed to run. ${detail}`
        : "Claude Agent CLI is installed but failed to run.",
    };
  }

  // Probe 2: claude auth status
  const authProbe = yield* runClaudeCommand(["auth", "status"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(authProbe) || Option.isNone(authProbe.success)) {
    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: "warning" as const,
      available: true,
      authStatus: "unknown" as const,
      checkedAt,
      message: "Could not verify Claude authentication status.",
    };
  }

  const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
  return {
    provider: CLAUDE_AGENT_PROVIDER,
    status: parsed.status,
    available: true,
    authStatus: parsed.authStatus,
    checkedAt,
    ...(parsed.message ? { message: parsed.message } : {}),
  } satisfies ServerProviderStatus;
});

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const codexStatus = yield* checkCodexProviderStatus;
    const claudeStatus = yield* checkClaudeProviderStatus;
    const piStatus = yield* checkPiProviderStatus;
    return {
      getStatuses: Effect.succeed([codexStatus, claudeStatus, piStatus]),
    } satisfies ProviderHealthShape;
  }),
);
