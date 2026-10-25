/**
 * Minimal protocol-v2 client for conformance tests and benchmarks. Uses Node's
 * built-in WebSocket (no browser) and the same CRDT as the app.
 */
import { RgaDocument } from '../../src/crdt/rga.ts';
import type { Op, AtomId } from '../../src/crdt/rga.ts';
import type { ServerMsg, WelcomeMsg, Peer } from '../../src/protocol/messages.ts';

export const BASE = (process.env.SERVER_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
export const WS_BASE = BASE.replace(/^http/, 'ws');

let counter = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface Closed { code: number; reason: string }

export class TestClient {
  ws!: WebSocket;
  doc = new RgaDocument();
  clientId: string;
  roomId: string;
  name: string;
  inbox: ServerMsg[] = [];
  welcome: WelcomeMsg | null = null;
  peers: Peer[] = [];
  acked = 0;
  seq = 0;
  closed: Closed | null = null;
  /** Unacked batches, resent after reconnect (mirrors the browser client). */
  outbox: { seq: number; ops: Op[] }[] = [];
  onOps: ((ops: Op[], from: string) => void) | null = null;
  private waiters: (() => void)[] = [];

  constructor(roomId: string, clientId = uid('c'), name = 'Tester') {
    this.roomId = roomId; this.clientId = clientId; this.name = name;
  }

  url(): string {
    return `${WS_BASE}/ws?roomId=${encodeURIComponent(this.roomId)}&clientId=${encodeURIComponent(this.clientId)}&name=${encodeURIComponent(this.name)}`;
  }

  connect(): Promise<WelcomeMsg> {
    this.closed = null;
    this.welcome = null;
    this.ws = new WebSocket(this.url());
    this.ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      this.inbox.push(msg);
      if (msg.type === 'welcome') {
        this.welcome = msg; this.peers = msg.peers;
        this.doc.mergeSnapshot(msg.snapshot);
      } else if (msg.type === 'ops') {
        for (const op of msg.ops) this.doc.apply(op);
        this.onOps?.(msg.ops, msg.from);
      } else if (msg.type === 'ack') {
        this.acked = Math.max(this.acked, msg.seq);
        this.outbox = this.outbox.filter(b => b.seq > msg.seq);
      } else if (msg.type === 'presence') {
        this.peers = msg.peers;
      }
      this.notify();
    };
    this.ws.onclose = ev => { this.closed = { code: ev.code, reason: ev.reason }; this.notify(); };
    return this.waitFor(() => this.welcome, 'welcome') as Promise<WelcomeMsg>;
  }

  private notify() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }

  /** Resolve when `pred` returns a truthy value; reject after timeout. */
  async waitFor<T>(pred: () => T | null | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = pred();
      if (v) return v;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what} (client ${this.clientId})`);
      await new Promise<void>(res => { const t = setTimeout(res, Math.min(left, 250)); this.waiters.push(() => { clearTimeout(t); res(); }); });
    }
  }

  sendRaw(data: string | Uint8Array<ArrayBuffer>) { this.ws.send(data); }

  sendOps(ops: Op[], type: 'ops' | 'sync' = 'ops'): number {
    const seq = ++this.seq;
    if (type === 'ops') this.outbox.push({ seq, ops });
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, seq, ops }));
    return seq;
  }

  /** Insert text at a visible index and send it. */
  type(pos: number, text: string): number {
    const { ids } = this.doc.visibleAtoms();
    const after: AtomId | null = pos === 0 ? null : ids[Math.min(pos, ids.length) - 1];
    return this.sendOps(this.doc.insertText(this.clientId, after, text));
  }

  erase(from: number, count: number): number | null {
    const { ids } = this.doc.visibleAtoms();
    const ops = this.doc.deleteIds(ids.slice(from, from + count));
    return ops.length ? this.sendOps(ops) : null;
  }

  resendOutbox() {
    for (const b of this.outbox) this.ws.send(JSON.stringify({ type: 'ops', seq: b.seq, ops: b.ops }));
  }

  waitAcked(seq = this.seq, timeoutMs = 10000) { return this.waitFor(() => this.acked >= seq, `ack ${seq}`, timeoutMs); }
  waitClosed(timeoutMs = 5000) { return this.waitFor(() => this.closed, 'close', timeoutMs); }
  lastError() { return [...this.inbox].reverse().find(m => m.type === 'error') as Extract<ServerMsg, { type: 'error' }> | undefined; }

  close() { if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000); }
}

export async function roomText(roomId: string): Promise<{ status: number; text?: string; epoch?: string }> {
  const res = await fetch(`${BASE}/api/room/text?roomId=${encodeURIComponent(roomId)}`);
  const body = await res.json() as { text?: string; epoch?: string };
  return { status: res.status, text: body.text, epoch: body.epoch };
}

/** Poll until every client's text equals the server's text. */
export async function waitConverged(roomId: string, clients: TestClient[], timeoutMs = 10000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const srv = (await roomText(roomId)).text ?? '';
    const texts = clients.map(c => c.doc.text());
    if (texts.every(t => t === srv)) return srv;
    last = `server=${JSON.stringify(srv.slice(0, 60))} clients=${texts.map(t => JSON.stringify(t.slice(0, 60))).join(',')}`;
    if (Date.now() > deadline) throw new Error(`not converged: ${last}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
