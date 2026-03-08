/**
 * PiAdapter - Pi implementation of the generic provider adapter contract.
 *
 * Owns Pi CLI RPC process orchestration and emits canonical provider runtime
 * events for the shared provider pipeline.
 *
 * @module PiAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "pi";
}

export class PiAdapter extends ServiceMap.Service<PiAdapter, PiAdapterShape>()(
  "t3/provider/Services/PiAdapter",
) {}
