/**
 * providerVersionCheck - Runtime version validation for provider CLIs.
 *
 * Runs `<binary> --version` and compares against a known-good minimum.
 * Returns a structured result so callers can warn or fail gracefully
 * instead of hitting cryptic protocol errors downstream.
 *
 * @module providerVersionCheck
 */
import { execFile } from "node:child_process";

export interface ProviderVersionResult {
  /** Whether the check succeeded at all (binary found, version parsed). */
  readonly ok: boolean;
  /** Raw version string from the CLI, e.g. "0.56.2" or "codex-cli 0.99.0". */
  readonly raw: string | undefined;
  /** Parsed semver tuple [major, minor, patch], or undefined if unparseable. */
  readonly parsed: readonly [number, number, number] | undefined;
  /** True if the version meets or exceeds the minimum. */
  readonly satisfiesMinimum: boolean;
  /** Human-readable message suitable for logging or surfacing to users. */
  readonly message: string;
}

/**
 * Parse a semver-ish string into [major, minor, patch].
 * Handles formats like "0.56.2", "codex-cli 0.99.0", "v1.2.3".
 */
function parseSemver(raw: string): readonly [number, number, number] | undefined {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

/**
 * Compare two semver tuples. Returns:
 *  -1 if a < b
 *   0 if a === b
 *   1 if a > b
 */
function compareSemver(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

function semverToString(v: readonly [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/**
 * Run `<binaryPath> --version` and compare against a minimum version.
 *
 * Never throws. Returns a structured result with enough context for
 * the caller to decide whether to warn, block, or proceed.
 */
export async function checkProviderVersion(input: {
  readonly provider: string;
  readonly binaryPath: string;
  readonly minimumVersion: readonly [number, number, number];
  /** Timeout in ms for the version check. Default 5000. */
  readonly timeoutMs?: number;
}): Promise<ProviderVersionResult> {
  const { provider, binaryPath, minimumVersion, timeoutMs = 5000 } = input;
  const minString = semverToString(minimumVersion);

  let raw: string | undefined;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        binaryPath,
        ["--version"],
        { timeout: timeoutMs, env: { ...process.env } },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          // Some CLIs print to stdout, some to stderr
          resolve((stdout || stderr || "").trim());
        },
      );
      child.on("error", reject);
    });
  } catch {
    return {
      ok: false,
      raw: undefined,
      parsed: undefined,
      satisfiesMinimum: false,
      message: `${provider}: Could not determine CLI version. Is '${binaryPath}' installed and on PATH?`,
    };
  }

  const parsed = parseSemver(raw);
  if (!parsed) {
    return {
      ok: false,
      raw,
      parsed: undefined,
      satisfiesMinimum: false,
      message: `${provider}: Could not parse version from '${raw}'. Expected semver format.`,
    };
  }

  const satisfiesMinimum = compareSemver(parsed, minimumVersion) >= 0;
  const currentString = semverToString(parsed);

  if (!satisfiesMinimum) {
    return {
      ok: true,
      raw,
      parsed,
      satisfiesMinimum: false,
      message: `${provider}: Installed version ${currentString} is below minimum ${minString}. Please update your ${provider} CLI to avoid protocol errors.`,
    };
  }

  return {
    ok: true,
    raw,
    parsed,
    satisfiesMinimum: true,
    message: `${provider}: Version ${currentString} (meets minimum ${minString}).`,
  };
}
