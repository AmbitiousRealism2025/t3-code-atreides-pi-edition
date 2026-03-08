# Bridge Test 4

Fourth streaming test document for bridge-related UI scenarios. This one focuses on ordering guarantees, cancellation, persistence, and state transitions that tend to break once reconnects and long-running tool phases already work.

---

## Scope

This document extends `bridge-test.md`, `bridge-test2.md`, and `bridge-test3.md` with scenarios that are easy to miss until the UI is under load:

- Out-of-order event delivery after reconnect or buffered flushes
- User-initiated stop/cancel during an active stream
- Session restore after a full page reload, not just a socket reconnect
- Streaming transitions between tool output, assistant prose, and terminal states
- Multiple concurrent sessions updating independently in one UI shell

The repo already keeps bridge streaming docs together in the top-level `ui-streaming-tests/` folder, so this file belongs there as a sibling of the first three bridge test documents.

---

## Scenario 16: Out-of-Order Event Arrival

WebSocket delivery is ordered per connection, but replay paths, buffering, or projection bugs can still surface events out of order at the UI boundary.

Example bad sequence:

```text
event-201 assistant_text_delta "I inspected the"
event-203 assistant_text_delta " and found the root cause."
event-202 assistant_text_delta " reconnect path"
```

Expected behaviour:

1. The client uses stable ordering metadata such as event IDs or sequence numbers.
2. The final rendered message becomes `I inspected the reconnect path and found the root cause.`
3. The UI does not permanently display scrambled text while waiting for missing events.
4. If ordering cannot be recovered, the turn fails loudly with a local error state instead of silently corrupting the transcript.

Failure mode: the renderer appends deltas strictly in arrival order, producing broken prose that looks plausible enough to escape notice.

---

## Scenario 17: User Stops a Stream Mid-Turn

Users need a predictable way to stop a runaway stream. A cancelled turn must settle cleanly without leaving the UI in a fake "still streaming" state.

Test flow:

1. Start a long bridge-heavy turn with visible assistant deltas and at least one tool block.
2. Click Stop while tokens are still arriving.
3. Server emits a terminal event such as `turn.cancelled` or `turn.completed` with a cancellation reason.

Expected behaviour:

- The spinner and live streaming indicator stop immediately.
- Partial assistant content remains visible.
- Tool blocks that already started remain attached to the turn.
- The composer returns to an editable state.
- A short terminal label explains that the user stopped the response.

Regression to watch for: the transport stops, but the client never closes the turn state, so the message keeps a stuck typing indicator forever.

---

## Scenario 18: Full Page Reload and Session Restore

Reconnect is the easy case. Full reload is harsher because all in-memory client state is gone.

Restore flow:

1. Start a streamed turn.
2. Reload the browser tab before the turn finishes.
3. App reboots, restores the session shell, and requests prior events from the server.
4. Any still-running turn resumes from persisted thread state.

The restored UI should:

1. Reconstruct the partial assistant message exactly once.
2. Reconstruct thinking and tool blocks in the correct order.
3. Re-attach terminal state if the turn finished while the page was reloading.
4. Avoid a double-hydration effect where the partial message appears once from cache and again from replay.

This matters because production users do reload tabs during long agent runs, especially when a session appears stalled.

---

## Scenario 19: Tool Output Ends, Assistant Summary Continues

A common shape is: assistant intent, large tool output, then final natural-language synthesis. The transition from tool phase back to prose is easy to mishandle when the UI groups blocks too aggressively.

Example sequence:

```text
assistant_text_delta   "I'll inspect the session manager first."
function_call          { name: "read_file", args: { path: "apps/server/src/providerManager.ts" } }
function_call_output   "// 600 lines..."
function_call          { name: "read_file", args: { path: "apps/web/src/lib/sessionStore.ts" } }
function_call_output   "// 220 lines..."
assistant_text_delta   "I found the mismatch. The server persists the cursor, but the web client resets it on reload."
assistant_text_delta   " I'll patch the restore path next."
```

Expected behaviour:

- The final assistant prose appears after the tool blocks, not nested inside them.
- The prose continuation lands in the same assistant bubble as the opening intent when that is the chosen UI model.
- Scroll position stays stable when large tool outputs expand or collapse.
- The completed turn reads chronologically from intent to evidence to conclusion.

---

## Scenario 20: Parallel Sessions in the Same UI Shell

The app can hold multiple sessions. Streaming state must stay isolated per session so activity in one tab or panel does not mutate another.

Test this by:

1. Opening Session A and Session B.
2. Starting a long streamed bridge turn in Session A.
3. Switching to Session B and starting a shorter turn.
4. Letting both run concurrently.

Validate all of the following:

- Session A's deltas never appear in Session B.
- Session list previews update for the correct session only.
- Unread or active indicators reflect per-session activity.
- Returning to Session A shows the full accumulated stream with no dropped content.
- Cancelling Session B does not affect Session A's in-flight turn.

Failure mode: shared client-side streaming state is keyed too broadly, so whichever session updates last overwrites the other.

---

## Pass/Fail Criteria

| # | Criterion | Pass Condition |
|---|-----------|---------------|
| 16 | Out-of-order handling | Final transcript is ordered by event sequence, not arrival timing |
| 17 | Stop/cancel | Turn settles cleanly with partial content preserved |
| 18 | Full reload restore | Transcript reconstructs exactly once after page reload |
| 19 | Tool-to-summary transition | Final prose appears after tool output in chronological order |
| 20 | Parallel sessions | In-flight state remains isolated per session |

---

## Notes

- This file belongs in `ui-streaming-tests/` because the repo already uses that top-level folder for manual streaming fixtures.
- Scenario 18 is the one I would prioritise first. Reload recovery is where hidden state bugs usually show up.
- Scenarios 16 and 20 are especially good candidates for future automated integration coverage once the server event model stabilises.
