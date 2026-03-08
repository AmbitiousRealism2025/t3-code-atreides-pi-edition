# Pi Provider Integration Phased Task Plan

## Current State and Preconditions

- Implementation target repo: `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/`
- Source master plan: `/Users/ambrealismwork/Documents/openclaw-docs/Project Forge/pi-provider-master-plan.md`
- Planned deliverable scope: expanded, repo-aware implementation plan that covers backend integration plus the UI/settings/health/model work required to make Pi selectable end-to-end.
- Pi binary path: `/opt/homebrew/bin/pi`
- Pi CLI version observed locally: `0.56.2`
- Pi CLI warnings/errors observed during local probes:
  - `Warning (startup, global settings): Lock file is already being held`
  - `Error: Lock file is already being held`
  - `[atreides-dashboard] WARNING: PI_AGENT_NAME not set, extension inactive`
  - Prior sample failure without explicit model: `Warning: No models match pattern "zai-org/GLM-5"`
- `pi --help` confirms the MVP command shape we need for turn execution:
  - `--mode rpc`
  - `--print` / `-p`
  - `--continue` / `-c`
  - `--session <path>`
  - `--provider <name>`
  - `--model <pattern>`
- Precondition for parser work: obtain one successful authenticated `pi --mode rpc --print` sample with an explicit working model and capture the exact newline-delimited JSON event stream before finalizing event-to-`ProviderRuntimeEvent` mapping.

## Summary

This plan converts the master Pi-provider concept into a codebase-specific rollout for the T3 Code monorepo. It keeps Codex as the default provider, adds Pi as an additive provider kind, introduces a new server-side adapter and health probe, and closes the repo-specific gaps in shared model handling, persistence, and the web picker/settings flows so Pi becomes a real selectable provider rather than a partially wired backend option.

Each phase below is implementation-ready and includes concrete work items, touched files, dependencies, acceptance criteria, and tests.

## Public API, Interface, and Type Changes

- `packages/contracts/src/orchestration.ts`
  - Widen `ProviderKind` from `"codex"` to `"codex" | "pi"`.
  - Keep `DEFAULT_PROVIDER_KIND` as `"codex"`.
- `packages/contracts/src/model.ts`
  - Add Pi model catalog entries, default Pi model, slug aliases, and provider-safe defaults for reasoning-effort tables.
- `packages/shared/src/model.ts`
  - Ensure provider-aware getters and normalizers work with Pi without forcing Codex-only assumptions.
- `apps/server/src/provider/Services/PiAdapter.ts`
  - New service tag implementing `ProviderAdapterShape<ProviderAdapterError>`.
- `apps/server/src/provider/Layers/PiAdapter.ts`
  - New live Pi adapter layer for session bookkeeping, process spawning, and canonical runtime event emission.
- `apps/server/src/provider/Layers/ProviderHealth.ts`
  - Return a `ServerProviderStatus` entry for Pi alongside Codex.
- `apps/web/src/session-logic.ts`
  - Promote Pi into the real provider picker options.
- `apps/web/src/appSettings.ts`
  - Add Pi custom-model settings and provider-aware helpers.
- `apps/web/src/routes/_chat.settings.tsx`
  - Add Pi custom-model UI and remove Codex-only branching where provider-aware behavior is intended.

## Phase 1: Preflight and Source-of-Truth Capture

### Goal

Freeze the real implementation context before code changes begin, so the Pi integration is grounded in the actual repo and actual local CLI behavior.

### Touched Files

- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/pi-provider-plan/pi-provider-phased-task-plan.md`
- Reference-only inspection targets:
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/orchestration.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/model.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/shared/src/model.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/serverLayers.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderHealth.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/store.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/appSettings.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/session-logic.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/components/ChatView.tsx`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/routes/_chat.settings.tsx`

### Tasks

1. Confirm the nested repo root is `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/` and treat that as the implementation boundary.
2. Record the current Pi CLI facts from live probes:
   - version `0.56.2`
   - lock-file contention on startup
   - extension warning about `PI_AGENT_NAME`
   - model-resolution failure when no valid model is configured
3. Capture the exact places where the repo still assumes Codex-only behavior:
   - `ProviderKind` and model catalog types
   - provider-session persistence decode logic
   - provider routing in server orchestration
   - web store fallbacks that coerce unknown providers to `"codex"`
   - settings structures that only persist Codex custom models
   - picker options that still expose placeholder providers instead of Pi
4. Run one successful Pi RPC probe when the lock/auth/model issue is cleared and append the raw sample to an internal implementation note before Phase 4 starts.

### Dependencies

- None. This phase is the starting gate for the rest of the work.

### Acceptance Criteria

- The implementation team can point to one source-of-truth list of provider-related seams to change.
- The preconditions for Pi parser work are explicit and actionable.
- No one starts event-mapping work while the exact Pi RPC event stream is still unknown.

### Test and Validation

- Manual validation only.
- Re-run:
  - `/opt/homebrew/bin/pi --version`
  - `/opt/homebrew/bin/pi --help`
  - `/opt/homebrew/bin/pi --mode rpc --model <working-model> --print "hello"`

## Phase 2: Contracts, Shared Model Catalog, and Persistence Normalization

### Goal

Make `"pi"` a first-class provider everywhere that provider types, model helpers, persistence, and state normalization currently assume Codex-only behavior.

### Touched Files

- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/orchestration.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/model.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/shared/src/model.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/store.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/appSettings.ts`
- Any compile-failing test or helper files surfaced by the `ProviderKind` widening.

