import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PI_AGENT_NAME = "t3code";

const DEFAULT_SHARED_PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SHARED_PI_RUNTIME_FILES = ["auth.json", "models.json", "settings.json"] as const;
const KNOWN_BUILT_IN_PI_PROVIDERS = new Set([
  "anthropic",
  "azure-openai-responses",
  "google-antigravity",
  "openai",
  "openai-codex",
]);

type JsonRecord = Record<string, unknown>;

type PiRuntimeSettings = {
  readonly defaultModel?: string;
  readonly enabledModels?: ReadonlyArray<string>;
};

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function removeExistingTargetFile(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { force: true });
}

function copyFilePreservingMode(sourcePath: string, targetPath: string): void {
  ensureDirectory(path.dirname(targetPath));
  removeExistingTargetFile(targetPath);
  fs.copyFileSync(sourcePath, targetPath);
  fs.chmodSync(targetPath, fs.statSync(sourcePath).mode);
}

function resolveSharedPiAgentDir(): string {
  const explicitDir = process.env.PI_CODING_AGENT_DIR?.trim();
  return explicitDir && explicitDir.length > 0 ? explicitDir : DEFAULT_SHARED_PI_AGENT_DIR;
}

function syncSharedPiRuntimeFile(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  ensureDirectory(path.dirname(targetPath));

  if (fs.existsSync(targetPath)) {
    const current = fs.lstatSync(targetPath);
    if (current.isSymbolicLink()) {
      const linkedPath = path.resolve(path.dirname(targetPath), fs.readlinkSync(targetPath));
      if (linkedPath === sourcePath) {
        return;
      }
      removeExistingTargetFile(targetPath);
    } else {
      copyFilePreservingMode(sourcePath, targetPath);
      return;
    }
  }

  try {
    fs.symlinkSync(sourcePath, targetPath);
  } catch {
    copyFilePreservingMode(sourcePath, targetPath);
  }
}

function collectCustomPiModelSlugs(modelsDocument: unknown): {
  readonly providerIds: ReadonlySet<string>;
  readonly modelSlugs: ReadonlySet<string>;
} {
  if (!isRecord(modelsDocument) || !isRecord(modelsDocument.providers)) {
    return {
      providerIds: new Set<string>(),
      modelSlugs: new Set<string>(),
    };
  }

  const providerIds = new Set<string>();
  const modelSlugs = new Set<string>();

  for (const [providerId, providerConfig] of Object.entries(modelsDocument.providers)) {
    const trimmedProviderId = providerId.trim();
    if (!trimmedProviderId || !isRecord(providerConfig) || !Array.isArray(providerConfig.models)) {
      continue;
    }

    providerIds.add(trimmedProviderId);

    for (const model of providerConfig.models) {
      if (!isRecord(model)) {
        continue;
      }

      const modelId = trimNonEmptyString(model.id);
      if (modelId) {
        modelSlugs.add(`${trimmedProviderId}/${modelId}`);
      }
    }
  }

  return { providerIds, modelSlugs };
}

function sanitizeEnabledModels(
  enabledModels: ReadonlyArray<unknown>,
  customProviders: ReadonlySet<string>,
  customModelSlugs: ReadonlySet<string>,
): {
  readonly enabledModels: ReadonlyArray<string>;
  readonly changed: boolean;
} {
  const nextEnabledModels: string[] = [];
  let changed = false;

  for (const value of enabledModels) {
    const model = trimNonEmptyString(value);
    if (!model) {
      changed = true;
      continue;
    }

    const slashIndex = model.indexOf("/");
    if (slashIndex > 0 && slashIndex < model.length - 1) {
      const providerId = model.slice(0, slashIndex);
      const isKnownModel =
        KNOWN_BUILT_IN_PI_PROVIDERS.has(providerId) ||
        (customProviders.has(providerId) && customModelSlugs.has(model));

      if (!isKnownModel) {
        changed = true;
        continue;
      }
    }

    if (nextEnabledModels.includes(model)) {
      changed = true;
      continue;
    }

    nextEnabledModels.push(model);
    if (value !== model) {
      changed = true;
    }
  }

  return {
    enabledModels: nextEnabledModels,
    changed,
  };
}

