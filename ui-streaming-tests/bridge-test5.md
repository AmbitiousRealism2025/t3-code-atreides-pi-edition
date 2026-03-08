# Bridge Test 5

Fifth streaming test document for bridge-related UI scenarios. This one focuses on duplicate delivery, incremental formatting, stream failure boundaries, and long-running transcript behavior.

---

## Scope

This document extends `bridge-test.md`, `bridge-test2.md`, `bridge-test3.md`, and `bridge-test4.md` with cases that usually fail once basic streaming, reconnect, and cancellation are already working:

- Duplicate event delivery after replay or reconnect
- Incremental Markdown rendering while a message is still streaming
- Provider or transport failure in the middle of tool-heavy output
- Very long turns that force aggressive scrolling and UI virtualization decisions
- Late-arriving terminal events after the UI already considers the turn complete

The repo already keeps bridge streaming docs together in the top-level `ui-streaming-tests/` folder, so this file belongs there as a sibling of the earlier bridge test documents.

---

## Scenario 21: Duplicate Event Replay

Replay paths often resend the last few events for safety. That is fine only if the UI can deduplicate them reliably.

Example sequence:

```text
event-301 assistant_text_delta "I inspected the stream"
event-302 assistant_text_delta " replay path."
-- reconnect --
event-302 assistant_text_delta " replay path."
event-303 assistant_text_delta " The issue is duplicate append."
```

Expected behaviour:

1. The client identifies duplicate event IDs and ignores already-applied deltas.
2. The final rendered message becomes `I inspected the stream replay path. The issue is duplicate append.`
3. Tool blocks, status chips, and terminal states are also deduplicated, not just text.
4. The user never sees doubled words or repeated tool cards.

Failure mode: reconnect succeeds, but the transcript quietly accumulates duplicated deltas and repeated tool output.

---

## Scenario 22: Streaming Markdown Boundaries

Markdown arrives token by token, not as a finished document. The renderer needs to stay stable while code fences, lists, and inline formatting are incomplete.

Example partial stream:

```text
assistant_text_delta "Here is the patch:\n\n```ts\n"
assistant_text_delta "const state = restoreSession();\n"
assistant_text_delta "if (!state) return;\n"
assistant_text_delta "```\n\nThis keeps reconnects idempotent."
```

Expected behaviour:

- The UI does not thrash between radically different layouts on every token.
- Incomplete code fences do not break the rest of the message list.
- Final Markdown rendering matches the completed message exactly once the closing fence arrives.
- Copy actions and syntax highlighting only activate when the block is structurally valid, or degrade gracefully until then.

Regression to watch for: an unterminated code fence causes the whole transcript below it to render as code until refresh.

---

## Scenario 23: Failure During Tool-Heavy Streaming

A turn can fail after some assistant text and some tool output have already streamed. The UI should preserve evidence without pretending the run completed normally.

Test flow:

1. Start a turn that emits assistant intent and at least two tool calls.
2. Force a provider-side error or disconnect during the second tool phase.
3. Server emits an explicit failure event.

Expected behaviour:

- Already-rendered assistant text remains visible.
- Completed tool output remains attached to the failed turn.
- The failed tool step is marked clearly if partial output exists.
- The turn ends in an error state with a concise explanation.
- The composer becomes usable again without needing a full refresh.

Bad outcome: the UI clears partial output on failure, leaving the user with no record of what the agent already did.

---

## Scenario 24: Very Long Transcript Streaming

Long-running sessions stress scroll anchoring, DOM growth, and virtualization. The UI should stay responsive even when a single turn emits a lot of streamed content.

Stress case:

1. Start a turn with many assistant deltas and large tool outputs.
2. Let the transcript grow beyond normal viewport size.
3. Switch between pinned-to-bottom and manually-scrolled-up states.

The UI should:

1. Stay anchored to the latest content while the user is following the stream.
2. Stop auto-jumping when the user scrolls upward to inspect prior output.
3. Preserve readable spacing and grouping even if older items are virtualized.
4. Avoid visible flicker when large blocks mount, collapse, or hydrate.
5. Keep CPU usage and input responsiveness acceptable during the stream.

This matters because a streaming UI that is logically correct but visually janky still feels broken.

---

## Scenario 25: Late Terminal Event After Local Completion

Sometimes the client decides a turn looks done before the authoritative terminal event arrives. The final server event still needs to reconcile state cleanly.

Example shape:

```text
assistant_text_delta   "Done, I applied the fix."
client infers completion from idle timeout
... 2 seconds later ...
turn.completed        { usage: ..., finishReason: "stop" }
```

Expected behaviour:

- The turn remains in a provisional but consistent state until the terminal event arrives, or until a clearly-defined timeout path marks it failed.
- When `turn.completed` finally lands, the UI upgrades the turn instead of creating a second terminal marker.
- Usage metadata, finish reason, and timestamps attach to the existing turn.
- No duplicate "completed" labels appear in the transcript.

Failure mode: the client locally closes the turn, then the real terminal event produces a second completion row or reopens a finished message.

---

## Pass/Fail Criteria

| # | Criterion | Pass Condition |
|---|-----------|---------------|
| 21 | Duplicate replay | Replayed events do not duplicate transcript or tool output |
| 22 | Streaming Markdown | Partial Markdown renders safely until the final structure is complete |
| 23 | Mid-stream failure | Partial evidence is preserved and the turn ends in a clear error state |
| 24 | Long transcript behavior | Streaming remains responsive and scroll behavior stays predictable |
| 25 | Late terminal reconciliation | Final server completion reconciles into one clean terminal state |

---

## Notes

- I placed this in `ui-streaming-tests/` because that folder already exists and already contains the other `bridge-test*.md` streaming docs.
- Scenario 21 is the one I would automate first. Duplicate replay bugs are subtle, common, and easy to miss in manual QA.
- Scenario 22 is the one most likely to produce ugly user-facing breakage even when the underlying event model is technically correct.
