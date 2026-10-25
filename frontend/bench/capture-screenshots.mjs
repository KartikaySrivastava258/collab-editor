// Regenerates docs/screenshots/*.png from real browser sessions against a
// locally started server (AI shots use the mock provider in e2e/fake-llm.mjs).
//   npm run build && node bench/capture-screenshots.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';

const out = '../docs/screenshots';

// Refuse to run against a leftover server: stale rooms would end up in the screenshots.
for (const port of [8390, 8399]) {
  const busy = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
  if (busy) { console.error(`port ${port} is already in use; stop the old process first`); process.exit(1); }
}
const frames = {};

/** Places captured frames side by side on a dark background. */
async function sideBySide(browser, buffers, path) {
  const imgs = buffers.map(b => `<img src="data:image/png;base64,${b.toString('base64')}" style="height:820px;display:block">`).join('');
  const p = await browser.newPage({ viewport: { width: 2000, height: 820 }, deviceScaleFactor: 2 });
  await p.setContent(`<body style="margin:0;background:#08090a"><div id="row" style="display:inline-flex;gap:24px">${imgs}</div></body>`);
  await p.locator('#row').screenshot({ path });
  await p.close();
}
const llm = spawn(process.execPath, ['e2e/fake-llm.mjs'], { env: { ...process.env, FAKE_LLM_PORT: '8399' }, stdio: 'ignore' });
const srv = spawn(process.execPath, ['test-server/server.ts'], { env: { ...process.env, PORT: '8390', STATIC_DIR: 'dist', LLM_API_KEY: 'shot', LLM_MODEL: 'fake', LLM_API_URL: 'http://127.0.0.1:8399' }, stdio: 'ignore' });
const base = 'http://127.0.0.1:8390';
// Never leave the server or mock LLM running, even if a step below throws.
const cleanup = () => { srv.kill(); llm.kill(); };
process.on('exit', cleanup);
process.on('uncaughtException', e => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', e => { console.error(e); cleanup(); process.exit(1); });
for (let i = 0; i < 100; i++) { try { await fetch(base + '/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

// cuttable proxy for the recovery screenshot
let refusing = false; const socks = new Set();
const proxy = net.createServer(c => { if (refusing) return c.destroy(); const u = net.connect(8390, '127.0.0.1');
  for (const s of [c, u]) { socks.add(s); s.on('close', () => socks.delete(s)); s.on('error', () => {}); } c.pipe(u).pipe(c); });
await new Promise(r => proxy.listen(8391, '127.0.0.1', r));

const browser = await chromium.launch();
const page = async (w, h, origin = base, name) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  if (name) await p.addInitScript(n => localStorage.setItem('collab.displayName.v1', n), name);
  p.origin = origin; return p;
};
const open = async (p, room) => { await p.goto(`${p.origin}/#${room}`); await p.getByTestId('connection').filter({ hasText: 'Connected' }).waitFor(); };
const text = `Field notes — launch review

The team agreed to ship the editor once two-client editing, reconnect recovery and the conformance suite pass against the Go server.

Open questions:
- Should rooms persist to disk, or is memory-only acceptable for the pilot?
- Who owns the AI provider key in staging?

Decision: keep storage in memory for now and document the limitation clearly.`;

// 01 workspace (desktop, real second collaborator connected)
const room = 'launch-review';
const a = await page(1440, 900, base, 'Ada Lovelace');
await open(a, 'design-notes'); await open(a, 'retro-2026-10'); await open(a, room);
await a.getByTestId('editor').click(); await a.keyboard.insertText(text);
const b = await page(1440, 900, base, 'Grace Hopper'); await open(b, room);
await a.getByTestId('presence').filter({ has: a.locator('span') }).waitFor();
await a.getByTestId('sync-status').filter({ hasText: 'All changes synced' }).waitFor();
await a.getByTestId('editor').evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
await a.waitForTimeout(400);
await a.screenshot({ path: `${out}/01-workspace.png` });

// 02 collaboration: two real clients side by side, B typing into the shared doc
const a2 = await page(760, 820, base, 'Ada Lovelace'); const b2 = await page(760, 820, base, 'Grace Hopper');
const room2 = 'pairing-session';
await open(a2, room2); await open(b2, room2);
await a2.getByTestId('editor').click(); await a2.keyboard.type('Draft from Ada: the sync status only turns green after the server acknowledges every edit.', { delay: 2 });
await b2.getByTestId('editor').click(); await b2.keyboard.press('End');
await b2.keyboard.type('\n\nGrace: confirmed — and offline edits wait in the tab until reconnect.', { delay: 2 });
await a2.waitForFunction(() => document.querySelector('[data-testid=editor]').value.includes('Grace: confirmed'));
await a2.waitForTimeout(400);
frames.collab = [await a2.screenshot(), await b2.screenshot()];
await sideBySide(browser, frames.collab, `${out}/02-collaboration.png`);

// 03 connection recovery: real outage via proxy, edits queued
const c = await page(1280, 720, 'http://127.0.0.1:8391', 'Ada Lovelace');
await open(c, 'outage-demo');
await c.getByTestId('editor').click(); await c.keyboard.type('Typed while connected. ');
await c.getByTestId('sync-status').filter({ hasText: 'All changes synced' }).waitFor();
refusing = true; for (const s of socks) s.destroy();
await c.getByTestId('offline-banner').waitFor();
await c.keyboard.type('Typed during the outage.');
await c.waitForTimeout(700);
await c.screenshot({ path: `${out}/03-connection-recovery.png` });
// Start waiting for the toast before restoring, so a fast auto-reconnect can't win the race.
const reconnected = c.getByTestId('toast').filter({ hasText: 'Reconnected' }).waitFor({ timeout: 20000 });
refusing = false;
await c.getByRole('button', { name: 'Retry now' }).click({ timeout: 1000 }).catch(() => { /* already reconnected */ });
await reconnected;
await c.getByTestId('sync-status').filter({ hasText: 'All changes synced' }).waitFor();
await c.screenshot({ path: `${out}/03b-reconnected.png` });

// 04 mobile: editor and navigation drawer
const m = await page(375, 760, base, 'Ada Lovelace');
await open(m, room);
await m.getByTestId('editor').click(); await m.keyboard.press('End');
await m.waitForTimeout(300);
frames.mobile = [await m.screenshot()];
await m.getByRole('button', { name: 'Open navigation' }).click(); await m.waitForTimeout(400);
frames.mobile.push(await m.screenshot());
await sideBySide(browser, frames.mobile, `${out}/04-mobile.png`);

// 06 AI suggestion (fake provider)
const s = await page(1280, 760, base, 'Ada Lovelace');
await open(s, 'ai-demo');
await s.getByTestId('editor').click(); await s.keyboard.type('The storm had lasted three days');
await s.getByTestId('ai-suggest').click();
await s.getByTestId('ai-text').waitFor();
await s.screenshot({ path: `${out}/06-ai-suggestion.png` });

await browser.close(); proxy.close(); srv.kill(); llm.kill();
console.log('captured');
