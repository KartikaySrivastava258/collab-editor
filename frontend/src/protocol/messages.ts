/**
 * Wire protocol v2 (JSON text frames). Documented in docs/PROTOCOL.md and
 * implemented identically by backend/hub (Go) and frontend/test-server (TS).
 */
import { validateOp, validateId } from '../crdt/rga.ts';
import type { Op, SnapshotAtom } from '../crdt/rga.ts';

export const PROTOCOL_VERSION = 2;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface Peer { id: string; name: string }

export interface Limits {
  maxDocAtoms: number;
  maxOpsPerMessage: number;
  maxMessageBytes: number;
}

export interface AiStatus { enabled: boolean; reason?: string }

// ── Server → client ────────────────────────────────────────────────────────
export interface WelcomeMsg {
  type: 'welcome';
  protocol: number;
  roomId: string;
  clientId: string;
  /** Changes whenever the server's in-memory copy of the room is (re)created. */
  epoch: string;
  snapshot: SnapshotAtom[];
  peers: Peer[];
  ai: AiStatus;
  limits: Limits;
  persistence: 'memory';
}
export interface OpsMsg { type: 'ops'; from: string; ops: Op[] }
export interface AckMsg { type: 'ack'; seq: number }
export interface PresenceMsg { type: 'presence'; peers: Peer[] }
export interface ErrorMsg { type: 'error'; code: string; message: string; seq?: number }
export interface PongMsg { type: 'pong'; nonce: number }
export interface AiResultMsg { type: 'ai_result'; requestId: string; text: string }
export interface AiErrorMsg { type: 'ai_error'; requestId: string; code: string; message: string }

export type ServerMsg =
  | WelcomeMsg | OpsMsg | AckMsg | PresenceMsg | ErrorMsg | PongMsg | AiResultMsg | AiErrorMsg;

// ── Client → server ────────────────────────────────────────────────────────
/** Normal edits; every insert must be authored by the sending client. */
export interface ClientOpsMsg { type: 'ops'; seq: number; ops: Op[] }
/** State replay after the server lost the room (epoch changed); any author. */
export interface ClientSyncMsg { type: 'sync'; seq: number; ops: Op[] }
export interface ClientPingMsg { type: 'ping'; nonce: number }
export interface AiSuggestMsg { type: 'ai_suggest'; requestId: string }
export interface AiCancelMsg { type: 'ai_cancel'; requestId: string }

export type ClientMsg = ClientOpsMsg | ClientSyncMsg | ClientPingMsg | AiSuggestMsg | AiCancelMsg;

/** WebSocket close codes used by the server. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  PolicyViolation: 1008,
  TooBig: 1009,
  ProtocolError: 4000,
  Replaced: 4001,
  SlowConsumer: 4002,
  ServerFull: 4003,
} as const;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isSeq(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER;
}

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; code: string; message: string };

/** Server-side validation of a client frame (used by the TS test server). */
export function parseClientMessage(raw: string, limits: Limits): ParseResult<ClientMsg> {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ok: false, code: 'bad_json', message: 'malformed JSON' }; }
  if (!isObj(data) || typeof data.type !== 'string') return { ok: false, code: 'bad_message', message: 'missing type' };
  switch (data.type) {
    case 'ops':
    case 'sync': {
      if (!isSeq(data.seq)) return { ok: false, code: 'bad_message', message: 'invalid seq' };
      if (!Array.isArray(data.ops) || data.ops.length === 0) return { ok: false, code: 'bad_message', message: 'ops must be a non-empty array' };
      if (data.ops.length > limits.maxOpsPerMessage) return { ok: false, code: 'too_many_ops', message: `at most ${limits.maxOpsPerMessage} ops per message` };
      for (const op of data.ops) if (!validateOp(op)) return { ok: false, code: 'invalid_op', message: 'invalid operation' };
      return { ok: true, msg: { type: data.type, seq: data.seq, ops: data.ops as Op[] } };
    }
    case 'ping':
      if (!isSeq(data.nonce)) return { ok: false, code: 'bad_message', message: 'invalid nonce' };
      return { ok: true, msg: { type: 'ping', nonce: data.nonce } };
    case 'ai_suggest':
    case 'ai_cancel':
      if (typeof data.requestId !== 'string' || !REQUEST_ID_RE.test(data.requestId)) return { ok: false, code: 'bad_message', message: 'invalid requestId' };
      return { ok: true, msg: { type: data.type, requestId: data.requestId } };
    default:
      return { ok: false, code: 'bad_message', message: 'unknown message type' };
  }
}

/** Client-side defensive validation of server frames. */
export function parseServerMessage(raw: string): ServerMsg | null {
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!isObj(d) || typeof d.type !== 'string') return null;
  switch (d.type) {
    case 'welcome': {
      if (typeof d.epoch !== 'string' || !Array.isArray(d.snapshot) || !Array.isArray(d.peers) || !isObj(d.limits) || !isObj(d.ai)) return null;
      for (const s of d.snapshot) if (!isObj(s) || !validateOp({ k: 'i', id: s.id, o: s.o, v: s.v })) return null;
      return d as unknown as WelcomeMsg;
    }
    case 'ops':
      if (typeof d.from !== 'string' || !Array.isArray(d.ops) || !d.ops.every(validateOp)) return null;
      return d as unknown as OpsMsg;
    case 'ack': return isSeq(d.seq) ? (d as unknown as AckMsg) : null;
    case 'presence':
      if (!Array.isArray(d.peers) || !d.peers.every(p => isObj(p) && typeof p.id === 'string' && typeof p.name === 'string')) return null;
      return d as unknown as PresenceMsg;
    case 'error': return typeof d.code === 'string' ? (d as unknown as ErrorMsg) : null;
    case 'pong': return isSeq(d.nonce) ? (d as unknown as PongMsg) : null;
    case 'ai_result': return typeof d.requestId === 'string' && typeof d.text === 'string' ? (d as unknown as AiResultMsg) : null;
    case 'ai_error': return typeof d.requestId === 'string' && typeof d.code === 'string' ? (d as unknown as AiErrorMsg) : null;
    default: return null;
  }
}

/** Display names: trimmed, 1–32 printable characters, no control chars. */
export function sanitizeName(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const cps = [...cleaned].slice(0, 32).join('');
  return cps.length > 0 ? cps : 'Guest';
}

export { validateId };