### Tasks

1. Update `ProviderKind` in contracts to `Schema.Literals(["codex", "pi"])` and preserve `DEFAULT_PROVIDER_KIND = "codex"`.
2. Extend contract model tables to include Pi:
   - `MODEL_OPTIONS_BY_PROVIDER`
   - `DEFAULT_MODEL_BY_PROVIDER`
   - `MODEL_SLUG_ALIASES_BY_PROVIDER`
   - `REASONING_EFFORT_OPTIONS_BY_PROVIDER`
   - `DEFAULT_REASONING_EFFORT_BY_PROVIDER`
3. Choose an MVP Pi model strategy:
   - built-in catalog contains one safe default Pi model slug
   - Pi exposes no reasoning-effort options in this first pass
   - Pi-specific `ProviderModelOptions` remain absent unless the runtime needs them
4. Update `packages/shared/src/model.ts` so provider-aware helpers resolve Pi models without falling back to Codex-only tables.
5. Update provider persistence decoding in `ProviderSessionDirectory` so persisted `providerName: "pi"` is valid.
6. Replace Codex-only provider inference in server orchestration:
   - stop checking `thread.session?.providerName === "codex"` as the only valid provider case
   - accept any valid `ProviderKind`
7. Replace Codex-only provider coercion in `apps/web/src/store.ts` so stored or synced `providerName: "pi"` remains Pi instead of collapsing to Codex.
8. Add Pi custom-model storage and normalization hooks in `apps/web/src/appSettings.ts` so later UI phases do not need to borrow `customCodexModels`.

### Dependencies

- Phase 1 preflight complete.

### Acceptance Criteria

- TypeScript accepts `"pi"` wherever a `ProviderKind` is expected.
- Pi session/provider values survive persistence round-trips.
- Shared model helpers no longer hard-code Codex as the only real provider.
- Web and server normalization helpers do not silently rewrite Pi back to Codex.

### Test and Validation

- Contract tests for provider schema decoding with `"pi"`.
- Shared model tests for Pi default model and normalization.
- `ProviderSessionDirectory` tests for persisted `providerName: "pi"`.
- Targeted store/orchestration tests covering Pi provider retention instead of Codex fallback.
- Run the relevant package and app tests after compile errors are resolved.

## Phase 3: Pi Adapter Skeleton and Server Registration

### Goal

Introduce a Pi adapter with the same service/layer shape as Codex and register it in the server runtime so provider routing can resolve Pi sessions.

### Touched Files

- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Services/PiAdapter.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/PiAdapter.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/serverLayers.ts`
- Optional reference:
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Services/CodexAdapter.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`

### Tasks

1. Add `PiAdapter.ts` in `Services/` using the same `ServiceMap.Service` pattern as Codex.
2. Create `Layers/PiAdapter.ts` with an MVP scaffold that includes:
   - `provider: "pi"`
   - `capabilities` with a deliberate MVP value for `sessionModelSwitch`
   - in-memory session map keyed by `threadId`
   - queue-backed `streamEvents`
   - shared provider error normalization helpers
3. Implement skeletal adapter methods:
   - `startSession`
   - `sendTurn`
   - `interruptTurn`
   - `respondToRequest`
   - `respondToUserInput`
   - `stopSession`
   - `listSessions`
   - `hasSession`
   - `readThread`
   - `rollbackThread`
   - `stopAll`
4. Register Pi in `ProviderAdapterRegistryLive` so `listProviders()` returns both `codex` and `pi`.
5. Compose `PiAdapterLive` into the server provider layer in `serverLayers.ts` alongside the existing Codex layer.

