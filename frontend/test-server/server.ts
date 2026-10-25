/**
 * Protocol test server (TypeScript).
 *
 * PURPOSE: an executable specification of protocol v2 that reuses the exact
 * CRDT + validation modules the browser uses. It lets the protocol
 * conformance suite (tests/protocol) and the Playwright E2E tests run where Go
 * is not installed. It is NOT the production backend — that is backend/ (Go),
 * and CI runs the same suites against the Go server.
 *
 * Run:  node test-server/server.ts            (from frontend/, Node >= 22.18)
 * Env:  PORT, ALLOWED_ORIGINS, MAX_DOC_ATOMS, MAX_ROOMS, MAX_MESSAGE_BYTES,
 *       LLM_API_KEY, LLM_API_URL, LLM_MODEL, AI_TIMEOUT_MS, STATIC_DIR
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { RgaDocument, CrdtError, keyOf, CLIENT_ID_RE } from '../src/crdt/rga.ts';
import type { Op } from '../src/crdt/rga.ts';
import {
  PROTOCOL_VERSION, ROOM_ID_RE, CloseCode, parseClientMessage, sanitizeName,
} from '../src/protocol/messages.ts';
import type { Limits, Peer, ServerMsg, ClientOpsMsg, ClientSyncMsg } from '../src/protocol/messages.ts';

const env = process.env;
const intEnv = (k: string, d: number) => { const v = Number(env[k]); return Number.isInteger(v) && v > 0 ? v : d; };

export interface ServerConfig {
  port: number;
  allowedOrigins: string[];
  limits: Limits;
  maxRooms: number;
  maxClientsPerRoom: number;
  llm: { key: string; url: string; model: string; timeoutMs: number };
  staticDir: string;
  sendQueueBytes: number;
  silent?: boolean;
}

export function configFromEnv(): ServerConfig {
  return {
    port: intEnv('PORT', 8080),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => s.trim()).filter(Boolean),
    limits: { maxDocAtoms: intEnv('MAX_DOC_ATOMS', 200_000), maxOpsPerMessage: 1000, maxMessageBytes: intEnv('MAX_MESSAGE_BYTES', 256 * 1024) },
    maxRooms: intEnv('MAX_ROOMS', 100),
    maxClientsPerRoom: intEnv('MAX_CLIENTS_PER_ROOM', 50),
    llm: { key: env.LLM_API_KEY ?? '', url: (env.LLM_API_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''), model: env.LLM_MODEL ?? '', timeoutMs: intEnv('AI_TIMEOUT_MS', 20_000) },
    staticDir: env.STATIC_DIR ?? '',
    sendQueueBytes: 4 * 1024 * 1024,
  };
}

interface Conn {
  ws: WebSocket;
  clientId: string;
  name: string;
  room: Room;
  ai: { requestId: string; abort: AbortController } | null;
  alive: boolean;
}

interface Room {
  id: string;
  epoch: string;
  doc: RgaDocument;
  conns: Map<string, Conn>;
  lastActive: number;
}

export function startServer(cfg: ServerConfig) {
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    if (!cfg.silent) console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  };
  const rooms = new Map<string, Room>();
  let shuttingDown = false;
  const aiEnabled = cfg.llm.key !== '' && cfg.llm.model !== '';

  function getRoom(id: string): Room | null {
    let room = rooms.get(id);
    if (room) return room;
    if (rooms.size >= cfg.maxRooms) {
      // Evict the least recently active room with no connections.
      let victim: Room | null = null;
      for (const r of rooms.values()) if (r.conns.size === 0 && (!victim || r.lastActive < victim.lastActive)) victim = r;
      if (!victim) return null;
      rooms.delete(victim.id);
      log('room_evicted', { room: victim.id });
    }
    room = { id, epoch: randomBytes(8).toString('hex'), doc: new RgaDocument({ maxAtoms: cfg.limits.maxDocAtoms }), conns: new Map(), lastActive: Date.now() };
    rooms.set(id, room);
    return room;
  }

  function send(c: Conn, msg: ServerMsg): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > cfg.sendQueueBytes) {
      log('slow_consumer', { room: c.room.id, client: c.clientId });
      c.ws.close(CloseCode.SlowConsumer, 'slow consumer');
      return;
    }
    c.ws.send(JSON.stringify(msg));
  }

  const peersOf = (room: Room): Peer[] => [...room.conns.values()].map(c => ({ id: c.clientId, name: c.name }));
  function broadcast(room: Room, msg: ServerMsg, except?: Conn) {
    for (const c of room.conns.values()) if (c !== except) send(c, msg);
  }

  function fail(c: Conn, code: string, message: string, seq?: number) {
    send(c, seq === undefined ? { type: 'error', code, message } : { type: 'error', code, message, seq });
    c.ws.close(CloseCode.ProtocolError, code);
  }

  /** Validate an ops/sync batch against room state without mutating it. */
  function checkBatch(c: Conn, msg: ClientOpsMsg | ClientSyncMsg): string | null {
    const doc = c.room.doc;
    const fresh = new Set<string>();
    for (const op of msg.ops) {
      if (op.k === 'i') {
        if (msg.type === 'ops' && op.id.c !== c.clientId) return 'foreign_author';
        if (op.o !== null && !doc.has(op.o) && !fresh.has(keyOf(op.o))) return 'unknown_origin';
        if (!doc.has(op.id)) fresh.add(keyOf(op.id));
      } else if (!doc.has(op.id) && !fresh.has(keyOf(op.id))) {
        return 'unknown_target';
      }
    }
    if (doc.size + fresh.size > cfg.limits.maxDocAtoms) return 'doc_too_large';
    return null;
  }

  function onBatch(c: Conn, msg: ClientOpsMsg | ClientSyncMsg) {
    const problem = checkBatch(c, msg);
    if (problem) return fail(c, problem, 'operation batch rejected', msg.seq);
    const applied: Op[] = [];
    try {
      for (const op of msg.ops) if (c.room.doc.apply(op) === 'applied') applied.push(op);
    } catch (e) {
      return fail(c, e instanceof CrdtError ? e.code : 'internal', 'operation batch rejected', msg.seq);
    }
    c.room.lastActive = Date.now();
    if (applied.length) broadcast(c.room, { type: 'ops', from: c.clientId, ops: applied }, c);
    send(c, { type: 'ack', seq: msg.seq });
  }

  async function onAiSuggest(c: Conn, requestId: string) {
    if (!aiEnabled) return send(c, { type: 'ai_error', requestId, code: 'disabled', message: 'AI is not configured on this server' });
    if (c.ai) return send(c, { type: 'ai_error', requestId, code: 'busy', message: 'a suggestion is already in progress' });
    const context = [...c.room.doc.text()].slice(-4000).join('');
    if (context.trim() === '') return send(c, { type: 'ai_error', requestId, code: 'empty_document', message: 'write something first' });
    const abort = new AbortController();
    c.ai = { requestId, abort };
    const timer = setTimeout(() => abort.abort(new Error('timeout')), cfg.llm.timeoutMs);
    try {
      const res = await fetch(`${cfg.llm.url}/chat/completions`, {
        method: 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.key}` },
        body: JSON.stringify({ model: cfg.llm.model, max_tokens: 160, messages: [
          { role: 'system', content: 'You are a writing assistant. Continue the user\'s text naturally in 1-3 sentences. Do not repeat existing text. No preamble.' },
          { role: 'user', content: context },
        ] }),
      });
      if (res.status === 429) throw Object.assign(new Error('rate limited'), { code: 'rate_limited' });
      if (!res.ok) throw Object.assign(new Error(`provider status ${res.status}`), { code: 'provider_error' });
      const body = await res.json() as { choices?: { message?: { content?: unknown } }[] };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw Object.assign(new Error('malformed provider response'), { code: 'provider_error' });
      const trimmed = [...text.trim()].slice(0, 2000).join('');
      if (!trimmed) throw Object.assign(new Error('empty suggestion'), { code: 'empty_response' });
      send(c, { type: 'ai_result', requestId, text: trimmed });
    } catch (e) {
      const reason = abort.signal.reason as Error | undefined;
      const code = abort.signal.aborted ? (reason?.message === 'timeout' ? 'timeout' : 'cancelled') : ((e as { code?: string }).code ?? 'provider_error');
      log('ai_error', { room: c.room.id, code });
      send(c, { type: 'ai_error', requestId, code, message: code === 'timeout' ? 'the AI provider did not respond in time' : (e as Error).message });
    } finally {
      clearTimeout(timer);
      if (c.ai?.requestId === requestId) c.ai = null;
    }
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!cfg.staticDir || req.method !== 'GET') return false;
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const root = path.resolve(cfg.staticDir);
    let file = path.resolve(root, '.' + path.posix.normalize(urlPath));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health' || url.pathname === '/healthz') return json(res, 200, { status: 'ok', service: 'collab-editor', implementation: 'ts-test-server' });
    if (url.pathname === '/readyz') return json(res, shuttingDown ? 503 : 200, { ready: !shuttingDown });
    if (url.pathname === '/api/room/text') {
      const roomId = url.searchParams.get('roomId') ?? '';
      if (!ROOM_ID_RE.test(roomId)) return json(res, 400, { error: 'invalid_room_id' });
      const room = rooms.get(roomId);
      if (!room) return json(res, 404, { error: 'room_not_found' });
      return json(res, 200, { roomId, text: room.doc.text(), lamportClock: room.doc.lamport, epoch: room.epoch, clients: room.conns.size });
    }
    if (serveStatic(req, res)) return;
    json(res, 404, { error: 'not_found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.limits.maxMessageBytes });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status: number, text: string) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (shuttingDown) return reject(503, 'Service Unavailable');
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin) && new URL(origin).host !== req.headers.host) return reject(403, 'Forbidden');
    const roomId = url.searchParams.get('roomId') ?? '';
    const clientId = url.searchParams.get('clientId') ?? '';
    if (!ROOM_ID_RE.test(roomId) || !CLIENT_ID_RE.test(clientId)) return reject(400, 'Bad Request');
    const room = getRoom(roomId);
    if (!room) return reject(503, 'Service Unavailable');
    if (!room.conns.has(clientId) && room.conns.size >= cfg.maxClientsPerRoom) return reject(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, ws => {
      const c: Conn = { ws, clientId, name: sanitizeName(url.searchParams.get('name')), room, ai: null, alive: true };
      const previous = room.conns.get(clientId);
      if (previous) { room.conns.delete(clientId); previous.ws.close(CloseCode.Replaced, 'replaced by a newer connection'); }
      room.conns.set(clientId, c);
      room.lastActive = Date.now();
      log('join', { room: roomId, client: clientId, clients: room.conns.size });
      send(c, {
        type: 'welcome', protocol: PROTOCOL_VERSION, roomId, clientId, epoch: room.epoch,
        snapshot: room.doc.snapshot(), peers: peersOf(room),
        ai: aiEnabled ? { enabled: true } : { enabled: false, reason: 'LLM_API_KEY / LLM_MODEL not configured on the server' },
        limits: cfg.limits, persistence: 'memory',
      });
      broadcast(room, { type: 'presence', peers: peersOf(room) }, c);

      ws.on('pong', () => { c.alive = true; });
      ws.on('message', (data, isBinary) => {
        c.alive = true;
        if (isBinary) return fail(c, 'bad_message', 'binary frames are not supported');
        const parsed = parseClientMessage(data.toString(), cfg.limits);
        if (!parsed.ok) return fail(c, parsed.code, parsed.message, undefined);
        const msg = parsed.msg;
        switch (msg.type) {
          case 'ops': case 'sync': return onBatch(c, msg);
          case 'ping': return send(c, { type: 'pong', nonce: msg.nonce });
          case 'ai_suggest': void onAiSuggest(c, msg.requestId); return;
          case 'ai_cancel': if (c.ai?.requestId === msg.requestId) c.ai.abort.abort(new Error('cancelled')); return;
        }
      });
      ws.on('close', () => {
        c.ai?.abort.abort(new Error('cancelled'));
        if (room.conns.get(clientId) === c) {
          room.conns.delete(clientId);
          room.lastActive = Date.now();
          broadcast(room, { type: 'presence', peers: peersOf(room) });
          log('leave', { room: roomId, client: clientId, clients: room.conns.size });
        }
      });
      ws.on('error', () => { /* close follows */ });
    });
  });

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) for (const c of room.conns.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, 25_000);

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const room of rooms.values()) for (const c of room.conns.values()) c.ws.close(CloseCode.GoingAway, 'server shutting down');
    await new Promise<void>(resolve => server.close(() => resolve()));
    log('shutdown_complete');
  }

  return new Promise<{ port: number; shutdown: () => Promise<void>; rooms: Map<string, Room> }>(resolve => {
    server.listen(cfg.port, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      log('listening', { port, ai: aiEnabled, implementation: 'ts-test-server' });
      resolve({ port, shutdown, rooms });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer(configFromEnv());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void s.shutdown().then(() => process.exit(0)); });
}
