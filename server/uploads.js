// Resumable uploads in pieces. Proxies limit request bodies (Cloudflare: 100 MB), and big recordings over a
// home connection drop out, so the browser sends UPLOAD_CHUNK_MB pieces, several at once (one connection
// through a proxy is often slower than the line), in any order, and can resume.
//   POST   /api/uploads                 { name, size }  -> { id, chunkSize, received, pieces }
//   GET    /api/uploads/<id>                            -> { id, name, size, received, chunkSize, pieces }
//   PUT    /api/uploads/<id>?offset=N   raw bytes       -> { received, pieces }   (N = k * chunkSize)
//   POST   /api/uploads/<id>/complete                   -> Source (probed, queued for preparing)
//   DELETE /api/uploads/<id>
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './store.js';

export const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'ts', 'm4v', 'mts', 'm2ts', 'wmv']);
const part = (id) => path.join(store.UPLOADS, `${id}.part`);

export function getUpload(id) {
  const u = store.getUploadMeta(id);
  if (u && !u.pieces) {   // started before pieces could come in any order: everything up to `received` is there
    u.chunk = config.chunkBytes;
    u.pieces = [...Array(u.received === u.size ? Math.ceil(u.size / u.chunk) : Math.floor(u.received / u.chunk)).keys()];
    u.received = Math.min(u.size, u.pieces.length * u.chunk);
  }
  return u;
}
export const pieceCount = (u) => Math.ceil(u.size / u.chunk);
const saveUpload = (u) => store.saveUploadMeta(u);

export function removeUpload(id) {
  if (!store.UPLOAD_ID.test(id)) return;
  store.deleteUploadMeta(id); fs.rmSync(part(id), { force: true });
}

// Checks name/size/quota/disk and registers a new upload. Throws Error with .status.
export function startUpload(user, { name, size }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  name = String(name || 'clip.mp4').replace(/[\/\\\u0000-\u001f]/g, '_').slice(0, 200);
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!VIDEO_EXT.has(ext)) throw fail(400, `.${ext} is not a video type this accepts`);
  size = Number(size);
  if (!(size > 0)) throw fail(400, 'empty file');
  if (size > config.maxUploadBytes) throw fail(413, `the file is larger than ${(config.maxUploadBytes / 1e9).toFixed(0)} GB`);
  // Reserve all promised bytes: a sequence of empty upload records must not overbook disk or a user's quota.
  const unfinished = store.listUploadMeta();
  const remaining = (u) => { const total = Number(u.size), received = Number(u.received || 0); return Number.isFinite(total) ? Math.max(0, total - (Number.isFinite(received) ? received : 0)) : 0; };
  // The same file again (same owner, name and size), e.g. from another browser or after site data was cleared:
  // continue that upload instead of holding its space twice.
  const same = unfinished.find((u) => u.owner === user.id && u.name === name && Number(u.size) === size && store.UPLOAD_ID.test(u.id || ''));
  if (same) { const u = getUpload(same.id); if (u) { u.updated = Date.now(); saveUpload(u); return u; } }
  const reserved = unfinished.reduce((n, u) => n + remaining(u), 0);
  const free = store.diskFree();
  if (free !== null && free - reserved - size < config.minFreeBytes) throw fail(507, 'not enough disk space on the server');
  if (!user.admin) {
    const used = store.usageByOwner(true)[user.id] || 0;
    const ownReserved = unfinished.filter((u) => u.owner === user.id).reduce((n, u) => n + remaining(u), 0);
    if (used + ownReserved + size > user.quota) {
      throw fail(413, `this would go over your storage limit (${((used + ownReserved) / 1e9).toFixed(1)} of ${(user.quota / 1e9).toFixed(0)} GB used or held by unfinished uploads). Delete old uploads or ask the admin for more space.`);
    }
  }
  const u = { id: store.randomId(20), owner: user.id, name, ext, size, chunk: config.chunkBytes, pieces: [], received: 0, created: Date.now(), updated: Date.now() };
  fs.writeFileSync(part(u.id), '');
  saveUpload(u);
  return u;
}

// Writes piece number offset/chunk. Pieces can come in any order and at the same time; a piece that already
// arrived is accepted again (a retry after a lost answer).
export async function writeChunk(u, req, offset) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const len = Number(req.headers['content-length'] || 0);
  if (!len) throw fail(411, 'missing Content-Length');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % u.chunk || offset >= u.size) throw fail(400, 'bad piece offset');
  if (len !== Math.min(u.chunk, u.size - offset)) throw fail(400, 'wrong piece size');
  const k = offset / u.chunk;
  if (u.pieces.includes(k)) { req.resume(); return u; }
  const fh = await fs.promises.open(part(u.id), 'r+');
  let pos = offset;
  try {
    for await (const chunk of req) {
      if (pos + chunk.length > offset + len) throw fail(400, 'more data than Content-Length');
      await fh.write(chunk, 0, chunk.length, pos);
      pos += chunk.length;
    }
  } finally { await fh.close(); }
  if (pos !== offset + len) throw fail(400, 'piece incomplete');
  // other pieces may have finished meanwhile: re-read and save in one synchronous step
  const fresh = getUpload(u.id);
  if (!fresh) throw fail(404, 'the upload was cancelled');
  if (!fresh.pieces.includes(k)) fresh.pieces.push(k);
  fresh.pieces.sort((a, b) => a - b);
  fresh.received = fresh.pieces.reduce((n, i) => n + Math.min(fresh.chunk, fresh.size - i * fresh.chunk), 0);
  fresh.updated = Date.now();
  saveUpload(fresh);
  return fresh;
}

// Moves a finished upload into its source folder; returns the file path there.
export function finishUpload(u, sid) {
  const dir = store.sourceDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `source.${u.ext}`);
  fs.renameSync(part(u.id), file);
  store.deleteUploadMeta(u.id);
  return file;
}
export const partPath = part;

// Unfinished uploads untouched for a day are dropped.
export function sweepUploads() {
  for (const { id } of store.listUploadMeta()) {
    const u = getUpload(id);
    if (!u || Date.now() - u.updated > 86400e3) removeUpload(id);
  }
  for (const f of fs.readdirSync(store.UPLOADS)) {   // orphaned .part files
    const m = /^([A-Za-z0-9]{20})\.part$/.exec(f);
    if (m && !store.getUploadMeta(m[1])) fs.rmSync(path.join(store.UPLOADS, f), { force: true });
  }
}
