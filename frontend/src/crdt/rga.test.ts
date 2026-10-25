import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RgaDocument, CrdtError, idGreater, isSingleCodePoint, validateOp, codePoints,
} from './rga.ts';
import type { Op, AtomId, InsertOp } from './rga.ts';
import { mulberry32, shuffle } from '../testing/random.ts';
import { insertAt, deleteRange, deliver, oracleText, runConvergence, ALPHABET } from '../testing/scenarios.ts';

// ── Regression tests for issues R1-R3 (docs/DIAGNOSIS.md) ─────────────────

test('R1 regression: 10k sequential chars then a mid-document insert lands at the exact index', () => {
  const d = new RgaDocument();
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(223).slice(0, 10_000);
  let last: AtomId | null = null;
  for (const ch of text) { last = d.insertText('alice', last, ch).at(-1)!.id; }
  assert.equal(d.text(), text);
  insertAt(d, 'alice', 70, '#');
  assert.equal(d.text(), text.slice(0, 70) + '#' + text.slice(70));
});

test('R1 regression: 20k inserts always at the front (worst case for fractional indices)', () => {
  const d = new RgaDocument();
  let expected = '';
  for (let i = 0; i < 20_000; i++) {
    const ch = String.fromCharCode(97 + (i % 26));
    d.insertText('a', null, ch);
    expected = ch + expected;
  }
  assert.equal(d.text(), expected);
});

test('R2 regression: concurrent same-position inserts, then each deletes its own char', () => {
  const a = new RgaDocument(), b = new RgaDocument();
  const oa = a.insertText('alice', null, 'A');
  const ob = b.insertText('bob', null, 'B');
  deliver(a, ob); deliver(b, oa);
  assert.equal(a.text(), b.text());
  const db = b.deleteIds([ob[0].id]);
  deliver(a, db);
  assert.equal(a.text(), 'A');
  assert.equal(b.text(), 'A');
  assert.equal(a.fingerprint(), b.fingerprint());
});

// ── Ordering semantics ─────────────────────────────────────────────────────

test('concurrent runs at the same position do not interleave and order deterministically', () => {
  const base = new RgaDocument();
  const seed = base.insertText('s', null, '[]');
  const a = new RgaDocument(), b = new RgaDocument();
  deliver(a, seed); deliver(b, seed);
  const oa = insertAt(a, 'alice', 1, 'abc');
  const ob = insertAt(b, 'bob', 1, 'xyz');
  const r1 = new RgaDocument(); deliver(r1, [...seed, ...oa, ...ob]);
  const r2 = new RgaDocument(); deliver(r2, [...seed, ...ob, ...oa]);
  deliver(a, ob); deliver(b, oa);
  const texts = new Set([a.text(), b.text(), r1.text(), r2.text()]);
  assert.equal(texts.size, 1, `diverged: ${[...texts].join(' | ')}`);
  assert.ok(['[abcxyz]', '[xyzabc]'].includes(a.text()), `interleaved: ${a.text()}`);
});

test('idGreater is a strict total order: t first, then client id', () => {
  assert.ok(idGreater({ c: 'a', t: 2 }, { c: 'z', t: 1 }));
  assert.ok(idGreater({ c: 'b', t: 1 }, { c: 'a', t: 1 }));
  assert.ok(!idGreater({ c: 'a', t: 1 }, { c: 'a', t: 1 }));
});

test('local insert lands immediately after its anchor even after remote activity', () => {
  const a = new RgaDocument(), b = new RgaDocument();
  const o1 = a.insertText('a', null, 'hello');
  deliver(b, o1);
  const o2 = insertAt(b, 'b', 5, ' world');
  deliver(a, o2);
  const o3 = insertAt(a, 'a', 5, ',');
  deliver(b, o3);
  assert.equal(a.text(), 'hello, world');
  assert.equal(b.text(), 'hello, world');
});

// ── Delivery anomalies ─────────────────────────────────────────────────────

test('duplicate delivery is idempotent', () => {
  const a = new RgaDocument();
  const ops: Op[] = [...a.insertText('a', null, 'abc')];
  ops.push(...deleteRange(a, 1, 1));
  const b = new RgaDocument();
  for (let i = 0; i < 3; i++) deliver(b, ops);
  assert.equal(b.text(), 'ac');
  assert.equal(b.fingerprint(), a.fingerprint());
  assert.equal(b.apply(ops[0]), 'duplicate');
  assert.equal(b.apply(ops[3]), 'duplicate');
});

