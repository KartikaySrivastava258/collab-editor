package ws

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// echoServer upgrades every request and echoes text messages back.
func echoServer(t *testing.T, opts Options) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrade(w, r, opts)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			typ, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			if typ == TextMessage {
				if err := c.WriteText(msg); err != nil {
					return
				}
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func dial(t *testing.T, srv *httptest.Server) *Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/", "", Options{MaxMessageBytes: 1 << 22, ReadTimeout: 5 * time.Second})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func expectClose(t *testing.T, c *Conn, code int) {
	t.Helper()
	for {
		_, _, err := c.ReadMessage()
		if err == nil {
			continue
		}
		var ce *CloseError
		if !errors.As(err, &ce) {
			t.Fatalf("expected close %d, got error %v", code, err)
		}
		if ce.Code != code {
			t.Fatalf("expected close code %d, got %d (%s)", code, ce.Code, ce.Text)
		}
		return
	}
}

func TestEchoAllLengthEncodings(t *testing.T) {
	srv := echoServer(t, Options{MaxMessageBytes: 1 << 20, ReadTimeout: 5 * time.Second})
	c := dial(t, srv)
	for _, n := range []int{0, 10, 125, 126, 200, 65535, 65536, 70000} {
		want := bytes.Repeat([]byte("a"), n)
		if err := c.WriteText(want); err != nil {
			t.Fatal(err)
		}
		_, got, err := c.ReadMessage()
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("len %d: err=%v got %d bytes", n, err, len(got))
		}
	}
}

func TestRejectsUnmaskedClientFrame(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 1024}))
	if _, err := c.conn.Write([]byte{0x81, 0x01, 'a'}); err != nil { // FIN|text, unmasked
		t.Fatal(err)
	}
	expectClose(t, c, CloseProtocolError)
}

func TestRejectsOversizeMessage(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 1024}))
	if err := c.WriteText(bytes.Repeat([]byte("x"), 2000)); err != nil {
		t.Fatal(err)
	}
	expectClose(t, c, CloseTooBig)
}

// A client-supplied 64-bit length must be rejected from the header alone,
// before any buffer is allocated.
func TestRejectsHugeLengthHeaderBeforeAllocating(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 1024}))
	hdr := []byte{0x81, 0x80 | 127}
	var ext [8]byte
	binary.BigEndian.PutUint64(ext[:], 1<<62)
	hdr = append(hdr, ext[:]...)
	hdr = append(hdr, 1, 2, 3, 4) // mask key
	if _, err := c.conn.Write(hdr); err != nil {
		t.Fatal(err)
	}
	expectClose(t, c, CloseTooBig)
}

func TestCumulativeFragmentLimit(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 100}))
	chunk := bytes.Repeat([]byte("y"), 60)
	if err := c.WriteRawFrame(false, opText, chunk); err != nil {
		t.Fatal(err)
	}
	if err := c.WriteRawFrame(true, opContinuation, chunk); err != nil {
		t.Fatal(err)
	}
	expectClose(t, c, CloseTooBig)
}

func TestFragmentedMessageWithInterleavedPing(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 1024}))
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.WriteRawFrame(false, opText, []byte("hel")))
	must(c.WriteRawFrame(true, opPing, []byte("p")))
	must(c.WriteRawFrame(true, opContinuation, []byte("lo")))
	_, got, err := c.ReadMessage()
	if err != nil || string(got) != "hello" {
		t.Fatalf("got %q err %v", got, err)
	}
}

