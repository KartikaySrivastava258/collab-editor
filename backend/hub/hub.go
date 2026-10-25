// Package hub owns rooms, their in-memory CRDT documents and connected
// clients. It implements protocol v2 (docs/PROTOCOL.md); the TS test server
// in frontend/test-server implements the same semantics.
//
// Concurrency model (replaces the single broadcast goroutine, which mutated
// maps under read locks and could send on closed channels):
//   - Hub.mu guards the rooms map. Room.mu guards one room's document and
//     client set. Lock order is always Hub.mu -> Room.mu.
//   - Every state change and every resulting fan-out is enqueued while
//     holding Room.mu, so all clients observe one total order and a joining
//     client receives its welcome snapshot before any later operation.
//   - Each client has a bounded outbound queue drained by one writer
//     goroutine. A client whose queue is full is disconnected (4002) instead
//     of blocking the room; it resynchronizes from the snapshot on reconnect.
//   - Send channels are never closed; shutdown is signalled through `done`,
//     so no goroutine can send on a closed channel.
package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"collab-editor/crdt"
	"collab-editor/ws"
)

// Suggester produces AI continuations. Implemented by package ai.
type Suggester interface {
	Suggest(ctx context.Context, text string) (string, error)
}

// CodedError lets a Suggester report a stable error code to clients.
type CodedError interface {
	error
	ErrorCode() string
}

// Config configures a Hub. Zero values are replaced by defaults in New.
type Config struct {
	MaxDocAtoms       int
	MaxOpsPerMessage  int
	MaxMessageBytes   int64
	MaxRooms          int
	MaxClientsPerRoom int
	SendQueue         int
	PingInterval      time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	OpsPerSecond      float64
	OpsBurst          float64
	AI                Suggester
	AIDisabledReason  string
	AITimeout         time.Duration
	AIContextRunes    int
	Logger            *slog.Logger
}

