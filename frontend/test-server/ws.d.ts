// Minimal typings for the subset of `ws` used by the test server.
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  export class WebSocket {
    readonly OPEN: 1;
    readyState: number;
    bufferedAmount: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: 'message', fn: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'close' | 'pong', fn: () => void): this;
    on(event: 'error', fn: (err: Error) => void): this;
  }
  export class WebSocketServer {
    constructor(opts: { noServer: boolean; maxPayload?: number });
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket) => void): void;
  }
}
