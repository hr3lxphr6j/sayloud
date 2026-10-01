/**
 * Static server for the Kokoro v1.1-zh WebGPU POC (throwaway).
 *
 * Mounts three roots so the model files stay out of the repo:
 *   /         -> this directory (index.html, poc.js)
 *   /models/  -> /tmp/kokoro-poc-models   (downloaded .onnx, voices, fixtures)
 *   /ort/     -> onnxruntime-web dist     (scratch npm install)
 *
 * Deliberately does NOT send COOP/COEP: the extension's offscreen document runs
 * without cross-origin isolation (P4 V15), so the POC must match that — no
 * SharedArrayBuffer, wasm threads pinned to 1.
 *
 * `POST /save?name=x` writes the request body to /tmp/kokoro-poc-out/x, which is
 * how browser-generated audio gets out of the page.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const POC = new URL('.', import.meta.url).pathname;
const MODELS = '/tmp/kokoro-poc-models';
const ORT = '/tmp/kokoro-poc-ort/node_modules/onnxruntime-web/dist';
const OUT = '/tmp/kokoro-poc-out';
const PORT = Number(process.env.POC_PORT ?? 8913);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.f32': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'POST' && url.pathname === '/save') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await mkdir(OUT, { recursive: true });
    const name = (url.searchParams.get('name') ?? 'out.bin').replace(/[^\w.-]/g, '_');
    await writeFile(join(OUT, name), Buffer.concat(chunks));
    res.end('saved ' + name);
    return;
  }

  const path = url.pathname;
  const file = path.startsWith('/models/')
    ? join(MODELS, path.slice('/models/'.length))
    : path.startsWith('/ort/')
      ? join(ORT, path.slice('/ort/'.length))
      : join(POC, path === '/' ? 'index.html' : path.slice(1));

  try {
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found: ' + file);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`poc server: http://127.0.0.1:${PORT}/`);
  console.log(`  models  -> ${MODELS}`);
  console.log(`  ort     -> ${ORT}`);
  console.log(`  output  -> ${OUT}`);
});