func (c *Config) applyDefaults() {
	if c.MaxDocAtoms <= 0 {
		c.MaxDocAtoms = 200000
	}
	if c.MaxOpsPerMessage <= 0 {
		c.MaxOpsPerMessage = 1000
	}
	if c.MaxMessageBytes <= 0 {
		c.MaxMessageBytes = 256 * 1024
	}
	if c.MaxRooms <= 0 {
		c.MaxRooms = 100
	}
	if c.MaxClientsPerRoom <= 0 {
		c.MaxClientsPerRoom = 50
	}
	if c.SendQueue <= 0 {
		c.SendQueue = 256
	}
	if c.PingInterval <= 0 {
		c.PingInterval = 25 * time.Second
	}
	if c.ReadTimeout <= 0 {
		c.ReadTimeout = 60 * time.Second
	}
	if c.WriteTimeout <= 0 {
		c.WriteTimeout = 10 * time.Second
	}
	if c.OpsPerSecond <= 0 {
		c.OpsPerSecond = 10000
	}
	if c.OpsBurst <= 0 {
		c.OpsBurst = 50000
	}
	if c.AITimeout <= 0 {
		c.AITimeout = 20 * time.Second
	}
	if c.AIContextRunes <= 0 {
		c.AIContextRunes = 4000
	}
	if c.AIDisabledReason == "" {
		c.AIDisabledReason = "LLM_API_KEY / LLM_MODEL not configured on the server"
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
}

// Errors returned by Admit.
var (
	ErrShuttingDown = errors.New("server is shutting down")
	ErrServerFull   = errors.New("room or server capacity reached")
)

// Hub manages all rooms.
type Hub struct {
	cfg     Config
	log     *slog.Logger
	mu      sync.Mutex
	rooms   map[string]*Room
	closing bool
	wg      sync.WaitGroup
}

// Room is one shared document and its connected clients.
type Room struct {
	id         string
	epoch      string
	mu         sync.Mutex
	doc        *crdt.Document
	clients    map[string]*Client
	lastActive time.Time
}

// New creates a Hub.
func New(cfg Config) *Hub {
	cfg.applyDefaults()
	return &Hub{cfg: cfg, log: cfg.Logger, rooms: make(map[string]*Room)}
}

// Limits returns the limits advertised to clients.
func (h *Hub) Limits() WireLimits {
	return WireLimits{MaxDocAtoms: h.cfg.MaxDocAtoms, MaxOpsPerMessage: h.cfg.MaxOpsPerMessage, MaxMessageBytes: h.cfg.MaxMessageBytes}
}

// ConnOptions returns WebSocket options derived from the config.
func (h *Hub) ConnOptions() ws.Options {
	return ws.Options{MaxMessageBytes: h.cfg.MaxMessageBytes, ReadTimeout: h.cfg.ReadTimeout, WriteTimeout: h.cfg.WriteTimeout}
}

func newEpoch() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// roomLocked returns the room, creating it (and evicting an idle room if at
// capacity) when needed. Returns nil if every room is busy. Caller holds h.mu.
func (h *Hub) roomLocked(id string) *Room {
	if r, ok := h.rooms[id]; ok {
		return r
	}
	if len(h.rooms) >= h.cfg.MaxRooms {
		var victim *Room
		var victimLast time.Time
		for _, r := range h.rooms {
			r.mu.Lock()
			idle := len(r.clients) == 0
			last := r.lastActive
			r.mu.Unlock()
			if idle && (victim == nil || last.Before(victimLast)) {
				victim = r
				victimLast = last
			}
		}
		if victim == nil {
			return nil
		}
		delete(h.rooms, victim.id)
		h.log.Info("room_evicted", "room", victim.id)
	}
	r := &Room{
		id:         id,
		epoch:      newEpoch(),
		doc:        crdt.NewDocument(crdt.Limits{MaxAtoms: h.cfg.MaxDocAtoms}),
		clients:    make(map[string]*Client),
		lastActive: time.Now(),
	}
	h.rooms[id] = r
	return r
}

// Admit reports whether a connection could currently join; it is checked
// before the WebSocket upgrade so rejections are plain HTTP 503s.
func (h *Hub) Admit(roomID, clientID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return ErrShuttingDown
	}
	r, ok := h.rooms[roomID]
	if !ok {
		if len(h.rooms) < h.cfg.MaxRooms {
			return nil
		}
		for _, other := range h.rooms {
			other.mu.Lock()
			idle := len(other.clients) == 0
			other.mu.Unlock()
			if idle {
				return nil
			}
		}
		return ErrServerFull
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, existing := r.clients[clientID]; !existing && len(r.clients) >= h.cfg.MaxClientsPerRoom {
		return ErrServerFull
	}
	return nil
}

// RoomInfo is a read-only view used by the HTTP API.
type RoomInfo struct {
	Text    string
	Lamport int64
	Epoch   string
	Clients int
}

// Room returns information about a room, or false if it does not exist.
func (h *Hub) Room(id string) (RoomInfo, bool) {
	h.mu.Lock()
	r, ok := h.rooms[id]
	h.mu.Unlock()
	if !ok {
		return RoomInfo{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return RoomInfo{Text: r.doc.Text(), Lamport: r.doc.Lamport(), Epoch: r.epoch, Clients: len(r.clients)}, true
}

func peersLocked(r *Room) []Peer {
	peers := make([]Peer, 0, len(r.clients))
	for _, c := range r.clients {
		peers = append(peers, Peer{ID: c.id, Name: c.name})
	}
	return peers
}

func (r *Room) broadcastLocked(msg []byte, except *Client) {
	for _, c := range r.clients {
		if c != except {
			c.enqueue(msg)
		}
	}
}

// Serve runs a connection until it closes. It registers the client, queues
// the welcome snapshot, then runs the read loop in the calling goroutine.
func (h *Hub) Serve(conn *ws.Conn, roomID, clientID, name string) {
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		_ = conn.WriteClose(ws.CloseGoingAway, "server shutting down")
		_ = conn.Close()
		return
	}
	room := h.roomLocked(roomID)
	if room == nil {
		h.mu.Unlock()
		_ = conn.WriteClose(CloseServerFull, "server full")
		_ = conn.Close()
		return
	}
	room.mu.Lock()
	h.mu.Unlock()

	if _, existing := room.clients[clientID]; !existing && len(room.clients) >= h.cfg.MaxClientsPerRoom {
		room.mu.Unlock()
		_ = conn.WriteClose(CloseServerFull, "room full")
		_ = conn.Close()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		hub: h, room: room, id: clientID, name: name, conn: conn,
		send: make(chan []byte, h.cfg.SendQueue), done: make(chan struct{}),
		ctx: ctx, cancel: cancel,
		bucket: tokenBucket{tokens: h.cfg.OpsBurst, rate: h.cfg.OpsPerSecond, burst: h.cfg.OpsBurst, last: time.Now()},
	}
	if old, ok := room.clients[clientID]; ok {
		old.kick(CloseReplaced, "replaced by a newer connection")
	}
	room.clients[clientID] = c
	room.lastActive = time.Now()
	ai := aiStatus{Enabled: h.cfg.AI != nil}
	if !ai.Enabled {
		ai.Reason = h.cfg.AIDisabledReason
	}
	c.enqueue(mustJSON(welcomeMsg{
		Type: "welcome", Protocol: ProtocolVersion, RoomID: roomID, ClientID: clientID,
		Epoch: room.epoch, Snapshot: room.doc.Snapshot(), Peers: peersLocked(room),
		AI: ai, Limits: h.Limits(), Persistence: "memory",
	}))
	room.broadcastLocked(mustJSON(presenceMsg{Type: "presence", Peers: peersLocked(room)}), c)
	clients := len(room.clients)
	h.wg.Add(1)
	room.mu.Unlock()

	h.log.Info("join", "room", roomID, "client", clientID, "clients", clients)
	go func() {
		defer h.wg.Done()
		c.writeLoop()
	}()
	c.readLoop()
	h.leave(c)
}

func (h *Hub) leave(c *Client) {
	c.kick(ws.CloseNormal, "")
	c.cancel()
	r := c.room
	r.mu.Lock()
	remaining := len(r.clients)
	if r.clients[c.id] == c {
		delete(r.clients, c.id)
		r.lastActive = time.Now()
		remaining = len(r.clients)
		r.broadcastLocked(mustJSON(presenceMsg{Type: "presence", Peers: peersLocked(r)}), nil)
	}
	r.mu.Unlock()
	h.log.Info("leave", "room", r.id, "client", c.id, "clients", remaining)
}

// Shutdown stops admitting clients, closes every connection with 1001 and
// waits for connection goroutines (bounded by ctx).
func (h *Hub) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.closing = true
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()
	for _, r := range rooms {
		r.mu.Lock()
		for _, c := range r.clients {
			c.kick(ws.CloseGoingAway, "server shutting down")
		}
		r.mu.Unlock()
	}
	done := make(chan struct{})
	go func() {
		h.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Ready reports whether the hub accepts new connections.
func (h *Hub) Ready() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.closing
}

// ── Client ──────────────────────────────────────────────────────────────────

// Client is one WebSocket connection.
type Client struct {
	hub    *Hub
	room   *Room
	id     string
	name   string
	conn   *ws.Conn
	send   chan []byte
	done   chan struct{}
	ctx    context.Context
	cancel context.CancelFunc

	closeOnce   sync.Once
	closeCode   int
	closeReason string

	bucket tokenBucket

	aiMu     sync.Mutex
	aiReq    string
	aiCancel context.CancelFunc
}

// enqueue never blocks; a full queue disconnects the slow client.
func (c *Client) enqueue(msg []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.send <- msg:
	default:
		c.hub.log.Warn("slow_consumer", "room", c.room.id, "client", c.id)
		c.kick(CloseSlowConsumer, "slow consumer")
	}
}

// kick asks the writer to send a close frame and stop. Safe to call many
// times and from any goroutine; only the first call's code is used.
func (c *Client) kick(code int, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode = code
		c.closeReason = reason
		close(c.done)
	})
}

