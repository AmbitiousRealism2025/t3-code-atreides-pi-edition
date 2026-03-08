# Pi Provider Implementation Report

## Status

Pi is now implemented as a real provider in T3 Code across:

- shared provider/model contracts
- server-side provider registration and runtime execution
- provider health reporting
- session persistence and provider routing
- web provider picker and settings

Pi is selectable in the UI, can start a session, can run a turn through the local Pi CLI, and streams canonical runtime events back into the existing orchestration pipeline.

## What Was Implemented

### 1. Provider contracts and model support

Pi was added as a first-class `ProviderKind` instead of being treated as an unknown or placeholder provider.

Key changes:

- `packages/contracts/src/orchestration.ts`
  - `ProviderKind` now includes `"pi"`.
- `packages/contracts/src/model.ts`
  - added Pi built-in model catalog
  - added Pi default model: `openai/gpt-4o-mini`
  - added Pi model aliases:
    - `4o-mini`
    - `gpt-4o-mini`
  - Pi currently has no reasoning-effort options
- `packages/contracts/src/providerRuntime.ts`
  - widened raw runtime event sources for Pi RPC traffic
- `packages/shared/src/model.ts`
  - provider-aware model resolution now works for Pi

### 2. Server-side Pi runtime adapter

Pi was implemented as a new provider adapter instead of being folded into Codex logic.

Key files:

- `apps/server/src/provider/Services/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`
- `apps/server/src/serverLayers.ts`

Behavior:

- one short-lived Pi RPC process is spawned per turn
- T3 Code owns Pi session continuity using files under the server state directory
- the adapter converts Pi RPC stdout/stderr into canonical `ProviderRuntimeEvent` records
- stop/interrupt kills the active Pi child process
- provider registration now returns both `codex` and `pi`

### 3. Pi session persistence and routing fixes

Pi provider values now survive persistence and routing instead of being coerced back to Codex.

Key files:

- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/web/src/store.ts`

This fixed the main Codex-only assumptions that would otherwise break resume flows or provider selection.

### 4. Web UI and settings support

Pi is exposed in the product as a real provider option.

Key files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/appSettings.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/routes/_chat.settings.tsx`

UI support includes:

- Pi in the provider picker
- Pi model selection support
- Pi custom model storage in settings
- provider-aware model resolution in chat flows

### 5. Provider health checks

Pi health now appears in the same server config payload used by the web app.

Key file:

- `apps/server/src/provider/Layers/ProviderHealth.ts`

Current Pi startup probes:

1. `pi --version`
2. `pi --help`
3. `pi --list-models openai/gpt-4o-mini`

The health check uses an isolated temporary Pi state directory to avoid false failures from Pi's global lock file.

## How Pi Works Locally

### Runtime shape

Pi is not being driven as a long-lived daemon session in this integration.

Instead:

- T3 Code creates lightweight provider session state per thread
- each chat turn spawns a fresh Pi process in RPC mode
- Pi session continuity is preserved through the Pi session file on disk

This was chosen because the installed Pi CLI's RPC mode behaves as a stdin/stdout JSON protocol. It is not correctly modeled by a simple `--mode rpc --print` one-shot integration.

### Pi process invocation

For a normal turn, the adapter starts Pi with arguments in this shape:

```bash
pi --mode rpc \
  [--continue] \
  --session <session-file> \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  [--model <model-slug>]
```

Then T3 Code sends a JSON RPC prompt command to Pi over stdin.

### Pi environment

The adapter isolates Pi runtime state with these environment variables:

- `PI_AGENT_NAME=t3code`
- `PI_CODING_AGENT_DIR=<server-state-dir>/providers/pi/agent`

This matters because running Pi without isolation can hit:

- `Lock file is already being held`
- `PI_AGENT_NAME not set`

### Attachments

Image attachments are supported in the adapter's prompt path.

T3 Code reads the stored attachment file, base64-encodes it, and sends it to Pi as RPC image content with:

- `type: "image"`
- `data: <base64>`
- `mimeType: <attachment mime type>`

## Local State and Files

### Default state directories

There are two relevant defaults:

- normal server default state dir: `~/.t3/userdata`
- root dev runner state dir: `~/.t3/dev`

If you start the app with `bun run dev` from the repo root, the dev runner sets:

- `T3CODE_STATE_DIR=~/.t3/dev`

If you run the server directly with `bun run dev` inside `apps/server`, the server default is:

- `T3CODE_STATE_DIR=~/.t3/userdata`

### Pi-specific files under state

The Pi adapter stores provider state under:

```text
<stateDir>/providers/pi/
```

Important subpaths:

- `providers/pi/agent/`
  - isolated Pi runtime directory used by T3 Code
- `providers/pi/sessions/<threadId>.jsonl`
  - Pi session file used for `--session` / `--continue`

If you need to verify local behavior, this is the first place to inspect.

## Startup Sequence For Local Dev

### Recommended full-stack command

From the repo root:

```bash
bun run dev
```

That is the right top-level command for normal local development in this repo.

What it does:

- starts the server package
- starts the web package
- sets coordinated dev env vars for both
- uses default dev ports unless you override them

Default dev ports from the root runner:

- server: `3773`
- web: `5733`

The web app talks to the server over:

```text
ws://localhost:3773
```

### Split commands

If you want to run pieces separately:

From the repo root:

```bash
bun run dev:server
bun run dev:web
```

Or directly:

```bash
cd apps/server && bun run dev
cd apps/web && bun run dev
```

### Useful dev env overrides

These are the most relevant overrides for local Pi testing:

