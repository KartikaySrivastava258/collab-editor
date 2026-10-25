/**
 * Generates backend/crdt/testdata/vectors.json from the TypeScript CRDT.
 * The Go tests replay each vector in several orders and must reproduce the
 * exact text and fingerprint, proving the two implementations agree.
 *
 *   node scripts/gen-crdt-vectors.ts          (from frontend/)
 */
import { writeFileSync } from 'node:fs';
import { RgaDocument } from '../src/crdt/rga.ts';
import type { Op } from '../src/crdt/rga.ts';
import { insertAt, deleteRange, deliver, runConvergence } from '../src/testing/scenarios.ts';

interface Vector { name: string; ops: Op[]; text: string; fingerprint: string }
const vectors: Vector[] = [];
function add(name: string, ops: Op[]) {
  const d = new RgaDocument();
  deliver(d, ops);
  vectors.push({ name, ops, text: d.text(), fingerprint: d.fingerprint() });
}

{ // concurrent inserts at the same origin by three clients
  const s = new RgaDocument(); const seed = s.insertText('s', null, '<>');
  const reps = ['alice', 'bob', 'carol'].map(c => { const d = new RgaDocument(); deliver(d, seed); return insertAt(d, c, 1, c.slice(0, 3)); });
  add('same-origin-three-clients', [...seed, ...reps.flat()]);
}
{ // issue R2: concurrent inserts, then one client deletes its own character
  const a = new RgaDocument(), b = new RgaDocument();
  const oa = a.insertText('alice', null, 'A'), ob = b.insertText('bob', null, 'B');
  deliver(a, ob);
  add('concurrent-insert-then-delete-own', [...oa, ...ob, ...a.deleteIds([ob[0].id])]);
}
{ // insert whose origin is a tombstone
  const a = new RgaDocument(); const o1 = a.insertText('a', null, 'abc');
  const del = deleteRange(a, 1, 1);
  const o2 = a.insertText('b', o1[1].id, 'X');
  add('origin-is-tombstone', [...o1, ...del, ...o2]);
}
{ // unicode mix
  const a = new RgaDocument();
  const ops = [...a.insertText('u', null, 'e\u0301 😀 👩‍👩‍👧 漢字 🇮🇳\n')];
  ops.push(...deleteRange(a, 2, 1));
  add('unicode-mix', ops);
}
{ // front-insert stress (fractional-index worst case)
  const a = new RgaDocument(); const ops: Op[] = [];
  for (let i = 0; i < 300; i++) ops.push(...a.insertText('f', null, String.fromCharCode(97 + (i % 26))));
  add('front-insert-300', ops);
}
for (let seed = 1; seed <= 40; seed++) {
  const { all } = runConvergence(seed, 4, 40);
  add(`random-seed-${seed}`, all);
}

const out = new URL('../../backend/crdt/testdata/vectors.json', import.meta.url);
writeFileSync(out, JSON.stringify({ generatedBy: 'frontend/scripts/gen-crdt-vectors.ts', vectors }) + '\n');
console.log(`wrote ${vectors.length} vectors, ${vectors.reduce((n, v) => n + v.ops.length, 0)} ops -> ${out.pathname}`);
