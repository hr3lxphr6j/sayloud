/**
 * Static server for the e2e pages.
 *
 * The tests need real http(s) pages rather than data: URLs: the extension is
 * injected with `activeTab`, and the e2e manifest grants host access to
 * 127.0.0.1 so the injected content script can run without a user gesture.
 *
 * It also stands in for a cloud TTS service under `/tts/v1`, in the shape of
 * Kokoro-FastAPI: the standard OpenAI speech endpoint returns audio bytes, and
 * `/dev/captioned_speech` returns base64 audio plus word
 * timestamps. The audio is real, decodable silence, so the offscreen document
 * plays it for its full length. Requests are counted so a spec can tell a
 * cache hit from a synthesis, and `/tts/control` lets a spec make the next
 * requests fail.
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

/** Stub TTS state, reset by `POST /tts/control {reset: true}`. */
const tts = { requests: [], failNext: 0 };

/** Seconds of audio per word; long enough that pause and seek can land mid-sentence. */
const SECONDS_PER_WORD = 0.35;

/** A mono 16-bit PCM WAV of silence, `seconds` long. */
function silentWav(seconds) {
  const sampleRate = 8000;
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const data = samples * 2;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(data, 40);
  return buffer;
}

/** Kokoro-style timestamps: one entry per word, in seconds. */
function timestampsFor(text) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.map((word, index) => ({
    word: word.replace(/[.,;:!?]+$/, ''),
    start_time: index * SECONDS_PER_WORD,
    end_time: (index + 1) * SECONDS_PER_WORD,
  }));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

/** Handle `/tts/...`; returns true when it answered. */
async function handleTts(pathname, request, response) {
  // Extension pages fetch cross-origin; the real Kokoro answers `*` too.
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  if (!pathname.startsWith('/tts/')) return false;
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors).end();
    return true;
  }

  if (pathname === '/tts/control') {
    if (request.method === 'GET') {
      response.writeHead(200, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify(tts));
      return true;
    }
    const body = await readJson(request);
    if (body.reset) {
      tts.requests = [];
      tts.failNext = 0;
    }
    if (typeof body.failNext === 'number') tts.failNext = body.failNext;
    response.writeHead(204, cors).end();
    return true;
  }

  if (pathname === '/tts/v1/audio/voices' && request.method === 'GET') {
    response.writeHead(200, { ...cors, 'content-type': 'application/json' });
    response.end(JSON.stringify({ voices: [{ id: 'af_stub', name: 'Stub' }] }));
    return true;
  }

  const captioned = pathname === '/tts/v1/dev/captioned_speech';
  if ((captioned || pathname === '/tts/v1/audio/speech') && request.method === 'POST') {
    const body = await readJson(request);
    const text = typeof body.input === 'string' ? body.input : '';
    tts.requests.push({ path: pathname, input: text, voice: body.voice, stream: body.stream });

    if (tts.failNext > 0) {
      tts.failNext -= 1;
      response.writeHead(503, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'stub is failing on purpose' } }));
      return true;
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const wav = silentWav(Math.max(1, words) * SECONDS_PER_WORD);
    if (captioned) {
      response.writeHead(200, { ...cors, 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          audio: wav.toString('base64'),
          audio_format: 'wav',
          timestamps: timestampsFor(text),
        })
      );
    } else {
      response.writeHead(200, { ...cors, 'content-type': 'audio/wav' }).end(wav);
    }
    return true;
  }

  response.writeHead(404, cors).end('not found');
  return true;
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`).pathname;

  if (await handleTts(pathname, request, response)) return;

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
