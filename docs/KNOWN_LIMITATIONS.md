# Known limitations (prioritized)

## Product and architecture

1. **Memory-only storage.** Rooms are lost on server restart unless a client that has the
   document reconnects and restores it. Next step: an append-only op log or periodic snapshots
   (e.g. SQLite) written before `ack`, so "synced" can mean durable.
2. **No authentication or authorization.** Anyone with a room ID can read and edit it. Author IDs
   are not authenticated (a room member could forge another member's author ID in a `sync`
   message). Next step: signed room links or accounts, plus server-assigned client IDs.
3. **Tombstones are never collected.** `MAX_DOC_ATOMS` (default 200,000) counts deleted
   characters too, so a heavily edited document can hit the limit while visibly short. The UI
   explains this when it happens. Next step: snapshot-based compaction once all clients have
   acknowledged.
4. **Plain text only.** No rich text, cursors/selections of others, comments or history view.
5. **Grapheme clusters** (e.g. family emoji) can be visually split by concurrent edits inside the
   same cluster; code points are never split.
6. **RGA interleaving.** Concurrent runs typed at the same spot stay contiguous, but their order is
    by ID; backward-typing interleaving anomalies are possible. (Fugue would remove these.)
7. **Large documents.** Per-keystroke handler cost is about 1.7 ms p50 / 5.3 ms p99 at 100k
    characters (Chromium, see BENCHMARKS.md). Remote updates still rebuild the visible array in
    O(n), and textarea layout of very large documents is the browser's own cost.
8. **Single server process.** Rooms are not shared across instances; horizontal scaling would
    need sticky routing by room or a shared op log.
9. **Stdlib WebSocket implementation.** Hardened and covered by tests, but a maintained library
    (e.g. `github.com/coder/websocket`) is the better long-term choice. The backend currently
    keeps zero third-party modules on purpose.
10. **AI** is non-streaming, one request per connection, English-centric prompt, and the automated
    tests use a mock provider (`frontend/e2e/fake-llm.mjs`), not a real LLM.
11. **Accessibility.** No automated axe/Lighthouse audit and no screen-reader testing yet (see
    TESTING.md for what is covered).

## Not measured

Go server performance (`make bench-go`); real-network latency; multi-hour soak and memory growth; multi-core
scaling. See BENCHMARKS.md.
