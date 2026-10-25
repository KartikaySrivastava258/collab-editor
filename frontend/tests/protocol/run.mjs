// Runs the protocol conformance suite. With SERVER_URL set (e.g. the Go
// server) it targets that server; otherwise it starts the TS test server.
import { spawn } from 'node:child_process';

const suite = new URL('./protocol.test.ts', import.meta.url).pathname;
let server = null;
let url = process.env.SERVER_URL;
if (!url) {
  const { startServer, configFromEnv } = await import('../../test-server/server.ts');
  server = await startServer({ ...configFromEnv(), port: 0, silent: true });
  url = `http://127.0.0.1:${server.port}`;
}
console.log(`protocol suite → ${url}${server ? ' (TS test server)' : ''}`);
// Async spawn: the in-process server must keep serving while the suite runs.
const child = spawn(process.execPath, ['--test', suite], { stdio: 'inherit', env: { ...process.env, SERVER_URL: url } });
const code = await new Promise(resolve => child.on('exit', c => resolve(c ?? 1)));
if (server) await server.shutdown();
process.exit(code);
