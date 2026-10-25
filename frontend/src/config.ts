/**
 * WebSocket endpoint. Production builds default to the page's own origin
 * (the Go server serves the frontend), so the share link and the socket point
 * at the same server. `npm run dev` injects ws://localhost:8080/ws.
 */
declare const __WS_URL__: string;

export function websocketUrl(): string {
  const configured = typeof __WS_URL__ === 'string' ? __WS_URL__ : '';
  if (configured) return configured;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}
