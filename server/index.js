// One HTTP server for everything:
//   /                      -> /home
//   /home, /edit/<id>, /admin and /static/*   the app (pages are public; their data needs a login)
//   /api/login, /api/logout, /api/me          sign in / out
//   /api/*                 everything else: signed in only (see api.js)
//   /<12-char id>[.mp4|.jpg]                  public clip pages and files (pages.js)
//   /healthz, /robots.txt
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import * as auth from './auth.js';
import { handleApi } from './api.js';
import { handleClipPage, notFoundPage } from './pages.js';
import { send, json, sendFile, readBody, TYPES } from './http.js';

const STATIC_DIR = process.env.STATIC_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web');

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
// pages of the app itself: only our own scripts; media/blob for the editor
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PAGES = { '/home': 'home.html', '/admin': 'admin.html' };

async function handle(req, res) {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
  if (req.url === '/healthz') return send(res, 200, 'ok', 'text/plain', { 'Cache-Control': 'no-store' }); // container health check (any Host)
  const host = String(req.headers.host || '').toLowerCase();
  if (config.allowedHosts.length && !config.allowedHosts.includes(host)) return send(res, 421, 'unknown host');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad request'); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'bad request'); }
  const m = req.method;

  if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
  if (handleClipPage(req, res, p)) return;
  if (p === '/' && (m === 'GET' || m === 'HEAD')) { res.writeHead(302, { Location: '/home' }); return res.end(); }

  if (m === 'GET' || m === 'HEAD') {
    const page = PAGES[p] || (/^\/edit\/[A-Za-z0-9]{16}$/.test(p) ? 'editor.html' : null);
    if (page) return sendFile(req, res, path.join(STATIC_DIR, page), { 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP });
    const sm = /^\/static\/([A-Za-z0-9._-]+)$/.exec(p);
    if (sm && TYPES[path.extname(sm[1])]) return sendFile(req, res, path.join(STATIC_DIR, sm[1]), { 'Cache-Control': 'no-cache' });
  }

  if (p.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    if (m !== 'GET' && m !== 'HEAD' && req.headers['x-clips'] !== '1') return json(res, 403, { error: 'missing X-Clips header' });
    if (p === '/api/login' && m === 'POST') {
      let pw = '';
      try { pw = JSON.parse(await readBody(req, 4096) || '{}').password; } catch { /* treated as empty */ }
      const r = await auth.login(req, res, pw);
      return r.ok ? json(res, 200, { user: r.user }) : json(res, r.status, { error: r.error });
    }
    if (p === '/api/logout' && m === 'POST') { auth.logout(req, res); return json(res, 200, { ok: true }); }
    const user = auth.currentUser(req);
    if (p === '/api/me' && m === 'GET') return json(res, 200, { user: user || null, siteName: config.siteName });
    if (!user) { req.resume(); return json(res, 401, { error: 'not signed in' }); }
    return handleApi(req, res, url, user);
  }
  return send(res, 404, notFoundPage(), 'text/html; charset=utf-8');
}

const server = http.createServer((req, res) => {
  Promise.resolve().then(() => handle(req, res)).catch((err) => {
    console.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('internal error'); } else res.destroy();
  });
});
server.requestTimeout = 0;   // long downloads and upload pieces on slow connections
server.headersTimeout = 60e3;
server.listen(config.port, config.host, () => console.log(`${config.siteName} listening on ${config.host}:${config.port}${config.publicUrl ? ` (public URL ${config.publicUrl})` : ''}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
