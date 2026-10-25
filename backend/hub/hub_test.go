package hub

import (
	"strings"
	"testing"
	"time"
)

func TestValidRoomID(t *testing.T) {
	for _, ok := range []string{"a", "doc-123_X", strings.Repeat("a", 64)} {
		if !ValidRoomID(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "has space", "slash/x", "ü", strings.Repeat("a", 65)} {
		if ValidRoomID(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestTokenBucketBackpressure(t *testing.T) {
	now := time.Now()
	b := tokenBucket{tokens: 10, rate: 100, burst: 10, last: now}
	if w := b.take(10, now); w != 0 {
		t.Fatalf("burst should be free, wait %v", w)
	}
	if w := b.take(5, now); w < 45*time.Millisecond || w > 55*time.Millisecond {
		t.Fatalf("expected ~50ms wait, got %v", w)
	}
	later := now.Add(time.Second)
	if w := b.take(1, later); w != 0 {
		t.Fatalf("refill failed, wait %v", w)
	}
}

func TestParseSeq(t *testing.T) {
	for raw, ok := range map[string]bool{"0": true, "42": true, "-1": false, "1.5": false, `"7"`: false, "9007199254740992": false, "": false} {
		if _, got := parseSeq([]byte(raw)); got != ok {
			t.Errorf("parseSeq(%s) = %v, want %v", raw, got, ok)
		}
	}
}

func TestDefaultsAndAdmitCapacity(t *testing.T) {
	h := New(Config{MaxRooms: 1, MaxClientsPerRoom: 1})
	if h.Limits().MaxOpsPerMessage != 1000 || h.Limits().MaxMessageBytes != 256*1024 {
		t.Fatalf("defaults not applied: %+v", h.Limits())
	}
	if err := h.Admit("r1", "a"); err != nil {
		t.Fatal(err)
	}
	if !h.Ready() {
		t.Fatal("hub should be ready")
	}
}
