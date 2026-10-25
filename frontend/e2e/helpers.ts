import { test as base, expect } from '@playwright/test';
import type { Page, Browser } from '@playwright/test';
import net from 'node:net';

/** Fails a test on any console error or uncaught exception, unless allowed. */
export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await use(errors);
    const allowNetwork = info.annotations.some(a => a.type === 'expected-network-errors');
    const unexpected = errors.filter(e => !(allowNetwork && /WebSocket connection|ERR_CONNECTION|Failed to load resource/.test(e)));
    expect(unexpected, 'unexpected console errors').toEqual([]);
  }, { auto: true }],
});
export { expect };

let n = 0;
export const newRoom = (tag = 'e2e') => `${tag}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export const editor = (page: Page) => page.getByTestId('editor');

export async function openRoom(page: Page, room: string, origin = '') {
  await page.goto(`${origin}/#${room}`);
  await expect(page.getByTestId('connection')).toHaveText('Connected');
  await expect(editor(page)).toBeVisible();
}

export async function newPeer(browser: Browser, room: string, origin = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { throw e; });
  await openRoom(page, room, origin);
  return { ctx, page };
}

export async function expectText(page: Page, text: string) {
  await expect(editor(page)).toHaveValue(text);
}

export async function serverText(baseURL: string, room: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/room/text?roomId=${room}`);
  return ((await res.json()) as { text: string }).text;
}

/** Raw TCP proxy in front of the server so tests can cut the network for any backend. */
export class Proxy {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private refusing = false;
  port = 0;
  private target: URL;
  constructor(target: URL) {
    this.target = target;
    this.server = net.createServer(client => {
      if (this.refusing) { client.destroy(); return; }
      const upstream = net.connect(Number(this.target.port), this.target.hostname);
      for (const s of [client, upstream]) { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); s.on('error', () => {}); }
      client.pipe(upstream).pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
  }
  async start(): Promise<string> {
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as net.AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }
  /** Drop every connection and refuse new ones (simulated outage). */
  cut() { this.refusing = true; for (const s of this.sockets) s.destroy(); }
  restore() { this.refusing = false; }
  async stop() { this.cut(); await new Promise<void>(r => this.server.close(() => r())); }
}

/** After restoring the network: click "Retry now" if the banner is still up, then wait for sync. */
export async function awaitRecovery(page: Page) {
  const retry = page.getByRole('button', { name: 'Retry now' });
  if (await retry.isVisible()) await retry.click({ timeout: 2_000 }).catch(() => { /* reconnected meanwhile */ });
  await expect(page.getByTestId('connection')).toHaveText('Connected', { timeout: 15_000 });
  await expect(page.getByTestId('sync-status')).toHaveText('All changes synced to server memory', { timeout: 15_000 });
}

/** "Retry now" while still offline must start a new attempt immediately. */
export async function expectRetryButtonStartsAttempt(page: Page) {
  const banner = page.getByTestId('offline-banner');
  const before = Number((await banner.textContent())?.match(/attempt (\d+)/i)?.[1] ?? '0');
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect.poll(async () => Number((await banner.textContent())?.match(/attempt (\d+)/i)?.[1] ?? '0')).toBeGreaterThan(before);
}
