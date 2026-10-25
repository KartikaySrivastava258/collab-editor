# Wire protocol v2

JSON text frames over one WebSocket per tab. Implemented by `backend/hub` (Go) and
`frontend/test-server` (TypeScript). The conformance suite `frontend/tests/protocol` is the
executable form of this document and runs against either server.

## Connecting

```
GET /ws?roomId=<room>&clientId=<client>&name=<display name>
```

| Parameter | Rule |
|---|---|
| `roomId` | `[A-Za-z0-9_-]{1,64}`, otherwise HTTP 400 |
| `clientId` | `[A-Za-z0-9_-]{1,64}`, otherwise HTTP 400. Browsers generate a fresh one per page load. |
| `name` | Control characters stripped, trimmed, 1–32 code points, otherwise `Guest` |
| `Origin` | Must be absent (non-browser), in `ALLOWED_ORIGINS`, or the server's own host, otherwise HTTP 403 |

Capacity limits (`MAX_ROOMS`, `MAX_CLIENTS_PER_ROOM`) return HTTP 503 before the upgrade.
A second connection with the same `clientId` in a room replaces the first (close code 4001).

## Data model

```ts
AtomId = { c: string /* clientId */, t: number /* Lamport counter, 1..2^53-1 */ }
Insert = { k: "i", id: AtomId, o: AtomId | null /* inserted after; null = start */, v: string /* one code point */ }
Delete = { k: "d", id: AtomId }
SnapshotAtom = { id, o, v, d?: true /* tombstone */ }    // listed in document order
```

Invariants checked by every replica: `v` is exactly one Unicode scalar value, and
`o.t < id.t` (the Lamport rule that RGA's correctness relies on).

## Server → client

| `type` | Fields | When |
|---|---|---|
| `welcome` | `protocol, roomId, clientId, epoch, snapshot[], peers[], ai{enabled, reason?}, limits{maxDocAtoms, maxOpsPerMessage, maxMessageBytes}, persistence:"memory"` | Always the first message |
| `ops` | `from, ops[]` | Another client's accepted batch (only ops that changed state) |
| `ack` | `seq` | Your batch `seq` was validated and applied (also for idempotent duplicates) |
| `presence` | `peers[{id, name}]` | Join/leave in the room |
| `error` | `code, message, seq?` | Followed by close 4000 |
| `pong` | `nonce` | Reply to `ping` |
| `ai_result` / `ai_error` | `requestId, text` / `requestId, code, message` | Only to the requesting client |

`epoch` changes whenever the server (re)creates its in-memory copy of a room (after a restart
or eviction). Clients use it, together with the snapshot, to restore the room (see below).

## Client → server

| `type` | Fields | Rules |
|---|---|---|
| `ops` | `seq, ops[1..maxOpsPerMessage]` | Inserts must be authored by the sender (`id.c == clientId`) |
| `sync` | `seq, ops[...]` | Same, but any author: replay of state the server lacks |
| `ping` | `nonce` | Application heartbeat (detects half-open sockets) |
| `ai_suggest` | `requestId` | At most one in flight per connection |
| `ai_cancel` | `requestId` | |

Each batch is validated **as a whole** before anything is applied (atomic): origins and delete
targets must exist in the room or earlier in the same batch, and the batch must fit within
`MAX_DOC_ATOMS`. Rejection codes: `bad_json`, `bad_message`, `invalid_op`, `too_many_ops`,
`foreign_author`, `unknown_origin`, `unknown_target`, `doc_too_large`, `id_conflict`.

The Go server also applies a per-connection token bucket (10,000 ops/s, burst 50,000) by
**pausing reads**, which is backpressure rather than rejection. The TS test server does not rate-limit.

## Reconnect and recovery (client side, `SyncClient`)

1. Local edits are applied immediately and queued until acknowledged.
2. On every `welcome`: merge the snapshot (never replace), compute the ops the server is missing
   (`missingOps`: inserts unknown to the server, then deletes it has not applied), and send them as
   `sync` batches. This covers unacked edits after a blip and full restoration after the server
   lost the room.
3. If the server rejected a batch (`error` with `seq`), the next `welcome` replaces local state
   with the snapshot and the user is told which edits were rolled back. The Lamport clock never
   moves backwards, so IDs are never reused.
4. Backoff: `min(30 s, 0.5 s × 2^(attempt-1))`, with "equal jitter" (between 50% and 100% of
   that). Retries immediately on the browser `online` event or "Retry now". The heartbeat pings
   every 20 s, and a missing reply within 10 s drops the socket. No welcome within 10 s of
   opening also counts as a failed attempt.

## Close codes

| Code | Meaning | Client behaviour |
|---|---|---|
| 1000 / 1001 | Normal / server shutting down | Reconnect |
| 1002 / 1007 / 1009 | WebSocket protocol violation / invalid UTF-8 / message too big | Reconnect (1009 also rolls back) |
| 4000 | Application protocol error (preceded by `error`) | Reconnect and roll back |
| 4001 | Replaced by a newer connection with the same `clientId` | Stop; show "Session moved" |
| 4002 | Slow consumer (outbound queue full) | Reconnect and resync |
| 4003 | Server or room full | Reconnect with backoff |
| 4100 | (client-initiated) heartbeat/welcome timeout | Reconnect |

## HTTP

| Route | Response |
|---|---|
| `GET /health`, `/healthz` | `200 {"status":"ok","service":"collab-editor","implementation":"go"\|"ts-test-server"}` |
| `GET /readyz` | `200 {"ready":true}`, or `503` while shutting down |
| `GET /api/room/text?roomId=` | `200 {roomId, text, lamportClock, epoch, clients}` · `400 invalid_room_id` · `404 room_not_found`. CORS only for allowed origins. |
| `GET /*` | Built frontend when `STATIC_DIR` is set (SPA fallback, CSP, `nosniff`) |
