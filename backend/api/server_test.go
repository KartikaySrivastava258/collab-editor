package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"collab-editor/ai"
	"collab-editor/crdt"
	"collab-editor/hub"
	"collab-editor/ws"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

type env struct {
	srv *httptest.Server
	hub *hub.Hub
}

func newEnv(t *testing.T, cfg hub.Config) *env {
	t.Helper()
	cfg.Logger = quiet
	h := hub.New(cfg)
	srv := httptest.NewServer(New(h, []string{"http://allowed.example"}, "", quiet))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.Shutdown(ctx)
		srv.Close()
	})
	return &env{srv: srv, hub: h}
}

type msg struct {
	Type      string              `json:"type"`
	Seq       int64               `json:"seq"`
	Code      string              `json:"code"`
	From      string              `json:"from"`
	Ops       []crdt.Op           `json:"ops"`
	Snapshot  []crdt.SnapshotAtom `json:"snapshot"`
	Peers     []hub.Peer          `json:"peers"`
	Epoch     string              `json:"epoch"`
	RequestID string              `json:"requestId"`
	Text      string              `json:"text"`
	Nonce     int64               `json:"nonce"`
	AI        struct {
		Enabled bool `json:"enabled"`
	} `json:"ai"`
	Limits hub.WireLimits `json:"limits"`
}

// tclient mirrors the browser client: local replica, outbox, acks.
type tclient struct {
	t      *testing.T
	id     string
	conn   *ws.Conn
	mu     sync.Mutex
	doc    *crdt.Document
	msgs   []msg
	peers  []hub.Peer
	acked  int64
	seq    int64
	outbox map[int64][]crdt.Op
	closed *ws.CloseError
	notify chan struct{}
}

func (e *env) dial(t *testing.T, room, id, origin string) *tclient {
	t.Helper()
	c := &tclient{t: t, id: id, doc: crdt.NewDocument(crdt.Limits{}), outbox: map[int64][]crdt.Op{}, notify: make(chan struct{}, 1)}
	c.connect(e, room, origin)
	c.waitFor("welcome", func() bool { return c.has("welcome") })
	return c
}

func (c *tclient) connect(e *env, room, origin string) {
	u := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/ws?roomId=" + url.QueryEscape(room) + "&clientId=" + url.QueryEscape(c.id) + "&name=" + url.QueryEscape("T-"+c.id)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := ws.Dial(ctx, u, origin, ws.Options{MaxMessageBytes: 64 << 20})
	if err != nil {
		c.t.Fatalf("dial %s: %v", c.id, err)
	}
	c.mu.Lock()
	c.conn = conn
	c.closed = nil
	c.msgs = nil
	c.mu.Unlock()
	go c.readLoop(conn)
	c.t.Cleanup(func() { conn.Close() })
}

func (c *tclient) readLoop(conn *ws.Conn) {
	for {
		_, data, err := conn.ReadMessage()
		c.mu.Lock()
		if err != nil {
			var ce *ws.CloseError
			if errors.As(err, &ce) {
				c.closed = ce
			} else {
				c.closed = &ws.CloseError{Code: -1, Text: err.Error()}
			}
			c.mu.Unlock()
			c.ping()
			return
		}
		var m msg
		if json.Unmarshal(data, &m) == nil {
			c.msgs = append(c.msgs, m)
			switch m.Type {
			case "welcome":
				if _, err := c.doc.MergeSnapshot(m.Snapshot); err != nil {
					c.t.Errorf("merge snapshot: %v", err)
				}
				c.peers = m.Peers
			case "ops":
				for _, op := range m.Ops {
					if _, err := c.doc.Apply(op); err != nil {
						c.t.Errorf("apply remote: %v", err)
					}
				}
			case "presence":
				c.peers = m.Peers
			case "ack":
				if m.Seq > c.acked {
					c.acked = m.Seq
				}
				for s := range c.outbox {
					if s <= m.Seq {
						delete(c.outbox, s)
					}
				}
			}
		}
		c.mu.Unlock()
		c.ping()
	}
}

