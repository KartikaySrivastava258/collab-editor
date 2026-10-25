// Package crdt implements an RGA (Replicated Growable Array) sequence CRDT
// for plain text. Unlike fractional float positions, RGA identifiers never
// run out of precision, so long typing runs and repeated inserts at the same
// spot stay correct (background in docs/DIAGNOSIS.md, issues R1-R3).
//
// Model (must stay identical to frontend/src/crdt/rga.ts; both are checked
// against testdata/vectors.json):
//   - Every character ("atom") has an immutable unique ID {C, T}: C is the
//     client ID (ASCII), T a Lamport counter.
//   - An insert names the atom it was typed after (its origin, nil = start).
//   - Deletes turn atoms into tombstones that stay in the sequence.
//   - Concurrent inserts after the same origin are ordered by descending ID;
//     integration skips atoms whose ID is greater than the new atom's ID.
//     This is correct because every insert has T > T(origin), which
//     ValidateOp enforces.
//   - One atom is one Unicode code point.
//
// Document is not safe for concurrent use; the hub serializes access per room.
package crdt

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxT is the largest accepted Lamport value (2^53-1) so IDs survive a round
// trip through JavaScript numbers unchanged.
const MaxT int64 = 1<<53 - 1

var clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ValidClientID reports whether s is an acceptable client/author ID.
func ValidClientID(s string) bool { return clientIDPattern.MatchString(s) }

// ID uniquely identifies an atom.
type ID struct {
	C string `json:"c"`
	T int64  `json:"t"`
}

func (id ID) String() string { return id.C + ":" + strconv.FormatInt(id.T, 10) }

// Op is a single insert ("i") or delete ("d") operation in wire format.
// O is always encoded (null for start-of-document and for deletes) because
// the TypeScript validator requires the field on inserts.
type Op struct {
	K  string `json:"k"`
	ID ID     `json:"id"`
	O  *ID    `json:"o"`
	V  string `json:"v,omitempty"`
}

// SnapshotAtom is one atom of a snapshot, in document order.
type SnapshotAtom struct {
	ID ID     `json:"id"`
	O  *ID    `json:"o"`
	V  string `json:"v"`
	D  bool   `json:"d,omitempty"`
}

// Status describes the outcome of Apply.
type Status int

const (
	// Applied means the document changed.
	Applied Status = iota
	// Duplicate means the op was already applied (idempotent no-op).
	Duplicate
	// Buffered means the op waits for a missing dependency.
	Buffered
)

// Error is a CRDT error with a stable machine-readable code.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Code + ": " + e.Msg }

func newErr(code, msg string) *Error { return &Error{Code: code, Msg: msg} }

// Limits bounds memory use. Zero means unlimited for MaxAtoms; MaxPending
// defaults to 100000 when zero.
type Limits struct {
	MaxAtoms   int
	MaxPending int
}

type atom struct {
	id      ID
	origin  *ID
	value   string
	deleted bool
}

// Document is a replica of one text document.
type Document struct {
	atoms           []*atom
	byID            map[ID]*atom
	pendingByOrigin map[ID][]Op
	pendingDeletes  map[ID]struct{}
	pendingCount    int
	visible         int
	hint            int
	clock           int64
	limits          Limits
}

// NewDocument returns an empty document.
func NewDocument(limits Limits) *Document {
	if limits.MaxPending <= 0 {
		limits.MaxPending = 100000
	}
	return &Document{
		byID:            make(map[ID]*atom),
		pendingByOrigin: make(map[ID][]Op),
		pendingDeletes:  make(map[ID]struct{}),
		limits:          limits,
	}
}

// IDGreater is the total order used for concurrent siblings.
func IDGreater(a, b ID) bool {
	if a.T != b.T {
		return a.T > b.T
	}
	return a.C > b.C
}

// ValidID reports whether id is well formed.
func ValidID(id ID) bool {
	return ValidClientID(id.C) && id.T >= 1 && id.T <= MaxT
}

// IsSingleCodePoint reports whether v is exactly one valid UTF-8 code point.
func IsSingleCodePoint(v string) bool {
	return v != "" && utf8.ValidString(v) && utf8.RuneCountInString(v) == 1
}

// ValidateOp checks an op's structure without consulting document state.
func ValidateOp(op Op) error {
	if !ValidID(op.ID) {
		return newErr("invalid_op", "invalid atom id")
	}
	switch op.K {
	case "d":
		return nil
	case "i":
		if op.O != nil {
			if !ValidID(*op.O) {
				return newErr("invalid_op", "invalid origin id")
			}
			if op.O.T >= op.ID.T {
				return newErr("invalid_op", "insert must have a higher counter than its origin")
			}
		}
		if !IsSingleCodePoint(op.V) {
			return newErr("invalid_op", "insert value must be exactly one code point")
		}
		return nil
	default:
		return newErr("invalid_op", "unknown op kind")
	}
}

