/**
 * Network benchmark against a running server (SERVER_URL) or, by default, the
 * TS test server spawned as a separate process.
 *
 *   node scripts/benchmarks/ws-latency.ts
 *   SERVER_URL=http://localhost:8080 SERVER_PID=<pid> node scripts/benchmarks/ws-latency.ts   # Go server
 *
 * Measures:
 *   1. remote edit latency: sender op → receiver applies it (same process clock)
 *   2. fan-out throughput with 10 clients + final convergence check
 *   3. server RSS / CPU during (2), sampled from /proc (Linux, local server only)
 *   4. reconnect recovery: network restored → client connected and fully acked
 * Writes scripts/benchmarks/results/ws-<implementation>.json.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { environment, percentiles } from './env.ts';

const root = new URL('../../', import.meta.url).pathname;
let base = process.env.SERVER_URL ?? '';
let pid = Number(process.env.SERVER_PID ?? 0);
let child: ReturnType<typeof spawn> | null = null;

if (!base) {
  const port = 8370;
  child = spawn(process.execPath, ['test-server/server.ts'], { cwd: `${root}frontend`, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  pid = child.pid ?? 0;
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
}
process.env.SERVER_URL = base;
const health = await (await fetch(`${base}/health`)).json() as { implementation?: string };
const impl = health.implementation ?? 'unknown';
const { TestClient, waitConverged } = await import('../../frontend/tests/protocol/client.ts');
const { SyncClient } = await import('../../frontend/src/sync/SyncClient.ts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function sample(): { rssMiB: number; cpuTicks: number } | null {
  if (!pid || os.platform() !== 'linux') return null;
  try {
    const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]) / 1024;
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { rssMiB: Math.round(rss * 10) / 10, cpuTicks: Number(f[11]) + Number(f[12]) };
  } catch { return null; }
}

// ── 1. latency ─────────────────────────────────────────────────────────────
async function latency() {
  const room = `bench-lat-${Date.now()}`;
  const tx = new TestClient(room, 'sender'); const rx = new TestClient(room, 'receiver');
  await tx.connect(); await rx.connect();
  const sentAt = new Map<string, number>(); const lat: number[] = []; const rtt: number[] = [];
  let measuring = false;
  rx.onOps = ops => { const now = performance.now(); for (const op of ops) { const k = `${op.id.c}:${op.id.t}`; const t = sentAt.get(k); if (t !== undefined && measuring) lat.push(now - t); } };
  const send = async (measure: boolean) => {
    measuring = measure;
    const before = tx.doc.length;
    const t0 = performance.now();
    const seq = tx.type(before, 'x');
    const op = tx.doc.visibleAtoms().ids[before];
    sentAt.set(`${op.c}:${op.t}`, t0);
    await tx.waitAcked(seq);
    if (measure) rtt.push(performance.now() - t0);
  };
  for (let i = 0; i < 100; i++) await send(false);                // warm-up
  for (let i = 0; i < 1000; i++) { await send(true); await sleep(5); }
  await rx.waitFor(() => rx.doc.length === tx.doc.length, 'receiver caught up');
  tx.close(); rx.close();
  return {
    workload: '1 sender + 1 receiver; 1,000 single-character insert batches sent one at a time (next sent after ack + 5 ms); 100 warm-up ops excluded',
    remoteApplyMs: percentiles(lat), senderAckRttMs: percentiles(rtt),
  };
}

// ── 2/3. throughput + resources ─────────────────────────────────────────────
async function throughput() {
  const room = `bench-tp-${Date.now()}`;
  const clients = Array.from({ length: 10 }, (_, i) => new TestClient(room, `p${i}`));
  for (const c of clients) await c.connect();
  const writers = clients.slice(0, 2);
  const durationMs = 10_000; const batch = 10; const window = 8;
  const samples: { t: number; rssMiB: number; cpuTicks: number }[] = [];
  const s0 = sample();
  const sampler = setInterval(() => { const s = sample(); if (s) samples.push({ t: performance.now(), ...s }); }, 500);
  const start = performance.now(); let sentOps = 0;
  await Promise.all(writers.map(async (w, wi) => {
    while (performance.now() - start < durationMs) {
      if (w.seq - w.acked >= window) { await w.waitFor(() => w.seq - w.acked < window, 'window', 20_000); continue; }
      w.type(Math.floor(Math.random() * (w.doc.length + 1)), String.fromCharCode(97 + wi).repeat(batch));
      sentOps += batch;
      if (w.seq % 20 === 0) await sleep(0);
    }
    await w.waitAcked(w.seq, 30_000);
  }));
  const elapsed = (performance.now() - start) / 1000;
  clearInterval(sampler);
  const s1 = sample();
  const text = await waitConverged(room, clients, 60_000);
  const fp = clients[0].doc.fingerprint();
  const identical = clients.every(c => c.doc.fingerprint() === fp);
  const disconnects = clients.filter(c => c.closed).length;
  for (const c of clients) c.close();
  const ticks = 100; // USER_HZ on Linux
  return {
    workload: `10 clients in one room; 2 writers send ${batch}-character insert batches at random positions with up to ${window} unacked batches each, for ${durationMs / 1000} s; 8 passive receivers`,
    acceptedOpsPerSec: Math.round(sentOps / elapsed), totalOps: sentOps, docChars: [...text].length,
    fanOutOpsDeliveredPerSec: Math.round((sentOps * (clients.length - 1)) / elapsed),
    converged: identical, disconnects,
    server: s0 && s1 ? {
      rssMiBStart: s0.rssMiB, rssMiBPeak: Math.max(s0.rssMiB, ...samples.map(s => s.rssMiB)), rssMiBEnd: s1.rssMiB,
      cpuPercentAvg: Math.round(((s1.cpuTicks - s0.cpuTicks) / ticks / elapsed) * 1000) / 10, samples: samples.length, sampleIntervalMs: 500,
    } : 'not measured (remote server or non-Linux)',
  };
}

// ── 4. reconnect recovery ───────────────────────────────────────────────────
async function recovery() {
  const target = new URL(base);
  let refusing = false; const socks = new Set<net.Socket>();
  const proxy = net.createServer(c => {
    if (refusing) { c.destroy(); return; }
    const u = net.connect(Number(target.port), target.hostname);
    for (const s of [c, u]) { socks.add(s); s.on('close', () => socks.delete(s)); s.on('error', () => {}); }
    c.pipe(u).pipe(c); c.on('close', () => u.destroy()); u.on('close', () => c.destroy());
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
  const port = (proxy.address() as net.AddressInfo).port;
  const room = `bench-rec-${Date.now()}`;
  const client = new SyncClient({ url: `ws://127.0.0.1:${port}/ws`, roomId: room, clientId: 'recoverer', name: 'bench' });
  client.start();
  const until = async (cond: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await sleep(1); } };
  await until(() => client.getState().phase === 'connected');
  const times: number[] = [];
  for (let i = 0; i < 21; i++) {
    refusing = true; for (const s of socks) s.destroy();
    await until(() => client.getState().phase !== 'connected');
    const ids = client.doc.visibleAtoms().ids;
    client.submit(client.doc.insertText('recoverer', ids[ids.length - 1] ?? null, 'offline edit '));
    await sleep(200);
    refusing = false;
    const t0 = performance.now();
    client.retryNow();
    await until(() => client.getState().phase === 'connected' && client.getState().unsynced === 0);
    if (i > 0) times.push(performance.now() - t0); // first sample is warm-up
  }
  const srv = await (await fetch(`${base}/api/room/text?roomId=${room}`)).json() as { text: string };
  const ok = srv.text === client.doc.text();
  client.stop(); proxy.close();
  return {
    workload: '20 outages (+1 warm-up): connection cut via TCP proxy, 13 characters typed offline, network restored and an immediate retry triggered; timed until connected and every edit acknowledged. Excludes backoff wait (backoff schedule: 0.5 s × 2^n with equal jitter, capped at 30 s).',
    recoveryMs: percentiles(times), serverMatchesClient: ok,
  };
}

const result = { benchmark: 'websocket', implementation: impl, server: base, environment: environment({ note: 'load generator and server share the same machine' }),
  latency: await latency(), throughput: await throughput(), recovery: await recovery() };
child?.kill();
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/ws-${impl}.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ impl, latency: result.latency.remoteApplyMs, ackRtt: result.latency.senderAckRttMs, throughput: { ...result.throughput, workload: undefined }, recovery: result.recovery.recoveryMs, recoveryOk: result.recovery.serverMatchesClient }, null, 1));
process.exit(0);
