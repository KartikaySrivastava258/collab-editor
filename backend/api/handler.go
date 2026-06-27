// Package api provides the HTTP layer for the collaborative editor server.
//
// Endpoints:
//   GET /ws?roomId=<id>&clientId=<id>   — WebSocket upgrade
//   GET /api/room/text?roomId=<id>      — Current document plaintext (REST)
//   GET /health                          — Health probe
package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/yourusername/collab-editor/agent"
	"github.com/yourusername/collab-editor/hub"
)

// Handler holds injected dependencies for all HTTP endpoints.
type Handler struct {
	hub    *hub.Hub
	agents map[string]*agent.Agent // roomID → running AI agent
	apiKey string
	apiURL string
}

// NewHandler constructs the handler with injected dependencies.
func NewHandler(h *hub.Hub, apiKey, apiURL string) *Handler {
	return &Handler{
		hub:    h,
		agents: make(map[string]*agent.Agent),
		apiKey: apiKey,
		apiURL: apiURL,
	}
}

// RegisterRoutes wires all HTTP endpoints onto the provided ServeMux.
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/api/room/text", h.GetRoomText)
	mux.HandleFunc("/health", h.HealthCheck)
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Handler
// ─────────────────────────────────────────────────────────────────────────────

// ServeWS upgrades an HTTP connection to WebSocket, registers the client
// with the Hub, ensures an AI agent is running for the room, and launches
// concurrent read/write pump goroutines.
//
// Query params:
//   roomId   (required) — collaborative room to join
//   clientId (required) — unique ID for this browser session
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("roomId")
	clientID := r.URL.Query().Get("clientId")

	if roomID == "" || clientID == "" {
		http.Error(w, "roomId and clientId query params required", http.StatusBadRequest)
		return
	}

	// NewClient performs the WebSocket handshake (HTTP → WS upgrade).
	// Uses our stdlib implementation — no external dependencies.
	client, err := hub.NewClient(clientID, roomID, h.hub, r, w)
	if err != nil {
		// Upgrade already wrote error response to w
		log.Printf("[WS] Upgrade failed for %s: %v", clientID, err)
		return
	}

	// Register with Hub — triggers document snapshot delivery to new client
	h.hub.Register(client)

	// Lazily spawn one AI agent per room
	h.ensureAgent(roomID)

	// ReadPump in a goroutine; WritePump blocks in this goroutine.
	// When WritePump returns (connection closed), the HTTP handler returns
	// and the goroutine is freed — clean lifecycle management.
	go client.ReadPump()
	client.WritePump()
}

// ensureAgent starts an AI agent for a room if one isn't running yet.
// Not protected by a mutex — called from HTTP handler goroutines.
// In the worst case two agents start briefly; the second will idle harmlessly
// because the Hub deduplicates by SenderID="AI_AGENT".
func (h *Handler) ensureAgent(roomID string) {
	if _, ok := h.agents[roomID]; ok {
		return
	}
	a := agent.NewAgent(roomID, h.hub, h.apiKey, h.apiURL)
	h.agents[roomID] = a
	h.hub.SetAgentForRoom(roomID, a)
	a.Start()
	log.Printf("[API] AI agent spawned for room %s", roomID)
}

// ─────────────────────────────────────────────────────────────────────────────
// REST Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// GetRoomText returns the current plaintext of a room's CRDT document.
// Useful for debugging, seeding LLM context, and integration tests.
func (h *Handler) GetRoomText(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("roomId")
	if roomID == "" {
		http.Error(w, "roomId required", http.StatusBadRequest)
		return
	}
	doc := h.hub.GetDocument(roomID)
	if doc == nil {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	type Response struct {
		RoomID string `json:"roomId"`
		Text   string `json:"text"`
		Clock  int64  `json:"lamportClock"`
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(Response{
		RoomID: roomID,
		Text:   doc.GetText(),
		Clock:  doc.GetLamportClock(),
	})
}

// HealthCheck returns 200 OK — for load balancer probes and k8s liveness checks.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "collab-editor"})
}
