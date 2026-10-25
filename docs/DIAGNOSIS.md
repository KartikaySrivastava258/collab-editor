# Diagnosis: what was broken and how it was fixed

"Original" means the codebase before this rewrite. The reproduction log for the reproduced issues
is in [`diagnosis/baseline-repro.log`](diagnosis/baseline-repro.log): the original CRDT run under
Node, and the original UI driven in headless Chromium.

**How each issue was found:** *Reproduced* means it was executed against the original code (see
the log). *Code review* means it was found by reading the code.

## Correctness (CRDT / data integrity)

| # | Symptom | How established | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|
| R1 | After ~55 characters typed in sequence, inserts land in the wrong place | Reproduced: 86 chars typed → 70 distinct IDs; the first duplicate is at index 55; a mid-document insert lands 1 char off | `float64` midpoint IDs run out of precision; the "nudge" (`+ SmallestNonzeroFloat64` in Go, `+ EPSILON` in TS) is a no-op or overshoots | Replaced with an **RGA** sequence CRDT: unique `(clientId, lamport)` IDs and "inserted-after" references, so no precision limit | `rga.test.ts` *R1 regression* (10k chars, 20k front-inserts); Go `TestSequentialTypingThenMidInsert` | Fixed |
| R2 | Two clients, three ops: final texts `"A"` vs `"B"` | Reproduced | Deletes matched by float ID only; concurrent inserts at the same spot get the **same** ID, so the wrong character is deleted | Deletes target unique atom IDs | `rga.test.ts` *R2 regression*; Go `TestConcurrentInsertDeleteOwn`; shared vector `concurrent-insert-then-delete-own` | Fixed (TS) |
| R3 | 179/200 randomized 3-replica runs diverge | Reproduced | R1 + R2 | RGA | Randomized property test: 1,000 seeds × 4 replicas, out-of-order + duplicate delivery, checked against an independent oracle | Fixed |
| R4 | Late joiners could not resolve later ops | Code review | Snapshot sent only visible characters (no tombstones) | Snapshot includes tombstones and origins | Protocol *late joiner gets full state including tombstones*; mutation-checked | Fixed |
| R5 | Delete arriving before its insert was lost | Code review | Not buffered ("a production system would buffer this") | Pending buffers for deletes and for inserts with unknown origin, both capped | `rga.test.ts` *out-of-order delivery* | Fixed |
| R6 | Go and TS orderings could drift apart | Code review | Two hand-maintained copies with different `allocateId` | 45 shared vectors (3,982 ops) generated from TS; Go replays them in 7 orders | Go `TestVectorsMatchTypeScript` | Fixed |

## Frontend editing

| # | Symptom | How established | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|
| U1 | Typing over a selection inserted instead of replacing (`"Xhello"`) | Reproduced in Chromium | `keydown` handler ignored the selection | Let the browser edit, then diff old/new value (`textDiff.ts`) | E2E *U1 regression*; unit diff tests | Fixed |
| U2 | Pasted / IME / emoji-picker text **vanished on the next keystroke** | Reproduced in Chromium | Only `keydown` reached the CRDT; React then overwrote the textarea | `input`-event diffing; IME applied at `compositionend` | E2E *U2 regression*, *IME composition*; randomized binding test | Fixed |
| U3 | Emoji could not be typed | Reproduced | Handler required `e.key.length === 1`, but an emoji is 2 UTF-16 units | Code-point atoms; surrogate-safe diff boundaries | E2E *U3 regression*; 5,000-case randomized diff test | Fixed |
| U4 | Unreachable server: stuck at "Disconnected", never retried | Reproduced | No reconnect logic | `SyncClient`: bounded exponential backoff with jitter, `online` event, heartbeat, Retry now | `SyncClient.test.ts` backoff/heartbeat; E2E *unreachable server* | Fixed |
| U5 | Edits while disconnected silently lost | Code review | Sent only if the socket was open; no queue | Outbox until acked; reconnect re-sends only what the server lacks | `SyncClient.test.ts`; E2E *network interruption* | Fixed |
| U6 | Reconnect/init wiped local unsent edits | Code review | `loadSnapshot` replaced state | Snapshot is merged, never replaced | `SyncClient.test.ts` *reconnect re-sends only what the server is missing* | Fixed |
| U7 | "Peers" never left; collaborator list was guessed from ops | Code review | No presence protocol | Server-sent presence on join/leave | Protocol *presence*; E2E *presence updates on leave* | Fixed |
| U8 | Remote deletes moved the caret incorrectly | Code review | Length-based heuristic | Caret anchored to atom IDs | E2E *caret stays anchored mid-document* (mutation-checked) | Fixed |
| U9 | Browser undo desynchronized the document | Code review | Native undo is not routed through the CRDT | Local-intent undo/redo (own edits only) | Unit history tests; E2E *undo/redo affect only my edits* | Fixed |

