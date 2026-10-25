package hub

import (
	"encoding/json"
	"regexp"

	"collab-editor/crdt"
)

// ProtocolVersion is the wire protocol version (docs/PROTOCOL.md).
const ProtocolVersion = 2

// Application close codes (mirrors frontend/src/protocol/messages.ts).
const (
	CloseProtocolError = 4000
	CloseReplaced      = 4001
	CloseSlowConsumer  = 4002
	CloseServerFull    = 4003
)

var (
	roomIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// ValidRoomID reports whether id is an acceptable room identifier.
func ValidRoomID(id string) bool { return roomIDPattern.MatchString(id) }

// Peer is a connected collaborator.
type Peer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// WireLimits are advertised to clients in the welcome message.
type WireLimits struct {
	MaxDocAtoms      int   `json:"maxDocAtoms"`
	MaxOpsPerMessage int   `json:"maxOpsPerMessage"`
	MaxMessageBytes  int64 `json:"maxMessageBytes"`
}

type aiStatus struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

type welcomeMsg struct {
	Type        string              `json:"type"`
	Protocol    int                 `json:"protocol"`
	RoomID      string              `json:"roomId"`
	ClientID    string              `json:"clientId"`
	Epoch       string              `json:"epoch"`
	Snapshot    []crdt.SnapshotAtom `json:"snapshot"`
	Peers       []Peer              `json:"peers"`
	AI          aiStatus            `json:"ai"`
	Limits      WireLimits          `json:"limits"`
	Persistence string              `json:"persistence"`
}

type opsMsg struct {
	Type string    `json:"type"`
	From string    `json:"from"`
	Ops  []crdt.Op `json:"ops"`
}

type ackMsg struct {
	Type string `json:"type"`
	Seq  int64  `json:"seq"`
}

type presenceMsg struct {
	Type  string `json:"type"`
	Peers []Peer `json:"peers"`
}

type errorMsg struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Seq     *int64 `json:"seq,omitempty"`
}

type pongMsg struct {
	Type  string `json:"type"`
	Nonce int64  `json:"nonce"`
}

type aiResultMsg struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
}

type aiErrorMsg struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// clientEnvelope is decoded first to dispatch on type; payload fields are
// kept raw so validation errors map to the same codes as the TS server.
type clientEnvelope struct {
	Type      *string           `json:"type"`
	Seq       json.RawMessage   `json:"seq"`
	Ops       []json.RawMessage `json:"ops"`
	Nonce     json.RawMessage   `json:"nonce"`
	RequestID *string           `json:"requestId"`
}

func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Only our own fixed message types are marshalled; failure is a bug.
		panic(err)
	}
	return b
}

// parseSeq accepts a JSON integer in [0, 2^53-1].
func parseSeq(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var v int64
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, false
	}
	return v, v >= 0 && v <= crdt.MaxT
}
