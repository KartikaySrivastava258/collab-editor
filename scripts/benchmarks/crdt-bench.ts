/**
 * In-process CRDT benchmark: original fractional-index CRDT (baseline commit
 * ca1e321) vs. the RGA replacement, on identical seeded workloads.
 *
 *   node scripts/benchmarks/crdt-bench.ts            (Node >= 22.18)
 *
 * Writes scripts/benchmarks/results/crdt.json. Timing excludes workload
 * generation. Each timed workload: 2 warm-up runs + 10 measured runs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { CRDTDocument } from './baseline/crdtDocument.original.ts';
import type { Mutation } from './baseline/types.original.ts';
import { RgaDocument } from '../../frontend/src/crdt/rga.ts';
import type { Op } from '../../frontend/src/crdt/rga.ts';
import { mulberry32 } from '../../frontend/src/testing/random.ts';
import { environment, percentiles } from './env.ts';

interface Adapter<D, O> {
  name: string;
  create(clientId: string): D;
  insertAt(d: D, client: string, pos: number, ch: string): O;
  deleteAt(d: D, pos: number): O | null;
  apply(d: D, op: O): void;
  text(d: D): string;
}

const baseline: Adapter<CRDTDocument, Mutation> = {
  name: 'baseline (fractional float64)',
  create: c => new CRDTDocument(c),
  insertAt: (d, _c, pos, ch) => d.insertLocal(pos, ch),
  deleteAt: (d, pos) => d.deleteLocal(pos + 1), // baseline uses 1-based visible positions
  apply: (d, op) => d.applyRemote(op),
  text: d => d.getText(),
};

const rga: Adapter<RgaDocument, Op> = {
  name: 'RGA (this change)',
  create: () => new RgaDocument(),
  insertAt: (d, c, pos, ch) => {
    const after = pos === 0 ? null : d.visibleAtoms().ids[pos - 1];
    return d.insertText(c, after, ch)[0];
  },
  deleteAt: (d, pos) => d.deleteIds([d.visibleAtoms().ids[pos]])[0] ?? null,
  apply: (d, op) => { d.apply(op); },
  text: d => d.text(),
};

function timeRuns(label: string, fn: () => void) {
  for (let i = 0; i < 2; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < 10; i++) { const t = performance.now(); fn(); ms.push(performance.now() - t); }
  return { label, runs: percentiles(ms) };
}

const N_SEQ = 10_000;

// ── Timing ──────────────────────────────────────────────────────────────────
const timing = {
  sequentialTyping: {
    workload: `${N_SEQ} single-character inserts appended at the end, one replica`,
    baseline: timeRuns('baseline', () => { const d = new CRDTDocument('a'); for (let i = 0; i < N_SEQ; i++) d.insertLocal(i, 'x'); }),
    rga: timeRuns('rga', () => { const d = new RgaDocument(); let last = null as Op['id'] | null; for (let i = 0; i < N_SEQ; i++) last = d.insertText('a', last, 'x')[0].id; }),
  },
  remoteApply: (() => {
    const rnd = mulberry32(7);
    const srcB = new CRDTDocument('src'); const opsB: Mutation[] = [];
    const srcR = new RgaDocument(); const opsR: Op[] = [];
    for (let i = 0; i < 5000; i++) {
      const pos = Math.floor(rnd() * (i + 1));
      opsB.push(srcB.insertLocal(pos, 'y'));
      opsR.push(rga.insertAt(srcR, 'src', pos, 'y'));
    }
    return {
      workload: '5,000 inserts at seeded random positions generated on one replica, integrated on a fresh replica',
      baseline: timeRuns('baseline', () => { const d = new CRDTDocument('dst'); for (const m of opsB) d.applyRemote(m); }),
      rga: timeRuns('rga', () => { const d = new RgaDocument(); for (const o of opsR) d.apply(o); }),
    };
  })(),
};

// Per-operation latency of local typing into a 10k-char document (RGA only).
const perOp: number[] = [];
{
  const d = new RgaDocument(); let last = null as Op['id'] | null;
  for (let i = 0; i < N_SEQ; i++) last = d.insertText('a', last, 'x')[0].id;
  const ids = d.visibleAtoms().ids;
  const rnd = mulberry32(3);
  for (let i = 0; i < 2000; i++) {
    const anchor = ids[Math.floor(rnd() * ids.length)];
    const t = performance.now();
    d.insertText('a', anchor, 'z');
    perOp.push((performance.now() - t) * 1000);
  }
}

// ── Correctness ─────────────────────────────────────────────────────────────
function convergence<D, O>(a: Adapter<D, O>, seeds: number, replicas: number, steps: number) {
  let converged = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = mulberry32(seed);
    const docs = Array.from({ length: replicas }, (_, i) => a.create(`r${i}`));
    const queues: O[][] = docs.map(() => []);
    for (let s = 0; s < steps; s++) {
      const k = Math.floor(rnd() * replicas); const d = docs[k]; const len = [...a.text(d)].length;
      const op = len > 0 && rnd() < 0.3 ? a.deleteAt(d, Math.floor(rnd() * len)) : a.insertAt(d, `r${k}`, Math.floor(rnd() * (len + 1)), 'abcdefghij'[Math.floor(rnd() * 10)]);
      if (op) queues.forEach((q, j) => { if (j !== k) q.push(op); });
      // causal (FIFO) delivery of a random prefix, with one duplicate
      const j = Math.floor(rnd() * replicas);
      const n = Math.floor(rnd() * (queues[j].length + 1));
      const batch = queues[j].splice(0, n);
      for (const o of batch) a.apply(docs[j], o);
      if (batch.length) a.apply(docs[j], batch[0]);
    }
    queues.forEach((q, j) => { for (const o of q) a.apply(docs[j], o); });
    const t = docs.map(d => a.text(d));
    if (t.every(x => x === t[0])) converged++;
  }
  return { seeds, replicas, steps, converged, rate: Math.round((converged / seeds) * 10000) / 100 };
}

function intent<D, O>(a: Adapter<D, O>, seeds: number, steps: number) {
  let ok = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = mulberry32(seed); const d = a.create('w'); const model: string[] = [];
    for (let s = 0; s < steps; s++) {
      if (model.length && rnd() < 0.3) { const p = Math.floor(rnd() * model.length); a.deleteAt(d, p); model.splice(p, 1); }
      else { const p = Math.floor(rnd() * (model.length + 1)); const ch = 'abcdefghij'[Math.floor(rnd() * 10)]; a.insertAt(d, 'w', p, ch); model.splice(p, 0, ch); }
    }
    if (a.text(d) === model.join('')) ok++;
  }
  return { seeds, steps, matchesModel: ok, rate: Math.round((ok / seeds) * 10000) / 100 };
}

const correctness = {
  convergence: { baseline: convergence(baseline, 500, 3, 60), rga: convergence(rga, 500, 3, 60) },
  singleWriterIntent: { baseline: intent(baseline, 500, 200), rga: intent(rga, 500, 200) },
};

const result = {
  benchmark: 'crdt', environment: environment(),
  method: 'Seeded workloads (mulberry32). Timing: 2 warm-up + 10 measured runs, wall clock via performance.now(). Convergence: replicas edit randomly, receive peers\' ops in causal FIFO order with duplicates, then all remaining ops; converged = identical final text on all replicas.',
  timing, perOpInsertMicros: { workload: '2,000 single-char inserts at random anchors into a 10,000-char RGA document', ...percentiles(perOp) },
  correctness,
};
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/crdt.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');

const row = (k: string, v: { runs: { p50: number; p95: number } }) => `${k.padEnd(10)} p50 ${v.runs.p50.toFixed(2).padStart(9)} ms   p95 ${v.runs.p95.toFixed(2).padStart(9)} ms`;
console.log(`sequential typing (${N_SEQ} chars)\n  ${row('baseline', timing.sequentialTyping.baseline)}\n  ${row('rga', timing.sequentialTyping.rga)}`);
console.log(`remote apply (5,000 random inserts)\n  ${row('baseline', timing.remoteApply.baseline)}\n  ${row('rga', timing.remoteApply.rga)}`);
console.log(`per-op insert into 10k doc (µs): ${JSON.stringify(result.perOpInsertMicros)}`);
console.log(`convergence: baseline ${correctness.convergence.baseline.converged}/500 (${correctness.convergence.baseline.rate}%), rga ${correctness.convergence.rga.converged}/500 (${correctness.convergence.rga.rate}%)`);
console.log(`single-writer intent: baseline ${correctness.singleWriterIntent.baseline.matchesModel}/500, rga ${correctness.singleWriterIntent.rga.matchesModel}/500`);
