/**
 * PiModelDiscovery - Live Pi model discovery service.
 *
 * Queries the Pi SDK for the user's available models and caches the result
 * in memory. Exposed via GET /api/provider/pi/models.
 *
 * @module PiModelDiscovery
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface PiModelEntry {
  readonly slug: string;
  readonly name: string;
  readonly supportsThinking: boolean;
}

export interface PiModelList {
  /** Models with credentials confirmed — shown first in the picker. */
  readonly configured: ReadonlyArray<PiModelEntry>;
  /** Models that exist in the registry but lack credentials. */
  readonly unconfigured: ReadonlyArray<PiModelEntry>;
  readonly reason?: "no_credentials" | "sdk_error";
  readonly detail?: string;
}

export interface PiModelDiscoveryShape {
  /**
   * Fetch available Pi models. Never fails — errors are surfaced in the
   * returned PiModelList via `reason` and `detail`.
   */
  readonly getModels: Effect.Effect<PiModelList>;
}

export class PiModelDiscovery extends ServiceMap.Service<PiModelDiscovery, PiModelDiscoveryShape>()(
  "t3/provider/Services/PiModelDiscovery",
) {}