### Dependencies

- Phase 2 type changes must be complete so the new adapter can compile.

### Acceptance Criteria

- `ProviderAdapterRegistry` can resolve Pi by provider kind.
- Server provider layers boot with both Codex and Pi registered.
- `ProviderService.startSession()` can route a Pi start request into the adapter without unsupported-provider failure.

### Test and Validation

- Unit tests for adapter registration and provider listing.
- Provider-service tests confirming Pi is routable.
- Smoke-check server startup to ensure the new layer dependencies compose correctly.

## Phase 4: Pi Runtime Execution and RPC Event Mapping

### Goal

Implement the MVP Pi runtime using one process per turn, store Pi session continuity under T3 Code state, and translate Pi RPC output into canonical provider runtime events.

### Touched Files

- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/PiAdapter.ts`
- Potential supporting files if needed:
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Errors.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/EventNdjsonLogger.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderService.ts`
- Reference-only:
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/CodexAdapter.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/providerRuntime.ts`
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

### Tasks

1. Define Pi session runtime state stored per thread:
   - `threadId`
   - `cwd`
   - `sessionFile`
   - `status`
   - active child-process handle for the current turn, if any
   - timestamps and optional last error text
2. Place Pi session files under server-managed state, for example:
   - `<stateDir>/providers/pi/sessions/<threadId>.jsonl`
3. Implement `startSession` as lightweight state initialization rather than a persistent interactive process.
4. Implement `sendTurn` by spawning a fresh turn process using:
   - `pi --mode rpc --print --continue --session <sessionFile> --dangerously-skip-permissions`
   - include `--provider` and `--model` when present in the T3 request
   - run the command in the thread’s resolved `cwd`
5. Parse stdout line-by-line as newline-delimited JSON.
6. Map the captured Pi event schema to canonical `ProviderRuntimeEvent` records already consumed by ingestion:
   - session status changes
   - turn started/completed
   - assistant deltas
   - request/user-input events if Pi emits them
   - runtime errors
7. Log or retain unknown Pi-native event lines as raw/native payloads instead of crashing the adapter.
8. Implement `interruptTurn` by signaling the active child process and transitioning session state accordingly.
9. Implement `stopSession` and `stopAll` by terminating in-flight processes and clearing in-memory state.
10. Implement MVP `readThread`:
    - return an empty-turn snapshot or a shallow session snapshot
    - document that Pi does not yet expose full history replay through the adapter
11. Implement MVP `rollbackThread`:
    - return a typed unsupported/no-op behavior rather than pretending rollback exists

### Dependencies

- Phase 3 adapter scaffold must exist.
- Successful Pi RPC sample capture is required before final event mapping is finalized.

### Acceptance Criteria

- A Pi turn can be started from `ProviderService.sendTurn()`.
- Pi output is parsed without crashing on unknown lines.
- Canonical events flow through `ProviderService.streamEvents` and remain consumable by `ProviderRuntimeIngestion`.
- Interrupting an active Pi turn stops the process and leaves session state consistent.

### Test and Validation

- Adapter tests with mocked child-process stdout/stderr for:
  - successful turn start and completion
  - streaming delta emission
  - malformed JSON line handling
  - unknown event tolerance
  - process interruption
  - process failure / non-zero exit handling
- Provider-service fanout tests proving Pi events arrive on the shared runtime stream.
- Manual smoke run once lock/auth/model setup is valid.

## Phase 5: Productization Surfaces for Selectable Provider Behavior

### Goal

Expose Pi in the product surfaces users actually touch: provider health, provider picker, settings, draft persistence, and model selection.

### Touched Files

- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderHealth.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/session-logic.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/components/ChatView.tsx`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/appSettings.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/routes/_chat.settings.tsx`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/store.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/composerDraftStore.ts`
- Any server-config fixtures or browser test fixtures that assert provider arrays.

### Tasks

1. Extend `ProviderHealth` to probe Pi:
   - installation reachability
   - model/config/auth usability as far as the CLI allows
   - actionable error/warning messaging for lock-file, missing binary, auth, or model config issues
2. Ensure `server.getConfig` includes Pi in `providers`.
3. Replace placeholder provider options with a real Pi option in `session-logic.ts`.
4. Update `ChatView.tsx` provider filtering so Pi appears in the selectable provider list and model picker.
5. Update app settings to store Pi custom models separately from Codex custom models.
6. Update `_chat.settings.tsx` so settings UI renders a Pi section with provider-aware add/remove custom model behavior.
7. Update store and draft persistence flows so:
   - Pi selections persist across reloads
   - Pi thread sync from server read model stays Pi
   - provider/model locking logic works when a thread already started with Pi