test('out-of-order delivery: children before parents, delete before insert', () => {
  const a = new RgaDocument();
  const ops: Op[] = [...a.insertText('a', null, 'abcdef')];
  ops.push(...deleteRange(a, 2, 2));
  const b = new RgaDocument();
  const reversed = [...ops].reverse();
  assert.equal(b.apply(reversed[0]), 'buffered'); // a delete of an unknown atom
  deliver(b, reversed.slice(1));
  assert.equal(b.text(), 'abef');
  assert.equal(b.pending, 0);
  assert.equal(b.fingerprint(), a.fingerprint());
});

// ── Validation & limits ────────────────────────────────────────────────────

test('rejects causally invalid inserts (t must exceed origin t)', () => {
  assert.equal(validateOp({ k: 'i', id: { c: 'a', t: 1 }, o: { c: 'b', t: 1 }, v: 'x' }), false);
  assert.equal(validateOp({ k: 'i', id: { c: 'a', t: 2 }, o: { c: 'b', t: 1 }, v: 'x' }), true);
  const d = new RgaDocument();
  assert.throws(() => d.apply({ k: 'i', id: { c: 'a', t: 1 }, o: { c: 'b', t: 5 }, v: 'x' }), CrdtError);
});

test('rejects malformed ops', () => {
  const bad: unknown[] = [
    null, 42, {}, { k: 'x', id: { c: 'a', t: 1 } },
    { k: 'i', id: { c: 'a', t: 1 }, o: null, v: 'ab' },            // two code points
    { k: 'i', id: { c: 'a', t: 1 }, o: null, v: '' },
    { k: 'i', id: { c: 'a', t: 1 }, o: null, v: '\ud800' },        // lone surrogate
    { k: 'i', id: { c: 'a b', t: 1 }, o: null, v: 'x' },           // bad client id
    { k: 'i', id: { c: 'a', t: 0 }, o: null, v: 'x' },
    { k: 'i', id: { c: 'a', t: 1.5 }, o: null, v: 'x' },
    { k: 'i', id: { c: 'a', t: 2 ** 60 }, o: null, v: 'x' },        // beyond safe integer
    { k: 'd', id: { c: '', t: 1 } },
  ];
  for (const op of bad) assert.equal(validateOp(op), false, JSON.stringify(op));
  const d = new RgaDocument();
  for (const op of bad) assert.throws(() => d.apply(op as Op), CrdtError);
});

test('same ID with different content is a conflict, not silently accepted', () => {
  const d = new RgaDocument();
  d.apply({ k: 'i', id: { c: 'a', t: 1 }, o: null, v: 'x' });
  assert.throws(() => d.apply({ k: 'i', id: { c: 'a', t: 1 }, o: null, v: 'y' }), /already exists/);
});

test('document and pending-buffer limits are enforced', () => {
  const d = new RgaDocument({ maxAtoms: 5 });
  d.insertText('a', null, 'abcde');
  assert.throws(() => d.insertText('a', null, 'f'), (e: unknown) => e instanceof CrdtError && e.code === 'doc_too_large');
  const p = new RgaDocument({ maxPending: 2 });
  p.apply({ k: 'd', id: { c: 'x', t: 1 } });
  p.apply({ k: 'd', id: { c: 'x', t: 2 } });
  assert.throws(() => p.apply({ k: 'd', id: { c: 'x', t: 3 } }), (e: unknown) => e instanceof CrdtError && e.code === 'pending_overflow');
});

// ── Unicode ────────────────────────────────────────────────────────────────

test('Unicode: emoji, combining marks, ZWJ sequences, CJK round-trip and converge', () => {
  const samples = ['😀', 'e\u0301', '👩‍👩‍👧‍👦', '漢字', '🇮🇳', 'a\u0000b', 'Z̤͔ͧ'];
  for (const s of samples) {
    const a = new RgaDocument(), b = new RgaDocument();
    const ops = a.insertText('a', null, s);
    assert.equal(ops.length, [...s].length, `atoms are code points for ${JSON.stringify(s)}`);
    deliver(b, [...ops].reverse());
    assert.equal(a.text(), s);
    assert.equal(b.text(), s);
  }
});

test('Unicode: lone surrogates are replaced, never stored', () => {
  const d = new RgaDocument();
  d.insertText('a', null, 'x\ud83dy');
  assert.equal(d.text(), 'x\ufffdy');
  assert.deepEqual(codePoints('\ude00'), ['\ufffd']);
  assert.ok(isSingleCodePoint('😀'));
  assert.ok(!isSingleCodePoint('\ud83d'));
});

