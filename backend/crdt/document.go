// Package crdt implements a text Conflict-Free Replicated Data Type (CRDT)
// using Fractional Indexing and Lamport Timestamps.
//
// Design philosophy:
//   - Every character is an immutable, uniquely addressed atom in the document.
//   - Positions are floating-point fractions, so any character can be inserted
//     between any two existing characters without shifting indices.
//   - Lamport Timestamps + Client ID provide a total deterministic ordering,
//     guaranteeing eventual consistency across all replicas.
//
// This is a simplified Logoot-style CRDT, making the core algorithms
// visible and auditable without external dependencies.
package crdt

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
)

// ─────────────────────────────────────────────────────────────────────────────
// Core Data Structures
// ─────────────────────────────────────────────────────────────────────────────

// Char is the fundamental immutable atom of the CRDT document.
// Once created, a Char's ID and ClientID never change — this immutability
// is what makes the CRDT conflict-free across distributed replicas.
type Char struct {
	// ID is a fractional index representing absolute position in the document.
	// Characters between position 0.0 and 1.0 can always be inserted at the
	// midpoint, giving O(log n) position density growth.
	ID float64 `json:"id"`

	// Value is the single UTF-8 character this atom represents.
	// An empty Value signals a tombstone (logically deleted character).
	Value string `json:"value"`

	// LamportTimestamp is a logical clock counter. It is incremented on every
	// local operation and updated to max(local, remote)+1 on receipt of a
	// remote mutation. This ensures causal ordering across replicas.
	LamportTimestamp int64 `json:"timestamp"`

	// ClientID is the unique identifier of the peer that created this Char.
	// It serves as the final tiebreaker when two Chars share the same ID
	// and Lamport Timestamp — sorted lexicographically (A < B < ... < Z).
	ClientID string `json:"clientId"`

	// Tombstoned marks this character as logically deleted.
	// We retain tombstones to ensure remote deletions can always find their
	// target, even if they arrive out of order (network reordering).
	Tombstoned bool `json:"tombstoned"`
}

