/**
 * Protocol v2 conformance suite. Backend-agnostic: point SERVER_URL at the Go
 * server (CI) or the TS test server. Run via `npm run test:protocol`, which
 * starts the TS test server unless SERVER_URL is already set.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TestClient, BASE, uid, roomText, waitConverged } from './client.ts';
import { mulberry32 } from '../../src/testing/random.ts';
import { RgaDocument } from '../../src/crdt/rga.ts';

const open: TestClient[] = [];
function client(room: string, id?: string, name?: string) { const c = new TestClient(room, id, name); open.push(c); return c; }
after(() => { for (const c of open) c.close(); });

describe('HTTP endpoints', () => {
  test('health and readiness report ok', async () => {
    const h = await fetch(`${BASE}/health`);
    assert.equal(h.status, 200);
    assert.equal((await h.json() as { status: string }).status, 'ok');
    const r = await fetch(`${BASE}/readyz`);
    assert.equal(r.status, 200);
  });
  test('room text endpoint validates ids and 404s unknown rooms', async () => {
    assert.equal((await roomText('bad id!')).status, 400);
    assert.equal((await roomText(uid('never'))).status, 404);
  });
});

describe('join and presence', () => {
  test('welcome carries empty snapshot, limits, persistence mode, AI status', async () => {
    const room = uid('r');
    const a = client(room, undefined, 'Ada');
    const w = await a.connect();
    assert.equal(w.protocol, 2);
    assert.equal(w.roomId, room);
    assert.deepEqual(w.snapshot, []);
    assert.equal(w.persistence, 'memory');
    assert.ok(w.limits.maxDocAtoms > 0 && w.limits.maxOpsPerMessage > 0 && w.limits.maxMessageBytes > 0);
    assert.equal(typeof w.ai.enabled, 'boolean');
    assert.deepEqual(w.peers.map(p => p.name), ['Ada']);
  });

  test('presence updates on join and leave', async () => {
    const room = uid('r');
    const a = client(room, undefined, 'Ada'); await a.connect();
    const b = client(room, undefined, 'Bo'); await b.connect();
    await a.waitFor(() => a.peers.length === 2, 'presence 2');
    assert.deepEqual(b.welcome!.peers.map(p => p.name).sort(), ['Ada', 'Bo']);
    b.close();
    await a.waitFor(() => a.peers.length === 1, 'presence 1');
    assert.equal(a.peers[0].id, a.clientId);
  });

  test('a second connection with the same client id replaces the first (4001)', async () => {
    const room = uid('r'); const id = uid('c');
    const a1 = client(room, id); await a1.connect();
    const a2 = client(room, id); await a2.connect();
    const closed = await a1.waitClosed();
    assert.equal(closed.code, 4001);
    assert.equal(a2.closed, null);
  });
});

describe('two-client collaboration', () => {
  test('edits from A reach B, and B edits reach A', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    const b = client(room); await b.connect();
    await a.waitAcked(a.type(0, 'Hello'));
    await b.waitFor(() => b.doc.text() === 'Hello', 'B sees Hello');
    await b.waitAcked(b.type(5, ', world'));
    await a.waitFor(() => a.doc.text() === 'Hello, world', 'A sees reply');
    assert.equal(await waitConverged(room, [a, b]), 'Hello, world');
  });

  test('sender does not receive an echo of its own ops', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    const b = client(room); await b.connect();
    await a.waitAcked(a.type(0, 'abc'));
    await b.waitFor(() => b.doc.text() === 'abc', 'B');
    assert.equal(a.inbox.filter(m => m.type === 'ops').length, 0);
  });

  test('concurrent typing at the same position converges without interleaving runs', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    const b = client(room); await b.connect();
    await a.waitAcked(a.type(0, '[]'));
    await b.waitFor(() => b.doc.text() === '[]', 'seed');
    a.type(1, 'alpha'); b.type(1, 'bravo'); // no waiting: truly concurrent
    await a.waitAcked(); await b.waitAcked();
    const text = await waitConverged(room, [a, b]);
    assert.ok(['[alphabravo]', '[bravoalpha]'].includes(text), text);
  });

  test('delete while the other client inserts nearby', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    const b = client(room); await b.connect();
    await a.waitAcked(a.type(0, 'abcdef'));
    await b.waitFor(() => b.doc.text() === 'abcdef', 'seed');
    a.erase(1, 4);        // removes bcde
    b.type(3, 'XY');      // inserts between c and d (concurrently deleted neighbours)
    await a.waitAcked(); await b.waitAcked();
    assert.equal(await waitConverged(room, [a, b]), 'aXYf');
  });
});

describe('convergence under load', () => {
  test('randomized: 4 clients x 150 interleaved edits converge with the server', async () => {
    const room = uid('rand');
    const clients = [0, 1, 2, 3].map(i => client(room, undefined, `P${i}`));
    for (const c of clients) await c.connect();
    const rnd = mulberry32(20261025);
    const alphabet = ['a', 'b', ' ', '\n', 'é', '😀'];
    let sent = 0;
    for (let step = 0; step < 600; step++) {
      const c = clients[Math.floor(rnd() * clients.length)];
      const len = c.doc.length;
      if (len > 0 && rnd() < 0.3) { if (c.erase(Math.floor(rnd() * len), 1 + Math.floor(rnd() * 3)) !== null) sent++; }
      else { c.type(Math.floor(rnd() * (len + 1)), alphabet[Math.floor(rnd() * alphabet.length)]); sent++; }
      if (step % 50 === 0) await new Promise(r => setTimeout(r, 5)); // let deliveries interleave
    }
    for (const c of clients) await c.waitAcked(c.seq, 20000);
    const text = await waitConverged(room, clients, 20000);
    const fp = clients[0].doc.fingerprint();
    for (const c of clients) assert.equal(c.doc.fingerprint(), fp, 'replicas must be identical including tombstones');
    assert.ok(sent > 500);
    assert.ok(text.length > 0);
  });
});

describe('late join, reconnect, idempotency', () => {
  test('late joiner gets full state including tombstones', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    await a.waitAcked(a.type(0, 'hello world'));
    await a.waitAcked(a.erase(5, 6)!);
    const late = client(room); await late.connect();
    assert.equal(late.doc.text(), 'hello');
    assert.equal(late.doc.fingerprint(), a.doc.fingerprint());
    assert.equal(late.welcome!.snapshot.filter(s => s.d).length, 6);
  });

  test('reconnect with offline edits merges both sides', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    const b = client(room); await b.connect();
    await a.waitAcked(a.type(0, 'shared'));
    await b.waitFor(() => b.doc.text() === 'shared', 'seed');
    a.close(); await a.waitClosed();
    a.type(6, ' (offline A)');                 // queued in outbox while disconnected
    await b.waitAcked(b.type(0, '[B] '));      // concurrent online edit
    await a.connect();                          // welcome snapshot merged
    a.resendOutbox();
    await a.waitAcked(a.seq);
    assert.equal(await waitConverged(room, [a, b]), '[B] shared (offline A)');
  });

  test('resending an already-applied batch is idempotent', async () => {
    const room = uid('r');
    const a = client(room); await a.connect();
    const ops = a.doc.insertText(a.clientId, null, 'once');
    a.sendRaw(JSON.stringify({ type: 'ops', seq: 1, ops }));
    a.sendRaw(JSON.stringify({ type: 'ops', seq: 2, ops }));
    a.seq = 2; await a.waitAcked(2);
    assert.equal((await roomText(room)).text, 'once');
  });

  test('sync replays state authored by others (server-restart recovery path)', async () => {
    const room = uid('r');
    const offline = new RgaDocument();
    offline.insertText('someoneElse', null, 'recovered text');
    const a = client(room); await a.connect();
    a.sendOps(offline.toOps(), 'sync');
    await a.waitAcked(a.seq);
    assert.equal((await roomText(room)).text, 'recovered text');
  });

  test('rooms are isolated', async () => {
    const r1 = uid('r'), r2 = uid('r');
    const a = client(r1); await a.connect();
    const b = client(r2); await b.connect();
    await a.waitAcked(a.type(0, 'only in r1'));
    await new Promise(r => setTimeout(r, 100));
    assert.equal(b.doc.text(), '');
    assert.equal(b.inbox.filter(m => m.type === 'ops').length, 0);
  });

  test('ping gets pong', async () => {
    const a = client(uid('r')); await a.connect();
    a.sendRaw(JSON.stringify({ type: 'ping', nonce: 42 }));
    await a.waitFor(() => a.inbox.find(m => m.type === 'pong' && m.nonce === 42), 'pong');
  });
});

describe('rejection of invalid input', () => {
  async function expectProtocolError(send: (c: TestClient) => void, code: string) {
    const c = client(uid('bad')); await c.connect();
    send(c);
    const closed = await c.waitClosed();
    assert.equal(closed.code, 4000, `close code for ${code}`);
    assert.equal(c.lastError()?.code, code);
  }
  test('malformed JSON', () => expectProtocolError(c => c.sendRaw('{not json'), 'bad_json'));
  test('unknown message type', () => expectProtocolError(c => c.sendRaw('{"type":"nope"}'), 'bad_message'));
  test('binary frames', () => expectProtocolError(c => c.sendRaw(new Uint8Array([1, 2, 3])), 'bad_message'));
  test('structurally invalid op (two code points)', () => expectProtocolError(
    c => c.sendRaw(JSON.stringify({ type: 'ops', seq: 1, ops: [{ k: 'i', id: { c: c.clientId, t: 1 }, o: null, v: 'ab' }] })), 'invalid_op'));
  test('insert authored by another client in an ops message', () => expectProtocolError(
    c => c.sendRaw(JSON.stringify({ type: 'ops', seq: 1, ops: [{ k: 'i', id: { c: 'impostor', t: 1 }, o: null, v: 'x' }] })), 'foreign_author'));
  test('insert after an unknown origin', () => expectProtocolError(
    c => c.sendRaw(JSON.stringify({ type: 'ops', seq: 1, ops: [{ k: 'i', id: { c: c.clientId, t: 9 }, o: { c: 'ghost', t: 3 }, v: 'x' }] })), 'unknown_origin'));
  test('delete of an unknown atom', () => expectProtocolError(
    c => c.sendRaw(JSON.stringify({ type: 'ops', seq: 1, ops: [{ k: 'd', id: { c: 'ghost', t: 3 } }] })), 'unknown_target'));
  test('too many ops in one message', async () => {
    const c = client(uid('bad')); await c.connect();
    const max = c.welcome!.limits.maxOpsPerMessage;
    const ops = new RgaDocument().insertText(c.clientId, null, 'x'.repeat(max + 1));
    c.sendRaw(JSON.stringify({ type: 'ops', seq: 1, ops }));
    assert.equal((await c.waitClosed()).code, 4000);
    assert.equal(c.lastError()?.code, 'too_many_ops');
  });
  test('oversized message is refused with close code 1009', async () => {
    const c = client(uid('bad')); await c.connect();
    c.sendRaw('x'.repeat(c.welcome!.limits.maxMessageBytes + 1024));
    assert.equal((await c.waitClosed()).code, 1009);
  });
  test('upgrade with invalid room id is rejected with 400', async () => {
    const status = await upgradeStatus(`/ws?roomId=${encodeURIComponent('bad room!')}&clientId=abc`);
    assert.equal(status, 400);
  });
  test('upgrade from a disallowed browser origin is rejected with 403', async () => {
    const status = await upgradeStatus(`/ws?roomId=${uid('r')}&clientId=abc`, 'https://evil.example');
    assert.equal(status, 403);
  });
  test('AI request when AI is disabled returns a clear error, editing unaffected', async (t) => {
    const c = client(uid('ai')); await c.connect();
    if (c.welcome!.ai.enabled) { t.skip('server has AI configured'); return; }
    c.sendRaw(JSON.stringify({ type: 'ai_suggest', requestId: 'req1' }));
    await c.waitFor(() => c.inbox.find(m => m.type === 'ai_error' && m.code === 'disabled'), 'ai_error');
    await c.waitAcked(c.type(0, 'still editable'));
    assert.equal(c.closed, null);
  });
});

/** Perform a raw WebSocket upgrade and return the HTTP status code. */
function upgradeStatus(pathAndQuery: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${pathAndQuery}`, {
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
    req.on('response', res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}
