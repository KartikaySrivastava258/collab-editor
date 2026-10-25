import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient, missingOps } from './SyncClient.ts';
import type { SocketLike } from './SyncClient.ts';
import { RgaDocument } from '../crdt/rga.ts';
import type { Op } from '../crdt/rga.ts';
import { startServer, configFromEnv } from '../../test-server/server.ts';

// ── deterministic harness ──────────────────────────────────────────────────

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  url: string;
  constructor(url: string) { this.url = url; }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code = 1000) { this.closedWith = code; }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
}

function harness(extra: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const sockets: FakeSocket[] = [];
  const client = new SyncClient({
    url: 'ws://test/ws', roomId: 'room1', clientId: 'me', name: 'Me',
    createSocket: u => { const s = new FakeSocket(u); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: h => { timers.delete(h as number); },
    random: () => 0.5, now: () => now,
    ...extra,
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  const last = () => sockets[sockets.length - 1];
  return { client, sockets, last, advance, timers, get now() { return now; } };
}

const welcome = (snapshot: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: 'welcome', protocol: 2, roomId: 'room1', clientId: 'me', epoch: 'e1', snapshot,
  peers: [{ id: 'me', name: 'Me' }], ai: { enabled: false, reason: 'off' },
  limits: { maxDocAtoms: 1000, maxOpsPerMessage: 3, maxMessageBytes: 65536 }, persistence: 'memory', ...extra,
});
const flushMicrotasks = () => new Promise<void>(r => setImmediate(r));

describe('SyncClient (deterministic)', () => {
  test('connects, applies welcome, reports connected and synced', () => {
    const h = harness(); h.client.start();
    assert.equal(h.client.getState().phase, 'connecting');
    h.last().open(); h.last().recv(welcome());
    const s = h.client.getState();
    assert.equal(s.phase, 'connected');
    assert.equal(s.joined, true);
    assert.equal(s.unsynced, 0);
    assert.match(h.last().url, /roomId=room1&clientId=me&name=Me/);
  });

  test('backoff grows exponentially with jitter, is bounded, and resets after welcome', () => {
    const h = harness({ backoffBaseMs: 500, backoffMaxMs: 4000 }); h.client.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.last().serverClose(1006);
      const st = h.client.getState();
      delays.push(st.retryAt! - h.now);
      assert.equal(st.attempt, i + 1);
      h.advance(st.retryAt! - h.now);
    }
    // random()=0.5 → delay = 0.75 * min(max, base*2^(n-1))
    assert.deepEqual(delays, [375, 750, 1500, 3000, 3000, 3000]);
    h.last().open(); h.last().recv(welcome());
    assert.equal(h.client.getState().attempt, 0);
  });

  test('stop() cancels pending reconnects and closes the socket', () => {
    const h = harness(); h.client.start();
    h.last().serverClose(1006);
    assert.equal(h.timers.size, 1);
    h.client.stop();
    assert.equal(h.timers.size, 0);
    h.advance(60_000);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.client.getState().phase, 'stopped');
  });

  test('replaced session (4001) does not reconnect', () => {
    const h = harness(); h.client.start(); h.last().open(); h.last().recv(welcome());
    h.last().serverClose(4001);
    h.advance(60_000);
    assert.equal(h.client.getState().phase, 'replaced');
    assert.equal(h.sockets.length, 1);
  });

  test('edits made offline are queued, then sent as one sync batch after welcome; ack clears them', async () => {
    const h = harness(); h.client.start();
    const ops = h.client.doc.insertText('me', null, 'hi!!'); // 4 ops, maxOpsPerMessage = 3
    h.client.submit(ops);
    await flushMicrotasks();
    assert.equal(h.client.getState().unsynced, 4);
    assert.equal(h.last().sent.length, 0);
    h.last().open(); h.last().recv(welcome());
    const sent = h.last().sent.filter(m => m.type === 'sync');
    assert.deepEqual(sent.map(m => (m.ops as Op[]).length), [3, 1], 'chunked by maxOpsPerMessage');
    assert.equal(h.client.getState().unsynced, 4);
    h.last().recv({ type: 'ack', seq: sent[1].seq });
    assert.equal(h.client.getState().unsynced, 0);
  });

  test('online edits are batched per microtask and acked', async () => {
    const h = harness(); h.client.start(); h.last().open(); h.last().recv(welcome());
    h.client.submit(h.client.doc.insertText('me', null, 'a'));
    h.client.submit(h.client.doc.insertText('me', h.client.doc.visibleAtoms().ids[0], 'b'));
    await flushMicrotasks();
    const batches = h.last().sent.filter(m => m.type === 'ops');
    assert.equal(batches.length, 1);
    assert.equal((batches[0].ops as Op[]).length, 2);
    h.last().recv({ type: 'ack', seq: batches[0].seq });
    assert.equal(h.client.getState().unsynced, 0);
  });

  test('reconnect re-sends only what the server is missing', () => {
    const h = harness(); h.client.start(); h.last().open();
    const server = new RgaDocument();
    server.insertText('peer', null, 'abc');
    h.last().recv(welcome(server.snapshot()));
    const mine = h.client.doc.insertText('me', h.client.doc.visibleAtoms().ids[2], 'Z');
    h.client.submit(mine);
    h.last().serverClose(1006);
    h.advance(10_000);
    h.last().open(); h.last().recv(welcome(server.snapshot(), { epoch: 'e1' }));
    const sync = h.last().sent.filter(m => m.type === 'sync');
    assert.equal(sync.length, 1);
    assert.deepEqual(sync[0].ops, mine);
  });

  test('server lost the room (empty snapshot, new epoch): full state is restored via sync', () => {
    const h = harness(); h.client.start(); h.last().open();
    const server = new RgaDocument(); server.insertText('peer', null, 'keep me');
    h.last().recv(welcome(server.snapshot()));
    h.last().serverClose(1001);
    h.advance(10_000);
    h.last().open(); h.last().recv(welcome([], { epoch: 'e2' }));
    const restored = new RgaDocument();
    for (const m of h.last().sent.filter(x => x.type === 'sync')) for (const op of m.ops as Op[]) restored.apply(op);
    assert.equal(restored.text(), 'keep me');
  });

  test('rejected batch: local state is rolled back to the server snapshot with a notice', () => {
    const h = harness(); h.client.start(); h.last().open(); h.last().recv(welcome());
    h.client.submit(h.client.doc.insertText('me', null, 'bad'));
    const clockBefore = h.client.doc.lamport;
    h.last().recv({ type: 'error', code: 'doc_too_large', message: 'x', seq: 1 });
    h.last().serverClose(4000);
    h.advance(10_000);
    h.last().open(); h.last().recv(welcome());
    assert.equal(h.client.doc.text(), '');
    assert.ok(h.client.doc.lamport >= clockBefore, 'clock must not go backwards');
    assert.match(h.client.getState().notice!.text, /rejected/);
    assert.equal(h.client.getState().unsynced, 0);
  });

  test('heartbeat timeout drops a half-open socket and reconnects', () => {
    const h = harness({ heartbeatMs: 1000, heartbeatTimeoutMs: 500 }); h.client.start();
    h.last().open(); h.last().recv(welcome());
    h.advance(1000);
    assert.equal(h.last().sent.at(-1)!.type, 'ping');
    h.advance(600); // no pong
    assert.equal(h.sockets[0].closedWith, 4100);
    assert.equal(h.client.getState().phase, 'reconnecting');
  });

  test('missing welcome after open is treated as a failed attempt', () => {
    const h = harness({ welcomeTimeoutMs: 2000 }); h.client.start();
    h.last().open();
    h.advance(2100);
    assert.equal(h.client.getState().attempt, 1);
  });

  test('AI: disabled server refuses locally; stale and cancelled results are ignored', () => {
    const h = harness(); h.client.start(); h.last().open(); h.last().recv(welcome());
    assert.equal(h.client.requestSuggestion(), null);
    h.last().recv(welcome([], { ai: { enabled: true } }));
    const r1 = h.client.requestSuggestion()!;
    assert.equal(h.client.getState().aiRequest.status, 'thinking');
    h.client.cancelSuggestion();
    h.last().recv({ type: 'ai_result', requestId: r1, text: 'late' });
    assert.equal(h.client.getState().aiRequest.status, 'cancelled');
    const r2 = h.client.requestSuggestion()!;
    h.last().recv({ type: 'ai_result', requestId: 'someOtherId', text: 'wrong' });
    assert.equal(h.client.getState().aiRequest.status, 'thinking');
    h.last().recv({ type: 'ai_result', requestId: r2, text: 'right' });
    const s = h.client.getState().aiRequest;
    assert.equal(s.status === 'ready' && s.text, 'right');
  });

  test('AI: disconnect while thinking surfaces an error instead of hanging', () => {
    const h = harness(); h.client.start(); h.last().open(); h.last().recv(welcome([], { ai: { enabled: true } }));
    h.client.requestSuggestion();
    h.last().serverClose(1006);
    const s = h.client.getState().aiRequest;
    assert.equal(s.status, 'error');
    assert.equal(s.status === 'error' && s.code, 'disconnected');
  });

  test('missingOps computes inserts then deletes the server lacks', () => {
    const local = new RgaDocument(); local.insertText('a', null, 'abc');
    const remote = local.snapshot();
    const ids = local.visibleAtoms().ids;
    local.deleteIds([ids[1]]);
    local.insertText('a', ids[2], 'd');
    const ops = missingOps(local.snapshot(), remote);
    assert.deepEqual(ops.map(o => o.k), ['i', 'd']);
  });
});

