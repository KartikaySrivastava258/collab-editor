// Package hub implements the real-time WebSocket multiplexer.
//
// Architecture:
//
//	┌─────────────┐   register/unregister   ┌──────────────────────┐
//	│   Client A  │ ──────────────────────► │                      │
//	│  readPump() │ ◄─── broadcast ──────── │  Hub  (1 goroutine)  │
//	│  writePump()│                         │                      │
//	└─────────────┘                         │  rooms  RWMutex map  │
//	┌─────────────┐                         │  docs   RWMutex map  │
//	│   Client B  │ ──── mutations ────────►│  agents RWMutex map  │
//	│  readPump() │ ◄─── broadcast ──────── │                      │
//	│  writePump()│                         │  broadcast  chan      │
//	└─────────────┘                         └──────────────────────┘
//
// The Hub's Run() loop is intentionally a single goroutine so the rooms
// map requires no lock within the select body — only external HTTP handler
// reads need the RWMutex.
package hub

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/yourusername/collab-editor/crdt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Timing constants
// ─────────────────────────────────────────────────────────────────────────────

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4096
)

// ─────────────────────────────────────────────────────────────────────────────
// BroadcastMessage — routing envelope for the broadcast channel
// ─────────────────────────────────────────────────────────────────────────────

// BroadcastMessage wraps a mutation with routing metadata for the Hub.
type BroadcastMessage struct {
	RoomID   string
	Mutation crdt.Mutation
	// SenderID is the WebSocket client ID to exclude from fanout (no echo).
	// Empty string = send to ALL connected WebSocket clients.
	SenderID string
	// FromAgent marks this mutation as originating from the AI agent.
	// When true, the Hub skips the NotifyUpdate call so the agent never
	// receives its own output as a "human" trigger — preventing debounce loops.
	FromAgent bool
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentNotifier — interface to break the hub→agent import cycle
// ─────────────────────────────────────────────────────────────────────────────

// AgentNotifier is implemented by the AI agent. The Hub calls NotifyUpdate
// after every human mutation without importing the agent package directly,
// which would create a circular dependency (hub→agent→hub).
type AgentNotifier interface {
	NotifyUpdate(text string)
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub
// ─────────────────────────────────────────────────────────────────────────────

// Hub manages all WebSocket clients grouped into rooms, and owns the
// server-authoritative CRDT documents. Run() must be called in a goroutine.
type Hub struct {
	rooms        map[string]map[*Client]bool
	roomsMu      sync.RWMutex
	documents    map[string]*crdt.Document
	documentsMu  sync.RWMutex
	agentsByRoom map[string]AgentNotifier
	agentsMu     sync.RWMutex

	register   chan *Client
	unregister chan *Client
	broadcast  chan BroadcastMessage
}

// NewHub constructs an initialized, ready-to-Run Hub.
func NewHub() *Hub {
	return &Hub{
		rooms:        make(map[string]map[*Client]bool),
		documents:    make(map[string]*crdt.Document),
		agentsByRoom: make(map[string]AgentNotifier),
		register:     make(chan *Client, 256),
		unregister:   make(chan *Client, 256),
		broadcast:    make(chan BroadcastMessage, 1024),
	}
}

// Register enqueues a client for registration. Thread-safe; called by HTTP handlers.
func (h *Hub) Register(client *Client) { h.register <- client }

// Broadcast is the thread-safe injection point for the AI agent and tests.
func (h *Hub) Broadcast(msg BroadcastMessage) { h.broadcast <- msg }

// SetAgentForRoom binds an agent to receive document update notifications.
func (h *Hub) SetAgentForRoom(roomID string, a AgentNotifier) {
	h.agentsMu.Lock()
	h.agentsByRoom[roomID] = a
	h.agentsMu.Unlock()
}

// GetDocument returns the server-side CRDT document for a room, or nil.
func (h *Hub) GetDocument(roomID string) *crdt.Document {
	h.documentsMu.RLock()
	defer h.documentsMu.RUnlock()
	return h.documents[roomID]
}

// ─────────────────────────────────────────────────────────────────────────────
// Hub Event Loop
// ─────────────────────────────────────────────────────────────────────────────

// Run is the Hub's single-goroutine event loop.
// All mutations to the rooms map are serialized here — no locks needed within
// the select cases. Locks are only needed for out-of-loop reads (HTTP handlers).
func (h *Hub) Run() {
	for {
		select {

		// ── Client connects ───────────────────────────────────────────────────
		case client := <-h.register:
			h.roomsMu.Lock()
			if h.rooms[client.RoomID] == nil {
				h.rooms[client.RoomID] = make(map[*Client]bool)
			}
			h.rooms[client.RoomID][client] = true
			h.roomsMu.Unlock()

			h.documentsMu.Lock()
			if h.documents[client.RoomID] == nil {
				h.documents[client.RoomID] = crdt.NewDocument()
			}
			h.documentsMu.Unlock()

			// Send full document snapshot to the new client (async, non-blocking)
			go h.sendSnapshot(client)
			log.Printf("[HUB] ✦ %s joined room %s", client.ID, client.RoomID)

		// ── Client disconnects ────────────────────────────────────────────────
		case client := <-h.unregister:
			h.roomsMu.Lock()
			if clients, ok := h.rooms[client.RoomID]; ok {
				if _, exists := clients[client]; exists {
					delete(clients, client)
					close(client.send)
					if len(clients) == 0 {
						delete(h.rooms, client.RoomID)
					}
				}
			}
			h.roomsMu.Unlock()
			log.Printf("[HUB] ✦ %s left room %s", client.ID, client.RoomID)

		// ── Mutation fanout ───────────────────────────────────────────────────
		case msg := <-h.broadcast:
			// 1. Apply to server-authoritative CRDT document
			h.documentsMu.RLock()
			doc := h.documents[msg.RoomID]
			h.documentsMu.RUnlock()

			if doc != nil {
				doc.ApplyRemote(msg.Mutation)

				// Notify AI agent ONLY for human mutations — never for the agent's
				// own output. FromAgent=true prevents debounce self-triggering loops.
				if !msg.FromAgent {
					h.agentsMu.RLock()
					agent := h.agentsByRoom[msg.RoomID]
					h.agentsMu.RUnlock()
					if agent != nil {
						go agent.NotifyUpdate(doc.GetText())
					}
				}
			}

			// 3. Serialize mutation once, fan out to all room clients except sender
			payload, err := json.Marshal(msg.Mutation)
			if err != nil {
				log.Printf("[HUB] marshal error: %v", err)
				continue
			}

			h.roomsMu.RLock()
			for client := range h.rooms[msg.RoomID] {
				if client.ID == msg.SenderID {
					continue // No echo — sender already applied locally
				}
				select {
				case client.send <- payload:
				default:
					// Buffer full → client too slow or dead; evict
					close(client.send)
					delete(h.rooms[msg.RoomID], client)
				}
			}
			h.roomsMu.RUnlock()
		}
	}
}

// sendSnapshot serializes the full document and pushes it to a new client.
func (h *Hub) sendSnapshot(client *Client) {
	h.documentsMu.RLock()
	doc := h.documents[client.RoomID]
	h.documentsMu.RUnlock()
	if doc == nil {
		return
	}

	type InitMsg struct {
		Type  string      `json:"type"`
		Chars []crdt.Char `json:"chars"`
	}
	payload, err := json.Marshal(InitMsg{Type: "init", Chars: doc.GetChars()})
	if err != nil {
		return
	}
	select {
	case client.send <- payload:
	default:
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

// Client represents one active WebSocket connection. It runs exactly two
// goroutines: ReadPump (inbound) and WritePump (outbound).
type Client struct {
	ID     string
	RoomID string
	hub    *Hub
	conn   *WSConn    // Our stdlib WebSocket implementation
	send   chan []byte // Outbound queue; WritePump drains it
}

// NewClient constructs a Client from an already-upgraded WebSocket connection.
func NewClient(id, roomID string, h *Hub, r *http.Request, w http.ResponseWriter) (*Client, error) {
	conn, err := Upgrade(w, r)
	if err != nil {
		return nil, err
	}
	return &Client{
		ID:     id,
		RoomID: roomID,
		hub:    h,
		conn:   conn,
		send:   make(chan []byte, 256),
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// ReadPump
// ─────────────────────────────────────────────────────────────────────────────

// ReadPump continuously reads WebSocket frames and forwards mutations to Hub.
//
// Concurrency design:
//   - Sole reader of conn — satisfies the single-reader requirement.
//   - Defers unregister on any error so WritePump's channel close is clean.
//   - Read deadline reset on every ping/pong keeps dead connections from
//     occupying memory indefinitely.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadDeadline(time.Now().Add(pongWait))

	for {
		opcode, message, err := c.conn.ReadMessage()
		if err != nil {
			return // Any read error → connection dead → deferred unregister fires
		}

		// Refresh deadline on any received frame (ping response is handled inside ReadMessage)
		c.conn.SetReadDeadline(time.Now().Add(pongWait))

		// Only process text/binary data frames
		if opcode != 0x1 && opcode != 0x2 {
			continue
		}
		if len(message) > maxMessageSize {
			continue
		}

		var mutation crdt.Mutation
		if err := json.Unmarshal(message, &mutation); err != nil {
			log.Printf("[READ] Bad JSON from %s: %v", c.ID, err)
			continue
		}

		// Enforce server-side identity — prevent clientId spoofing
		mutation.ClientID = c.ID
		mutation.RoomID = c.RoomID

		c.hub.broadcast <- BroadcastMessage{
			RoomID:   c.RoomID,
			Mutation: mutation,
			SenderID: c.ID,
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// WritePump
// ─────────────────────────────────────────────────────────────────────────────

// WritePump drains the outbound send channel and writes frames to the WebSocket.
//
// Concurrency design:
//   - Sole writer of conn — satisfies the single-writer requirement.
//   - Ticker sends WebSocket Ping frames to detect dead connections through
//     NATs, reverse proxies, and cloud load balancers.
//   - When Hub closes the send channel (client eviction), WritePump sends
//     a graceful Close frame and exits.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed channel — send graceful WebSocket close
				c.conn.WriteMessage(opClose, []byte{})
				return
			}
			if err := c.conn.WriteMessage(opText, message); err != nil {
				return
			}

		case <-ticker.C:
			// Periodic ping — detect dead connections without waiting for a read
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(opPing, nil); err != nil {
				return
			}
		}
	}
}