// Lamport returns the highest counter observed.
func (d *Document) Lamport() int64 { return d.clock }

// Len returns the number of visible code points.
func (d *Document) Len() int { return d.visible }

// Size returns the number of stored atoms including tombstones.
func (d *Document) Size() int { return len(d.atoms) }

// Pending returns the number of ops waiting for a dependency.
func (d *Document) Pending() int { return d.pendingCount + len(d.pendingDeletes) }

// Has reports whether the atom exists (visible or tombstoned).
func (d *Document) Has(id ID) bool {
	_, ok := d.byID[id]
	return ok
}

// Get returns an atom's origin and value.
func (d *Document) Get(id ID) (origin *ID, value string, ok bool) {
	a, found := d.byID[id]
	if !found {
		return nil, "", false
	}
	return a.origin, a.value, true
}

func (d *Document) observe(t int64) {
	if t > d.clock {
		d.clock = t
	}
}

// Apply integrates an op from any replica. It is commutative and idempotent
// and buffers ops whose dependencies have not arrived yet.
func (d *Document) Apply(op Op) (Status, error) {
	if err := ValidateOp(op); err != nil {
		return Duplicate, err
	}
	if op.K == "d" {
		return d.applyDelete(op.ID)
	}
	return d.applyInsert(op)
}

func (d *Document) applyDelete(id ID) (Status, error) {
	a, ok := d.byID[id]
	if !ok {
		if _, waiting := d.pendingDeletes[id]; waiting {
			return Duplicate, nil
		}
		if err := d.checkPendingCapacity(); err != nil {
			return Duplicate, err
		}
		d.pendingDeletes[id] = struct{}{}
		return Buffered, nil
	}
	if a.deleted {
		return Duplicate, nil
	}
	a.deleted = true
	d.visible--
	return Applied, nil
}

