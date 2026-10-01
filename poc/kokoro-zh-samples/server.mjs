/**
 * Static server for the listening page (spike, throwaway).
 *
 *   node poc/kokoro-zh-samples/server.mjs
 *
 * Serves this directory, with `/audio/` mapped to the wavs under
 * /tmp/kokoro-zh-samples-out so 5 MB of samples stay out of the repo.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const AUDIO = '/tmp/kokoro-zh-samples-out';
const PORT = Number(process.env.SAMPLES_PORT ?? 8914);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = path.startsWith('/audio/')
    ? join(AUDIO, path.slice('/audio/'.length))
    : join(HERE, path === '/' ? 'index.html' : path.slice(1));

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
  console.log(`试听页: http://127.0.0.1:${PORT}/`);
  console.log(`音频:   ${AUDIO}`);
});