func (c *tclient) ping() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *tclient) waitFor(what string, cond func() bool) {
	c.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		c.mu.Lock()
		ok := cond()
		c.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-c.notify:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			c.t.Fatalf("%s: timeout waiting for %s", c.id, what)
		}
	}
}

// has must be called with c.mu held (inside waitFor's cond).
func (c *tclient) has(typ string) bool {
	for _, m := range c.msgs {
		if m.Type == typ {
			return true
		}
	}
	return false
}

func (c *tclient) find(typ string) *msg {
	for i := len(c.msgs) - 1; i >= 0; i-- {
		if c.msgs[i].Type == typ {
			m := c.msgs[i]
			return &m
		}
	}
	return nil
}

func (c *tclient) send(v interface{}) {
	b, _ := json.Marshal(v)
	if err := c.conn.WriteText(b); err != nil {
		c.t.Fatalf("send: %v", err)
	}
}

func (c *tclient) sendOps(ops []crdt.Op, kind string) int64 {
	c.mu.Lock()
	c.seq++
	seq := c.seq
	if kind == "ops" {
		c.outbox[seq] = ops
	}
	conn := c.conn
	c.mu.Unlock()
	b, _ := json.Marshal(map[string]interface{}{"type": kind, "seq": seq, "ops": ops})
	_ = conn.WriteText(b)
	return seq
}

func (c *tclient) typeAt(pos int, text string) int64 {
	c.mu.Lock()
	var after *crdt.ID
	if pos > 0 {
		ids := c.doc.VisibleIDs()
		id := ids[pos-1]
		after = &id
	}
	ops, err := c.doc.InsertText(c.id, after, text)
	c.mu.Unlock()
	if err != nil {
		c.t.Fatal(err)
	}
	return c.sendOps(ops, "ops")
}

func (c *tclient) erase(from, n int) int64 {
	c.mu.Lock()
	ids := c.doc.VisibleIDs()
	if from+n > len(ids) {
		n = len(ids) - from
	}
	ops := c.doc.DeleteIDs(ids[from : from+n])
	c.mu.Unlock()
	return c.sendOps(ops, "ops")
}

func (c *tclient) waitAck(seq int64) { c.waitFor(fmt.Sprintf("ack %d", seq), func() bool { return c.acked >= seq }) }
func (c *tclient) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.doc.Text()
}
func (c *tclient) waitClosed() *ws.CloseError {
	c.waitFor("close", func() bool { return c.closed != nil })
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (e *env) waitConverged(t *testing.T, room string, clients ...*tclient) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		info, ok := e.hub.Room(room)
		all := ok
		for _, c := range clients {
			if c.text() != info.Text {
				all = false
			}
		}
		if all {
			return info.Text
		}
		if time.Now().After(deadline) {
			t.Fatalf("not converged: server=%q", info.Text)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// ── tests ──────────────────────────────────────────────────────────────────

func TestHealthReadyAndRoomText(t *testing.T) {
	e := newEnv(t, hub.Config{})
	for path, want := range map[string]int{"/health": 200, "/healthz": 200, "/readyz": 200, "/api/room/text?roomId=bad%20id": 400, "/api/room/text?roomId=missing": 404, "/nope": 404} {
		resp, err := http.Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%s: %d want %d", path, resp.StatusCode, want)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing security header", path)
		}
	}
}

func TestTwoClientCollaborationAndPresence(t *testing.T) {
	e := newEnv(t, hub.Config{})
	a := e.dial(t, "room1", "alice", "")
	b := e.dial(t, "room1", "bob", "http://allowed.example")
	a.waitFor("presence 2", func() bool { return len(a.peers) == 2 })
	a.waitAck(a.typeAt(0, "Hello"))
	b.waitFor("hello", func() bool { return b.doc.Text() == "Hello" })
	b.waitAck(b.typeAt(5, ", world"))
	if got := e.waitConverged(t, "room1", a, b); got != "Hello, world" {
		t.Fatalf("got %q", got)
	}
	a.mu.Lock()
	echoes := 0
	for _, m := range a.msgs {
		if m.Type == "ops" && m.From == "alice" {
			echoes++
		}
	}
	a.mu.Unlock()
	if echoes != 0 {
		t.Fatalf("sender received %d echoes of its own ops", echoes)
	}
	b.conn.Close()
	a.waitFor("presence 1", func() bool { return len(a.peers) == 1 })
}

