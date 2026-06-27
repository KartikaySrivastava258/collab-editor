<div align="center">

# ✦ Collab Editor

### Real-Time Collaborative Document Editor

**A production-grade distributed systems project** demonstrating Conflict-Free Replicated Data Types (CRDTs), concurrent WebSocket architecture in Go, and an asynchronous AI writing agent.

[![CI](https://github.com/yourusername/collab-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/yourusername/collab-editor/actions)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8?logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Zero Deps](https://img.shields.io/badge/Go_deps-zero-brightgreen)](backend/go.mod)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[**Live Demo**](#) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [Design Decisions](#-design-decisions)

</div>

---

## What This Is

Collab Editor is a **Google Docs–style real-time collaborative text editor** built from first principles. Multiple users can type simultaneously in the same document, and every replica converges to the identical text — guaranteed — regardless of network latency, packet reordering, or concurrent edits.

The system also includes an **AI writing agent** that observes the document, waits for the user to pause, calls an LLM API, and types its response character-by-character into the shared document — behaving exactly like a live collaborator.

> **Zero external Go dependencies.** The WebSocket protocol (RFC 6455) is implemented from scratch using only `net/http`, `crypto/sha1`, and `encoding/binary`. Every distributed systems mechanic — CRDT ordering, Lamport clocks, WebSocket framing, goroutine lifecycle — is fully auditable in the source.

### Why This Problem Is Hard

In a distributed system with no central clock, two users can type into the same position at the exact same millisecond. A naive "last write wins" approach would silently delete one user's character. The system must:

1. **Never lose data** — every character from every client must survive.
2. **Converge deterministically** — after all messages are delivered, every replica must hold the *identical* document, regardless of message delivery order.
3. **Feel instant** — the editor must never wait for a server round-trip before showing the user their own keystrokes.

---

## ✨ Features

| Feature | Implementation |
|---|---|
| **Real-time sync** | WebSocket-based mutation broadcasting |
| **Conflict-free editing** | Fractional-index CRDT with Lamport timestamps |
| **AI collaborator** | Debounced LLM agent that types live into the document |
| **Cursor preservation** | Remote inserts/deletes shift cursor without interrupting typing |
| **Room-based sessions** | Share a URL hash to invite collaborators |
| **Graceful degradation** | AI agent works in demo mode without an API key |

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Go Backend                                │
│                                                                  │
│  ┌──────────┐    register     ┌────────────────────────────┐    │
│  │ Client A │ ─────────────► │         WebSocket Hub       │    │
│  │ readPump │ ◄── broadcast ─ │                            │    │
│  │writePump │                 │  rooms: map[RoomID]Clients │    │
│  └──────────┘                 │  docs:  map[RoomID]*CRDT   │    │
│  ┌──────────┐    mutations    │                            │    │
│  │ Client B │ ─────────────► │  broadcast chan (1024 buf) │    │
│  │ readPump │ ◄── broadcast ─ │                            │    │
│  │writePump │                 └────────────┬───────────────┘    │
│  └──────────┘                              │                     │
│                                      notify on                   │
│                                     human edit                   │
│                                            │                     │
│                               ┌────────────▼───────────────┐    │
│                               │       AI Agent Worker       │    │
│                               │                            │    │
│                               │  1. Debounce 2s            │    │
│                               │  2. LLM API call           │    │
│                               │  3. Type chars @ 50ms each │    │
│                               └────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                                    │ WebSocket
┌───────────────────────────────────▼─────────────────────────────┐
│                       React Frontend                             │
│                                                                  │
│  useCollabEditor hook                                            │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  CRDTDocument (TypeScript)                             │     │
│  │  ┌────────────────────────────────────────────────┐   │     │
│  │  │  chars: Char[] — sorted by fractional ID       │   │     │
│  │  │  [0.0|sentinel] [0.25|'H'] [0.5|'i'] [1.0|sen]│   │     │
│  │  └────────────────────────────────────────────────┘   │     │
│  │  insertLocal()  → Mutation → WebSocket.send()          │     │
│  │  applyRemote()  ← Mutation ← WebSocket.onmessage()     │     │
│  └────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

```
collab-editor/
├── backend/
│   ├── crdt/
│   │   ├── document.go        # ← CRDT engine: Char, Document, fractional index math
│   │   └── document_test.go   # ← Convergence, idempotency, race detector tests
│   ├── hub/
│   │   └── hub.go             # ← WebSocket Hub: rooms, goroutines, mutex safety
│   ├── agent/
│   │   └── agent.go           # ← AI agent: debounce loop, LLM call, char injection
│   ├── api/
│   │   └── handler.go         # ← HTTP layer: WebSocket upgrade, REST endpoints
│   └── main.go                # ← Server entrypoint, graceful shutdown
│
├── frontend/
│   └── src/
│       ├── types/crdt.ts      # ← Wire protocol TypeScript types
│       ├── utils/crdtDocument.ts  # ← Client-side CRDT engine (no dependencies)
│       ├── hooks/useCollabEditor.ts  # ← WebSocket + CRDT React hook
│       ├── components/
│       │   └── CollaborativeEditor.tsx  # ← Editor UI, cursor preservation
│       └── App.tsx            # ← Room routing, session management
│
├── docker-compose.yml
├── Makefile
└── .github/workflows/ci.yml
```

---

## 🧠 Design Decisions

### 1. Why CRDT over Operational Transformation?

**Operational Transformation (OT)** — used by Google Docs — requires a central server to serialize all operations and transform indices. This creates a bottleneck and makes the algorithm stateful.

**CRDTs** assign every character a globally unique, mathematically immutable position. Operations are commutative and associative, so they can be applied in any order and any number of times with the same result.

### 2. Fractional Indexing vs. Tree-Based CRDTs

Libraries like [Yjs](https://github.com/yjs/yjs) use a doubly-linked list with relative references ("insert after CharID X"). This handles infinite insertions at any position but requires a more complex data structure.

This project uses **Logoot-style fractional indexing**:

```
Position:  0.0   0.25   0.5   0.75   1.0
           [SEN]  [H]    [i]   [!]   [SEN]
```

Inserting between `H` (0.25) and `i` (0.5) yields midpoint `0.375`.

**Trade-off:** Eventually, float64 precision limits the number of inserts in the *same position* (after ~52 bisections). For a student project or most real-world documents, this is not a practical concern.

### 3. Lamport Timestamps for Tie-Breaking

When two clients insert at position `0.375` simultaneously, they get the same fractional ID. We break the tie with:

```
sort order: (fractional_id, lamport_timestamp, client_id_lexicographic)
```

This is a **total order** — identical on every replica — which is precisely what guarantees convergence.

```go
func charLess(a, b Char) bool {
    if a.ID != b.ID           { return a.ID < b.ID }
    if a.LamportTimestamp != b.LamportTimestamp {
        return a.LamportTimestamp < b.LamportTimestamp
    }
    return a.ClientID < b.ClientID // "AI_AGENT" < "user_alice"
}
```

### 4. Tombstoning vs. Deletion

Characters are never physically removed from the array. A "deleted" character becomes a **tombstone** — its `tombstoned` flag is set to `true` and it's excluded from visible text.

Why? If Client A deletes a character and Client B *concurrently* inserts *after* that same character, B's mutation references the soon-to-be-deleted character's ID. If we physically removed it before B's mutation arrived, B's insert would have no anchor and we'd lose their character.

### 5. Go Concurrency Model

```
Per-connection goroutines:    readPump  →  Hub.broadcast channel
                              writePump ←  Hub.broadcast channel

Hub goroutine (single):       serializes all room map mutations
                              no mutex needed within the select loop

AI agent goroutine:           separate goroutine pool
                              injects via Hub.Broadcast() (channel, thread-safe)
```

The Hub's `run()` loop is intentionally a **single goroutine** reading from channels. This means the `rooms` map only needs a mutex for out-of-loop reads (by HTTP handlers), not for the core broadcast logic.

---

## 🚀 Quick Start

### Prerequisites

- **Go 1.21+** — [install](https://go.dev/dl/)
- **Node.js 18+** — [install](https://nodejs.org/)

### Run Locally

```bash
# Clone
git clone https://github.com/yourusername/collab-editor.git
cd collab-editor

# Install dependencies
make install

# Start backend + frontend concurrently
make dev
```

Open **http://localhost:3000** — you'll be redirected to a new room URL.

Open a second tab at the same URL to see real-time collaboration.

### With AI Agent

```bash
# Set your OpenAI API key (any OpenAI-compatible API works)
export LLM_API_KEY=sk-...

# Restart backend
make backend
```

The AI agent activates after you pause typing for 2 seconds.

### Docker

```bash
# Full stack with Docker Compose
LLM_API_KEY=sk-... docker compose up --build

# Backend only
docker compose up backend
```

---

## 🧪 Testing

```bash
# Run Go tests with race detector
make test-go

# Expected output:
# --- PASS: TestConvergence_ConcurrentInserts (0.00s)
# --- PASS: TestConvergence_ThreeWay (0.00s)
# --- PASS: TestIdempotency_DuplicateMutation (0.00s)
# --- PASS: TestConcurrentAccess_NoDataRace (0.05s)
# --- PASS: TestFullSession_AliceBobAI (0.00s)
```

The race detector test (`TestConcurrentAccess_NoDataRace`) spawns 100 concurrent goroutines reading and writing the same document. Zero data races reported.

---

## 📡 API Reference

### WebSocket — `GET /ws?roomId=<id>&clientId=<id>`

Upgrades to a WebSocket connection. The server immediately sends an `init` message with the current document state.

**Inbound mutation (client → server):**
```json
{
  "roomId":    "room_abc123",
  "clientId":  "user_xyz",
  "opType":    "insert",
  "charId":    0.375,
  "value":     "H",
  "timestamp": 42
}
```

**Init message (server → new client):**
```json
{
  "type": "init",
  "chars": [
    { "id": 0.25, "value": "H", "clientId": "user_xyz", "timestamp": 1 },
    { "id": 0.5,  "value": "i", "clientId": "AI_AGENT", "timestamp": 7 }
  ]
}
```

### REST

| Endpoint | Description |
|---|---|
| `GET /health` | Health check — returns `{"status":"ok"}` |
| `GET /api/room/text?roomId=<id>` | Current plaintext of a room |

---

## 🛣 Potential Extensions

| Extension | Complexity | Value |
|---|---|---|
| Persistent storage (Redis/Postgres) | Medium | High |
| Presence cursors (show where others are typing) | Medium | High |
| Rich text (bold/italic) using attribute spans | High | High |
| Operational replay / version history | High | Medium |
| Horizontal scaling (Redis Pub/Sub as Hub backend) | High | High |
| WASM CRDT engine (shared Go/TS code) | Very High | Medium |

---

## 🔗 References

- [Logoot: A Scalable Optimistic Replication Algorithm](https://hal.inria.fr/inria-00432368/document) — Martin et al., 2009
- [A comprehensive study of CRDTs](https://hal.inria.fr/inria-00555588/document) — Shapiro et al., 2011
- [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) — The WebSocket Protocol (implemented from scratch using Go stdlib)
- [Designing Data-Intensive Applications](https://dataintensive.net/) — Kleppmann (Chapter 9: Consistency and Consensus)

---

## License

MIT © 2024 — Built as a distributed systems portfolio project.

---

<div align="center">
  <sub>Built with Go · React · TypeScript · WebSockets · CRDT theory</sub>
</div>
