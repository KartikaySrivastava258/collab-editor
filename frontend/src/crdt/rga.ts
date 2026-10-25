/**
 * RGA (Replicated Growable Array) sequence CRDT for plain text.
 *
 * Why RGA and not fractional positions: float64 midpoints run out of
 * precision after ~55 inserts at the same spot, which produces duplicate
 * positions and divergent replicas (docs/DIAGNOSIS.md, issues R1-R3).
 *
 * Model
 *  - Every character ("atom") has an immutable, globally unique ID (c, t):
 *      c = client ID (ASCII, validated), t = Lamport counter (positive integer).
 *  - An insert names the atom it was typed after ("origin", or null = start).
 *  - Deletes mark atoms as tombstones; tombstones stay in the sequence so later
 *    operations that reference them still integrate deterministically.
 *  - Concurrent inserts after the same origin are ordered by descending ID
 *    (higher t first, then higher c). The integration scan skips atoms whose ID
 *    is greater than the new atom's ID. Correctness relies on the invariant
 *    t(insert) > t(origin), which `apply` enforces.
 *
 * Positions are Unicode code points: one atom = one code point, never a lone
 * surrogate. Grapheme clusters (e.g. ZWJ emoji) span several atoms.
 *
 * This file must stay behaviourally identical to backend/crdt/rga.go. Both are
 * checked against the shared vectors in backend/crdt/testdata/vectors.json.
 *
 * Only erasable TypeScript syntax is used so Node can run it without a build.
 */

export interface AtomId {
  /** Client ID that created the atom (ASCII, [A-Za-z0-9_-]{1,64}). */
  c: string;
  /** Lamport counter at creation; positive safe integer. */
  t: number;
}

export interface InsertOp {
  k: 'i';
  id: AtomId;
  /** Atom this one was inserted after; null = beginning of document. */
  o: AtomId | null;
  /** Exactly one Unicode code point. */
  v: string;
}

export interface DeleteOp {
  k: 'd';
  id: AtomId;
}

export type Op = InsertOp | DeleteOp;

/** Snapshot entry, listed in document order. `d: true` marks a tombstone. */
export interface SnapshotAtom {
  id: AtomId;
  o: AtomId | null;
  v: string;
  d?: boolean;
}

interface Atom {
  id: AtomId;
  o: AtomId | null;
  v: string;
  deleted: boolean;
}

export type ApplyStatus =
  | 'applied'      // changed the document
  | 'duplicate'    // already applied; no-op (idempotency)
  | 'buffered';    // waiting for a causal dependency (origin / delete target)

export class CrdtError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CrdtError';
  }
}

export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_T = Number.MAX_SAFE_INTEGER;

export function keyOf(id: AtomId): string {
  return id.c + ':' + id.t;
}

export function sameId(a: AtomId | null, b: AtomId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.t === b.t && a.c === b.c;
}

/** Total order on IDs. Must match Go's idGreater exactly (ASCII c only). */
export function idGreater(a: AtomId, b: AtomId): boolean {
  if (a.t !== b.t) return a.t > b.t;
  return a.c > b.c;
}

/** True if `v` is exactly one Unicode scalar value (no lone surrogates). */
export function isSingleCodePoint(v: string): boolean {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2) return false;
  const cp = v.codePointAt(0)!;
  if (cp >= 0xd800 && cp <= 0xdfff) return false; // lone surrogate
  return (cp > 0xffff ? 2 : 1) === v.length;
}

export function validateId(id: unknown): id is AtomId {
  if (typeof id !== 'object' || id === null) return false;
  const r = id as { c?: unknown; t?: unknown };
  return typeof r.c === 'string' && CLIENT_ID_RE.test(r.c) &&
    typeof r.t === 'number' && Number.isInteger(r.t) && r.t >= 1 && r.t <= MAX_T;
}

/** Structural validation of an op (does not consult document state). */
export function validateOp(op: unknown): op is Op {
  if (typeof op !== 'object' || op === null) return false;
  const r = op as { k?: unknown; id?: unknown; o?: unknown; v?: unknown };
  if (!validateId(r.id)) return false;
  if (r.k === 'd') return true;
  if (r.k !== 'i') return false;
  if (!(r.o === null || validateId(r.o))) return false;
  if (r.o !== null && (r.o as AtomId).t >= (r.id as AtomId).t) return false; // causality
  return typeof r.v === 'string' && isSingleCodePoint(r.v);
}

export interface RgaLimits {
  /** Max atoms (visible + tombstones). Infinity = unlimited. */
  maxAtoms: number;
  /** Max ops buffered while waiting for dependencies. */
  maxPending: number;
}

const DEFAULT_LIMITS: RgaLimits = { maxAtoms: Infinity, maxPending: 100_000 };

