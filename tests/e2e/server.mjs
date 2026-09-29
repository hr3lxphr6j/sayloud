/**
 * Static server for the e2e pages.
 *
 * The tests need real http(s) pages rather than data: URLs: the extension is
 * injected with `activeTab`, and the e2e manifest grants host access to
 * 127.0.0.1 so the injected content script can run without a user gesture.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./pages/', import.meta.url));
const PORT = Number(process.env.SAYLOUD_E2E_PORT ?? 8787);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`).pathname;

  if (pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  // Chrome fetches this itself, outside the page's network context, so a 404
  // here shows up as a console error and hides real ones.
  if (pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }

  const name = pathname.replace(/^\/+/, '') || 'index.html';
  const file = resolve(ROOT, name);

  // Refuse anything that escapes the pages directory.
  if (!file.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sayloud e2e server listening on http://127.0.0.1:${PORT}`);
});
