#!/usr/bin/env node
/**
 * 日语假名 TTS 测试服务器
 */

import http from 'http';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const kana2ipaModule = require('kana2ipa');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 8915;

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 路由：首页
  if (req.url === '/' && req.method === 'GET') {
    const html = readFileSync(join(__dirname, 'test-japanese-kana-tts-local.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 路由：对比测试页面
  if (req.url === '/test' && req.method === 'GET') {
    const html = readFileSync(join(__dirname, 'test-kokoro-direct-japanese.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 路由：音色检查页面
  if (req.url === '/voices' && req.method === 'GET') {
    const html = readFileSync(join(__dirname, 'test-kokoro-voices.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 路由：kana2ipa API
  if (req.url === '/api/kana2ipa' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { kana } = JSON.parse(body);
        const ipa = kana2ipaModule.kana2ipa(kana);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ipa }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🚀 日语假名 TTS 测试服务器已启动`);
  console.log(`📍 主页面：http://localhost:${PORT}`);
  console.log(`📍 对比测试：http://localhost:${PORT}/test`);
  console.log(`📍 音色检查：http://localhost:${PORT}/voices`);
  console.log('');
  console.log('按 Ctrl+C 停止服务器');
});
