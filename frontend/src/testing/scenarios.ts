/** Shared scenario helpers for CRDT tests, cross-language vectors and benchmarks. */
import { RgaDocument, keyOf, idGreater } from '../crdt/rga.ts';
import type { Op, InsertOp } from '../crdt/rga.ts';
import { mulberry32, shuffle } from './random.ts';

/** Insert `text` at visible index `pos` (0 = start) on doc as client `c`. */
export function insertAt(doc: RgaDocument, c: string, pos: number, text: string): Op[] {
  const { ids } = doc.visibleAtoms();
  return doc.insertText(c, pos === 0 ? null : ids[pos - 1], text);
}
export function deleteRange(doc: RgaDocument, from: number, count: number): Op[] {
  const { ids } = doc.visibleAtoms();
  return doc.deleteIds(ids.slice(from, from + count));
}
export function deliver(doc: RgaDocument, ops: readonly Op[]) { for (const o of ops) doc.apply(o); }

/** Independent oracle: RGA tree, children by descending ID, pre-order DFS. */
export function oracleText(ops: readonly Op[]): string {
  const inserts = new Map<string, InsertOp>();
  const deleted = new Set<string>();
  for (const op of ops) {
    if (op.k === 'i') inserts.set(keyOf(op.id), op); else deleted.add(keyOf(op.id));
  }
  const children = new Map<string, InsertOp[]>();
  for (const op of inserts.values()) {
    const parent = op.o === null ? '' : keyOf(op.o);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(op);
  }
  for (const list of children.values()) list.sort((x, y) => (idGreater(x.id, y.id) ? -1 : 1));
  let out = '';
  const stack: InsertOp[] = [...(children.get('') ?? [])].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (!deleted.has(keyOf(n.id))) out += n.v;
    const kids = children.get(keyOf(n.id));
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

export const ALPHABET = ['a', 'b', 'c', 'd', ' ', '\n', 'é', '😀', '漢'];

export function runConvergence(seed: number, replicas: number, steps: number) {
  const rnd = mulberry32(seed);
  const ids = Array.from({ length: replicas }, (_, i) => `r${i}`);
  const docs = ids.map(() => new RgaDocument());
  const all: Op[] = [];
  const inbox: Op[][] = ids.map(() => []);
  const delivered: Op[][] = ids.map(() => []);
  for (let s = 0; s < steps; s++) {
    const k = Math.floor(rnd() * replicas);
    const d = docs[k];
    let ops: Op[];
    if (d.length > 0 && rnd() < 0.35) {
      const from = Math.floor(rnd() * d.length);
      ops = deleteRange(d, from, 1 + Math.floor(rnd() * 3));
    } else {
      const len = 1 + Math.floor(rnd() * 4);
      let t = '';
      for (let i = 0; i < len; i++) t += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      ops = insertAt(d, ids[k], Math.floor(rnd() * (d.length + 1)), t);
    }
    all.push(...ops);
    inbox.forEach((box, j) => { if (j !== k) box.push(...ops); });
    // Deliver a random subset to a random replica, in random order, with duplicates.
    const j = Math.floor(rnd() * replicas);
    if (inbox[j].length && rnd() < 0.6) {
      shuffle(inbox[j], rnd);
      const n = Math.floor(rnd() * (inbox[j].length + 1));
      const batch = inbox[j].splice(0, n);
      deliver(docs[j], batch);
      delivered[j].push(...batch);
      if (delivered[j].length && rnd() < 0.3) docs[j].apply(delivered[j][Math.floor(rnd() * delivered[j].length)]);
    }
  }
  inbox.forEach((box, j) => { shuffle(box, rnd); deliver(docs[j], box); });
  return { docs, all };
}