- `T3CODE_STATE_DIR`
  - choose an explicit state directory
- `T3CODE_PORT_OFFSET`
  - shifts the default server/web ports together
- `T3CODE_DEV_INSTANCE`
  - alternate way to derive a stable port offset
- `T3CODE_NO_BROWSER=1`
  - prevent auto-opening the browser

Example:

```bash
T3CODE_STATE_DIR=~/tmp/t3-pi-dev T3CODE_NO_BROWSER=1 bun run dev
```

## Preconditions For Testing Pi

Before testing Pi in the app, make sure all of the following are true:

1. Pi CLI is installed and reachable.

```bash
pi --version
```

2. Pi can start cleanly when isolated.

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) PI_AGENT_NAME=t3code pi --help
```

3. Pi has access to credentials for the model/provider you want to use.

4. The model you plan to use is available through Pi.

Example probe:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) PI_AGENT_NAME=t3code pi --list-models openai/gpt-4o-mini
```

Important local finding from implementation work:

- on this machine, the probe for `openai/gpt-4o-mini` returned `No models matching "openai/gpt-4o-mini"`

That means the built-in default may not be usable in your local Pi install even though the integration supports it. If that happens, add a working custom Pi model in Settings and use that instead.

## How To Test The Pi Integration In T3 Code

### Basic UI test

1. Start the app from the repo root with:

```bash
bun run dev
```

2. Open the app in the browser.

3. Go to Settings.

4. In the custom model section for Pi:
   - add a model slug that your local Pi install can actually use if the default model is unavailable

5. Open or create a chat thread.

6. In the provider picker, select `Pi`.

7. Choose the desired Pi model.

8. Send a prompt.

Expected result:

- the session should start with provider `pi`
- the turn should enter a running state
- streamed output should appear in the chat timeline

### Interrupt test

1. Start a longer Pi turn.
2. Interrupt it from the UI.

Expected result:

- the active Pi child process is killed
- the orchestration state should settle as interrupted instead of hanging

### Persistence/resume test

1. Start a Pi thread and complete at least one turn.
2. Restart the app.
3. Re-open the same thread.
4. Send another Pi turn.

Expected result:

- the thread remains associated with provider `pi`
- the session file is reused
- the adapter may pass `--continue` when the Pi session file already exists

### File-level verification

While testing, inspect:

```text
<stateDir>/providers/pi/sessions/
<stateDir>/providers/pi/agent/
```

What to look for:

- session file created for the thread
- session file reused across turns
- Pi runtime directory present under the T3 state dir

## Current Limitations

These are intentional or known MVP gaps:

- `respondToRequest` is not implemented for Pi
- `respondToUserInput` is not implemented for Pi
- `rollbackThread` is not implemented for Pi
- `readThread` currently returns an empty turns snapshot
- Pi extension UI requests are surfaced as warnings, not handled interactively

This means the current implementation is best described as:

- session start
- turn execution
- streaming output
- interrupt
- basic persistence

rather than full parity with Codex.

## Common Failure Modes

### 1. Pi binary not found

Symptom:

- Pi provider health shows unavailable

Likely cause:

- `pi` is not installed or not on `PATH`

### 2. Lock file conflict

Symptom:

- Pi reports `Lock file is already being held`

Mitigation in T3 Code:

- health checks use an isolated temporary Pi directory
- runtime uses a provider-scoped `PI_CODING_AGENT_DIR`

### 3. Missing or expired credentials

Symptom:

- Pi health degrades
- turns fail quickly

Likely cause:

- the underlying provider credentials are not configured for Pi

### 4. Default model unavailable

Symptom:

- Pi health warning mentioning `openai/gpt-4o-mini`
- turn launch or model selection issues

Action:

- add a working Pi model in the Settings screen and select it explicitly

## Validation Completed

The following validation was completed during implementation:

- `bun lint`
  - passed
- targeted typechecks passed for:
  - `packages/contracts`
  - `packages/shared`
  - `apps/web`
- targeted tests passed for:
  - `apps/web/src/appSettings.test.ts`
  - `apps/web/src/session-logic.test.ts`
  - `apps/web/src/store.test.ts`
  - `apps/web/src/wsNativeApi.test.ts`
  - `packages/shared/src/model.test.ts`
  - `packages/contracts/src/provider.test.ts`
  - `apps/server/src/provider/Layers/ProviderHealth.test.ts`
  - `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`
  - `apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts`

## Repo-Wide Validation Caveat

Repo-wide `bun typecheck` still does not currently pass, but the remaining failures are outside the Pi implementation work and were already present in unrelated areas such as:

- `scripts/build-desktop-artifact.ts`
- `scripts/dev-runner.ts`
- `apps/server/integration/OrchestrationEngineHarness.integration.ts`
- `apps/server/src/wsServer.test.ts`

So the Pi work is validated with targeted checks, but the monorepo is not yet globally green.

## Suggested Demo Script

If you want a simple show-and-tell flow for the team:

1. Run `bun run dev` from the repo root.
2. Open Settings and show the Pi custom model section.
3. Show that Pi appears as a real provider in the provider picker.
4. Start a Pi thread with a known-good custom Pi model.
5. Send a prompt and show streaming output.
6. Interrupt one in-flight turn to demonstrate process control.
7. Show the created session file under `<stateDir>/providers/pi/sessions/`.

## Bottom Line

Yes, for normal local development in this repo, the main startup command is:

```bash
bun run dev
```

If Pi itself is installed, authenticated, and pointed at a working model, that is the simplest path to testing the local Pi integration end to end.
