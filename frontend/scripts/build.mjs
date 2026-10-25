// Production build: esbuild bundles src/index.tsx into dist/assets/app.{js,css}.
//   COLLAB_WS_URL  optional fixed WebSocket URL (default: same origin as the page)
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(`${outdir}/assets`, { recursive: true });
const result = await esbuild.build({
  entryPoints: { app: 'src/index.tsx' },
  bundle: true, outdir: `${outdir}/assets`, minify: true, sourcemap: 'linked',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'], jsx: 'automatic', metafile: true, logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"', __WS_URL__: JSON.stringify(process.env.COLLAB_WS_URL ?? '') },
});
copyFileSync('public/index.html', `${outdir}/index.html`);
const report = { builtAt: new Date().toISOString(), esbuild: esbuild.version, files: {} };
for (const f of ['assets/app.js', 'assets/app.css']) {
  const buf = readFileSync(`${outdir}/${f}`);
  report.files[f] = { bytes: buf.length, gzipBytes: gzipSync(buf, { level: 9 }).length };
}
writeFileSync(`${outdir}/build-report.json`, JSON.stringify(report, null, 2));
for (const [f, s] of Object.entries(report.files)) console.log(`${f.padEnd(16)} ${(s.bytes / 1024).toFixed(1).padStart(7)} KiB   gzip ${(s.gzipBytes / 1024).toFixed(1).padStart(6)} KiB`);
if (result.warnings.length) process.exitCode = 1;
