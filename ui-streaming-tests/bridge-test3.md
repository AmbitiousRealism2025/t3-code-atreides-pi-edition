# Bridge Test 3

Third streaming test document for bridge-related UI scenarios — extends `bridge-test.md` and `bridge-test2.md` with edge cases around event deduplication, assistant/thinking splits, markdown boundary conditions, and accessibility under long-running streams.

---

## Scope

This document focuses on failure-prone states that tend to show up once the basics already work:

- Resume flows where the server replays overlapping events after a reconnect
- Turns that interleave visible assistant text with hidden or collapsible thinking blocks
- Markdown structures that arrive on awkward token boundaries
- Streaming sessions that must remain legible and navigable for keyboard and screen-reader users

Run these scenarios after the first two bridge test documents so we can isolate regressions in the more advanced render paths.

---

## Scenario 11: Replay Deduplication After Resume

Reconnect handling is not just about missing tokens. It is also about avoiding duplicates when the client resumes from an event cursor that is slightly behind the server's last flushed state.

Example replay sequence:

```text
event-101 assistant_text_delta "Bridge setup is in place."
event-102 assistant_text_delta " Next I'll verify the remote worker."
-- socket drops --
client resumes from event-101
server replays event-102
server streams event-103 assistant_text_delta " The worker responded with ACK."
```

Expected behaviour:

1. The UI preserves the already-rendered prefix.
2. `event-102` is not appended twice.
3. The final message reads naturally with no repeated sentence fragments.
4. The streaming indicator stays attached to the existing bubble rather than creating a duplicate bubble.

Common failure mode: reconnect logic keys off raw text length instead of stable event IDs, so repeated deltas show up as duplicated clauses in the final assistant message.

---

## Scenario 12: Thinking Block Followed by Public Answer

Some provider sessions emit a private or collapsible "thinking" stream before the assistant starts the user-visible answer. The chat view must keep these streams distinct.

Expected event order:

```text
thinking_delta        "Need to inspect the bridge resume path."
thinking_delta        " Looking at ws event projection."
assistant_text_delta  "I found the issue."
assistant_text_delta  " The client is replaying one delta twice after reconnect."
```

The UI should:

1. Accumulate the thinking content inside a dedicated thinking block.
2. Start a separate assistant message when the public answer begins.
3. Avoid merging the hidden thinking text into the user-visible markdown output.
4. Preserve both sections when the turn is restored from persisted state.

This scenario is especially important for bridge sessions because long relay operations often produce extended reasoning before a concise visible result.

---

## Scenario 13: Markdown Boundary Splits

The renderer must stay stable when markdown syntax arrives across inconvenient chunk boundaries.

Use a stream shaped like this:

```text
"Here is the command:\n\n```ba"
"sh\nbun run dev\n"
"```\n\nAnd here is a "
"[link](https://example.com)"
```

Validate all of the following:

- Opening backticks that arrive in separate chunks do not flash as plain text before resolving into a fenced code block.
- A link label and URL split across chunks still become a single anchor once complete.
- Inline code opened in one chunk and closed in another does not cause the whole paragraph to reflow repeatedly.
- The renderer does not drop trailing whitespace that is semantically meaningful inside code fences.

If any of these fail, users will see visible markdown "snapping" where prose keeps changing shape mid-stream.

---

## Scenario 14: Mixed Tool Output, Diff, and Final Summary

Bridge-heavy turns often include a long tool phase, a file-diff summary, and then a short natural-language wrap-up.

Example shape:

```text
assistant_text_delta   "I'll inspect the bridge tests first."
function_call          { name: "read_file", args: { path: "ui-streaming-tests/bridge-test2.md" } }
function_call_output   "# Bridge Test 2 ..."
function_call          { name: "apply_patch", args: { file: "ui-streaming-tests/bridge-test3.md" } }
function_call_output   "Success. Added 1 file."
assistant_text_delta   "Created bridge-test3.md and preserved the existing folder layout."
```

The final turn should read as one coherent story:

1. Initial assistant intent appears first.
2. Tool cards are ordered correctly and remain expandable.
3. Large tool output does not push the final answer off-screen or cause scroll jumps.
4. The closing summary is clearly visible once streaming finishes.

Regression to watch for: the last assistant summary mounts above the tool output because events are grouped by type instead of arrival order.

---

## Scenario 15: Accessibility During Long Streams

Long-running bridge turns can last tens of seconds. During that time, the interface must remain usable without a mouse and understandable without constant visual monitoring.

Accessibility checks:

1. Keyboard focus remains stable while new content streams in.
2. Screen-reader announcements are polite and do not re-announce the entire growing message on every token batch.
3. Expand/collapse controls for thinking and tool blocks are reachable and labeled.
4. The streaming status has an accessible name such as "Assistant is responding."
5. Error and reconnect states are announced with enough context to explain what happened.

Test this with both a short burst and a prolonged stream so we can catch over-verbose live-region behaviour that only appears under sustained updates.

---

## Pass/Fail Criteria

| # | Criterion | Pass Condition |
|---|-----------|---------------|
| 11 | Replay deduplication | No repeated clauses or duplicate message bubbles after resume |
| 12 | Thinking/public split | Thinking stays isolated from visible assistant markdown |
| 13 | Markdown boundaries | Fences, links, and inline code settle without flicker |
| 14 | Mixed tool + summary turn | Event ordering remains chronological and readable |
| 15 | Accessibility | Focus, live-region output, and controls remain usable during streaming |

---

## Notes

- This file is intentionally a sibling of `bridge-test.md` and `bridge-test2.md` in `ui-streaming-tests/` because the repo already groups these streaming fixtures at the top level.
- Scenarios 11 and 14 pair well with the reconnect and tool-call cases in `bridge-test2.md`.
- Scenario 15 is easiest to verify with browser accessibility tooling and a real keyboard-only pass through the chat UI.