function syncSanitizedPiSettingsFile(sharedAgentDir: string, runtimeDir: string): void {
  const sourcePath = path.join(sharedAgentDir, "settings.json");
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  const targetPath = path.join(runtimeDir, "settings.json");
  const settingsDocument = readJsonFile(sourcePath);
  if (!isRecord(settingsDocument)) {
    copyFilePreservingMode(sourcePath, targetPath);
    return;
  }

  const originalEnabledModels = Array.isArray(settingsDocument.enabledModels)
    ? settingsDocument.enabledModels
    : undefined;
  if (!originalEnabledModels) {
    copyFilePreservingMode(sourcePath, targetPath);
    return;
  }

  const customPiModels = collectCustomPiModelSlugs(readJsonFile(path.join(sharedAgentDir, "models.json")));
  const sanitizedEnabledModels = sanitizeEnabledModels(
    originalEnabledModels,
    customPiModels.providerIds,
    customPiModels.modelSlugs,
  );

  if (!sanitizedEnabledModels.changed) {
    copyFilePreservingMode(sourcePath, targetPath);
    return;
  }

  ensureDirectory(path.dirname(targetPath));
  removeExistingTargetFile(targetPath);
  fs.writeFileSync(
    targetPath,
    `${JSON.stringify(
      {
        ...settingsDocument,
        enabledModels: sanitizedEnabledModels.enabledModels,
      },
      null,
      2,
    )}\n`,
  );
  fs.chmodSync(targetPath, fs.statSync(sourcePath).mode);
}

function stripPiProviderPrefix(model: string): string | undefined {
  const trimmed = model.trim();
  if (!trimmed) {
    return undefined;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }

  return trimmed.slice(slashIndex + 1);
}

export function readPiRuntimeSettings(runtimeDir: string): PiRuntimeSettings | undefined {
  const settingsDocument = readJsonFile(path.join(runtimeDir, "settings.json"));
  if (!isRecord(settingsDocument)) {
    return undefined;
  }

  const defaultModel = trimNonEmptyString(settingsDocument.defaultModel);
  const enabledModels = Array.isArray(settingsDocument.enabledModels)
    ? settingsDocument.enabledModels
        .map((value) => trimNonEmptyString(value))
        .filter((value): value is string => value !== undefined)
    : undefined;

  if (!defaultModel && !enabledModels) {
    return undefined;
  }

  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(enabledModels ? { enabledModels } : {}),
  };
}

export function getPiModelProbeCandidates(
  runtimeDir: string,
  fallbackModel: string,
): ReadonlyArray<string> {
  const settings = readPiRuntimeSettings(runtimeDir);
  const candidates = [
    settings?.defaultModel,
    settings?.defaultModel ? stripPiProviderPrefix(settings.defaultModel) : undefined,
    fallbackModel,
    stripPiProviderPrefix(fallbackModel),
  ];

  return candidates.filter((candidate, index): candidate is string => {
    if (!candidate) {
      return false;
    }
    return candidates.indexOf(candidate) === index;
  });
}

export function preparePiRuntimeState(runtimeDir: string): void {
  ensureDirectory(runtimeDir);

  const sharedAgentDir = resolveSharedPiAgentDir();
  if (path.resolve(sharedAgentDir) === path.resolve(runtimeDir)) {
    return;
  }

  for (const fileName of SHARED_PI_RUNTIME_FILES) {
    if (fileName === "settings.json") {
      syncSanitizedPiSettingsFile(sharedAgentDir, runtimeDir);
      continue;
    }

    syncSharedPiRuntimeFile(
      path.join(sharedAgentDir, fileName),
      path.join(runtimeDir, fileName),
    );
  }
}

export function createPiRuntimeEnv(runtimeDir: string): NodeJS.ProcessEnv {
  preparePiRuntimeState(runtimeDir);
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: runtimeDir,
    PI_AGENT_NAME,
  };
}