func TestConcurrentEditsConverge(t *testing.T) {
	e := newEnv(t, hub.Config{})
	a := e.dial(t, "r", "alice", "")
	b := e.dial(t, "r", "bob", "")
	a.waitAck(a.typeAt(0, "[]"))
	b.waitFor("seed", func() bool { return b.doc.Text() == "[]" })
	sa := a.typeAt(1, "alpha")
	sb := b.typeAt(1, "bravo")
	a.waitAck(sa)
	b.waitAck(sb)
	got := e.waitConverged(t, "r", a, b)
	if got != "[alphabravo]" && got != "[bravoalpha]" {
		t.Fatalf("runs interleaved: %q", got)
	}
	// delete while the other inserts nearby
	a.waitAck(a.erase(1, 5))
	b.waitAck(b.typeAt(3, "XY"))
	e.waitConverged(t, "r", a, b)
	if a.doc.Fingerprint() != b.doc.Fingerprint() {
		t.Fatal("replicas differ")
	}
}

func TestManyClientsRandomEditsConverge(t *testing.T) {
	e := newEnv(t, hub.Config{})
	var clients []*tclient
	for i := 0; i < 4; i++ {
		clients = append(clients, e.dial(t, "rand", fmt.Sprintf("p%d", i), ""))
	}
	var wg sync.WaitGroup
	for i, c := range clients {
		wg.Add(1)
		go func(i int, c *tclient) {
			defer wg.Done()
			for step := 0; step < 150; step++ {
				c.mu.Lock()
				n := c.doc.Len()
				c.mu.Unlock()
				if n > 3 && (step+i)%4 == 0 {
					c.erase((step*7+i)%n, 1)
				} else {
					c.typeAt((step*13+i)%(n+1), string(rune('a'+i)))
				}
			}
		}(i, c)
	}
	wg.Wait()
	for _, c := range clients {
		c.waitAck(c.seq)
	}
	e.waitConverged(t, "rand", clients...)
	fp := clients[0].doc.Fingerprint()
	for _, c := range clients {
		if c.doc.Fingerprint() != fp {
			t.Fatalf("%s differs", c.id)
		}
	}
}

func TestLateJoinGetsTombstones(t *testing.T) {
	e := newEnv(t, hub.Config{})
	a := e.dial(t, "r", "alice", "")
	a.waitAck(a.typeAt(0, "hello world"))
	a.waitAck(a.erase(5, 6))
	late := e.dial(t, "r", "late", "")
	late.mu.Lock()
	defer late.mu.Unlock()
	w := late.find("welcome")
	tomb := 0
	for _, s := range w.Snapshot {
		if s.D {
			tomb++
		}
	}
	if late.doc.Text() != "hello" || tomb != 6 {
		t.Fatalf("late text %q tombstones %d", late.doc.Text(), tomb)
	}
}

func TestReconnectWithOfflineEdits(t *testing.T) {
	e := newEnv(t, hub.Config{})
	a := e.dial(t, "r", "alice", "")
	b := e.dial(t, "r", "bob", "")
	a.waitAck(a.typeAt(0, "shared"))
	b.waitFor("seed", func() bool { return b.doc.Text() == "shared" })
	a.conn.Close()
	b.waitFor("alice gone", func() bool { return len(b.peers) == 1 })
	a.typeAt(6, " (offline A)") // write fails silently; stays in outbox
	b.waitAck(b.typeAt(0, "[B] "))
	a.connect(e, "r", "")
	a.waitFor("welcome", func() bool { return a.has("welcome") })
	a.mu.Lock()
	pending := a.outbox
	a.mu.Unlock()
	for seq, ops := range pending {
		payload, _ := json.Marshal(map[string]interface{}{"type": "ops", "seq": seq, "ops": ops})
		_ = a.conn.WriteText(payload)
	}
	a.waitAck(a.seq)
	if got := e.waitConverged(t, "r", a, b); got != "[B] shared (offline A)" {
		t.Fatalf("got %q", got)
	}
}