func sameOrigin(a, b *ID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (d *Document) applyInsert(op Op) (Status, error) {
	if existing, ok := d.byID[op.ID]; ok {
		if existing.value != op.V || !sameOrigin(existing.origin, op.O) {
			return Duplicate, newErr("id_conflict", "atom "+op.ID.String()+" already exists with different content")
		}
		return Duplicate, nil
	}
	if op.O != nil {
		if _, ok := d.byID[*op.O]; !ok {
			list := d.pendingByOrigin[*op.O]
			for _, p := range list {
				if p.ID == op.ID {
					return Duplicate, nil
				}
			}
			if len(list) == 0 {
				if err := d.checkPendingCapacity(); err != nil {
					return Duplicate, err
				}
			}
			d.pendingByOrigin[*op.O] = append(list, op)
			d.pendingCount++
			return Buffered, nil
		}
	}
	stack := []Op{op}
	for len(stack) > 0 {
		next := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if err := d.integrate(next); err != nil {
			return Duplicate, err
		}
		if waiting, ok := d.pendingByOrigin[next.ID]; ok {
			delete(d.pendingByOrigin, next.ID)
			d.pendingCount -= len(waiting)
			for _, w := range waiting {
				if _, exists := d.byID[w.ID]; !exists {
					stack = append(stack, w)
				}
			}
		}
	}
	return Applied, nil
}

func (d *Document) checkPendingCapacity() error {
	if d.pendingCount+len(d.pendingDeletes) >= d.limits.MaxPending {
		return newErr("pending_overflow", "too many operations waiting for dependencies")
	}
	return nil
}

func cloneID(id *ID) *ID {
	if id == nil {
		return nil
	}
	c := *id
	return &c
}

func (d *Document) integrate(op Op) error {
	if d.limits.MaxAtoms > 0 && len(d.atoms) >= d.limits.MaxAtoms {
		return newErr("doc_too_large", fmt.Sprintf("document limit of %d atoms reached", d.limits.MaxAtoms))
	}
	i := 0
	if op.O != nil {
		idx := d.indexOf(*op.O)
		if idx < 0 {
			return newErr("internal", "origin vanished")
		}
		i = idx + 1
	}
	for i < len(d.atoms) && IDGreater(d.atoms[i].id, op.ID) {
		i++
	}
	a := &atom{id: op.ID, origin: cloneID(op.O), value: op.V}
	d.atoms = append(d.atoms, nil)
	copy(d.atoms[i+1:], d.atoms[i:])
	d.atoms[i] = a
	d.byID[op.ID] = a
	d.hint = i
	d.observe(op.ID.T)
	if _, ok := d.pendingDeletes[op.ID]; ok {
		delete(d.pendingDeletes, op.ID)
		a.deleted = true
	} else {
		d.visible++
	}
	return nil
}

// indexOf finds an atom's position, checking near the last insert first.
func (d *Document) indexOf(id ID) int {
	a, ok := d.byID[id]
	if !ok {
		return -1
	}
	h := d.hint
	n := len(d.atoms)
	if h < n && d.atoms[h] == a {
		return h
	}
	if h+1 < n && d.atoms[h+1] == a {
		return h + 1
	}
	if h > 0 && h-1 < n && d.atoms[h-1] == a {
		return h - 1
	}
	for i, x := range d.atoms {
		if x == a {
			return i
		}
	}
	return -1
}

// InsertText creates and applies inserts for text after atom `after`
// (nil = start). Invalid UTF-8 bytes become U+FFFD.
func (d *Document) InsertText(clientID string, after *ID, text string) ([]Op, error) {
	if !ValidClientID(clientID) {
		return nil, newErr("invalid_client", "bad client id")
	}
	if after != nil && !d.Has(*after) {
		return nil, newErr("unknown_origin", "insert anchor not found")
	}
	ops := make([]Op, 0, utf8.RuneCountInString(text))
	origin := cloneID(after)
	for _, r := range text {
		op := Op{K: "i", ID: ID{C: clientID, T: d.clock + 1}, O: origin, V: string(r)}
		if _, err := d.applyInsert(op); err != nil {
			return ops, err
		}
		ops = append(ops, op)
		next := op.ID
		origin = &next
	}
	return ops, nil
}

// DeleteIDs creates and applies deletes, skipping missing or deleted atoms.
func (d *Document) DeleteIDs(ids []ID) []Op {
	ops := make([]Op, 0, len(ids))
	for _, id := range ids {
		a, ok := d.byID[id]
		if !ok || a.deleted {
			continue
		}
		_, _ = d.applyDelete(id)
		ops = append(ops, Op{K: "d", ID: id})
	}
	return ops
}

// VisibleIDs returns the IDs of visible atoms in document order.
func (d *Document) VisibleIDs() []ID {
	ids := make([]ID, 0, d.visible)
	for _, a := range d.atoms {
		if !a.deleted {
			ids = append(ids, a.id)
		}
	}
	return ids
}

// Text returns the visible document text.
func (d *Document) Text() string {
	var b strings.Builder
	for _, a := range d.atoms {
		if !a.deleted {
			b.WriteString(a.value)
		}
	}
	return b.String()
}

// TailText returns at most the last maxRunes visible code points.
func (d *Document) TailText(maxRunes int) string {
	parts := make([]string, 0, maxRunes)
	for i := len(d.atoms) - 1; i >= 0 && len(parts) < maxRunes; i-- {
		if !d.atoms[i].deleted {
			parts = append(parts, d.atoms[i].value)
		}
	}
	var b strings.Builder
	for i := len(parts) - 1; i >= 0; i-- {
		b.WriteString(parts[i])
	}
	return b.String()
}

// Snapshot returns the full state in document order, tombstones included.
func (d *Document) Snapshot() []SnapshotAtom {
	out := make([]SnapshotAtom, len(d.atoms))
	for i, a := range d.atoms {
		out[i] = SnapshotAtom{ID: a.id, O: cloneID(a.origin), V: a.value, D: a.deleted}
	}
	return out
}

// MergeSnapshot integrates a snapshot produced by any replica.
func (d *Document) MergeSnapshot(snap []SnapshotAtom) (int, error) {
	changed := 0
	for _, s := range snap {
		st, err := d.Apply(Op{K: "i", ID: s.ID, O: s.O, V: s.V})
		if err != nil {
			return changed, err
		}
		if st == Applied {
			changed++
		}
		if s.D {
			st, err = d.Apply(Op{K: "d", ID: s.ID})
			if err != nil {
				return changed, err
			}
			if st == Applied {
				changed++
			}
		}
	}
	return changed, nil
}

// Fingerprint is a canonical encoding used to compare replicas; it matches
// RgaDocument.fingerprint() in TypeScript byte for byte.
func (d *Document) Fingerprint() string {
	var b strings.Builder
	for _, a := range d.atoms {
		b.WriteString(strconv.FormatInt(a.id.T, 10))
		b.WriteByte('.')
		b.WriteString(a.id.C)
		if a.deleted {
			b.WriteByte('x')
		}
		b.WriteByte('=')
		b.WriteString(a.value)
		b.WriteByte('|')
	}
	return b.String()
}
