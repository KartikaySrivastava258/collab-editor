// Deterministic OpenAI-compatible endpoint for E2E tests.
//   prompt contains "SLOWAI" -> never answers (exercises timeout / cancel)
//   prompt contains "FAILAI" -> HTTP 500
//   otherwise                -> fixed continuation
import http from 'node:http';
const port = Number(process.env.FAKE_LLM_PORT ?? 8299);
http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const prompt = JSON.stringify(JSON.parse(body || '{}').messages ?? []);
    if (prompt.includes('SLOWAI')) return; // hang until the client gives up
    if (prompt.includes('FAILAI')) { res.writeHead(500); res.end('{"error":"boom"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: ' and then the rain stopped.' } }] }));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake LLM on ${port}`));
