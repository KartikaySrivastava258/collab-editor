# Benchmarks

All numbers below come from the JSON files in [`scripts/benchmarks/results/`](../scripts/benchmarks/results/),
produced by the scripts next to them. Nothing was estimated.

**Environment (all runs):** Linux 6.18 x86-64 VM, **1 vCPU** (Intel Xeon @ 2.10 GHz), 3.9 GiB RAM,
Node v22.22.2, Chromium 141.0.7390.37 headless, production frontend build.
**Server under test: the TypeScript protocol server** (`frontend/test-server`), which shares its CRDT
code with the browser. Go server numbers are not included yet: `make bench-go` runs the Go
micro-benchmarks plus the same WebSocket workload against the Go binary (with `/proc` sampling).

Load generator, server and browser share the single vCPU, so absolute throughput numbers are
lower bounds and latencies include scheduling contention.

## 1. CRDT: original vs. RGA (same seeded workloads)

`node scripts/benchmarks/crdt-bench.ts` → `crdt.json`. The original code is copied unmodified from
the baseline commit, except for one type-import line (see `scripts/benchmarks/baseline/`).
Timing: 2 warm-up + 10 measured runs.

| Correctness | Original (float64 fractional) | RGA |
|---|---|---|
| Convergence: 500 seeds × 3 replicas × 60 random ops, causal delivery + duplicates | **1 / 500 (0.2%)** | **500 / 500 (100%)** |
| Single-writer intent: 500 seeds × 200 random edits vs. a plain-string model | **5 / 500 (1%)** | **500 / 500 (100%)** |

Causal (FIFO) delivery was chosen because it **favours the original**, which could not handle
out-of-order delivery at all. The RGA is additionally tested under arbitrary order (see TESTING.md).

| Timing (ms per run) | Original p50 / p95 | RGA p50 / p95 |
|---|---|---|
| 10,000 chars typed at the end | 230.3 / 268.5 | 6.4 / 8.8 |
| Integrate 5,000 inserts at random positions on a fresh replica | 44.1 / 56.5 | 5.5 / 12.1 |

Interpretation: the original's output is already **wrong** after about 55 sequential characters,
so its speed is not a meaningful comparison. The relevant result is correctness. Its slowness
comes mostly from rebuilding the visible-character array on every operation.

RGA single insert at a random anchor in a 10,000-char document (2,000 samples): p50 3.9 µs,
p95 5.2 µs, p99 9.4 µs, max 40.7 µs.

## 2. Network (TS test server, separate process)

`node scripts/benchmarks/ws-latency.ts` → `ws-ts-test-server.json`

| Metric | Workload | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| Remote edit latency (sender op → receiver applied) | 1 sender, 1 receiver, single-char batches, 100 warm-up excluded | 1,000 | 0.38 ms | 0.83 ms | 2.40 ms | 9.58 ms |
| Sender ack round trip | same | 1,000 | 0.50 ms | 1.14 ms | 3.79 ms | 9.76 ms |
| Reconnect recovery (network restored → connected and all edits acked) | 20 outages via TCP proxy, 13 chars typed offline each, immediate retry; **excludes backoff wait** | 20 | 4.65 ms | 13.24 ms | 13.75 ms | 13.75 ms |

Both clients run in the benchmark process and share one clock, so no cross-machine clock skew is
involved. Everything is loopback, so these are server- and stack-overhead numbers, not
internet latencies.

**Throughput / fan-out:** 10 clients in one room; 2 writers send 10-char batches at random
positions (up to 8 unacked each) for 10 s.

| Accepted ops/s | Ops delivered to receivers/s | Ops | Final doc chars | All 10 replicas identical | Disconnects | Server RSS start → peak | Server CPU avg |
|---|---|---|---|---|---|---|---|
| 3,679 | 33,114 | 36,860 | 36,860 (no op lost) | yes | 0 | 94.7 → 112.2 MiB | 14.1% |

The server used only ~14% CPU (sampled from `/proc` every 500 ms, 19 samples). The bottleneck
was the **load generator**: ten full CRDT replicas on the same single vCPU. So 3,679 ops/s is a
lower bound, not the server's capacity. Server capacity: **Not measured.**

## 3. Browser (Chromium, production build)

`node frontend/bench/browser-bench.mjs` → `browser.json` (before the optimization:
`browser-before-optimization.json`, same script, workload and build mode).

**Local input cost per keystroke**: time inside the editor's `input` handling (window
capture → window bubble listener), 300 keystrokes after 20 warm-up. Timer resolution in headless
Chromium is 0.1 ms.

| Document size | Handler p50 / p95 / p99, **before** | Handler p50 / p95 / p99, **after** | Input → next frame p50 / p95, before → after |
|---|---|---|---|
| empty | 1.0 / 2.4 / 4.1 ms | 0.9 / 2.4 / 3.9 ms | 7.5 / 15.5 → 7.4 / 15.8 ms |
| 20,000 chars | 2.2 / 5.0 / 6.9 ms | 1.1 / 3.4 / 4.9 ms | 8.4 / 18.4 → 8.2 / 17.4 ms |
| 100,000 chars | 8.4 / 13.3 / **34.7** ms | 1.7 / 4.0 / **5.3** ms | 14.2 / 22.6 → 7.4 / 19.8 ms |

**How the optimization was found:** a Chrome CPU profile of 150 keystrokes on a 100k document
(unminified build) attributed our JavaScript self-time to: `visibleAtoms` + `readModel` ≈ 879 ms
(full rebuild of ID and value arrays on every local keystroke), `countText` ≈ 309 ms (whole-text
word count), `utf16ToCodePointIndex` ≈ 122 ms. Fixes:
- splice local edits into the bookkeeping arrays incrementally, falling back to a full rebuild if
  remote changes are pending during IME;
- debounce word counts by 150 ms;
- O(1) offset mapping when the text has no surrogate pairs.

Correctness was re-verified with a randomized two-client E2E test that asserts binding ↔ CRDT
consistency (and fails within seconds if the fast path is broken on purpose).

**Browser-to-browser latency** (keydown in tab A → text visible in tab B; B polls with
`requestAnimationFrame`, so resolution is about one frame): n = 200, p50 15 ms, p95 20 ms,
p99 27 ms, max 55 ms.

## 4. Bundle size (production build, `dist/build-report.json`)

| File | Bytes | gzip -9 |
|---|---|---|
| `app.js` | 241,100 (235.4 KiB) | 75,070 (73.3 KiB) |
| `app.css` | 13,924 (13.6 KiB) | 3,716 (3.6 KiB) |

The JavaScript is dominated by React 19 + ReactDOM. These sizes are from the build used for the
browser benchmark; later builds may differ by a few hundred bytes.

## Not measured

- Go server latency, throughput and memory (`make bench-go`).
- Real-network latency (all runs are loopback).
- Multi-core server scaling, and long-running (hours) stability or memory growth.
- Bundle transfer under HTTP compression in production (only the gzip size is computed).
