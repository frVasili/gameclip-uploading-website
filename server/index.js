// One HTTP server for everything:
//   /                      -> /home
//   /home, /edit/<id>, /admin and /static/*   the app (pages are public; their data needs a login)
//   /api/login, /api/logout, /api/me          sign in / out
//   /api/invite/check, /api/invite/accept     one-time invite links (public; the token is the credential)
//   /api/*                 everything else: signed in only (see api.js)
//   /<12-char id>[.mp4|.jpg]                  public clip pages and files (pages.js)
//   /healthz, /robots.txt
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as auth from './auth.js';
import { handleApi, userError } from './api.js';
import { handleClipPage, notFoundPage } from './pages.js';
import { send, json, sendFile, readBody, TYPES } from './http.js';

const STATIC_DIR = process.env.STATIC_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'web');

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
// pages of the app itself: only our own scripts; media/blob for the editor
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PAGES = { '/home': 'home.html', '/admin': 'admin.html', '/account': 'admin.html', '/invite': 'invite.html' };

// Versioned asset URLs. CDNs (Cloudflare's default "Browser Cache TTL" is 4 h) and browsers may keep scripts
// longer than we ask, so pages link /static/v-<hash of web/>/file. A new release = new URLs = no stale scripts.
// Relative imports inside the JS modules resolve under the same versioned folder automatically.
const VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(STATIC_DIR).sort()) { h.update(f); h.update(fs.readFileSync(path.join(STATIC_DIR, f))); }
  return h.digest('hex').slice(0, 10);
})();
const pageCache = new Map();
function sendPage(req, res, file) {
  let html = pageCache.get(file);
  if (!html) {
    html = Buffer.from(fs.readFileSync(path.join(STATIC_DIR, file), 'utf8').replace(/(["'])\/static\//g, `$1/static/v-${VERSION}/`));
    pageCache.set(file, html);
  }
  const etag = `"${crypto.createHash('sha256').update(html).digest('hex')}"`;
  const headers = { 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP, ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  return send(res, 200, html, 'text/html; charset=utf-8', headers);
}

// small JSON body for the public auth endpoints; bad or oversized input counts as empty
async function smallBody(req) {
  try { const b = JSON.parse(await readBody(req, 4096) || '{}'); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
}

async function handle(req, res) {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
  if (auth.isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
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
    if (page) return sendPage(req, res, page);
    const sm = /^\/static\/(?:v-([a-f0-9]{10})\/)?([A-Za-z0-9._-]+)$/.exec(p);
    if (sm && TYPES[path.extname(sm[2])]) {
      // the current version is immutable; old or unversioned URLs must always be re-checked
      const cache = sm[1] === VERSION ? 'public, max-age=31536000, immutable' : 'no-cache';
      return sendFile(req, res, path.join(STATIC_DIR, sm[2]), { 'Cache-Control': cache });
    }
  }

  if (p.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    if (m !== 'GET' && m !== 'HEAD' && req.headers['x-clips'] !== '1') return json(res, 403, { error: 'missing X-Clips header' });
    if (p === '/api/login' && m === 'POST') {
      const b = await smallBody(req);
      const r = await auth.login(req, res, b.name, b.password);
      return r.ok ? json(res, 200, { user: r.user }) : json(res, r.status, { error: r.error });
    }
    // invite links: public, but the token is the credential (rate limited like logins)
    if ((p === '/api/invite/check' || p === '/api/invite/accept') && m === 'POST') {
      const b = await smallBody(req);
      try { return json(res, 200, p.endsWith('check') ? auth.checkInvite(req, b.token) : await auth.acceptInvite(req, res, b)); }
      catch (e) { return json(res, e.status || 400, { error: e.message }); }
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
    if (!res.headersSent && Number.isInteger(err?.status)) return json(res, err.status, { error: userError(err.message) || 'request failed' });
    console.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('internal error'); } else res.destroy();
  });
});
server.requestTimeout = 0;   // long downloads and upload pieces on slow connections
server.headersTimeout = 60e3;
server.listen(config.port, config.host, () => console.log(`${config.siteName} listening on ${config.host}:${config.port}${config.publicUrl ? ` (public URL ${config.publicUrl})` : ''}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
