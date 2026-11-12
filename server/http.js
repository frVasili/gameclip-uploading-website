// Small HTTP helpers shared by both listeners.
import fs from 'node:fs';
import path from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

export function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}
export const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), 'application/json', { 'Cache-Control': 'no-store', ...headers });

// Serves a file with Range support (video players and Discord's proxy seek with Range requests).
// maxRange: answer a Range request with at most this many bytes (206 with the shorter Content-Range; players
// then ask for the next piece). The editor uses it: Firefox stops reading a paused video's open-ended download,
// and on a shared HTTP/2-3 connection the unread data held up the editor's other requests (saves hung on
// "saving..." until playback resumed).
export function sendFile(req, res, file, headers = {}, { maxRange = 0 } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not found');
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ETag: etag,
    'Last-Modified': st.mtime.toUTCString(), ...headers };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }

  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }); return res.end();
    }
    if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }       // suffix: last N bytes
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }); return res.end();
    }
    if (maxRange > 0) end = Math.min(end, start + maxRange - 1);
    status = 206;
    base['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  res.writeHead(status, { ...base, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