func (c *Client) writeLoop() {
	ticker := time.NewTicker(c.hub.cfg.PingInterval)
	defer ticker.Stop()
	defer c.conn.Close()
	for {
		select {
		case msg := <-c.send:
			if err := c.conn.WriteText(msg); err != nil {
				c.kick(ws.CloseNormal, "")
				return
			}
		case <-ticker.C:
			if err := c.conn.Ping(); err != nil {
				c.kick(ws.CloseNormal, "")
				return
			}
		case <-c.done:
			if c.closeCode != CloseSlowConsumer {
				// Flush queued messages, e.g. an error explaining the close.
			drain:
				for {
					select {
					case msg := <-c.send:
						if c.conn.WriteText(msg) != nil {
							break drain
						}
					default:
						break drain
					}
				}
			}
			_ = c.conn.WriteClose(c.closeCode, c.closeReason)
			return
		}
	}
}

func (c *Client) readLoop() {
	for {
		typ, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if typ != ws.TextMessage {
			c.fail("bad_message", "binary frames are not supported", nil)
			return
		}
		if !c.handle(data) {
			return
		}
	}
}

func (c *Client) fail(code, message string, seq *int64) {
	c.enqueue(mustJSON(errorMsg{Type: "error", Code: code, Message: message, Seq: seq}))
	c.kick(CloseProtocolError, code)
}