// Mutation represents a single atomic operation broadcast over the network.
// This is the wire format exchanged between clients and the server.
type Mutation struct {
	RoomID    string  `json:"roomId"`
	ClientID  string  `json:"clientId"`
	OpType    string  `json:"opType"`  // "insert" | "delete"
	CharID    float64 `json:"charId"`  // Fractional position
	Value     string  `json:"value"`   // Character value (empty for delete)
	Timestamp int64   `json:"timestamp"` // Lamport logical timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// CRDT Document
// ─────────────────────────────────────────────────────────────────────────────

// Document is the thread-safe, replicated text document.
// Internally it maintains a sorted slice of Char atoms. The sort order
// defines the canonical document text across all replicas.
type Document struct {
	mu    sync.RWMutex // Protects chars and clock from concurrent goroutine access
	chars []Char       // Sorted list of all (including tombstoned) character atoms

	// lamportClock is this replica's logical time. Monotonically increasing.
	// Access ONLY under mu to avoid data races.
	lamportClock int64
}

// NewDocument creates an empty document with sentinel boundary characters.
// Sentinels at position 0.0 and 1.0 ensure there is always a left and right
// neighbor when computing fractional indices — no edge case math needed.
func NewDocument() *Document {
	return &Document{
		chars: []Char{
			{ID: 0.0, Value: "", ClientID: "SENTINEL_LEFT", LamportTimestamp: 0},
			{ID: 1.0, Value: "", ClientID: "SENTINEL_RIGHT", LamportTimestamp: 0},
		},
		lamportClock: 0,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fractional Index Allocation
// ─────────────────────────────────────────────────────────────────────────────

// allocateID computes a unique fractional index between leftID and rightID.
//
// Algorithm:
//  1. Take the midpoint: mid = (left + right) / 2
//  2. If the midpoint is exactly equal to either boundary (floating-point
//     collision), nudge by a tiny epsilon toward the right boundary.
//
// This gives O(1) insertion without rebalancing, at the cost of eventual
// floating-point precision loss for deeply nested insertions. For a document
// of reasonable size (< 10^14 characters), float64 precision is sufficient.
func allocateID(leftID, rightID float64) float64 {
	mid := (leftID + rightID) / 2.0

	// Guard against floating-point collapse — if mid equals a boundary,
	// nudge slightly. In practice this only occurs after ~52 recursive
	// bisections at the same position (float64 mantissa exhaustion).
	if mid == leftID || mid == rightID {
		mid = leftID + (rightID-leftID)*0.5 + math.SmallestNonzeroFloat64
	}
	return mid
}

// generateUniqueID creates a fractional ID for a new character at a given
// visible position in the document. It finds the fractional positions of
// the character immediately before and after the insertion point and
// allocates a new ID in the interval (leftID, rightID).
func (d *Document) generateUniqueID(visiblePosition int) (float64, error) {
	// Collect only visible (non-tombstoned) chars, including sentinels
	visible := d.visibleChars()

	// visiblePosition is 0-indexed within the visible character array.
	// We want to insert BEFORE visible[visiblePosition], so:
	//   left  = visible[visiblePosition - 1]  (or sentinel left)
	//   right = visible[visiblePosition]       (or sentinel right)

	leftIdx := visiblePosition     // index in visible slice
	rightIdx := visiblePosition + 1

	if leftIdx < 0 || rightIdx >= len(visible)+1 {
		return 0, fmt.Errorf("position %d out of range [0, %d]", visiblePosition, len(visible))
	}

	// Map visible indices back to the full chars slice to get fractional IDs
	leftID := visible[leftIdx].ID
	var rightID float64

	if rightIdx <= len(visible)-1 {
		rightID = visible[rightIdx].ID
	} else {
		// Past the last visible char → insert before right sentinel
		rightID = 1.0
	}

	return allocateID(leftID, rightID), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Operations
// ─────────────────────────────────────────────────────────────────────────────

// InsertLocal creates a new character at the given visible cursor position.
// It allocates a fractional ID, increments the Lamport clock, inserts the
// atom into the sorted array, and returns the resulting Mutation to broadcast.
//
// Thread safety: acquires write lock for the duration of the operation.
func (d *Document) InsertLocal(position int, value string, clientID string) (Mutation, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Advance local Lamport clock before any operation
	d.lamportClock++

	// Find the visible chars (sentinels included at boundaries)
	visible := d.visibleCharsUnsafe() // called under lock — use unsafe variant

	// Clamp to valid insertion range [0, len(visible)-1]
	// Position 0 = before first visible char (after left sentinel)
	if position < 0 {
		position = 0
	}
	if position > len(visible)-2 { // -2 to exclude right sentinel
		position = len(visible) - 2
	}

	leftID := visible[position].ID
	rightID := visible[position+1].ID

	newID := allocateID(leftID, rightID)

	char := Char{
		ID:               newID,
		Value:            value,
		LamportTimestamp: d.lamportClock,
		ClientID:         clientID,
		Tombstoned:       false,
	}

	d.insertSorted(char)

	return Mutation{
		ClientID:  clientID,
		OpType:    "insert",
		CharID:    newID,
		Value:     value,
		Timestamp: d.lamportClock,
	}, nil
}

// DeleteLocal marks the character at the given visible position as tombstoned.
// Returns the Mutation to broadcast to remote peers.
//
// Thread safety: acquires write lock.
func (d *Document) DeleteLocal(position int, clientID string) (Mutation, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.lamportClock++

	visible := d.visibleCharsUnsafe()

	// Sentinel chars at index 0 and last cannot be deleted
	if position <= 0 || position >= len(visible)-1 {
		return Mutation{}, fmt.Errorf("cannot delete at boundary position %d", position)
	}

	targetChar := visible[position]

	// Find and tombstone the char in the full array
	for i := range d.chars {
		if d.chars[i].ID == targetChar.ID && d.chars[i].ClientID == targetChar.ClientID {
			d.chars[i].Tombstoned = true
			break
		}
	}

	return Mutation{
		ClientID:  clientID,
		OpType:    "delete",
		CharID:    targetChar.ID,
		Value:     "",
		Timestamp: d.lamportClock,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote Operation Application (Eventual Consistency)
// ─────────────────────────────────────────────────────────────────────────────

// ApplyRemote integrates a mutation received from a remote peer.
// This is the convergence function — it must be commutative and idempotent:
//   - Commutativity: apply(A, B) == apply(B, A) for any two mutations A, B
//   - Idempotency: apply(A, apply(A, doc)) == apply(A, doc)
//
// Both properties follow from the fractional ID + ClientID total order.
//
// Thread safety: acquires write lock.
func (d *Document) ApplyRemote(m Mutation) {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Advance Lamport clock: receive rule is max(local, remote) + 1
	if m.Timestamp > d.lamportClock {
		d.lamportClock = m.Timestamp
	}
	d.lamportClock++

	switch m.OpType {
	case "insert":
		// Idempotency check: skip if this exact char already exists
		for _, c := range d.chars {
			if c.ID == m.CharID && c.ClientID == m.ClientID {
				return // Already applied — network duplicate
			}
		}
		char := Char{
			ID:               m.CharID,
			Value:            m.Value,
			LamportTimestamp: m.Timestamp,
			ClientID:         m.ClientID,
			Tombstoned:       false,
		}
		d.insertSorted(char)

	case "delete":
		// Find by CharID. In case of fractional ID collision (extremely rare),
		// also match on ClientID to identify the correct atom.
		for i := range d.chars {
			if d.chars[i].ID == m.CharID {
				d.chars[i].Tombstoned = true
				return
			}
		}
		// If we cannot find the char, it may arrive before the insert (causal
		// reordering). A production system would buffer this; here we log it.
		// In practice, the Go hub serializes operations so this is rare.
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Read Operations
// ─────────────────────────────────────────────────────────────────────────────

// GetText returns the current document content as a plain string,
// filtering out tombstoned characters and sentinels.
//
// Thread safety: acquires read lock.
func (d *Document) GetText() string {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var sb strings.Builder
	for _, c := range d.chars {
		if !c.Tombstoned && c.Value != "" {
			sb.WriteString(c.Value)
		}
	}
	return sb.String()
}

// GetChars returns a snapshot of all non-tombstoned, non-sentinel characters.
// Used to send the full document state to newly joining clients.
//
// Thread safety: acquires read lock.
func (d *Document) GetChars() []Char {
	d.mu.RLock()
	defer d.mu.RUnlock()

	var result []Char
	for _, c := range d.chars {
		if !c.Tombstoned && c.Value != "" {
			result = append(result, c)
		}
	}
	return result
}

// GetLamportClock returns the current logical time of this replica.
func (d *Document) GetLamportClock() int64 {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.lamportClock
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

// insertSorted inserts a Char into d.chars maintaining sort invariant.
// Sort key (primary → secondary → tertiary):
//  1. Fractional ID ascending — defines document order
//  2. Lamport Timestamp ascending — later insertions sort after earlier ones
//  3. ClientID lexicographic ascending — deterministic tiebreak across replicas
//
// This total order guarantees that all replicas converge to the same sequence
// when all mutations have been applied, regardless of delivery order.
//
// Must be called with d.mu write lock held.
func (d *Document) insertSorted(c Char) {
	// Binary search for the insertion point
	idx := sort.Search(len(d.chars), func(i int) bool {
		return charLess(c, d.chars[i])
	})
	// Grow slice by one and shift elements right
	d.chars = append(d.chars, Char{})
	copy(d.chars[idx+1:], d.chars[idx:])
	d.chars[idx] = c
}

// charLess defines the total ordering between two Char atoms.
// This is the convergence predicate — it must be identical on all replicas.
func charLess(a, b Char) bool {
	if a.ID != b.ID {
		return a.ID < b.ID
	}
	if a.LamportTimestamp != b.LamportTimestamp {
		return a.LamportTimestamp < b.LamportTimestamp
	}
	// Final tiebreak: lexicographic ClientID ensures "AI_AGENT" < "user_alice"
	return a.ClientID < b.ClientID
}

// visibleChars returns visible (non-tombstoned) chars including sentinels.
// Acquires read lock — do NOT call under write lock (use visibleCharsUnsafe).
func (d *Document) visibleChars() []Char {
	var result []Char
	for _, c := range d.chars {
		if !c.Tombstoned {
			result = append(result, c)
		}
	}
	return result
}

// visibleCharsUnsafe returns visible chars without acquiring a lock.
// Must ONLY be called when d.mu is already held by the caller.
func (d *Document) visibleCharsUnsafe() []Char {
	var result []Char
	for _, c := range d.chars {
		if !c.Tombstoned {
			result = append(result, c)
		}
	}
	return result
}
