# Bridge Test 2

Second streaming test document for bridge-related UI scenarios — extends `bridge-test.md` with additional edge cases around reconnection, large payloads, and multi-agent coordination rendering.

---

## Scope

`bridge-test.md` covers the basics: short bursts, mid-stream code blocks, tables, and nested lists. This document picks up where that one leaves off and focuses on:

- High-volume token streams that stress the renderer's batching logic
- Cross-project agent threads rendered inside a single chat view
- Error and interruption recovery mid-stream
- Long-running tool-call blocks with interleaved prose

---

## Scenario 5: High-Volume Token Burst

Some model responses arrive extremely fast — thousands of tokens in under a second. The UI must not queue up DOM mutations one-per-token. Rendering should be debounced or batched so the browser stays responsive.

Expected behaviour:

1. Tokens arrive at the WebSocket handler.
2. The handler accumulates tokens into a short-lived buffer (target: ~16ms window, one animation frame).
3. A single React state update fires per frame, containing all buffered tokens.
4. The user sees smooth text growth without jank.

Failure mode to watch for: each token triggers a `setState` call, causing hundreds of renders per second and a frozen UI during a fast stream.

---

## Scenario 6: Cross-Project Thread in a Single Session

When a Lead agent dispatches work to a remote project via the relay bridge, the resulting turn may contain messages from multiple agents interleaved. The chat view should visually distinguish agents while keeping the thread readable.

Example turn sequence:

```
[Lead → backend:Worker]   "Implement /api/sessions endpoint."
[backend:Worker → Lead]   "ACK: Starting on /api/sessions."
[backend:Worker → Lead]   "DONE: Endpoint implemented. See apps/server/src/routes/sessions.ts."
[Lead → frontend:Worker]  "Wire up SessionList component to /api/sessions."
[frontend:Worker → Lead]  "ACK: On it."
[frontend:Worker → Lead]  "DONE: SessionList now fetches from /api/sessions with SWR."
```

Each message should render with the sender's name and a distinct colour or badge. The thread must not collapse cross-project messages into a single "agent" bubble — provenance matters for debugging.

---

## Scenario 7: Tool-Call Blocks With Interleaved Prose

The Codex app-server emits tool-call events (`function_call`, `function_call_output`) mixed with assistant text deltas. The renderer must handle the following interleaved sequence gracefully:

```
assistant_text_delta   "I'll check the file first."
function_call          { name: "read_file", args: { path: "apps/server/src/wsServer.ts" } }
function_call_output   { content: "// 240 lines of TypeScript..." }
assistant_text_delta   "The WebSocket server is straightforward. Here's what I'll change:"
assistant_text_delta   "\n\n```typescript\n// patch here\n```"
```

The chat view should render:

1. The prose before the tool call.
2. A collapsed (or expandable) tool-call block showing the function name and arguments.
3. The tool output, optionally truncated if large.
4. The prose continuation, fused with any code blocks that follow.

Streaming must not break when a `function_call` event arrives before the preceding `assistant_text_delta` sequence has flushed.

---

## Scenario 8: Mid-Stream WebSocket Disconnect and Resume

The server must preserve partial message state so that a reconnecting client can continue rendering from the correct point.

Reconnect protocol:

1. Client detects WebSocket close (code 1001 or 1006).
2. Client re-connects and sends `{ method: "session.resume", params: { sessionId, lastEventId } }`.
3. Server replays all events after `lastEventId` from the thread log.
4. Client re-renders the partial message from the replayed events, then continues streaming.

Test this scenario by:

- Starting a long response (> 500 tokens).
- Killing the WebSocket connection at token 200.
- Reconnecting immediately.
- Verifying the rendered message is complete and contains no duplicated or missing segments.

---

## Scenario 9: Agent Error Mid-Stream

If the Codex app-server emits an error event during a turn, the UI must:

1. Stop the streaming indicator.
2. Render whatever partial content arrived before the error.
3. Show a clear error state attached to the message bubble (not a global toast that obscures the conversation).
4. Allow the user to retry the turn without losing context.

Error event shape (from `packages/contracts`):

```typescript
// OrchestrationDomainEvent — error variant
{
  type: "turn.error",
  sessionId: string,
  turnId: string,
  error: {
    code: string,       // e.g. "rate_limit_exceeded"
    message: string,
    retryable: boolean
  }
}
```

The retry button should only appear when `retryable: true`. For non-retryable errors, show a help link or contact prompt instead.

---

## Scenario 10: Very Long Single Message (> 10 000 tokens)

Some agent responses — particularly those involving large file reads or long plans — exceed 10 000 tokens. The UI must:

- Virtualise the message list so off-screen content is not in the DOM.
- Not freeze during the final render when streaming ends and React reconciles the full content.
- Allow the user to jump to the bottom without scrolling through the entire message.

This is the most demanding test. Run it against a release build (`bun build && bun start`) to get accurate performance numbers. Dev mode with HMR overhead will skew results.

---

## Pass/Fail Criteria

| # | Criterion | Pass Condition |
|---|-----------|---------------|
| 5 | High-volume burst | UI stays at ≥ 60 fps during a 1 000-token/s stream |
| 6 | Cross-project thread | Each agent message shows correct sender provenance |
| 7 | Tool-call interleaving | Tool blocks render without breaking surrounding prose |
| 8 | Disconnect/resume | No duplicated or missing tokens after reconnect |
| 9 | Mid-stream error | Error state is localised to the message; retry works |
| 10 | Very long message | No jank at stream-end; virtualisation keeps DOM lean |

---

## Notes

- These tests complement the scenarios in `bridge-test.md` — run both files together for a full coverage pass.
- Scenarios 8 and 9 require the real WebSocket server running locally. They cannot be mocked at the unit-test level because the reconnect handshake involves server-side session state.
- Scenario 10 is best paired with a React Profiler trace to identify which component commits are slow.
- See `apps/web/src` for the streaming message components under test.
