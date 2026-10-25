/**
 * Session helpers. Anonymous by design: there is no authentication, so the
 * client ID only distinguishes browser tabs and the name is self-chosen.
 */
import { ROOM_ID_RE } from '../protocol/messages.ts';

/** Random URL-safe ID from the platform CSPRNG. */
export function randomId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** A fresh client ID per page load: Lamport counters restart on reload, so IDs must not be reused. */
export function newClientId(): string { return 'c' + randomId(15); }

export function newRoomId(): string { return 'doc-' + randomId(8); }

/**
 * Accepts a bare room ID or a pasted link containing `#roomId`.
 * Returns null if nothing valid is found.
 */
export function parseRoomInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hash = trimmed.includes('#') ? trimmed.slice(trimmed.lastIndexOf('#') + 1) : trimmed;
  const id = decodeURIComponent(hash).trim();
  return ROOM_ID_RE.test(id) ? id : null;
}

export function roomFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    const id = decodeURIComponent(raw);
    return ROOM_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** localStorage wrapper that never throws (private mode, quota, disabled storage). */
export const safeStorage = {
  get(key: string): string | null {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set(key: string, value: string): void {
    try { globalThis.localStorage?.setItem(key, value); } catch { /* ignore */ }
  },
};

export interface RecentRoom { id: string; openedAt: number }

const RECENT_KEY = 'collab.recentRooms.v1';
const NAME_KEY = 'collab.displayName.v1';
const SIDEBAR_KEY = 'collab.sidebarCollapsed.v1';

export function loadRecent(): RecentRoom[] {
  try {
    const parsed = JSON.parse(safeStorage.get(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is RecentRoom =>
      typeof r === 'object' && r !== null && typeof (r as RecentRoom).id === 'string' &&
      ROOM_ID_RE.test((r as RecentRoom).id) && typeof (r as RecentRoom).openedAt === 'number').slice(0, 8);
  } catch {
    return [];
  }
}

export function rememberRoom(list: RecentRoom[], id: string, now = Date.now()): RecentRoom[] {
  const next = [{ id, openedAt: now }, ...list.filter(r => r.id !== id)].slice(0, 8);
  safeStorage.set(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function loadName(): string {
  const saved = safeStorage.get(NAME_KEY);
  if (saved && saved.trim()) return saved.trim().slice(0, 32);
  const name = 'Guest ' + randomId(3).toUpperCase();
  safeStorage.set(NAME_KEY, name);
  return name;
}
export function saveName(name: string): void { safeStorage.set(NAME_KEY, name); }
export function loadSidebarCollapsed(): boolean { return safeStorage.get(SIDEBAR_KEY) === '1'; }
export function saveSidebarCollapsed(v: boolean): void { safeStorage.set(SIDEBAR_KEY, v ? '1' : '0'); }

/** Initials for avatars. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const chars = parts.length >= 2 ? [parts[0][0], parts[parts.length - 1][0]] : [...(parts[0] ?? '?')].slice(0, 2);
  return chars.join('').toUpperCase();
}

/** Stable, readable avatar colour derived from the client ID. */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const palette = ['#8ab4f8', '#81c995', '#f2c66d', '#f28b82', '#c58af9', '#78d9ec', '#fcad70', '#a8dab5'];
  return palette[h % palette.length];
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Word and character counts of the canonical visible text. */
export function countText(text: string): { words: number; chars: number } {
  const trimmed = text.trim();
  return { words: trimmed ? trimmed.split(/\s+/u).length : 0, chars: [...text].length };
}
