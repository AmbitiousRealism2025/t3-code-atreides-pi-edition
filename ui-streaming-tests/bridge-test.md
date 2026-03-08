# Bridge Test

Streaming test document for bridge-related UI scenarios — verifies that long-form markdown renders correctly as it arrives over the WebSocket.

---

## What Is a Bridge?

In the context of T3 Code and agent-relay, a **bridge** connects agents running in separate projects so they can communicate as if they were local to each other. Without a bridge, relay messages are scoped to a single project's `.agent-relay/` directory. With a bridge, a Lead agent in `frontend/` can dispatch work to a Worker in `backend/`, receive status updates, and coordinate across process boundaries — all through the same file-based relay protocol.

This matters because real workflows span multiple codebases. A Lead orchestrating a full-stack feature needs to hand off server changes to a backend agent and UI changes to a frontend agent, then merge the results. The bridge makes that possible without requiring shared infrastructure.

---

## How the Bridge Works

### Local vs. Bridge Addressing

| Context | Correct Format | Notes |
|---------|---------------|-------|
| Same project | `TO: WorkerName` | Plain name, no prefix |
| Cross-project | `TO: otherproject:AgentName` | `project:` prefix required |
| Broadcast local | `TO: *` | All agents in current project |
| Broadcast remote | `TO: otherproject:*` | All agents in remote project |

The relay daemon resolves the `project:` prefix by looking up a bridge configuration that maps project names to their `.agent-relay/` directories. If no bridge config is found, cross-project messages fail with a clear error rather than silently dropping.

### Message Flow

```
Lead (frontend/)
  │
  │  cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
  │  TO: backend:Worker
  │
  │  Implement the /api/sessions endpoint.
  │  EOF
  │
  ▼
Bridge Daemon
  │  resolves "backend" → /path/to/backend/.agent-relay/
  │  writes message to backend inbox
  ▼
backend/.agent-relay/inbox/
  │
  ▼
Worker (backend/)
  reads message, ACKs, does work, reports DONE
  │
  ▼
Lead (frontend/)
  receives DONE, continues orchestration
```

The bridge daemon runs as a background process and polls both sides. Latency is typically under 200ms on a local filesystem. Over NFS or remote mounts it degrades gracefully but predictably.

---

## Streaming Test Scenarios

This section contains long-form content intended to stress-test incremental rendering in the chat view.

### Scenario 1: Short Burst

A single paragraph of moderate length, arriving in small chunks. The UI should not flash or repaint the entire message — only the newly appended content should update.

The agent sends its first thought. Then a second sentence appears. Then a third. The scroll position should stay stable unless the user is already at the bottom, in which case it should follow the new content down automatically. Edge case: if the user has scrolled up to read earlier messages, auto-scroll must not hijack their position.

### Scenario 2: Code Block Mid-Stream

The agent starts prose, then opens a code block:

```typescript
// apps/server/src/wsServer.ts
import { WebSocketServer } from "ws";
import { createProviderManager } from "./providerManager.js";

export function startWsServer(port: number) {
  const wss = new WebSocketServer({ port });
  const manager = createProviderManager();

  wss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      const msg = JSON.parse(raw.toString());
      const result = await manager.dispatch(msg);
      ws.send(JSON.stringify(result));
    });
  });

  return wss;
}
```

The UI must hold the code block open until the closing triple-backtick arrives. Partial code blocks should render with a visible "streaming" indicator — not as broken markdown.

### Scenario 3: Table Arriving Incrementally

| Column A | Column B | Column C |
|----------|----------|----------|
| Row 1A   | Row 1B   | Row 1C   |
| Row 2A   | Row 2B   | Row 2C   |
| Row 3A   | Row 3B   | Row 3C   |

Tables are the hardest case. The header row arrives first, then the separator, then rows one by one. The renderer should either buffer the whole table before painting it, or show a graceful progressive state. Flickering column widths on each row arrival is a known failure mode to watch for.

### Scenario 4: Nested Lists

The agent produces a structured plan:

- **Phase 1: Audit**
  - Review existing WebSocket message types in `packages/contracts`
  - Identify undocumented event shapes in `providerManager.ts`
  - Confirm session lifecycle states are complete
- **Phase 2: Schema**
  - Add missing schemas to `packages/contracts/src`
  - Run `bun typecheck` across all packages
  - Fix any type errors surfaced by stricter schemas
- **Phase 3: Integration**
  - Wire new schemas into `wsServer.ts` dispatch
  - Update `apps/web` consumers to use typed contracts
  - Add Vitest tests for new event shapes

Nested list rendering should indent correctly on first arrival. Bullet points that arrive mid-word must not cause layout shift once the word completes.

---

## Pass/Fail Criteria

A streaming session passes this bridge test if:

1. **No layout thrash** — the chat view does not repaint unchanged content when new tokens arrive.
2. **Code blocks are fenced correctly** — partial blocks show a pending state, not broken markdown.
3. **Scroll behavior is correct** — auto-scroll follows new content only when the user is at the bottom.
4. **Tables do not flicker** — column widths stabilize after the header row.
5. **Reconnect is seamless** — if the WebSocket drops mid-stream, the partial message is preserved and streaming resumes from where it left off once reconnected.

---

## Notes

- Run this test against both the development server (`bun dev`) and the production build (`bun build && bun start`) — streaming behavior can differ because the dev server uses Vite's HMR layer.
- The bridge-specific scenarios (cross-project agent messages rendered in the chat view) require a live relay daemon. Mock the daemon for unit tests; use the real daemon for integration tests.
- See `.plans/13-provider-service-integration-tests.md` for the broader integration test strategy that this file feeds into.
