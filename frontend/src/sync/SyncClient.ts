/**
 * SyncClient owns one room session: the local CRDT replica, the WebSocket,
 * the outbox of unacknowledged edits, presence, reconnection and AI requests.
 *
 *  - Every local op stays queued until the server acknowledges it, so edits
 *    made while offline are never dropped.
 *  - Reconnects use bounded exponential backoff with jitter, retry right away
 *    on the browser's `online` event, and a heartbeat catches half-open sockets.
 *  - On (re)connect the server snapshot is merged, never replaced, and only
 *    the ops the server is missing are re-sent. The same path restores a room
 *    after a server restart, since storage is memory-only.
 *  - "Synced" in the UI means every local op has been acked.
 *
 * No framework code in here; React subscribes via `subscribe`/`getState`.
 */
import { RgaDocument, keyOf, CrdtError } from '../crdt/rga.ts';
import type { Op, SnapshotAtom } from '../crdt/rga.ts';
import { parseServerMessage } from '../protocol/messages.ts';
import type { Peer, Limits, AiStatus, ServerMsg, WelcomeMsg } from '../protocol/messages.ts';

export type Phase = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'replaced' | 'stopped';

export type AiRequestState =
  | { status: 'idle' }
  | { status: 'thinking'; requestId: string; docVersion: number }
  | { status: 'ready'; requestId: string; text: string; docVersion: number }
  | { status: 'error'; requestId: string; code: string; message: string }
  | { status: 'cancelled'; requestId: string };

export interface SyncState {
  phase: Phase;
  /** Consecutive failed attempts since the last successful welcome. */
  attempt: number;
  /** Epoch ms of the next scheduled reconnect, if any. */
  retryAt: number | null;
  /** True once a welcome has been received at least once. */
  joined: boolean;
  /** Local ops not yet acknowledged by the server. */
  unsynced: number;
  peers: Peer[];
  ai: AiStatus | null;
  limits: Limits | null;
  /** Increments on every document change (local or remote). */
  version: number;
  aiRequest: AiRequestState;
  /** Last user-relevant problem (e.g. rejected edits), cleared by the UI. */
  notice: { id: number; kind: 'error' | 'info'; text: string } | null;
  /** Unix ms of the last remote edit applied (real activity only). */
  lastRemoteEditAt: number | null;
}

