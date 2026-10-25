import { useEffect, useState, useSyncExternalStore } from 'react';
import { SyncClient } from '../sync/SyncClient.ts';
import type { SyncState } from '../sync/SyncClient.ts';

const idle: SyncState = {
  phase: 'connecting', attempt: 0, retryAt: null, joined: false, unsynced: 0, peers: [], ai: null,
  limits: null, version: 0, aiRequest: { status: 'idle' }, notice: null, lastRemoteEditAt: null,
};
const noopSubscribe = () => () => {};
const idleSnapshot = () => idle;

/**
 * One SyncClient per (room, clientId). Created inside the effect so React
 * StrictMode's double-invocation cannot leak sockets; stop() runs on room
 * change/unmount and cancels timers and the socket.
 */
export function useSyncSession(url: string, roomId: string, clientId: string, name: string) {
  const [client, setClient] = useState<SyncClient | null>(null);
  useEffect(() => {
    if (!roomId) return; // landing page: no session
    const c = new SyncClient({ url, roomId, clientId, name });
    c.start();
    setClient(c);
    return () => { c.stop(); setClient(prev => (prev === c ? null : prev)); };
    // name changes are applied with setName below, not by reconnecting a new client
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, roomId, clientId]);
  useEffect(() => { client?.setName(name); }, [client, name]);
  const state = useSyncExternalStore(client ? client.subscribe : noopSubscribe, client ? client.getState : idleSnapshot);
  return { client, state };
}

/** Re-render every second while `active` (countdowns, relative times). */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