8. Review browser fixtures and mock server config payloads to include Pi in provider arrays where assertions expect available providers.

### Dependencies

- Phase 2 provider/model normalization.
- Phase 3 server registration.
- Phase 4 runtime behavior should be stable enough that UI smoke checks are meaningful.

### Acceptance Criteria

- Pi appears as a real provider option in the app.
- Pi provider status is visible through the same config/status surface as Codex.
- Pi custom models can be saved and used by the model picker without polluting Codex settings.
- Existing Codex flows remain unchanged.

### Test and Validation

- Provider-health tests for Pi ready/warning/error cases.
- Session-logic tests confirming Pi is available in provider options.
- App-settings tests for Pi custom model normalization and selection.
- Store and composer-draft tests proving Pi selections persist.
- Browser fixture tests proving Pi shows up in provider arrays and UI picker surfaces.

## Phase 6: Tests, Validation, and Manual Smoke Checks

### Goal

Prove Pi works end-to-end without regressing Codex and leave a clear verification path for follow-up maintenance.

### Touched Files

- Contract, server, web, and browser test files surfaced by the changes in Phases 2 through 5.
- Potential new test file:
  - `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/PiAdapter.test.ts`

### Tasks

1. Add or update contract tests for `"pi"` in provider-bearing schemas.
2. Add adapter-registry tests proving Pi registration and provider lookup.
3. Add session-directory tests proving `providerName: "pi"` persists and decodes correctly.
4. Add Pi adapter tests covering:
   - session creation
   - turn spawning
   - delta streaming
   - completion
   - interruption
   - malformed line handling
   - unknown-event tolerance
   - stop/stopAll cleanup
5. Add provider-service/orchestration tests covering Pi session start, reuse, restart behavior, and runtime event fanout.
6. Add web tests covering:
   - Pi provider availability
   - Pi draft persistence
   - Pi settings/custom model handling
   - Pi model picker behavior
7. Update browser fixtures and transport tests that assert server config provider arrays.
8. Run the implementation validation matrix:
   - repo build
   - server tests
   - web tests
   - browser tests relevant to provider picker/config
9. Run manual smoke checks:
   - start dev server
   - select Pi in UI
   - create new Pi thread
   - send one successful message
   - interrupt one in-flight message
   - verify one error-path case
   - verify one resumed/continued session

### Dependencies

- All prior phases complete.

### Acceptance Criteria

- Starting a thread with no explicit provider still defaults to Codex.
- Starting a thread with `provider: "pi"` creates a Pi-backed session and persists `providerName: "pi"`.
- A Pi turn emits assistant deltas and completes as canonical runtime events.
- Unknown Pi-native events do not crash ingestion.
- Pi health reports useful ready/warning/error states.
- Web provider and model selections remain stable across sync and draft persistence.
- Codex behavior and tests remain green.

### Test Command Suggestions

- `bun run build`
- `bun test`
- `bun --cwd apps/server test`
- `bun --cwd apps/web test`
- Any project-specific browser test command already used in this repo

## File-by-File Watch List

These files are especially likely to need changes because they currently encode Codex-only assumptions or provider registration logic.

- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/orchestration.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/contracts/src/model.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/packages/shared/src/model.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/serverLayers.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/provider/Layers/ProviderHealth.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/store.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/appSettings.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/routes/_chat.settings.tsx`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/session-logic.ts`
- `/Users/ambrealismwork/Desktop/coding-projects/t3-code/t3code/apps/web/src/components/ChatView.tsx`

## Defaults and Assumptions

- Codex remains the default provider after the Pi integration lands.
- Pi is additive and does not replace any Codex code path.
- The MVP Pi runtime uses one process per turn with `--print --continue --session`, not a persistent interactive process.
- Pi does not expose provider-specific reasoning controls in the first pass.
- `readThread` and `rollbackThread` are intentionally limited for Pi MVP.
- Unknown Pi-native events should be logged and preserved as raw/native payload when possible, not treated as fatal parse errors.
- One successful explicit-model Pi RPC sample is required before locking the final event parser behavior.

## Implementation Order Recommendation

1. Phase 2 first, because provider types and normalization will fan out compile errors that reveal the full change list.
2. Phase 3 next, to get Pi into the server dependency graph.
3. Phase 4 after a successful Pi RPC sample is captured.
4. Phase 5 once the backend is routable and stable enough for real UI smoke checks.
5. Phase 6 last as the hardening pass.