test('Unicode: concurrent inserts inside an emoji neighbourhood never split a code point', () => {
  const a = new RgaDocument(), b = new RgaDocument();
  const seed = a.insertText('a', null, '😀😀');
  deliver(b, seed);
  const oa = insertAt(a, 'a', 1, '🙂');
  const ob = insertAt(b, 'b', 1, 'é');
  deliver(a, ob); deliver(b, oa);
  assert.equal(a.text(), b.text());
  assert.equal([...a.text()].length, 4);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(a.text()));
});

// ── Snapshots / late join / offline merge ──────────────────────────────────

test('snapshot gives a late joiner identical state, including tombstones', () => {
  const a = new RgaDocument();
  insertAt(a, 'a', 0, 'hello world');
  deleteRange(a, 5, 6);
  const late = new RgaDocument();
  late.mergeSnapshot(a.snapshot());
  assert.equal(late.fingerprint(), a.fingerprint());
  assert.equal(late.lamport, a.lamport);
  // A concurrent op that targets a tombstoned origin still integrates on the late joiner.
  const b = new RgaDocument(); b.mergeSnapshot(a.snapshot());
  const tomb = a.snapshot().find(s => s.d)!;
  const op: InsertOp = { k: 'i', id: { c: 'b', t: b.lamport + 1 }, o: tomb.id, v: '!' };
  b.apply(op); late.apply(op); a.apply(op);
  assert.equal(late.text(), a.text());
});

test('offline edits on both sides merge via snapshot exchange', () => {
  const server = new RgaDocument();
  const seed = server.insertText('srv', null, 'shared');
  const client = new RgaDocument();
  deliver(client, seed);
  const offline = insertAt(client, 'c', 6, ' offline');          // made while disconnected
  const online = insertAt(server, 'o', 0, 'online ');            // made by someone else meanwhile
  client.mergeSnapshot(server.snapshot());                         // reconnect: welcome snapshot
  deliver(server, offline);                                         // client resends pending ops
  assert.equal(client.text(), 'online shared offline');
  assert.equal(server.fingerprint(), client.fingerprint());
  assert.ok(online.length > 0);
});

test('toOps rebuilds an identical document (used for server-restart recovery)', () => {
  const a = new RgaDocument();
  insertAt(a, 'a', 0, 'abc😀def');
  deleteRange(a, 2, 3);
  const b = new RgaDocument();
  deliver(b, a.toOps());
  assert.equal(b.fingerprint(), a.fingerprint());
});

// ── Randomized property tests ──────────────────────────────────────────────

test('randomized convergence: 1000 seeds x 4 replicas x 60 steps, random order + duplicates', () => {
  let ops = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const { docs, all } = runConvergence(seed, 4, 60);
    ops += all.length;
    const fp = docs[0].fingerprint();
    for (const d of docs) {
      assert.equal(d.fingerprint(), fp, `seed ${seed} diverged`);
      assert.equal(d.pending, 0, `seed ${seed} left buffered ops`);
    }
    assert.equal(docs[0].text(), oracleText(all), `seed ${seed} disagrees with oracle`);
    const inserted = all.filter(o => o.k === 'i').length;
    assert.equal(docs[0].size, inserted, `seed ${seed}: an insert was lost or duplicated`);
  }
  assert.ok(ops > 50_000, `generated ${ops} ops`);
});

test('single-writer intent: random edits match a plain-string model (500 seeds)', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const rnd = mulberry32(seed);
    const d = new RgaDocument();
    let model: string[] = [];
    for (let s = 0; s < 80; s++) {
      if (model.length && rnd() < 0.4) {
        const from = Math.floor(rnd() * model.length);
        const n = 1 + Math.floor(rnd() * 3);
        deleteRange(d, from, n);
        model.splice(from, n);
      } else {
        const pos = Math.floor(rnd() * (model.length + 1));
        const ch = ALPHABET[Math.floor(rnd() * ALPHABET.length)];
        insertAt(d, 'w', pos, ch);
        model.splice(pos, 0, ch);
      }
    }
    assert.equal(d.text(), model.join(''), `seed ${seed}`);
  }
});

test('shuffle helper is deterministic for a seed', () => {
  const a = shuffle([1, 2, 3, 4, 5], mulberry32(7));
  const b = shuffle([1, 2, 3, 4, 5], mulberry32(7));
  assert.deepEqual(a, b);
});