// handle processes one client message; false stops the read loop.
func (c *Client) handle(data []byte) bool {
	if !json.Valid(data) {
		c.fail("bad_json", "malformed JSON", nil)
		return false
	}
	var env clientEnvelope
	if err := json.Unmarshal(data, &env); err != nil || env.Type == nil {
		c.fail("bad_message", "missing type", nil)
		return false
	}
	switch *env.Type {
	case "ops", "sync":
		seq, ok := parseSeq(env.Seq)
		if !ok {
			c.fail("bad_message", "invalid seq", nil)
			return false
		}
		if len(env.Ops) == 0 {
			c.fail("bad_message", "ops must be a non-empty array", nil)
			return false
		}
		if len(env.Ops) > c.hub.cfg.MaxOpsPerMessage {
			c.fail("too_many_ops", "too many ops in one message", nil)
			return false
		}
		ops := make([]crdt.Op, len(env.Ops))
		for i, raw := range env.Ops {
			if err := json.Unmarshal(raw, &ops[i]); err != nil || crdt.ValidateOp(ops[i]) != nil || !hasOriginField(raw, ops[i].K) {
				c.fail("invalid_op", "invalid operation", nil)
				return false
			}
		}
		if !c.throttle(len(ops)) {
			return false
		}
		return c.applyBatch(*env.Type == "sync", seq, ops)
	case "ping":
		nonce, ok := parseSeq(env.Nonce)
		if !ok {
			c.fail("bad_message", "invalid nonce", nil)
			return false
		}
		c.enqueue(mustJSON(pongMsg{Type: "pong", Nonce: nonce}))
		return true
	case "ai_suggest", "ai_cancel":
		if env.RequestID == nil || !requestIDPattern.MatchString(*env.RequestID) {
			c.fail("bad_message", "invalid requestId", nil)
			return false
		}
		if *env.Type == "ai_suggest" {
			c.startAI(*env.RequestID)
		} else {
			c.cancelAI(*env.RequestID)
		}
		return true
	default:
		c.fail("bad_message", "unknown message type", nil)
		return false
	}
}

