// Browser benchmark (Chromium via Playwright) against the built app served by
// the TS test server (spawned) or E2E_BASE_URL.
//   npm run build && node bench/browser-bench.mjs
// 1. Local input cost: time spent in the editor's `input` handling per keystroke
//    (window capture → window bubble listener) and input → next animation frame.
// 2. Browser-to-browser latency: keydown in page A → text visible in page B
//    (B polls with requestAnimationFrame, so resolution is ~1 frame).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';

const pct = s => { const a = [...s].sort((x, y) => x - y); const at = p => a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)]; const r = x => Math.round(x * 1000) / 1000;
  return { n: a.length, p50: r(at(50)), p95: r(at(95)), p99: r(at(99)), max: r(a[a.length - 1]), mean: r(a.reduce((x, y) => x + y, 0) / a.length) }; };
let base = process.env.E2E_BASE_URL; let child = null;
if (!base) {
  child = spawn(process.execPath, ['test-server/server.ts'], { env: { ...process.env, PORT: '8380', STATIC_DIR: 'dist' }, stdio: 'ignore' });
  base = 'http://127.0.0.1:8380';
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
}
const browser = await chromium.launch();
const open = async room => { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.goto(`${base}/#${room}`);
  await p.getByTestId('connection').filter({ hasText: 'Connected' }).waitFor(); return p; };

async function localInput(prefill) {
  const p = await open(`bench-local-${prefill}-${Date.now()}`);
  const ed = p.getByTestId('editor'); await ed.click();
  if (prefill) { await p.keyboard.insertText('lorem ipsum dolor sit amet, '.repeat(Math.ceil(prefill / 28)).slice(0, prefill)); await p.getByTestId('sync-status').filter({ hasText: 'All changes synced' }).waitFor({ timeout: 60000 }); }
  await p.evaluate(() => {
    window.__h = []; window.__f = [];
    window.addEventListener('input', e => { window.__t0 = performance.now(); window.__ts = e.timeStamp; }, true);
    window.addEventListener('input', () => { const t1 = performance.now(); window.__h.push(t1 - window.__t0); const ts = window.__ts; requestAnimationFrame(() => window.__f.push(performance.now() - ts)); }, false);
  });
  for (let i = 0; i < 20; i++) await p.keyboard.type('w');            // warm-up
  await p.waitForTimeout(150);                                         // let warm-up frame callbacks drain
  await p.evaluate(() => { window.__h = []; window.__f = []; });
  for (let i = 0; i < 300; i++) await p.keyboard.type(i % 7 === 6 ? ' ' : 'k', { delay: 0 });
  await p.waitForTimeout(200);
  const r = await p.evaluate(() => ({ h: window.__h, f: window.__f }));
  await p.context().close();
  return { docChars: prefill, handlerMs: pct(r.h), inputToNextFrameMs: pct(r.f) };
}

async function remote() {
  const room = `bench-remote-${Date.now()}`;
  const a = await open(room), b = await open(room);
  await a.getByTestId('editor').click();
  await a.evaluate(() => { window.__k = []; window.addEventListener('keydown', () => window.__k.push(Date.now()), true); });
  await b.evaluate(() => { window.__seen = []; let last = 0; const ed = document.querySelector('[data-testid=editor]');
    const loop = () => { const n = ed.value.length; if (n > last) { for (let i = last; i < n; i++) window.__seen.push(Date.now()); last = n; } requestAnimationFrame(loop); }; loop(); });
  for (let i = 0; i < 220; i++) { await a.keyboard.type('x'); await a.waitForTimeout(40); }
  await b.waitForFunction(() => window.__seen.length >= 220);
  const k = await a.evaluate(() => window.__k), s = await b.evaluate(() => window.__seen);
  await a.context().close(); await b.context().close();
  return { samples: 200, latencyMs: pct(k.slice(20).map((t, i) => s[i + 20] - t)) };
}

const result = {
  benchmark: 'browser', server: base, implementation: (await (await fetch(base + '/health')).json()).implementation,
  environment: { date: new Date().toISOString(), os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cpus: os.cpus().length, node: process.version, browser: `chromium ${browser.version()} (headless)` },
  localInput: [await localInput(0), await localInput(20000), await localInput(100000)],
  remoteEdit: await remote(),
  bundle: JSON.parse(readFileSync('dist/build-report.json', 'utf8')),
};
await browser.close(); child?.kill();
mkdirSync('../scripts/benchmarks/results', { recursive: true });
writeFileSync('../scripts/benchmarks/results/browser.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ localInput: result.localInput, remoteEdit: result.remoteEdit, browser: result.environment.browser }, null, 1));