func TestSameClientIDReplacesOldConnection(t *testing.T) {
	e := newEnv(t, hub.Config{})
	a1 := e.dial(t, "r", "same", "")
	_ = e.dial(t, "r", "same", "")
	if ce := a1.waitClosed(); ce.Code != hub.CloseReplaced {
		t.Fatalf("close code %d", ce.Code)
	}
}

func TestRejectsInvalidMessages(t *testing.T) {
	e := newEnv(t, hub.Config{MaxOpsPerMessage: 10})
	cases := []struct {
		name, payload, code string
	}{
		{"bad json", `{not json`, "bad_json"},
		{"unknown type", `{"type":"nope"}`, "bad_message"},
		{"missing seq", `{"type":"ops","ops":[{"k":"d","id":{"c":"x","t":1}}]}`, "bad_message"},
		{"two code points", `{"type":"ops","seq":1,"ops":[{"k":"i","id":{"c":"me","t":1},"o":null,"v":"ab"}]}`, "invalid_op"},
		{"missing origin field", `{"type":"ops","seq":1,"ops":[{"k":"i","id":{"c":"me","t":1},"v":"a"}]}`, "invalid_op"},
		{"foreign author", `{"type":"ops","seq":1,"ops":[{"k":"i","id":{"c":"impostor","t":1},"o":null,"v":"a"}]}`, "foreign_author"},
		{"unknown origin", `{"type":"ops","seq":1,"ops":[{"k":"i","id":{"c":"me","t":9},"o":{"c":"ghost","t":3},"v":"a"}]}`, "unknown_origin"},
		{"unknown target", `{"type":"ops","seq":1,"ops":[{"k":"d","id":{"c":"ghost","t":3}}]}`, "unknown_target"},
		{"too many ops", `{"type":"ops","seq":1,"ops":[` + strings.Repeat(`{"k":"d","id":{"c":"g","t":1}},`, 10) + `{"k":"d","id":{"c":"g","t":1}}]}`, "too_many_ops"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := e.dial(t, fmt.Sprintf("bad%d", i), "me", "")
			if err := c.conn.WriteText([]byte(tc.payload)); err != nil {
				t.Fatal(err)
			}
			ce := c.waitClosed()
			c.mu.Lock()
			em := c.find("error")
			c.mu.Unlock()
			if ce.Code != hub.CloseProtocolError || em == nil || em.Code != tc.code {
				t.Fatalf("close=%d error=%+v, want 4000/%s", ce.Code, em, tc.code)
			}
		})
	}
	t.Run("binary frame", func(t *testing.T) {
		c := e.dial(t, "badbin", "me", "")
		_ = c.conn.WriteBinary([]byte{1, 2, 3})
		if ce := c.waitClosed(); ce.Code != hub.CloseProtocolError {
			t.Fatalf("close %d", ce.Code)
		}
	})
	t.Run("oversized message", func(t *testing.T) {
		c := e.dial(t, "badbig", "me", "")
		_ = c.conn.WriteText([]byte(strings.Repeat("x", 300*1024)))
		if ce := c.waitClosed(); ce.Code != ws.CloseTooBig {
			t.Fatalf("close %d", ce.Code)
		}
	})
}

