/**
 * PiModelDiscoveryLive - Live implementation of PiModelDiscovery.
 *
 * Queries the Pi SDK's ModelRegistry for available models and caches the
 * result in memory for 60 seconds to avoid repeated SDK round-trips
 * (~560ms each without cache).
 *
 * @module PiModelDiscoveryLive
 */
import { Effect, Layer } from "effect";

import {
  PiModelDiscovery,
  type PiModelDiscoveryShape,
  type PiModelList,
} from "../Services/PiModelDiscovery.ts";

// 60-second in-memory cache (latency is ~560ms without cache)
let cache: { models: PiModelList; expiresAt: number } | undefined;
const CACHE_TTL_MS = 60_000;

async function discoverPiModels(): Promise<PiModelList> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) {
    return cache.models;
  }

  try {
    // Dynamic import so this module stays loadable even if the package is absent
    const { AuthStorage, ModelRegistry } = await import("@mariozechner/pi-coding-agent");

    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);

    // getAll() returns every built-in + custom model regardless of credentials.
    // getAvailable() is a fast credential check — use it to annotate each entry.
    const all = modelRegistry.getAll();
    const available = modelRegistry.getAvailable();
    const availableSlugs = new Set(
      available.map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`),
    );

    if (all.length === 0) {
      const result: PiModelList = { configured: [], unconfigured: [], reason: "no_credentials" };
      cache = { models: result, expiresAt: now + CACHE_TTL_MS };
      return result;
    }

    const configured: Array<{ slug: string; name: string; supportsThinking: boolean }> = [];
    const unconfigured: Array<{ slug: string; name: string; supportsThinking: boolean }> = [];

    for (const m of all as Array<{ provider: string; id: string; name?: string; reasoning?: boolean; capabilities?: { reasoning?: boolean } }>) {
      const slug = `${m.provider}/${m.id}`;
      // SDK exposes reasoning as a direct field on the model object (not nested under capabilities)
      const supportsThinking = m.reasoning === true || m.capabilities?.reasoning === true;
      const entry = { slug, name: m.name ?? `${m.provider} / ${m.id}`, supportsThinking };
      if (availableSlugs.has(slug)) {
        configured.push(entry);
      } else {
        unconfigured.push(entry);
      }
    }

    const result: PiModelList = { configured, unconfigured };
    cache = { models: result, expiresAt: now + CACHE_TTL_MS };
    return result;
  } catch (error) {
    const result: PiModelList = {
      configured: [],
      unconfigured: [],
      reason: "sdk_error",
      detail: error instanceof Error ? error.message : String(error),
    };
    // Do not cache errors so the next request retries
    return result;
  }
}

export const PiModelDiscoveryLive = Layer.effect(
  PiModelDiscovery,
  Effect.succeed({
    getModels: Effect.promise(discoverPiModels),
  } satisfies PiModelDiscoveryShape),
);
