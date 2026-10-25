// Dev server on http://localhost:3000 with rebuild-on-save and live reload.
// The editor connects to COLLAB_WS_URL (default ws://localhost:8080/ws), so
// run the Go server (make backend) or the TS test server alongside.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/assets', { recursive: true });
copyFileSync('public/index.html', 'dist/index.html');
const ctx = await esbuild.context({
  entryPoints: { app: 'src/index.tsx' }, bundle: true, outdir: 'dist/assets', sourcemap: 'inline', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', __WS_URL__: JSON.stringify(process.env.COLLAB_WS_URL ?? 'ws://localhost:8080/ws') },
  banner: { js: "new EventSource('/esbuild').addEventListener('change', () => location.reload());" },
  logLevel: 'info',
});
await ctx.watch();
const port = Number(process.env.PORT ?? 3000);
await ctx.serve({ servedir: 'dist', port, host: '127.0.0.1' });
console.log(`dev server: http://localhost:${port}  (WebSocket: ${process.env.COLLAB_WS_URL ?? 'ws://localhost:8080/ws'})`);