func TestUpgradeRejections(t *testing.T) {
	e := newEnv(t, hub.Config{})
	base := "ws" + strings.TrimPrefix(e.srv.URL, "http")
	try := func(path, origin string) int {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, resp, err := ws.Dial(ctx, base+path, origin, ws.Options{})
		if err == nil {
			return 101
		}
		if resp == nil {
			t.Fatalf("dial %s: %v", path, err)
		}
		return resp.StatusCode
	}
	if got := try("/ws?roomId=bad%20room&clientId=x", ""); got != 400 {
		t.Errorf("bad room: %d", got)
	}
	if got := try("/ws?roomId=r&clientId=", ""); got != 400 {
		t.Errorf("missing client: %d", got)
	}
	if got := try("/ws?roomId=r&clientId=x", "https://evil.example"); got != 403 {
		t.Errorf("bad origin: %d", got)
	}
	if got := try("/ws?roomId=r&clientId=x", "http://allowed.example"); got != 101 {
		t.Errorf("allowed origin: %d", got)
	}
}

func TestDocumentLimitRejectsBatch(t *testing.T) {
	e := newEnv(t, hub.Config{MaxDocAtoms: 5})
	c := e.dial(t, "small", "me", "")
	c.typeAt(0, "toolong")
	if ce := c.waitClosed(); ce.Code != hub.CloseProtocolError {
		t.Fatalf("close %d", ce.Code)
	}
	if info, _ := e.hub.Room("small"); info.Text != "" {
		t.Fatalf("partial batch applied: %q", info.Text)
	}
}

// A peer that stops reading must be evicted (queue overflow or write
// timeout) without stalling the room. ~11 MB of fan-out exceeds loopback
// socket buffers, so the stalled client's writer blocks and its queue fills.
func TestSlowConsumerIsDisconnectedWithoutBlockingRoom(t *testing.T) {
	e := newEnv(t, hub.Config{SendQueue: 4, WriteTimeout: time.Second, OpsPerSecond: 1e9, OpsBurst: 1e9})
	writer := e.dial(t, "slow", "writer", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stalled, _, err := ws.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+"/ws?roomId=slow&clientId=stalled", "", ws.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close() // never read from
	writer.waitFor("presence", func() bool { return len(writer.peers) == 2 })
	chunk := strings.Repeat("x", 1000)
	for i := 0; i < 150; i++ {
		writer.typeAt(0, chunk)
	}
	writer.waitAck(writer.seq) // the healthy client kept being served
	writer.waitFor("stalled client evicted", func() bool { return len(writer.peers) == 1 })
}

func TestGracefulShutdownClosesClientsWith1001(t *testing.T) {
	e := newEnv(t, hub.Config{})
	a := e.dial(t, "r", "alice", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.hub.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if ce := a.waitClosed(); ce.Code != ws.CloseGoingAway {
		t.Fatalf("close %d", ce.Code)
	}
	resp, err := http.Get(e.srv.URL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Fatalf("readyz during shutdown: %d", resp.StatusCode)
	}
}

// ── AI ─────────────────────────────────────────────────────────────────────

func fakeLLM(t *testing.T, handler http.HandlerFunc) *ai.Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return ai.New(srv.URL, "test-key", "test-model")
}

func aiReply(text string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Authorization") != "Bearer test-key" || body.Model != "test-model" {
			http.Error(w, "bad request", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"choices": []interface{}{map[string]interface{}{"message": map[string]string{"content": text}}}})
	}
}

func aiOutcome(t *testing.T, c *tclient, reqID string) *msg {
	t.Helper()
	var out *msg
	c.waitFor("ai outcome "+reqID, func() bool {
		for i := range c.msgs {
			m := c.msgs[i]
			if (m.Type == "ai_result" || m.Type == "ai_error") && m.RequestID == reqID {
				out = &m
				return true
			}
		}
		return false
	})
	return out
}

func TestAIDisabledDoesNotAffectEditing(t *testing.T) {
	e := newEnv(t, hub.Config{})
	c := e.dial(t, "r", "me", "")
	c.mu.Lock()
	enabled := c.find("welcome").AI.Enabled
	c.mu.Unlock()
	if enabled {
		t.Fatal("AI should be disabled")
	}
	c.send(map[string]string{"type": "ai_suggest", "requestId": "q1"})
	if m := aiOutcome(t, c, "q1"); m.Code != "disabled" {
		t.Fatalf("got %+v", m)
	}
	c.waitAck(c.typeAt(0, "still works"))
}

