// npm test: sendFile's Range handling (no ffmpeg needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { sendFile } from '../server/http.js';

test('maxRange answers open-ended ranges in pieces; without it the whole rest is sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-http-'));
  const file = path.join(dir, 'v.mp4'), size = 20 * 1024 * 1024, piece = 8 * 1024 * 1024;
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  const srv = http.createServer((req, res) => sendFile(req, res, file, {}, { maxRange: req.url === '/capped' ? piece : 0 }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const get = async (p, range) => { const r = await fetch(base + p, { headers: range ? { Range: range } : {} }); const b = await r.arrayBuffer(); return { s: r.status, cr: r.headers.get('content-range'), n: b.byteLength }; };
    assert.deepEqual(await get('/capped', 'bytes=0-'), { s: 206, cr: `bytes 0-${piece - 1}/${size}`, n: piece });
    assert.deepEqual(await get('/capped', `bytes=${2 * piece}-`), { s: 206, cr: `bytes ${2 * piece}-${size - 1}/${size}`, n: size - 2 * piece });
    assert.deepEqual(await get('/capped', 'bytes=100-199'), { s: 206, cr: `bytes 100-199/${size}`, n: 100 });
    assert.deepEqual(await get('/capped'), { s: 200, cr: null, n: size });           // plain downloads stay whole
    assert.deepEqual(await get('/public', 'bytes=0-'), { s: 206, cr: `bytes 0-${size - 1}/${size}`, n: size });
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
