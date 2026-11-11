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

export const notFoundPage = (msg = 'Nothing here.') => `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title>
<style>body{background:url(/static/linen.svg) #25272b;color:#c0c4cc;font:16px "Helvetica Neue","Segoe UI",system-ui,sans-serif;text-shadow:0 -1px 0 rgba(0,0,0,.6);display:grid;place-items:center;height:90vh;margin:0}a{color:#a8d3ff}</style>
<p>${esc(msg)} <a href="/home">Go to ${esc(config.siteName)}</a></p>`;

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
<meta name="theme-color" content="#2a97ff">
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
  @font-face{font-family:"Chakra Petch";font-weight:600;font-display:swap;src:url(/static/chakra-petch-600.woff2) format("woff2")}
  html,body{margin:0;background:#25272b;color:#c0c4cc;font:15px/1.45 "Helvetica Neue","Segoe UI",system-ui,-apple-system,sans-serif}
  body{min-height:100vh;background:radial-gradient(120% 90% at 50% 0,transparent 55%,rgba(0,0,0,.35)) fixed,url(/static/linen.svg),#25272b;text-shadow:0 -1px 0 rgba(0,0,0,.6)}
  header{display:flex;align-items:center;height:54px;padding:0 20px;background:linear-gradient(180deg,#5c606a,#3c3f46 50%,#2a2c31 50%,#232529);border-bottom:1px solid #000;box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 2px 6px rgba(0,0,0,.45)}
  main{max-width:min(1280px,100vw);margin:0 auto;padding:22px 20px 40px;box-sizing:border-box}
  .bar{display:inline-flex;align-items:center;gap:9px;color:#f4f5f7;text-decoration:none;font:600 18px "Chakra Petch",system-ui,sans-serif;letter-spacing:.02em}
  .bar img{width:28px;height:28px}
  video{width:100%;max-height:78vh;background:#000;border-radius:8px;display:block;border:5px solid #000;box-sizing:border-box;box-shadow:0 1px 0 rgba(255,255,255,.12),0 8px 24px rgba(0,0,0,.5)}
  h1{font:700 22px "Helvetica Neue","Segoe UI",system-ui,sans-serif;margin:16px 0 4px;color:#f4f5f7;overflow-wrap:anywhere}
  .meta{color:#aeb3bc;font-size:14px} .meta a{color:#a8d3ff}
</style>
</head><body>
<header><a class="bar" href="/home"><img src="/static/favicon.svg" alt="">${esc(config.siteName)}</a></header>
<main>
<video src="${mp4}" ${c.hasThumb ? `poster="${jpg}"` : ''} controls playsinline preload="metadata"></video>
<h1>${title}</h1>
<div class="meta">by ${by} · ${desc} · <a href="${mp4}" download>download</a></div>
</main></body></html>`;
}

// Returns true if this was a clip URL (handled), false otherwise.
export function handleClipPage(req, res, pathname) {
  const m = /^\/([A-Za-z0-9]{12})(\.mp4|\.jpg)?$/.exec(pathname);
  if (!m) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'method not allowed', 'text/plain', { Allow: 'GET, HEAD' }); return true; }
  const t0 = Date.now();
  res.on('close', () => logRequest(req, res, t0));
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const clip = CLIP_ID.test(m[1]) ? getClip(m[1]) : null;
  if (!clip) { send(res, 404, notFoundPage('This clip does not exist (or was deleted).'), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' }); return true; }
  if (m[2]) { sendFile(req, res, clipFile(clip.id, m[2].slice(1)), { 'Cache-Control': MEDIA_CACHE }); return true; }
  send(res, 200, watchPage(req, clip), 'text/html; charset=utf-8', {
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; media-src 'self'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'",
  });
  return true;
}