// hasOriginField enforces that inserts carry an explicit "o" (null or ID),
// matching the TypeScript validator.
func hasOriginField(raw json.RawMessage, kind string) bool {
	if kind != "i" {
		return true
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil {
		return false
	}
	_, ok := probe["o"]
	return ok
}

// checkBatchLocked validates a batch against room state without mutating it.
func (c *Client) checkBatchLocked(isSync bool, ops []crdt.Op) string {
	doc := c.room.doc
	fresh := make(map[crdt.ID]struct{})
	known := func(id crdt.ID) bool {
		if doc.Has(id) {
			return true
		}
		_, ok := fresh[id]
		return ok
	}
	for _, op := range ops {
		if op.K == "i" {
			if !isSync && op.ID.C != c.id {
				return "foreign_author"
			}
			if op.O != nil && !known(*op.O) {
				return "unknown_origin"
			}
			if !doc.Has(op.ID) {
				fresh[op.ID] = struct{}{}
			}
		} else if !known(op.ID) {
			return "unknown_target"
		}
	}
	if doc.Size()+len(fresh) > c.hub.cfg.MaxDocAtoms {
		return "doc_too_large"
	}
	return ""
}

func (c *Client) applyBatch(isSync bool, seq int64, ops []crdt.Op) bool {
	r := c.room
	r.mu.Lock()
	if problem := c.checkBatchLocked(isSync, ops); problem != "" {
		r.mu.Unlock()
		c.fail(problem, "operation batch rejected", &seq)
		return false
	}
	applied := make([]crdt.Op, 0, len(ops))
	for _, op := range ops {
		st, err := r.doc.Apply(op)
		if err != nil {
			r.mu.Unlock()
			code := "internal"
			var ce *crdt.Error
			if errors.As(err, &ce) {
				code = ce.Code
			}
			c.fail(code, "operation batch rejected", &seq)
			return false
		}
		if st == crdt.Applied {
			applied = append(applied, op)
		}
	}
	r.lastActive = time.Now()
	if len(applied) > 0 {
		r.broadcastLocked(mustJSON(opsMsg{Type: "ops", From: c.id, Ops: applied}), c)
	}
	c.enqueue(mustJSON(ackMsg{Type: "ack", Seq: seq}))
	r.mu.Unlock()
	return true
}

// throttle applies backpressure by pausing reads when a client exceeds its
// op rate. Returns false if the connection closed while waiting.
func (c *Client) throttle(n int) bool {
	wait := c.bucket.take(float64(n), time.Now())
	if wait <= 0 {
		return true
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-c.done:
		return false
	}
}

type tokenBucket struct {
	tokens, rate, burst float64
	last                time.Time
}

// take removes n tokens and returns how long the caller must wait first.
func (b *tokenBucket) take(n float64, now time.Time) time.Duration {
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	b.tokens -= n
	if b.tokens >= 0 {
		return 0
	}
	return time.Duration(-b.tokens / b.rate * float64(time.Second))
}

// ── AI suggestions ──────────────────────────────────────────────────────────

func (c *Client) aiError(requestID, code, message string) {
	c.enqueue(mustJSON(aiErrorMsg{Type: "ai_error", RequestID: requestID, Code: code, Message: message}))
}

func (c *Client) startAI(requestID string) {
	h := c.hub
	select {
	case <-c.done:
		return // connection closing; do not start new work
	default:
	}
	if h.cfg.AI == nil {
		c.aiError(requestID, "disabled", "AI is not configured on this server")
		return
	}
	c.aiMu.Lock()
	if c.aiReq != "" {
		c.aiMu.Unlock()
		c.aiError(requestID, "busy", "a suggestion is already in progress")
		return
	}
	c.room.mu.Lock()
	prompt := c.room.doc.TailText(h.cfg.AIContextRunes)
	c.room.mu.Unlock()
	if strings.TrimSpace(prompt) == "" {
		c.aiMu.Unlock()
		c.aiError(requestID, "empty_document", "write something first")
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, h.cfg.AITimeout)
	c.aiReq = requestID
	c.aiCancel = cancel
	c.aiMu.Unlock()

	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		defer cancel()
		text, err := h.cfg.AI.Suggest(ctx, prompt)
		c.aiMu.Lock()
		if c.aiReq == requestID {
			c.aiReq = ""
			c.aiCancel = nil
		}
		c.aiMu.Unlock()
		if err != nil {
			code := "provider_error"
			msg := "the AI provider returned an error"
			switch {
			case errors.Is(ctx.Err(), context.DeadlineExceeded):
				code, msg = "timeout", "the AI provider did not respond in time"
			case errors.Is(ctx.Err(), context.Canceled):
				code, msg = "cancelled", "the suggestion was cancelled"
			default:
				var coded CodedError
				if errors.As(err, &coded) {
					code = coded.ErrorCode()
					msg = coded.Error()
				}
			}
			h.log.Info("ai_error", "room", c.room.id, "code", code)
			c.aiError(requestID, code, msg)
			return
		}
		c.enqueue(mustJSON(aiResultMsg{Type: "ai_result", RequestID: requestID, Text: text}))
	}()
}

func (c *Client) cancelAI(requestID string) {
	c.aiMu.Lock()
	defer c.aiMu.Unlock()
	if c.aiReq == requestID && c.aiCancel != nil {
		c.aiCancel()
	}
}
