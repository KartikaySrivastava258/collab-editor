/**
 * Turns SyncState into user-facing labels. Kept pure so the wording rules are
 * unit-tested: the UI must never claim "synced" while edits are unacknowledged
 * and must never imply durable storage (the server keeps rooms in memory).
 */
import type { SyncState } from '../sync/SyncClient.ts';

export type Tone = 'ok' | 'warn' | 'bad';

export interface ConnectionView { label: string; tone: Tone; busy: boolean; detail: string }

export function connectionView(s: SyncState, now: number): ConnectionView {
  const secs = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : null;
  const retry = secs === null ? 'Retrying…' : secs === 0 ? 'Retrying now…' : `Next attempt in ${secs}s.`;
  switch (s.phase) {
    case 'connected':
      return { label: 'Connected', tone: 'ok', busy: false, detail: 'Live connection to the collaboration server.' };
    case 'connecting':
      return s.attempt === 0
        ? { label: 'Connecting…', tone: 'warn', busy: true, detail: 'Opening a connection to the server.' }
        : { label: 'Can’t reach server', tone: 'bad', busy: true, detail: `Attempt ${s.attempt} failed. ${retry}` };
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'warn', busy: true, detail: s.attempt > 0 ? `Connection lost (attempt ${s.attempt}). ${retry}` : 'Re-establishing the connection.' };
    case 'offline':
      return { label: 'Offline', tone: 'bad', busy: false, detail: 'Your device appears to be offline. We will retry when the network returns.' };
    case 'replaced':
      return { label: 'Session moved', tone: 'bad', busy: false, detail: 'This session was replaced by a newer connection with the same ID. Reload to continue here.' };
    case 'stopped':
      return { label: 'Closed', tone: 'warn', busy: false, detail: 'This session is closed.' };
  }
}

export interface SyncView { text: string; tone: Tone }

export function syncView(s: SyncState): SyncView {
  const n = s.unsynced;
  const changes = `${n} change${n === 1 ? '' : 's'}`;
  if (s.phase === 'connected') {
    return n === 0
      ? { text: 'All changes synced to server memory', tone: 'ok' }
      : { text: `Syncing ${changes}…`, tone: 'warn' };
  }
  if (n > 0) return { text: `${changes} waiting to sync — kept in this tab`, tone: 'bad' };
  return { text: 'Not connected — edits will sync when reconnected', tone: 'warn' };
}

export function aiUnavailableReason(s: SyncState): string | null {
  if (!s.ai) return 'Connect to the server to check AI availability';
  if (!s.ai.enabled) return s.ai.reason ? `AI unavailable: ${s.ai.reason}` : 'AI is not enabled on this server';
  if (s.phase !== 'connected') return 'AI needs a live connection';
  return null;
}