/** Subset of the browser WebSocket API that SyncClient relies on. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SyncClientOptions {
  url: string;
  roomId: string;
  clientId: string;
  name: string;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  now?: () => number;
  /** Backoff tuning (ms). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  welcomeTimeoutMs?: number;
}

const OPEN = 1;
const DEFAULT_LIMITS: Limits = { maxDocAtoms: 200_000, maxOpsPerMessage: 1000, maxMessageBytes: 256 * 1024 };

type DocListener = (kind: 'local' | 'remote' | 'reset') => void;

export class SyncClient {
  readonly roomId: string;
  readonly clientId: string;
  doc: RgaDocument;

  private name: string;
  private opts: Required<Omit<SyncClientOptions, 'url' | 'roomId' | 'clientId' | 'name'>> & { url: string };
  private ws: SocketLike | null = null;
  private state: SyncState;
  private listeners = new Set<() => void>();
  private docListeners = new Set<DocListener>();
  private pending: Op[] = [];
  private outbox: { seq: number; ops: Op[] }[] = [];
  private seq = 0;
  private welcomed = false;
  private resetOnWelcome: string | null = null;
  private retryTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private heartbeatDeadline: unknown = null;
  private welcomeTimer: unknown = null;
  private flushScheduled = false;
  private lastMessageAt = 0;
  private nonce = 0;
  private noticeId = 0;
  private stopped = false;
  private onlineHandler = () => this.retryNow();
  private offlineHandler = () => { if (!this.welcomed || this.state.phase !== 'connected') this.set({ phase: 'offline' }); };

  constructor(o: SyncClientOptions) {
    this.roomId = o.roomId;
    this.clientId = o.clientId;
    this.name = o.name;
    this.opts = {
      url: o.url,
      createSocket: o.createSocket ?? (u => new WebSocket(u) as unknown as SocketLike),
      setTimer: o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: o.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>)),
      random: o.random ?? Math.random,
      now: o.now ?? Date.now,
      backoffBaseMs: o.backoffBaseMs ?? 500,
      backoffMaxMs: o.backoffMaxMs ?? 30_000,
      heartbeatMs: o.heartbeatMs ?? 20_000,
      heartbeatTimeoutMs: o.heartbeatTimeoutMs ?? 10_000,
      welcomeTimeoutMs: o.welcomeTimeoutMs ?? 10_000,
    };
    this.doc = new RgaDocument();
    this.state = {
      phase: 'connecting', attempt: 0, retryAt: null, joined: false, unsynced: 0, peers: [],
      ai: null, limits: null, version: 0, aiRequest: { status: 'idle' }, notice: null, lastRemoteEditAt: null,
    };
  }

  // ── public API ────────────────────────────────────────────────────────────

  getState = (): SyncState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  onDocChange(fn: DocListener): () => void {
    this.docListeners.add(fn);
    return () => { this.docListeners.delete(fn); };
  }

  start(): void {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }
    this.connect();
  }

  /** Close the session for good: timers cancelled, socket closed, listeners kept inert. */
  stop(): void {
    this.stopped = true;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', this.onlineHandler);
      window.removeEventListener('offline', this.offlineHandler);
    }
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) { this.detach(ws); try { ws.close(1000, 'client stopped'); } catch { /* ignore */ } }
    this.set({ phase: 'stopped', retryAt: null });
  }

  /** Skip the backoff wait (e.g. the "Retry now" button or the `online` event). */
  retryNow(): void {
    if (this.stopped || this.state.phase === 'replaced' || this.ws) return;
    if (this.retryTimer !== null) { this.opts.clearTimer(this.retryTimer); this.retryTimer = null; }
    this.connect();
  }

  setName(name: string): void {
    if (name === this.name) return;
    this.name = name;
    if (this.ws) this.dropSocket('rename');
  }

  get limits(): Limits { return this.state.limits ?? DEFAULT_LIMITS; }

  /** Whether `n` more atoms fit within the server's document limit. */
  canInsert(n: number): boolean { return this.doc.size + n <= this.limits.maxDocAtoms; }

  /** Queue ops that were already applied to `doc` by the editor. */
  submit(ops: Op[]): void {
    if (ops.length === 0 || this.stopped) return;
    this.pending.push(...ops);
    this.bump('local');
    this.scheduleFlush();
  }

  requestSuggestion(): string | null {
    const ai = this.state.ai;
    if (!ai?.enabled || this.state.phase !== 'connected' || this.state.aiRequest.status === 'thinking') return null;
    const requestId = `ai${this.opts.now().toString(36)}${Math.floor(this.opts.random() * 1e9).toString(36)}`;
    this.send({ type: 'ai_suggest', requestId });
    this.set({ aiRequest: { status: 'thinking', requestId, docVersion: this.state.version } });
    return requestId;
  }

  cancelSuggestion(): void {
    const r = this.state.aiRequest;
    if (r.status !== 'thinking') return;
    this.send({ type: 'ai_cancel', requestId: r.requestId });
    this.set({ aiRequest: { status: 'cancelled', requestId: r.requestId } });
  }

  dismissSuggestion(): void { this.set({ aiRequest: { status: 'idle' } }); }

  clearNotice(): void { this.set({ notice: null }); }

  // ── connection lifecycle ─────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped || this.ws) return;
    this.retryTimer = null;
    this.welcomed = false;
    const url = `${this.opts.url}?roomId=${encodeURIComponent(this.roomId)}&clientId=${encodeURIComponent(this.clientId)}&name=${encodeURIComponent(this.name)}`;
    let ws: SocketLike;
    try {
      ws = this.opts.createSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.set({ phase: this.state.joined ? 'reconnecting' : 'connecting', retryAt: null });
    ws.onopen = () => {
      this.lastMessageAt = this.opts.now();
      this.welcomeTimer = this.opts.setTimer(() => this.dropSocket('welcome timeout'), this.opts.welcomeTimeoutMs);
    };
    ws.onmessage = ev => this.onMessage(ev.data);
    ws.onerror = () => { /* a close event always follows */ };
    ws.onclose = ev => this.onClose(ev.code, ev.reason);
  }

  private detach(ws: SocketLike): void {
    ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
  }

  /** Abandon the current socket immediately (half-open, timeouts, rename). */
  private dropSocket(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.detach(ws);
    try { ws.close(4100, reason.slice(0, 100)); } catch { /* ignore */ }
    this.onClose(4100, reason);
  }

  private onClose(code: number, _reason: string): void {
    this.ws = null;
    this.welcomed = false;
    this.clearTimers();
    if (this.state.aiRequest.status === 'thinking') {
      this.set({ aiRequest: { status: 'error', requestId: this.state.aiRequest.requestId, code: 'disconnected', message: 'Connection lost before the suggestion arrived.' } });
    }
    if (this.stopped) return;
    if (code === 4001) {
      this.set({ phase: 'replaced', peers: [], retryAt: null });
      return;
    }
    if (code === 1009) this.resetOnWelcome = 'A change was too large for the server and was rolled back.';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const attempt = this.state.attempt + 1;
    const exp = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** Math.min(attempt - 1, 16));
    const delay = Math.round(exp / 2 + this.opts.random() * (exp / 2)); // "equal jitter"
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    this.retryTimer = this.opts.setTimer(() => this.connect(), delay);
    this.set({
      phase: offline ? 'offline' : (this.state.joined ? 'reconnecting' : 'connecting'),
      attempt, retryAt: this.opts.now() + delay, peers: [],
    });
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.heartbeatTimer, this.heartbeatDeadline, this.welcomeTimer]) {
      if (t !== null) this.opts.clearTimer(t);
    }
    this.retryTimer = this.heartbeatTimer = this.heartbeatDeadline = this.welcomeTimer = null;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = this.opts.setTimer(() => {
      this.heartbeatTimer = null;
      const sentAt = this.opts.now();
      this.send({ type: 'ping', nonce: ++this.nonce });
      this.heartbeatDeadline = this.opts.setTimer(() => {
        this.heartbeatDeadline = null;
        if (this.lastMessageAt < sentAt) this.dropSocket('heartbeat timeout');
      }, this.opts.heartbeatTimeoutMs);
      this.startHeartbeat();
    }, this.opts.heartbeatMs);
  }

  // ── messages ─────────────────────────────────────────────────────────────

  private send(msg: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private onMessage(data: unknown): void {
    this.lastMessageAt = this.opts.now();
    const msg = typeof data === 'string' ? parseServerMessage(data) : null;
    if (!msg) {
      this.notify('error', 'Received an invalid message from the server; reconnecting.');
      this.resetOnWelcome = 'The connection was reset after an invalid server message.';
      this.dropSocket('invalid server message');
      return;
    }
    try {
      this.handle(msg);
    } catch (e) {
      const code = e instanceof CrdtError ? e.code : 'internal';
      this.resetOnWelcome = `Local state could not apply a server update (${code}) and was reloaded.`;
      this.dropSocket('apply failed');
    }
  }

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case 'welcome': return this.onWelcome(msg);
      case 'ops': {
        let changed = 0;
        for (const op of msg.ops) if (this.doc.apply(op) === 'applied') changed++;
        if (changed > 0) {
          this.state = { ...this.state, lastRemoteEditAt: this.opts.now() };
          this.bump('remote');
        }
        return;
      }
      case 'ack': {
        this.outbox = this.outbox.filter(b => b.seq > msg.seq);
        this.set({ unsynced: this.countUnsynced() });
        return;
      }
      case 'presence': return this.set({ peers: msg.peers });
      case 'error': {
        this.resetOnWelcome = `The server rejected recent edits (${msg.code}); they were rolled back.`;
        return; // the server closes the socket next; we reconnect and reload.
      }
      case 'pong': return;
      case 'ai_result': {
        const r = this.state.aiRequest;
        if (r.status === 'thinking' && r.requestId === msg.requestId) {
          this.set({ aiRequest: { status: 'ready', requestId: r.requestId, text: msg.text, docVersion: r.docVersion } });
        }
        return; // results for stale/cancelled requests are ignored
      }
      case 'ai_error': {
        const r = this.state.aiRequest;
        if (r.status === 'thinking' && r.requestId === msg.requestId) {
          this.set({ aiRequest: msg.code === 'cancelled'
            ? { status: 'cancelled', requestId: r.requestId }
            : { status: 'error', requestId: r.requestId, code: msg.code, message: msg.message } });
        }
        return;
      }
    }
  }

  private onWelcome(msg: WelcomeMsg): void {
    if (this.welcomeTimer !== null) { this.opts.clearTimer(this.welcomeTimer); this.welcomeTimer = null; }
    const limits = msg.limits;
    if (this.resetOnWelcome) {
      // Discard local state that the server refused; keep the Lamport clock
      // moving forward so new IDs never collide with discarded ones.
      const clock = this.doc.lamport;
      this.doc = new RgaDocument();
      this.doc.observe(clock);
      this.doc.mergeSnapshot(msg.snapshot);
      this.pending = [];
      this.outbox = [];
      this.notify('error', this.resetOnWelcome);
      this.resetOnWelcome = null;
      this.emitDoc('reset');
    } else {
      const changed = this.doc.mergeSnapshot(msg.snapshot);
      // Re-send whatever the server does not have: unacked local edits, or the
      // whole document if the server lost the room (restart / eviction).
      const missing = missingOps(this.doc.snapshot(), msg.snapshot);
      this.pending = [];
      this.outbox = [];
      for (let i = 0; i < missing.length; i += limits.maxOpsPerMessage) {
        const ops = missing.slice(i, i + limits.maxOpsPerMessage);
        const seq = ++this.seq;
        this.outbox.push({ seq, ops });
      }
      if (changed > 0) this.emitDoc('remote');
    }
    this.welcomed = true;
    this.set({
      version: this.state.version + 1,
      phase: 'connected', attempt: 0, retryAt: null, joined: true, peers: msg.peers,
      ai: msg.ai, limits, unsynced: this.countUnsynced(),
    });
    for (const b of this.outbox) this.send({ type: 'sync', seq: b.seq, ops: b.ops });
    this.startHeartbeat();
  }

  // ── outgoing edits ───────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => { this.flushScheduled = false; this.flush(); });
  }

  private flush(): void {
    if (!this.welcomed || !this.ws || this.ws.readyState !== OPEN || this.pending.length === 0) {
      this.set({ unsynced: this.countUnsynced() });
      return;
    }
    const max = this.limits.maxOpsPerMessage;
    while (this.pending.length > 0) {
      const ops = this.pending.splice(0, max);
      const seq = ++this.seq;
      this.outbox.push({ seq, ops });
      this.send({ type: 'ops', seq, ops });
    }
    this.set({ unsynced: this.countUnsynced() });
  }

  private countUnsynced(): number {
    let n = this.pending.length;
    for (const b of this.outbox) n += b.ops.length;
    return n;
  }

  // ── state plumbing ───────────────────────────────────────────────────────

  private bump(kind: 'local' | 'remote'): void {
    this.state = { ...this.state, version: this.state.version + 1, unsynced: this.countUnsynced() };
    this.emitDoc(kind);
    this.emit();
  }

  private emitDoc(kind: 'local' | 'remote' | 'reset'): void {
    for (const fn of this.docListeners) fn(kind);
  }

  private notify(kind: 'error' | 'info', text: string): void {
    this.state = { ...this.state, notice: { id: ++this.noticeId, kind, text } };
  }

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void { for (const fn of this.listeners) fn(); }
}

/** Ops present in `local` but not in the server snapshot `remote`. */
export function missingOps(local: readonly SnapshotAtom[], remote: readonly SnapshotAtom[]): Op[] {
  const known = new Map<string, boolean>();
  for (const s of remote) known.set(keyOf(s.id), s.d === true);
  const ops: Op[] = [];
  for (const s of local) if (!known.has(keyOf(s.id))) ops.push({ k: 'i', id: s.id, o: s.o, v: s.v });
  for (const s of local) if (s.d && known.get(keyOf(s.id)) !== true) ops.push({ k: 'd', id: s.id });
  return ops;
}
