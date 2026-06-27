// Package crdt_test validates the correctness of the CRDT engine.
//
// Test categories:
//  1. Basic insert/delete operations
//  2. Concurrent insert convergence (the key correctness property)
//  3. Lamport timestamp advancement
//  4. Tombstone retention and idempotency
//  5. Race condition detection (run with -race flag)
package crdt

import (
	"fmt"
	"sync"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// Basic Operations
// ─────────────────────────────────────────────────────────────────────────────

func TestNewDocument_EmptyText(t *testing.T) {
	doc := NewDocument()
	if text := doc.GetText(); text != "" {
		t.Errorf("new document should be empty, got %q", text)
	}
}

func TestInsertLocal_SingleChar(t *testing.T) {
	doc := NewDocument()
	_, err := doc.InsertLocal(0, "H", "client1")
	if err != nil {
		t.Fatalf("InsertLocal failed: %v", err)
	}
	if text := doc.GetText(); text != "H" {
		t.Errorf("expected %q, got %q", "H", text)
	}
}

func TestInsertLocal_MultipleChars_SequentialTyping(t *testing.T) {
	doc := NewDocument()
	word := "Hello"
	for i, ch := range word {
		if _, err := doc.InsertLocal(i, string(ch), "client1"); err != nil {
			t.Fatalf("InsertLocal(%d, %q) failed: %v", i, string(ch), err)
		}
	}
	if got := doc.GetText(); got != word {
		t.Errorf("expected %q, got %q", word, got)
	}
}

func TestDeleteLocal_RemovesCorrectChar(t *testing.T) {
	doc := NewDocument()
	for i, ch := range "Hello" {
		doc.InsertLocal(i, string(ch), "client1")
	}

	// Delete 'e' at position 1 → "Hllo"
	if _, err := doc.DeleteLocal(2, "client1"); err != nil {
		t.Fatalf("DeleteLocal failed: %v", err)
	}
	if got := doc.GetText(); got != "Hllo" {
		t.Errorf("expected %q, got %q", "Hllo", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// CRDT Convergence (the critical property)
// ─────────────────────────────────────────────────────────────────────────────

// TestConvergence_ConcurrentInserts verifies that two replicas receiving the
// same mutations in different orders converge to the same document.
//
// Scenario:
//   - Replica A inserts "A" at position 0 (charId near 0.5)
//   - Replica B inserts "B" at position 0 (charId near 0.5, different clientID)
//   - Both replicas apply both mutations (in opposite order)
//   - Final text must be identical on both replicas
func TestConvergence_ConcurrentInserts(t *testing.T) {
	replicaA := NewDocument()
	replicaB := NewDocument()

	// Concurrent inserts at the same position
	mutA, _ := replicaA.InsertLocal(0, "A", "client_A")
	mutB, _ := replicaB.InsertLocal(0, "B", "client_B")

	// Cross-apply in different orders
	replicaA.ApplyRemote(mutB) // A already has A, now gets B
	replicaB.ApplyRemote(mutA) // B already has B, now gets A

	textA := replicaA.GetText()
	textB := replicaB.GetText()

	if textA != textB {
		t.Errorf("convergence failure: replicaA=%q, replicaB=%q", textA, textB)
	}

	// Both must have exactly 2 characters
	if len(textA) != 2 {
		t.Errorf("expected 2 characters, got %q (%d chars)", textA, len(textA))
	}

	t.Logf("Converged to: %q", textA)
}

// TestConvergence_ThreeWay verifies 3-replica convergence.
func TestConvergence_ThreeWay(t *testing.T) {
	docs := [3]*Document{NewDocument(), NewDocument(), NewDocument()}
	clientIDs := []string{"alice", "bob", "AI_AGENT"}

	// Each client inserts one character concurrently
	mutations := make([]Mutation, 3)
	for i, doc := range docs {
		m, err := doc.InsertLocal(0, fmt.Sprintf("%d", i), clientIDs[i])
		if err != nil {
			t.Fatalf("InsertLocal failed for client %s: %v", clientIDs[i], err)
		}
		mutations[i] = m
	}

	// All replicas apply all mutations from all other replicas
	for i, doc := range docs {
		for j, m := range mutations {
			if i != j {
				doc.ApplyRemote(m)
			}
		}
	}

	// All three must converge to the same text
	texts := [3]string{docs[0].GetText(), docs[1].GetText(), docs[2].GetText()}
	for i := 1; i < 3; i++ {
		if texts[i] != texts[0] {
			t.Errorf("3-way convergence failure: doc0=%q, doc%d=%q", texts[0], i, texts[i])
		}
	}

	t.Logf("3-way converged to: %q", texts[0])
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

// TestIdempotency_DuplicateMutation verifies that applying the same mutation
// twice produces the same result as applying it once (network deduplication).
func TestIdempotency_DuplicateMutation(t *testing.T) {
	docA := NewDocument()
	docB := NewDocument()

	mut, _ := docA.InsertLocal(0, "X", "sender")

	docB.ApplyRemote(mut)
	docB.ApplyRemote(mut) // Apply again — should be a no-op

	if got := docB.GetText(); got != "X" {
		t.Errorf("idempotency failure: expected %q, got %q", "X", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Lamport Clock
// ─────────────────────────────────────────────────────────────────────────────

func TestLamportClock_AdvancesOnLocalOp(t *testing.T) {
	doc := NewDocument()
	clockBefore := doc.GetLamportClock()
	doc.InsertLocal(0, "a", "client1")
	clockAfter := doc.GetLamportClock()

	if clockAfter <= clockBefore {
		t.Errorf("clock should increase after local insert: before=%d, after=%d",
			clockBefore, clockAfter)
	}
}

func TestLamportClock_UpdatesOnRemoteHigherTimestamp(t *testing.T) {
	doc := NewDocument()

	// Inject a remote mutation with a very high timestamp
	remoteMut := Mutation{
		ClientID:  "remote",
		OpType:    "insert",
		CharID:    0.5,
		Value:     "R",
		Timestamp: 9999,
	}
	doc.ApplyRemote(remoteMut)

	// After apply: local clock should be at least 10000 (max(0, 9999) + 1)
	if clock := doc.GetLamportClock(); clock < 10000 {
		t.Errorf("clock should be >= 10000 after remote with ts=9999, got %d", clock)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Race Condition Detection (run with: go test -race ./...)
// ─────────────────────────────────────────────────────────────────────────────

// TestConcurrentAccess_NoDataRace confirms that concurrent reads and writes
// to the document do not cause data races. The Go race detector (-race flag)
// will report any unsynchronized memory accesses.
func TestConcurrentAccess_NoDataRace(t *testing.T) {
	doc := NewDocument()
	var wg sync.WaitGroup
	const goroutines = 50

	// Concurrent writers
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			doc.InsertLocal(0, "x", fmt.Sprintf("client_%d", idx))
		}(i)
	}

	// Concurrent readers
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = doc.GetText()
		}()
	}

	wg.Wait()

	// All insertions should be present
	text := doc.GetText()
	if len(text) != goroutines {
		t.Errorf("expected %d chars, got %d: %q", goroutines, len(text), text)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fractional Index Allocation
// ─────────────────────────────────────────────────────────────────────────────

func TestAllocateID_StrictlyBetweenBounds(t *testing.T) {
	cases := []struct{ left, right float64 }{
		{0.0, 1.0},
		{0.0, 0.5},
		{0.5, 1.0},
		{0.25, 0.75},
		{0.499999, 0.5},
	}

	for _, tc := range cases {
		mid := allocateID(tc.left, tc.right)
		if mid <= tc.left || mid >= tc.right {
			t.Errorf("allocateID(%v, %v) = %v: not strictly between bounds", tc.left, tc.right, mid)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Full Scenario: Simulate a collaborative session
// ─────────────────────────────────────────────────────────────────────────────

// TestFullSession simulates Alice and Bob co-editing a document with an AI
// agent injecting mutations concurrently, then verifies convergence.
func TestFullSession_AliceBobAI(t *testing.T) {
	alice := NewDocument()
	bob := NewDocument()
	ai := NewDocument()

	// Alice types "Hello "
	aliceMuts := []Mutation{}
	for i, ch := range "Hello " {
		m, _ := alice.InsertLocal(i, string(ch), "alice")
		aliceMuts = append(aliceMuts, m)
	}

	// Bob types "World" concurrently
	bobMuts := []Mutation{}
	for i, ch := range "World" {
		m, _ := bob.InsertLocal(i, string(ch), "bob")
		bobMuts = append(bobMuts, m)
	}

	// AI types "!"
	aiMuts := []Mutation{}
	m, _ := ai.InsertLocal(0, "!", "AI_AGENT")
	aiMuts = append(aiMuts, m)

	// Cross-apply all mutations to all replicas
	for _, m := range append(bobMuts, aiMuts...) {
		alice.ApplyRemote(m)
	}
	for _, m := range append(aliceMuts, aiMuts...) {
		bob.ApplyRemote(m)
	}
	for _, m := range append(aliceMuts, bobMuts...) {
		ai.ApplyRemote(m)
	}

	textA, textB, textAI := alice.GetText(), bob.GetText(), ai.GetText()

	if textA != textB || textB != textAI {
		t.Errorf("session convergence failure:\n  alice=%q\n  bob=%q\n  ai=%q",
			textA, textB, textAI)
	}

	// All characters from all three peers must be present
	if len(textA) != len("Hello ")+len("World")+len("!") {
		t.Errorf("expected 12 chars, got %d: %q", len(textA), textA)
	}

	t.Logf("Full session converged to: %q", textA)
}
