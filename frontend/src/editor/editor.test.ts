import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText, utf16ToCodePointIndex, codePointIndexToUtf16 } from './textDiff.ts';
import { EditHistory } from './history.ts';
import { RgaDocument } from '../crdt/rga.ts';
import type { Op } from '../crdt/rga.ts';
import { insertAt, deliver } from '../testing/scenarios.ts';
import { mulberry32 } from '../testing/random.ts';

function apply(before: string, e: ReturnType<typeof diffText>): string {
  if (!e) return before;
  return before.slice(0, e.start) + e.inserted + before.slice(e.start + e.removed);
}

test('diffText: typing, deleting, replacing a selection (issue U1)', () => {
  assert.deepEqual(diffText('hello', 'hellox', 6), { start: 5, removed: 0, inserted: 'x' });
  assert.deepEqual(diffText('hello', 'hell', 4), { start: 4, removed: 1, inserted: '' });
  assert.deepEqual(diffText('hello', 'X', 1), { start: 0, removed: 5, inserted: 'X' });
  assert.equal(diffText('same', 'same'), null);
});

test('diffText: caret disambiguates repeated characters', () => {
  assert.deepEqual(diffText('aa', 'aaa', 1), { start: 0, removed: 0, inserted: 'a' });
  assert.deepEqual(diffText('aa', 'aaa', 3), { start: 2, removed: 0, inserted: 'a' });
  assert.deepEqual(diffText('abab', 'ababab', 4), { start: 2, removed: 0, inserted: 'ab' });
});

test('diffText: paste and IME-style multi-character input (issue U2)', () => {
  assert.deepEqual(diffText('ab', 'aPASTEb', 6), { start: 1, removed: 0, inserted: 'PASTE' });
  assert.deepEqual(diffText('nihao', '你好', 2), { start: 0, removed: 5, inserted: '你好' });
});

test('diffText: never splits surrogate pairs (issue U3)', () => {
  // 😀 = D83D DE00, 😁 = D83D DE01 share the high surrogate.
  const e = diffText('a😀b', 'a😁b', 3)!;
  assert.deepEqual(e, { start: 1, removed: 2, inserted: '😁' });
  const e2 = diffText('😀', '😀😀', 4)!;
  assert.equal(e2.inserted, '😀');
  assert.equal(e2.start % 2, 0);
});

test('diffText: randomized edits always reproduce the target and keep pairs intact', () => {
  const rnd = mulberry32(99);
  const pool = ['a', 'b', ' ', '😀', '😁', 'é', '\n'];
  const rand = (n: number) => Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)]).join('');
  for (let i = 0; i < 5000; i++) {
    const before = rand(Math.floor(rnd() * 12));
    const cps = [...before];
    const s = Math.floor(rnd() * (cps.length + 1));
    const del = Math.floor(rnd() * (cps.length - s + 1));
    const ins = rand(Math.floor(rnd() * 4));
    const after = [...cps.slice(0, s), ins, ...cps.slice(s + del)].join('');
    const caret = cps.slice(0, s).join('').length + ins.length;
    const e = diffText(before, after, caret);
    assert.equal(apply(before, e), after, JSON.stringify({ before, after, e }));
    if (e) {
      assert.ok(!/[\ud800-\udbff]$/.test(before.slice(0, e.start)), 'split at start');
      assert.ok(!/^[\udc00-\udfff]/.test(before.slice(e.start + e.removed)), 'split at end');
    }
  }
});

test('utf16 <-> code point index mapping', () => {
  const t = 'a😀b';
  assert.equal(utf16ToCodePointIndex(t, 0), 0);
  assert.equal(utf16ToCodePointIndex(t, 1), 1);
  assert.equal(utf16ToCodePointIndex(t, 3), 2);
  assert.equal(utf16ToCodePointIndex(t, 4), 3);
  assert.equal(codePointIndexToUtf16([...t], 2), 3);
});

// ── history ────────────────────────────────────────────────────────────────

function typed(doc: RgaDocument, h: EditHistory, pos: number, text: string, now: number): Op[] {
  const { ids } = doc.visibleAtoms();
  const after = pos === 0 ? null : ids[pos - 1];
  const ops = doc.insertText('me', after, text);
  h.record(ops.map(o => o.id), [], after, now);
  return ops;
}

test('history: undo/redo typing merges consecutive keystrokes', () => {
  const doc = new RgaDocument(); const h = new EditHistory();
  'hello'.split('').forEach((ch, i) => typed(doc, h, i, ch, 1000 + i * 100));
  typed(doc, h, 5, '!', 5000); // after a pause: separate step
  assert.equal(doc.text(), 'hello!');
  h.undo(doc, 'me'); assert.equal(doc.text(), 'hello');
  h.undo(doc, 'me'); assert.equal(doc.text(), '');
  assert.equal(h.canUndo, false);
  h.redo(doc, 'me'); assert.equal(doc.text(), 'hello');
  h.redo(doc, 'me'); assert.equal(doc.text(), 'hello!');
});

test('history: undo of a deletion restores text in place', () => {
  const doc = new RgaDocument(); const h = new EditHistory();
  typed(doc, h, 0, 'abcdef', 0);
  const { ids } = doc.visibleAtoms();
  const del = doc.deleteIds(ids.slice(1, 4)); // remove "bcd"
  h.record([], del.map(o => o.id), null, 10_000);
  assert.equal(doc.text(), 'aef');
  const r = h.undo(doc, 'me')!;
  assert.equal(doc.text(), 'abcdef');
  assert.equal(doc.visibleCountThrough(r.caretAfter), 4);
});

test('history: undo only reverts own edits and converges with a collaborator', () => {
  const me = new RgaDocument(); const peer = new RgaDocument(); const h = new EditHistory();
  const mine = typed(me, h, 0, 'mine', 0);
  deliver(peer, mine);
  const theirs = insertAt(peer, 'peer', 4, ' theirs');
  deliver(me, theirs);
  const r = h.undo(me, 'me')!;
  deliver(peer, r.ops);
  assert.equal(me.text(), ' theirs');
  assert.equal(peer.text(), ' theirs');
  const r2 = h.redo(me, 'me')!;
  deliver(peer, r2.ops);
  assert.equal(me.text(), peer.text());
});

test('history: a new edit clears the redo stack', () => {
  const doc = new RgaDocument(); const h = new EditHistory();
  typed(doc, h, 0, 'a', 0);
  h.undo(doc, 'me');
  assert.equal(h.canRedo, true);
  typed(doc, h, 0, 'b', 5000);
  assert.equal(h.canRedo, false);
});

test('history: a sealed (programmatic) insertion is a separate undo step on both sides', () => {
  const doc = new RgaDocument(); const h = new EditHistory();
  typed(doc, h, 0, 'abc', 0);
  const { ids } = doc.visibleAtoms();
  const ai = doc.insertText('me', ids[2], 'XYZ');
  h.record(ai.map(o => o.id), [], ids[2], 100, false);
  typed(doc, h, 6, 'd', 200);
  assert.equal(doc.text(), 'abcXYZd');
  h.undo(doc, 'me'); assert.equal(doc.text(), 'abcXYZ');
  h.undo(doc, 'me'); assert.equal(doc.text(), 'abc');
  h.undo(doc, 'me'); assert.equal(doc.text(), '');
});