export class RgaDocument {
  private atoms: Atom[] = [];
  private byKey = new Map<string, Atom>();
  private pendingByOrigin = new Map<string, InsertOp[]>();
  private pendingDeletes = new Set<string>();
  private pendingCount = 0;
  private visible = 0;
  private hint = 0;
  private clock = 0;
  private limits: RgaLimits;

  constructor(limits: Partial<RgaLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Highest Lamport value observed (local or remote). */
  get lamport(): number { return this.clock; }
  /** Number of visible code points. */
  get length(): number { return this.visible; }
  /** Atoms stored including tombstones. */
  get size(): number { return this.atoms.length; }
  /** Ops waiting for a missing dependency. */
  get pending(): number { return this.pendingCount + this.pendingDeletes.size; }

  has(id: AtomId): boolean { return this.byKey.has(keyOf(id)); }

  isDeleted(id: AtomId): boolean {
    const a = this.byKey.get(keyOf(id));
    return a ? a.deleted : false;
  }

  valueOf(id: AtomId): string | undefined {
    return this.byKey.get(keyOf(id))?.v;
  }

  /** Raise the Lamport clock (e.g. after loading a snapshot). */
  observe(t: number): void {
    if (t > this.clock) this.clock = t;
  }

  // ── Applying operations ─────────────────────────────────────────────────

  /**
   * Integrate an operation from any replica (including our own echo).
   * Commutative, idempotent, and tolerant of out-of-order delivery: inserts
   * whose origin is unknown and deletes whose target is unknown are buffered.
   */
  apply(op: Op): ApplyStatus {
    if (!validateOp(op)) throw new CrdtError('invalid_op', 'malformed operation');
    if (op.k === 'd') return this.applyDelete(op.id);
    return this.applyInsert(op);
  }

  applyAll(ops: readonly Op[]): number {
    let changed = 0;
    for (const op of ops) if (this.apply(op) === 'applied') changed++;
    return changed;
  }

  private applyDelete(id: AtomId): ApplyStatus {
    const key = keyOf(id);
    const atom = this.byKey.get(key);
    if (!atom) {
      if (this.pendingDeletes.has(key)) return 'duplicate';
      this.checkPendingCapacity();
      this.pendingDeletes.add(key);
      return 'buffered';
    }
    if (atom.deleted) return 'duplicate';
    atom.deleted = true;
    this.visible--;
    return 'applied';
  }

  private applyInsert(op: InsertOp): ApplyStatus {
    const key = keyOf(op.id);
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.v !== op.v || !sameId(existing.o, op.o)) {
        throw new CrdtError('id_conflict', `atom ${key} already exists with different content`);
      }
      return 'duplicate';
    }
    if (op.o !== null && !this.byKey.has(keyOf(op.o))) {
      const ok = keyOf(op.o);
      const list = this.pendingByOrigin.get(ok);
      if (list) {
        if (list.some(p => sameId(p.id, op.id))) return 'duplicate';
        list.push(op);
      } else {
        this.checkPendingCapacity();
        this.pendingByOrigin.set(ok, [op]);
      }
      this.pendingCount++;
      return 'buffered';
    }
    // Integrate, then release anything that was waiting on this atom.
    const stack: InsertOp[] = [op];
    while (stack.length > 0) {
      const next = stack.pop()!;
      this.integrate(next);
      const waiting = this.pendingByOrigin.get(keyOf(next.id));
      if (waiting) {
        this.pendingByOrigin.delete(keyOf(next.id));
        this.pendingCount -= waiting.length;
        for (const w of waiting) if (!this.byKey.has(keyOf(w.id))) stack.push(w);
      }
    }
    return 'applied';
  }

  private checkPendingCapacity(): void {
    if (this.pendingCount + this.pendingDeletes.size >= this.limits.maxPending) {
      throw new CrdtError('pending_overflow', 'too many operations waiting for dependencies');
    }
  }

  private integrate(op: InsertOp): void {
    if (this.atoms.length >= this.limits.maxAtoms) {
      throw new CrdtError('doc_too_large', `document limit of ${this.limits.maxAtoms} atoms reached`);
    }
    let i = 0;
    if (op.o !== null) {
      const originIdx = this.indexOfKey(keyOf(op.o));
      if (originIdx < 0) throw new CrdtError('internal', 'origin vanished');
      i = originIdx + 1;
    }
    const atoms = this.atoms;
    while (i < atoms.length && idGreater(atoms[i].id, op.id)) i++;
    const atom: Atom = { id: op.id, o: op.o, v: op.v, deleted: false };
    atoms.splice(i, 0, atom);
    this.byKey.set(keyOf(op.id), atom);
    this.hint = i;
    this.observe(op.id.t);
    const key = keyOf(op.id);
    if (this.pendingDeletes.delete(key)) {
      atom.deleted = true;
    } else {
      this.visible++;
    }
  }

  /** Index of an atom in the full sequence; uses the last-insert hint first. */
  private indexOfKey(key: string): number {
    const atom = this.byKey.get(key);
    if (!atom) return -1;
    const h = this.hint;
    const atoms = this.atoms;
    if (atoms[h] === atom) return h;
    if (atoms[h + 1] === atom) return h + 1;
    if (h > 0 && atoms[h - 1] === atom) return h - 1;
    return atoms.indexOf(atom);
  }

  // ── Local editing helpers ───────────────────────────────────────────────

  /**
   * Create and apply inserts for `text` (any string; split into code points;
   * lone surrogates become U+FFFD) after atom `after` (null = start).
   */
  insertText(clientId: string, after: AtomId | null, text: string): InsertOp[] {
    if (!CLIENT_ID_RE.test(clientId)) throw new CrdtError('invalid_client', 'bad client id');
    if (after !== null && !this.has(after)) throw new CrdtError('unknown_origin', 'insert anchor not found');
    const ops: InsertOp[] = [];
    let origin = after;
    for (const v of codePoints(text)) {
      const op: InsertOp = { k: 'i', id: { c: clientId, t: this.clock + 1 }, o: origin, v };
      this.applyInsert(op);
      ops.push(op);
      origin = op.id;
    }
    return ops;
  }

  /** Create and apply deletes for the given atoms (already-deleted ones are skipped). */
  deleteIds(ids: readonly AtomId[]): DeleteOp[] {
    const ops: DeleteOp[] = [];
    for (const id of ids) {
      const atom = this.byKey.get(keyOf(id));
      if (!atom || atom.deleted) continue;
      const op: DeleteOp = { k: 'd', id };
      this.applyDelete(id);
      ops.push(op);
    }
    return ops;
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  text(): string {
    let s = '';
    for (const a of this.atoms) if (!a.deleted) s += a.v;
    return s;
  }

  /** Visible atoms in order: parallel arrays of IDs and values. */
  visibleAtoms(): { ids: AtomId[]; values: string[] } {
    const ids: AtomId[] = [];
    const values: string[] = [];
    for (const a of this.atoms) {
      if (!a.deleted) { ids.push(a.id); values.push(a.v); }
    }
    return { ids, values };
  }

  /**
   * Number of visible atoms at or before `id` in sequence order. Works for
   * tombstones too, which makes it a stable caret anchor: a caret placed
   * "after atom X" stays after X's position even if X is deleted remotely.
   * Returns 0 for null (document start) and -1 if unknown.
   */
  visibleCountThrough(id: AtomId | null): number {
    if (id === null) return 0;
    const idx = this.indexOfKey(keyOf(id));
    if (idx < 0) return -1;
    let n = 0;
    for (let i = 0; i <= idx; i++) if (!this.atoms[i].deleted) n++;
    return n;
  }

  /** Full state in document order, including tombstones (needed for merging). */
  snapshot(): SnapshotAtom[] {
    return this.atoms.map(a => (a.deleted
      ? { id: a.id, o: a.o, v: a.v, d: true }
      : { id: a.id, o: a.o, v: a.v }));
  }

  /** All operations needed to rebuild this document on an empty replica. */
  toOps(): Op[] {
    const ops: Op[] = [];
    for (const a of this.atoms) ops.push({ k: 'i', id: a.id, o: a.o, v: a.v });
    for (const a of this.atoms) if (a.deleted) ops.push({ k: 'd', id: a.id });
    return ops;
  }

  /**
   * Merge a snapshot (from the server or another replica) into this document.
   * Snapshot order is a valid causal order, so nothing is buffered. Returns
   * the number of changes.
   */
  mergeSnapshot(snap: readonly SnapshotAtom[]): number {
    let changed = 0;
    for (const s of snap) {
      if (this.apply({ k: 'i', id: s.id, o: s.o, v: s.v }) === 'applied') changed++;
      if (s.d && this.apply({ k: 'd', id: s.id }) === 'applied') changed++;
    }
    return changed;
  }

  /** Canonical string for convergence checks (order + tombstones + values). */
  fingerprint(): string {
    let s = '';
    for (const a of this.atoms) s += `${a.id.t}.${a.id.c}${a.deleted ? 'x' : ''}=${a.v}|`;
    return s;
  }
}

/** Split into code points; lone surrogates are replaced with U+FFFD. */
export function codePoints(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out.push(cp >= 0xd800 && cp <= 0xdfff ? '\uFFFD' : ch);
  }
  return out;
}
