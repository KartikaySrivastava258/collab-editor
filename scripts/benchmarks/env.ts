/** Environment metadata recorded with every benchmark result. */
import os from 'node:os';
import { execSync } from 'node:child_process';

export function environment(extra: Record<string, unknown> = {}) {
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a git checkout */ }
  return {
    date: new Date().toISOString(), commit,
    os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, node: process.version, ...extra,
  };
}

/** Nearest-rank percentiles. */
export function percentiles(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { n: s.length, min: r(s[0]), p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}