// ── integration against the real (TS) server, in-process ───────────────────

async function waitUntil(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('SyncClient against the test server', () => {
  test('two clients converge; server restart loses memory but clients restore the room', async () => {
    const cfg = { ...configFromEnv(), port: 0, silent: true };
    let srv = await startServer(cfg);
    const port = srv.port;
    const mk = (id: string) => {
      const c = new SyncClient({ url: `ws://127.0.0.1:${port}/ws`, roomId: 'it-room', clientId: id, name: id, backoffBaseMs: 50, backoffMaxMs: 200 });
      c.start();
      return c;
    };
    const a = mk('alice'), b = mk('bob');
    try {
      await waitUntil(() => a.getState().phase === 'connected' && b.getState().phase === 'connected', 'connect');
      await waitUntil(() => a.getState().peers.length === 2, 'presence');
      a.submit(a.doc.insertText('alice', null, 'Hello'));
      await waitUntil(() => b.doc.text() === 'Hello', 'B receives');
      // concurrent edits
      a.submit(a.doc.insertText('alice', a.doc.visibleAtoms().ids[4], ' A'));
      b.submit(b.doc.insertText('bob', b.doc.visibleAtoms().ids[4], ' B'));
      await waitUntil(() => a.doc.text() === b.doc.text() && a.getState().unsynced === 0 && b.getState().unsynced === 0, 'converge');
      const before = a.doc.text();

      // Restart the server on the same port: all in-memory rooms are lost.
      await srv.shutdown();
      await waitUntil(() => a.getState().phase !== 'connected', 'A notices');
      a.submit(a.doc.insertText('alice', null, '>')); // edit while the server is down
      srv = await startServer({ ...cfg, port });
      await waitUntil(() => a.getState().phase === 'connected' && b.getState().phase === 'connected', 'reconnect', 15000);
      await waitUntil(() => a.getState().unsynced === 0 && b.getState().unsynced === 0, 'resynced', 15000);
      await waitUntil(() => a.doc.text() === b.doc.text(), 'converged after restart');
      assert.equal(a.doc.text(), '>' + before);
      const res = await fetch(`http://127.0.0.1:${port}/api/room/text?roomId=it-room`);
      assert.equal((await res.json() as { text: string }).text, a.doc.text(), 'server restored from clients');
    } finally {
      a.stop(); b.stop();
      await srv.shutdown();
    }
  });
});