## Backend, protocol and operations (found in code review)

| # | Symptom / risk | Root cause | Fix | Test | Status |
|---|---|---|---|---|---|
| G1 | Memory exhaustion from one frame | `make([]byte, payloadLen)` with a client-supplied 64-bit length | Size checked before allocation, cumulative across fragments | `TestRejectsHugeLengthHeaderBeforeAllocating`, `TestCumulativeFragmentLimit` | Fixed |
| G2 | Unmasked client frames, reserved bits, bad control frames accepted | Missing RFC 6455 checks | Enforced, with 1002 / 1007 / 1009 close codes | `TestProtocolViolations`, `TestRejectsUnmaskedClientFrame` | Fixed |
| G3 | Corrupted frames under load | Reader wrote pong/close frames while the writer goroutine also wrote | All writes serialized by a mutex | `TestConcurrentWritersAreSerialized` (`-race`) | Fixed |
| G4 | Idle but healthy clients dropped after ~60 s | Pongs did not extend the read deadline | Every frame extends the deadline | `TestControlFramesKeepConnectionAlive` | Fixed |
| G5 | Data race / crash: `delete` on the rooms map under `RLock` | Slow-client eviction inside the broadcast loop | Per-room mutex; eviction via `kick()`; send channels never closed | `-race` integration tests; `TestSlowConsumer…` | Fixed |
| G6 | Panic "send on closed channel" | `go sendSnapshot` raced with unregister closing `send` | Welcome is enqueued under the room lock; channels are never closed | `TestLateJoinGetsTombstones`, `TestSameClientIDReplacesOldConnection` | Fixed |
| G7 | Snapshot silently dropped when the queue was full | Non-blocking send with `default:` | Welcome is the first queued message; a full queue disconnects (client resyncs) | Protocol suite | Fixed |
| G8 | Fatal "concurrent map writes" | `ensureAgent` wrote a plain map from HTTP handlers | Agent removed; AI is a per-request call | — | Removed |
| G9 | AI typed into **everyone's** document; in demo mode it inserted "(Demo mode …)" text | Auto-typing agent on a 3 s pause | Opt-in suggestion returned only to the requester; insertion is a normal, undoable local edit | `TestAISuggestionSuccessIsPrivateToRequester`; E2E *F: suggestion is private* | Fixed |
| G10 | AI was misconfigured by default | Groq model name hard-coded with an OpenAI URL; data race on `cancelTyping` | `LLM_MODEL` required with a key (fail-fast config); context-based cancellation | `TestAIErrorsTimeoutCancelBusyEmpty`, `TestValidAIAndStaticConfig` | Fixed |
| G11 | `Access-Control-Allow-Origin: *`; no WebSocket origin check | Permissive defaults | Allowlist plus same-origin; 403 otherwise | Protocol *disallowed browser origin*; `TestUpgradeRejections` | Fixed |
| G12 | Shutdown left WebSockets open | `http.Server.Shutdown` does not track hijacked connections | `hub.Shutdown`: readiness → 503, close 1001, wait for goroutines | `TestGracefulShutdownClosesClientsWith1001`; CI SIGTERM step | Fixed |
| G13 | Placeholder module path `github.com/yourusername/...` | Template leftover | Module `collab-editor` | Build in CI | Done |
| G14 | CI passed with no frontend tests (`--passWithNoTests`) | Configuration | CI runs unit, protocol and E2E suites; fails if a Go package has no tests | CI | Done |
| G15 | React 18 with `@types/react` 19; deprecated react-scripts | Dependency drift | React 19.2.5 with matching types; esbuild build | `tsc`, build | Done |

## Bugs caught during the rewrite

| Bug | Found by | Fix |
|---|---|---|
| Page crash on first welcome (temporal-dead-zone access in the binding's construction callback) | Chromium smoke test | Constructor render does not emit events |
| Test server served `index.html` for JS assets (relative vs absolute path check) | Chromium smoke test | Resolve the static root first |
| "Skip to editor" link navigated to a room named `editor` (hash routing) | Writing the keyboard test | Focus moved programmatically |
| Undo after inserting an AI suggestion also removed the user's own typing | E2E | Programmatic insertions are sealed undo steps |
| Escape did not close the mobile drawer; focus stayed outside | E2E | Focus moves into the drawer and returns on close |
| Rooms opened via links / back-forward were missing from "Recent" | Reviewing a screenshot | Record on route change; regression E2E |
| 100k-char documents: keystroke handler p99 was 34.7 ms | Benchmark + CPU profile | Incremental bookkeeping, debounced counts, O(1) offsets (see BENCHMARKS.md) |
