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

export const sourceDir = (sid) => path.join(SOURCES, sid);
export function getSource(sid) {
  if (!SOURCE_ID.test(sid)) return null;
  return withOwner(readJson(path.join(sourceDir(sid), 'meta.json')));
}
export function saveSource(meta) { writeJson(path.join(sourceDir(meta.id), 'meta.json'), meta); }
export function listSources() {
  return fs.readdirSync(SOURCES).filter((s) => SOURCE_ID.test(s)).map(getSource).filter(Boolean)
    .sort((a, b) => b.created - a.created);
}
export function deleteSource(sid) {
  if (!SOURCE_ID.test(sid)) return false;
  fs.rmSync(sourceDir(sid), { recursive: true, force: true });
  return true;
}

export const clipFile = (id, ext) => path.join(CLIPS, `${id}.${ext}`);
export function getClip(id) {
  if (!CLIP_ID.test(id)) return null;
  return withOwner(readJson(clipFile(id, 'json')));
}
export function saveClip(meta) { writeJson(clipFile(meta.id, 'json'), meta); }
export function listClips() {
  return fs.readdirSync(CLIPS).filter((f) => f.endsWith('.json')).map((f) => getClip(f.slice(0, -5)))
    .filter(Boolean).sort((a, b) => b.created - a.created);
}
export function deleteClip(id) {
  if (!CLIP_ID.test(id)) return false;
  for (const ext of ['json', 'mp4', 'jpg']) fs.rmSync(clipFile(id, ext), { force: true });
  return true;
}

function dirSize(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) { try { n += fs.statSync(path.join(dir, f)).size; } catch { /* gone */ } } } catch { /* gone */ }
  return n;
}
// Bytes used per owner: their recordings (with editor files), clips and unfinished uploads.
let usageCache = { at: 0, map: null };
export function usageByOwner(fresh = false) {
  if (!fresh && usageCache.map && Date.now() - usageCache.at < 15000) return usageCache.map;
  const map = {};
  const add = (owner, bytes) => { map[owner] = (map[owner] || 0) + bytes; };
  for (const s of listSources()) add(s.owner, dirSize(sourceDir(s.id)));
  for (const c of listClips()) add(c.owner, c.size || 0);
  for (const f of fs.readdirSync(UPLOADS).filter((x) => x.endsWith('.json'))) {
    const u = readJson(path.join(UPLOADS, f)); if (u) add(u.owner, u.received || 0);
  }
  usageCache = { at: Date.now(), map };
  return map;
}
export const forgetUsage = () => { usageCache.map = null; };

export function diskFree() {
  try { const s = fs.statfsSync(DATA_DIR); return s.bavail * s.bsize; } catch { return null; }
}