func TestAISuggestionSuccessIsPrivateToRequester(t *testing.T) {
	e := newEnv(t, hub.Config{AI: fakeLLM(t, aiReply("  and then it rained.  "))})
	a := e.dial(t, "r", "alice", "")
	b := e.dial(t, "r", "bob", "")
	a.waitAck(a.typeAt(0, "It was sunny"))
	a.send(map[string]string{"type": "ai_suggest", "requestId": "q1"})
	m := aiOutcome(t, a, "q1")
	if m.Type != "ai_result" || m.Text != "and then it rained." {
		t.Fatalf("got %+v", m)
	}
	time.Sleep(50 * time.Millisecond)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.has("ai_result") || b.doc.Text() != "It was sunny" {
		t.Fatal("suggestion leaked to other client or was inserted into the document")
	}
}

func TestAIErrorsTimeoutCancelBusyEmpty(t *testing.T) {
	release := make(chan struct{})
	var calls int32
	slow := fakeLLM(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	e := newEnv(t, hub.Config{AI: slow, AITimeout: 300 * time.Millisecond})
	defer close(release)
	c := e.dial(t, "r", "me", "")

	c.send(map[string]string{"type": "ai_suggest", "requestId": "empty"})
	if m := aiOutcome(t, c, "empty"); m.Code != "empty_document" {
		t.Fatalf("empty: %+v", m)
	}
	c.waitAck(c.typeAt(0, "Some text"))

	c.send(map[string]string{"type": "ai_suggest", "requestId": "t1"})
	c.send(map[string]string{"type": "ai_suggest", "requestId": "t2"})
	if m := aiOutcome(t, c, "t2"); m.Code != "busy" {
		t.Fatalf("busy: %+v", m)
	}
	if m := aiOutcome(t, c, "t1"); m.Code != "timeout" {
		t.Fatalf("timeout: %+v", m)
	}

	e2 := newEnv(t, hub.Config{AI: slow, AITimeout: 10 * time.Second})
	d := e2.dial(t, "r", "me", "")
	d.waitAck(d.typeAt(0, "Some text"))
	d.send(map[string]string{"type": "ai_suggest", "requestId": "c1"})
	d.waitFor("provider called", func() bool { return atomic.LoadInt32(&calls) >= 2 })
	d.send(map[string]string{"type": "ai_cancel", "requestId": "c1"})
	if m := aiOutcome(t, d, "c1"); m.Code != "cancelled" {
		t.Fatalf("cancel: %+v", m)
	}
}

func TestAIProviderFailures(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"rate_limited":   func(w http.ResponseWriter, r *http.Request) { http.Error(w, "slow down", 429) },
		"provider_auth":  func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", 401) },
		"provider_error": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"choices":[]}`)) },
		"empty_response": aiReply("   "),
	}
	for want, h := range cases {
		t.Run(want, func(t *testing.T) {
			e := newEnv(t, hub.Config{AI: fakeLLM(t, h)})
			c := e.dial(t, "r", "me", "")
			c.waitAck(c.typeAt(0, "context"))
			c.send(map[string]string{"type": "ai_suggest", "requestId": "q"})
			if m := aiOutcome(t, c, "q"); m.Type != "ai_error" || m.Code != want {
				t.Fatalf("got %+v", m)
			}
		})
	}
}

func TestSanitizeName(t *testing.T) {
	for in, want := range map[string]string{"": "Guest", "  Ada  ": "Ada", "a\x00b\nc": "abc", strings.Repeat("é", 40): strings.Repeat("é", 32)} {
		if got := SanitizeName(in); got != want {
			t.Errorf("SanitizeName(%q) = %q want %q", in, got, want)
		}
	}
}
