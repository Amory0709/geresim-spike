// Tiny static server — Node http, no deps. Serves the spike directory.
// Used by verify_render.mjs when Python http.server is blocked by sandbox.
import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.argv[2] || '8767');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.vtk': 'text/plain', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const full = normalize(join(__dirname, p));
  if (!full.startsWith(__dirname)) { res.statusCode = 403; res.end('forbidden'); return; }
  if (!existsSync(full)) { res.statusCode = 404; res.end('not found: ' + p); return; }
  const st = statSync(full);
  if (st.isDirectory()) { res.statusCode = 404; res.end('is dir'); return; }
  const data = readFileSync(full);
  res.setHeader('Content-Type', MIME[extname(full)] || 'application/octet-stream');
  res.setHeader('Content-Length', data.length);
  res.end(data);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${__dirname} at http://127.0.0.1:${PORT}/`);
});