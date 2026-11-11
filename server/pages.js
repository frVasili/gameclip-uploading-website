// Public, anonymous part: the watch page Discord embeds, the clip files, and nothing else about anyone's data.
//   GET /<id>       watch page with the Open Graph tags Discord uses to embed the video
//   GET /<id>.mp4   the video (Range support)
//   GET /<id>.jpg   the thumbnail
// Unknown ids get the same 404 as any other bad path, so clips can't be discovered by probing.
import fs from 'node:fs';
import path from 'node:path';
import { config, publicBase } from './config.js';
import { getClip, clipFile, CLIP_ID, DATA_DIR } from './store.js';
import { userName } from './auth.js';
import { send, sendFile, esc } from './http.js';

const MEDIA_CACHE = 'public, max-age=300';

// Access log for clip fetches (JSON lines, no visitor IPs): shows how Discord's crawler and media proxy fetch
// clips. Rotated at 20 MB (one old copy kept). ACCESS_LOG=false turns it off.
const LOG = path.join(DATA_DIR, 'access.log');
export function logRequest(req, res, t0) {
  if (!config.logRequests) return;
  const ms = Date.now() - t0, len = Number(res.getHeader('content-length') || 0);
  const rec = { t: new Date(t0).toISOString(), m: req.method, p: req.url, s: res.statusCode, range: req.headers.range, len,
    done: res.writableFinished, ms, ua: (req.headers['user-agent'] || '').slice(0, 160) };
  try {
    if ((fs.statSync(LOG, { throwIfNoEntry: false })?.size || 0) > 20e6) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, `${JSON.stringify(rec)}\n`);
  } catch (e) { console.error('access log:', e.message); }
}

const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Shared by the 404 and the watch page: the Aqua toolbar and push button.
const PAGE_CSS = `@font-face{font-family:Inter;font-weight:100 900;font-display:swap;src:url(/static/inter.woff2) format("woff2")}
  html,body{margin:0;background:#fff;color:#1d1d1f;font:14px/1.45 Inter,"Lucida Grande","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  body{min-height:100vh}
  header{display:flex;align-items:center;height:52px;padding:0 18px;background:linear-gradient(#ececec,#d2d2d2);border-bottom:1px solid #8e8e8e;box-shadow:inset 0 1px 0 #fafafa}
  .bar{display:inline-flex;align-items:center;gap:9px;color:#333;text-decoration:none;font-weight:700;font-size:16px;text-shadow:0 1px 0 rgba(255,255,255,.8)}
  .bar img{width:26px;height:26px}
  a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:26px;padding:2px 13px;border-radius:5px;border:1px solid #a4a4a4;border-bottom-color:#8b8b8b;background:linear-gradient(#fff,#ededed);box-shadow:0 1px 0 rgba(255,255,255,.7);color:#1d1d1f;font-weight:500;font-size:13px;text-decoration:none;white-space:nowrap}
  a.btn:hover{background:linear-gradient(#fff,#f6f6f6)} a.btn:active{background:linear-gradient(#d9d9d9,#e9e9e9);box-shadow:inset 0 1px 2px rgba(0,0,0,.2)}
  a.btn:focus-visible{outline:none;box-shadow:0 0 0 2px #fff,0 0 0 4px #2a6fd2}`;
const pageHeader = () => `<header><a class="bar" href="/home"><img src="/static/favicon.svg" alt="">${esc(config.siteName)}</a></header>`;

export const notFoundPage = (msg = 'Nothing here.') => `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title>
<link rel="icon" href="/static/favicon.svg">
<style>${PAGE_CSS}
  main{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:calc(100vh - 53px);padding:0 16px 60px;box-sizing:border-box;text-align:center;font-size:16px;font-weight:600}
  main p{margin:0}</style>
${pageHeader()}
<main><p>${esc(msg)}</p><a class="btn" href="/home">Go to ${esc(config.siteName)}</a></main>`;

function watchPage(req, c) {
  const base = publicBase(req);
  const url = `${base}/${c.id}`, mp4 = `${base}/${c.id}.mp4`, jpg = `${base}/${c.id}.jpg`;
  const title = esc(c.title || 'Clip'), by = esc(userName(c.owner));
  const desc = esc(`${fmtDuration(c.duration)} · ${c.height}p · ${(c.size / 1e6).toFixed(1)} MB`);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} · ${esc(config.siteName)}</title>
<meta name="theme-color" content="#2f84f5">
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:type" content="video.other">
${c.hasThumb ? `<meta property="og:image" content="${jpg}">
<meta property="og:image:width" content="${c.width}">
<meta property="og:image:height" content="${c.height}">` : ''}
<meta property="og:video" content="${mp4}">
<meta property="og:video:url" content="${mp4}">
<meta property="og:video:secure_url" content="${mp4}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="${c.width}">
<meta property="og:video:height" content="${c.height}">
<link rel="icon" href="/static/favicon.svg">
<style>
  ${PAGE_CSS}
  main{max-width:min(1280px,100vw);margin:0 auto;padding:22px 20px 40px;box-sizing:border-box}
  video{width:100%;max-height:78vh;background:#000;display:block;border:1px solid #7d7d7d;box-sizing:border-box;box-shadow:0 2px 10px rgba(0,0,0,.25)}
  h1{font-weight:700;font-size:20px;margin:16px 0 4px;color:#1d1d1f;overflow-wrap:anywhere}
  .meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;color:#77787b;font-size:13px}
  a.btn.small{min-height:22px;padding:1px 10px;font-size:12px}
</style>
</head><body>
${pageHeader()}
<main>
<video src="${mp4}" ${c.hasThumb ? `poster="${jpg}"` : ''} controls playsinline preload="metadata"></video>
<h1>${title}</h1>
<div class="meta"><span>by ${by} · ${desc}</span><a class="btn small" href="${mp4}?download" download>download</a></div>
</main></body></html>`;
}

// "Save as" with the clip's title as the file name (ASCII fallback + UTF-8 name, RFC 6266).
function attachment(c) {
  const name = (c.title || c.id).replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || c.id;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  return `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encodeURIComponent(name)}.mp4`;
}

// Returns true if this was a clip URL (handled), false otherwise.
export function handleClipPage(req, res, pathname, query = new URLSearchParams()) {
  const m = /^\/([A-Za-z0-9]{12})(\.mp4|\.jpg)?$/.exec(pathname);
  if (!m) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'method not allowed', 'text/plain', { Allow: 'GET, HEAD' }); return true; }
  const t0 = Date.now();
  res.on('close', () => logRequest(req, res, t0));
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const clip = CLIP_ID.test(m[1]) ? getClip(m[1]) : null;
  if (!clip) { send(res, 404, notFoundPage('This clip does not exist (or was deleted).'), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' }); return true; }
  if (m[2]) {
    const headers = { 'Cache-Control': MEDIA_CACHE };
    if (m[2] === '.mp4' && query.has('download')) headers['Content-Disposition'] = attachment(clip);
    sendFile(req, res, clipFile(clip.id, m[2].slice(1)), headers); return true;
  }
  send(res, 200, watchPage(req, clip), 'text/html; charset=utf-8', {
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; media-src 'self'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'",
  });
  return true;
}
