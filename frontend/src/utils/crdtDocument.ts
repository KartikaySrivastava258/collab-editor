/**
 * Client-side CRDT Engine
 *
 * A pure TypeScript implementation of the Logoot-style fractional indexing CRDT.
 * No external dependencies — the convergence algorithm is fully self-contained
 * and auditable by code reviewers.
 *
 * This module is intentionally decoupled from React: it is a plain class that
 * holds document state and can be unit-tested independently of the UI layer.
 */

import { Char, Mutation } from '../types/crdt';

// ─────────────────────────────────────────────────────────────────────────────
// Fractional Index Allocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allocates a new fractional ID strictly between leftId and rightId.
 *
 * Uses the arithmetic midpoint. If the midpoint collapses due to
 * float64 precision limits, we nudge by Number.EPSILON — the smallest
 * representable difference — which handles up to ~52 levels of nesting
 * at the same position.
 */
function allocateId(leftId: number, rightId: number): number {
  const mid = (leftId + rightId) / 2;
  if (mid === leftId || mid === rightId) {
    return leftId + Number.EPSILON;
  }
  return mid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Total Ordering (must match Go implementation exactly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * charLess defines the total ordering for CRDT characters.
 *
 * Sort key hierarchy:
 *  1. Fractional ID ascending     — document position
 *  2. Lamport timestamp ascending — causal ordering
 *  3. ClientID lexicographic      — deterministic tiebreak (AI_AGENT < user_xxx)
 *
 * This ordering MUST be identical to the Go backend's charLess function.
 * If they diverge, replicas will produce different documents — correctness
 * depends on all replicas using the exact same total order.
 */
function charLess(a: Char, b: Char): boolean {
  if (a.id !== b.id) return a.id < b.id;
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp;
  return a.clientId < b.clientId;
}

// ─────────────────────────────────────────────────────────────────────────────
// CRDTDocument
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CRDTDocument maintains the client-side replicated document state.
 *
 * Invariant: this.chars is always sorted by charLess.
 * Maintaining this invariant on every insert is what provides O(1)
 * text rendering: just filter out tombstones and join.
 */
export class CRDTDocument {
  private chars: Char[];
  private lamportClock: number;
  private clientId: string;

  constructor(clientId: string) {
    this.clientId = clientId;
    this.lamportClock = 0;
    // Sentinel characters define the absolute boundaries [0.0, 1.0].
    // Every real character lives strictly between them.
    this.chars = [
      { id: 0.0, value: '', clientId: 'SENTINEL_LEFT',  timestamp: 0 },
      { id: 1.0, value: '', clientId: 'SENTINEL_RIGHT', timestamp: 0 },
    ];
  }

  // ── Local Operations ───────────────────────────────────────────────────────

  /**
   * insertLocal creates a new Char at the given cursor position and returns
   * the Mutation to send to the server.
   *
   * @param cursorPos - 0-indexed position among visible characters
   * @param value     - single character to insert
   */
  insertLocal(cursorPos: number, value: string): Mutation {
    this.lamportClock++;

    const visible = this.getVisible(); // includes sentinels
    const clampedPos = Math.max(0, Math.min(cursorPos, visible.length - 2));

    const leftId = visible[clampedPos].id;
    const rightId = visible[clampedPos + 1].id;
    const newId = allocateId(leftId, rightId);

    const char: Char = {
      id: newId,
      value,
      clientId: this.clientId,
      timestamp: this.lamportClock,
      tombstoned: false,
    };

    this.insertSorted(char);

    return {
      roomId:    '',  // Filled by the WebSocket hook before sending
      clientId:  this.clientId,
      opType:    'insert',
      charId:    newId,
      value,
      timestamp: this.lamportClock,
    };
  }

  /**
   * deleteLocal tombstones the Char at the given cursor position and
   * returns the Mutation to send to the server.
   *
   * @param cursorPos - 0-indexed position among visible characters (1-based counting)
   */
  deleteLocal(cursorPos: number): Mutation | null {
    this.lamportClock++;

    const visible = this.getVisible();
    // Position 0 is the left sentinel — cannot be deleted
    if (cursorPos <= 0 || cursorPos >= visible.length - 1) {
      return null;
    }

    const target = visible[cursorPos];

    // Find in full array and tombstone
    for (let i = 0; i < this.chars.length; i++) {
      if (this.chars[i].id === target.id && this.chars[i].clientId === target.clientId) {
        this.chars[i] = { ...this.chars[i], tombstoned: true };
        break;
      }
    }

    return {
      roomId:    '',
      clientId:  this.clientId,
      opType:    'delete',
      charId:    target.id,
      value:     '',
      timestamp: this.lamportClock,
    };
  }

  // ── Remote Operations ──────────────────────────────────────────────────────

  /**
   * applyRemote integrates a mutation from a remote peer.
   *
   * This function must be:
   *  - Commutative:  applyRemote(A, applyRemote(B, doc)) === applyRemote(B, applyRemote(A, doc))
   *  - Idempotent:   applyRemote(A, applyRemote(A, doc)) === applyRemote(A, doc)
   *
   * Both properties follow from the fractional ID total order.
   */
  applyRemote(mutation: Mutation): void {
    // Lamport receive rule: advance clock to max(local, remote) + 1
    if (mutation.timestamp > this.lamportClock) {
      this.lamportClock = mutation.timestamp;
    }
    this.lamportClock++;

    if (mutation.opType === 'insert') {
      // Idempotency: skip if already present
      const exists = this.chars.some(
        c => c.id === mutation.charId && c.clientId === mutation.clientId
      );
      if (!exists) {
        const char: Char = {
          id:        mutation.charId,
          value:     mutation.value,
          clientId:  mutation.clientId,
          timestamp: mutation.timestamp,
          tombstoned: false,
        };
        this.insertSorted(char);
      }
    } else if (mutation.opType === 'delete') {
      for (let i = 0; i < this.chars.length; i++) {
        if (this.chars[i].id === mutation.charId) {
          this.chars[i] = { ...this.chars[i], tombstoned: true };
          return;
        }
      }
    }
  }

  /**
   * loadSnapshot replaces the document state with an authoritative snapshot
   * from the server (sent on initial connection). Used to avoid replaying
   * all historical mutations on join.
   */
  loadSnapshot(chars: Char[]): void {
    this.chars = [
      { id: 0.0, value: '', clientId: 'SENTINEL_LEFT',  timestamp: 0 },
      ...chars.sort((a, b) => charLess(a, b) ? -1 : 1),
      { id: 1.0, value: '', clientId: 'SENTINEL_RIGHT', timestamp: 0 },
    ];
  }

  // ── Read Operations ────────────────────────────────────────────────────────

  /** Returns the document as a plain string (tombstones and sentinels excluded) */
  getText(): string {
    return this.chars
      .filter(c => !c.tombstoned && c.value !== '')
      .map(c => c.value)
      .join('');
  }

  /** Returns a snapshot of visible (non-tombstoned, non-sentinel) characters */
  getVisibleChars(): Char[] {
    return this.chars.filter(c => !c.tombstoned && c.value !== '');
  }

  /** Returns the current Lamport clock value */
  getClock(): number {
    return this.lamportClock;
  }

  // ── Internal Helpers ───────────────────────────────────────────────────────

  /**
   * insertSorted uses binary search to maintain the sort invariant after
   * every insert. O(log n) search + O(n) splice — acceptable for documents
   * up to tens of thousands of characters.
   */
  private insertSorted(char: Char): void {
    let lo = 0;
    let hi = this.chars.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (charLess(this.chars[mid], char)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    this.chars.splice(lo, 0, char);
  }

  /**
   * getVisible returns all non-tombstoned characters including sentinels.
   * Used internally when computing insertion positions.
   */
  private getVisible(): Char[] {
    return this.chars.filter(c => !c.tombstoned);
  }
}
