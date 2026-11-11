// On-disk store. Everything lives under DATA_DIR:
//   auth.json                    users (scrypt hashes) and sessions (hashed tokens), mode 600
//   sources/<sid>/source.<ext>   an uploaded recording, untouched
//   sources/<sid>/meta.json      probe result, owner, last edit settings, exports
//   sources/<sid>/preview.mp4    browser-playable copy without audio (for the editor)
//   sources/<sid>/audio-<n>.m4a  each audio track on its own (+ -light/-strong leveled previews)
//   sources/<sid>/peaks-<n>.json waveform peaks
//   clips/<id>.mp4 .jpg .json    finished, public clips (the only thing anonymous visitors can read)
//   uploads/<uid>.part .json     uploads in progress (chunked)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export const DATA_DIR = config.dataDir;
export const SOURCES = path.join(DATA_DIR, 'sources');
export const CLIPS = path.join(DATA_DIR, 'clips');
export const UPLOADS = path.join(DATA_DIR, 'uploads');
export const TMP = path.join(DATA_DIR, 'tmp');
for (const d of [SOURCES, CLIPS, UPLOADS, TMP]) fs.mkdirSync(d, { recursive: true });

// Ids: base62. Public clip ids are 12 chars = ~71 bits, not guessable or enumerable.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomId(len = 12) {
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 248 && out.length < len) out += ALPHABET[b % 62]; // 248 = 4*62, no modulo bias
    }
  }
  return out;
}
export const CLIP_ID = /^[A-Za-z0-9]{12}$/;
export const SOURCE_ID = /^[A-Za-z0-9]{16}$/;
export const UPLOAD_ID = /^[A-Za-z0-9]{20}$/;

export function writeJson(file, obj, mode = 0o644) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode });
  fs.renameSync(tmp, file);
}
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Older data (single-user versions) has no owner: it belongs to the admin.
const withOwner = (o) => (o && !o.owner ? { ...o, owner: 'admin' } : o);

// ---- in-memory cache of all metadata JSON (sources, clips, unfinished uploads) ----
// This process is the only writer, so after one scan per kind nothing is read from disk again: every write,
// rename or delete of metadata goes through the functions below, which update the cache after the file
// operation succeeded. Callers get copies (they mutate and then save), so a mutation without a save can never
// leak into the cache. Files edited by hand while the server runs are not noticed until a restart.
const cache = { source: null, clip: null, upload: null };   // kind -> Map(id -> meta)
const KINDS = {
  source: { dir: SOURCES, id: SOURCE_ID, file: (id) => path.join(SOURCES, id, 'meta.json'), ids: () => fs.readdirSync(SOURCES).filter((s) => SOURCE_ID.test(s)) },
  clip: { dir: CLIPS, id: CLIP_ID, file: (id) => clipFile(id, 'json'), ids: () => fs.readdirSync(CLIPS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) },
  upload: { dir: UPLOADS, id: UPLOAD_ID, file: (id) => path.join(UPLOADS, `${id}.json`), ids: () => fs.readdirSync(UPLOADS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) },
};
const copy = (o) => (o ? structuredClone(o) : null);
function warm(kind) {
  if (cache[kind]) return cache[kind];
  const k = KINDS[kind], m = new Map();
  for (const id of k.ids()) { if (!k.id.test(id)) continue; const o = readJson(k.file(id)); if (o) m.set(id, o); }
  return (cache[kind] = m);
}
function put(kind, meta, mode) {
  const k = KINDS[kind];
  if (!k.id.test(meta.id)) throw new Error('bad id');
  warm(kind);   // scan before the first write so the new file is not counted twice
  writeJson(k.file(meta.id), meta, mode);
  cache[kind].set(meta.id, copy(meta));
  forgetUsage();
}
const get = (kind, id) => (KINDS[kind].id.test(id) ? copy(warm(kind).get(id)) : null);
const all = (kind) => [...warm(kind).values()].map(copy);
// Drops the entry (and forgets usage); the caller removes the files.
function drop(kind, id) { warm(kind).delete(id); forgetUsage(); }

export const sourceDir = (sid) => path.join(SOURCES, sid);
export const getSource = (sid) => withOwner(get('source', sid));
export function saveSource(meta) { put('source', meta); }
export function listSources() { return all('source').map(withOwner).sort((a, b) => b.created - a.created); }
export function deleteSource(sid) {
  if (!SOURCE_ID.test(sid)) return false;
  fs.rmSync(sourceDir(sid), { recursive: true, force: true });
  drop('source', sid);
  return true;
}

export const clipFile = (id, ext) => path.join(CLIPS, `${id}.${ext}`);
export const getClip = (id) => withOwner(get('clip', id));
export function saveClip(meta) { put('clip', meta); }
export function listClips() { return all('clip').map(withOwner).sort((a, b) => b.created - a.created); }
export function deleteClip(id) {
  if (!CLIP_ID.test(id)) return false;
  for (const ext of ['json', 'mp4', 'jpg']) fs.rmSync(clipFile(id, ext), { force: true });
  drop('clip', id);
  return true;
}

// Unfinished uploads (uploads/<id>.json; the .part file is handled by uploads.js).
export const getUploadMeta = (id) => get('upload', id);
export const saveUploadMeta = (u) => put('upload', u);
export const listUploadMeta = () => all('upload');
export function deleteUploadMeta(id) {
  if (!UPLOAD_ID.test(id)) return;
  fs.rmSync(KINDS.upload.file(id), { force: true });
  drop('upload', id);
}

function dirSize(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) { try { n += fs.statSync(path.join(dir, f)).size; } catch { /* gone */ } } } catch { /* gone */ }
  return n;
}
// Bytes used per owner: their recordings (with editor files), clips and unfinished uploads. Metadata comes from
// the cache; only the editor-file sizes of recordings are stat()ed, and that result is kept for 15 s (media.js
// adds files to a recording's folder without telling the store). Any store write clears it.
let usageCache = { at: 0, map: null };
export function usageByOwner(fresh = false) {
  if (!fresh && usageCache.map && Date.now() - usageCache.at < 15000) return usageCache.map;
  const map = {};
  const add = (owner, bytes) => { map[owner] = (map[owner] || 0) + bytes; };
  for (const s of warm('source').values()) add(s.owner || 'admin', dirSize(sourceDir(s.id)));
  for (const c of warm('clip').values()) add(c.owner || 'admin', c.size || 0);
  for (const u of warm('upload').values()) add(u.owner, u.received || 0);
  usageCache = { at: Date.now(), map };
  return map;
}
export function forgetUsage() { usageCache.map = null; }

export function diskFree() {
  try { const s = fs.statfsSync(DATA_DIR); return s.bavail * s.bsize; } catch { return null; }
}