func TestProtocolViolations(t *testing.T) {
	cases := []struct {
		name string
		send func(c *Conn) error
		code int
	}{
		{"continuation without start", func(c *Conn) error { return c.WriteRawFrame(true, opContinuation, []byte("x")) }, CloseProtocolError},
		{"fragmented control frame", func(c *Conn) error { return c.WriteRawFrame(false, opPing, nil) }, CloseProtocolError},
		{"oversized control frame", func(c *Conn) error { return c.WriteRawFrame(true, opPing, bytes.Repeat([]byte("p"), 126)) }, CloseProtocolError},
		{"unknown opcode", func(c *Conn) error { return c.WriteRawFrame(true, 0x3, nil) }, CloseProtocolError},
		{"invalid utf-8 text", func(c *Conn) error { return c.WriteRawFrame(true, opText, []byte{0xff, 0xfe}) }, CloseInvalidPayload},
		{"new message during fragmentation", func(c *Conn) error {
			if err := c.WriteRawFrame(false, opText, []byte("a")); err != nil {
				return err
			}
			return c.WriteRawFrame(true, opText, []byte("b"))
		}, CloseProtocolError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := dial(t, echoServer(t, Options{MaxMessageBytes: 1024}))
			if err := tc.send(c); err != nil {
				t.Fatal(err)
			}
			expectClose(t, c, tc.code)
		})
	}
}

// Regression: pongs did not extend the read deadline, so idle-but-alive
// clients were dropped. Any frame must now count as activity.
func TestControlFramesKeepConnectionAlive(t *testing.T) {
	srv := echoServer(t, Options{MaxMessageBytes: 1024, ReadTimeout: 200 * time.Millisecond})
	c := dial(t, srv)
	for i := 0; i < 6; i++ {
		time.Sleep(100 * time.Millisecond)
		if err := c.WriteRawFrame(true, opPong, nil); err != nil {
			t.Fatalf("connection dropped after %d keepalives: %v", i, err)
		}
	}
	if err := c.WriteText([]byte("still here")); err != nil {
		t.Fatal(err)
	}
	if _, got, err := c.ReadMessage(); err != nil || string(got) != "still here" {
		t.Fatalf("got %q err %v", got, err)
	}
}

func TestPeerCloseIsEchoed(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 1024}))
	if err := c.WriteClose(CloseNormal, "bye"); err != nil {
		t.Fatal(err)
	}
	expectClose(t, c, CloseNormal)
	if err := c.WriteText([]byte("x")); !errors.Is(err, ErrCloseSent) {
		t.Fatalf("write after close: %v", err)
	}
}

func TestHandshakeRejections(t *testing.T) {
	srv := echoServer(t, Options{})
	do := func(method string, hdr map[string]string) int {
		req, _ := http.NewRequest(method, srv.URL, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	base := map[string]string{"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}
	clone := func(k, v string) map[string]string {
		m := map[string]string{}
		for a, b := range base {
			m[a] = b
		}
		if v == "" {
			delete(m, k)
		} else {
			m[k] = v
		}
		return m
	}
	if got := do(http.MethodPost, base); got != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", got)
	}
	if got := do(http.MethodGet, clone("Sec-WebSocket-Version", "8")); got != http.StatusUpgradeRequired {
		t.Errorf("version 8: %d", got)
	}
	if got := do(http.MethodGet, clone("Sec-WebSocket-Key", "")); got != http.StatusBadRequest {
		t.Errorf("missing key: %d", got)
	}
	if got := do(http.MethodGet, clone("Sec-WebSocket-Key", "short")); got != http.StatusBadRequest {
		t.Errorf("bad key: %d", got)
	}
	if got := do(http.MethodGet, clone("Upgrade", "")); got != http.StatusBadRequest {
		t.Errorf("missing upgrade: %d", got)
	}
}

func TestAcceptKeyMatchesRFCExample(t *testing.T) {
	// RFC 6455 §1.3 example.
	if got := computeAccept("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("accept = %s", got)
	}
}

// Run with -race: concurrent writers must not interleave frames.
func TestConcurrentWritersAreSerialized(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessageBytes: 1 << 20}))
	const writers, each = 8, 50
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				if err := c.WriteText(bytes.Repeat([]byte("z"), 300)); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	got := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		for got < writers*each {
			_, msg, err := c.ReadMessage()
			if err != nil || len(msg) != 300 {
				t.Errorf("frame %d corrupted: len=%d err=%v", got, len(msg), err)
				return
			}
			got++
		}
	}()
	wg.Wait()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("only %d echoes received", got)
	}
}
