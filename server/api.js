// The signed-in part: uploads, editor, exports, user management. Every request here needs a session; users
// only ever see their own uploads and clips, the admin sees everything. Every state-changing request must
// also carry "X-Clips: 1" (a cross-site page can't send that without a CORS preflight we never answer).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, publicBase } from './config.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as uploads from './uploads.js';
import { json, sendFile, readBody } from './http.js';
import { probe, prepare, convertPreview, render, plan, thumbnail, PRESETS, LEVELING, LOUDNESS, measureTrack, makeLeveledPreview, makePoster, gpu, detectGpu, maxOf } from './media.js';

let FFMPEG_VERSION = 'unknown';
try { FFMPEG_VERSION = execFileSync(process.env.FFMPEG || 'ffmpeg', ['-version']).toString().split('\n')[0].replace(/ Copyright.*/, ''); } catch { /* unknown */ }
detectGpu().then((g) => console.log(g.available ? `GPU encoding available (${g.device})` : `GPU encoding off: ${g.error}`));

// ---- job queue: one ffmpeg job at a time ----
const jobs = new Map();
const queue = [];
let running = null;
let sideFfmpegRunning = 0;
const sideFfmpegQueue = [];
const posterFailures = new Set();

// Previews and analysis deliberately do not hold up exports, but still need a small shared limit.
function sideFfmpeg(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      sideFfmpegRunning++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        sideFfmpegRunning--;
        sideFfmpegQueue.shift()?.();
      });
    };
    if (sideFfmpegRunning < 2) run(); else sideFfmpegQueue.push(run);
  });
}

function enqueue(job) {
  Object.assign(job, { id: store.randomId(10), state: 'queued', progress: 0, created: Date.now() });
  jobs.set(job.id, job); queue.push(job); pump();
  return job;
}
async function pump() {
  if (running || !queue.length) return;
  running = queue.shift();
  running.state = 'running'; running.started = Date.now();
  try {
    await running.run((f) => { running.progress = Math.round(f * 1000) / 1000; });
    running.state = 'done'; running.progress = 1;
  } catch (e) {
    running.state = 'error'; running.error = e.message;
    console.error(`[job ${running.kind} ${running.id}]`, e.message);
    running.onError?.(e);
  }
  running.finished = Date.now();
  store.forgetUsage();
  for (const [id, j] of jobs) if (j.finished && Date.now() - j.finished > 3600e3) jobs.delete(id);
  running = null;
  pump();
}
// error text shown to users: no server paths, no ffmpeg noise
export const userError = (msg) => String(msg || '').replace(/(?:\/[\w.@+-]+)+\/?/g, 'the file').replace(/\s*\|\s*Last message repeated \d+ times/g, '').slice(0, 300);
const jobView = (j) => j && { id: j.id, kind: j.kind, state: j.state, progress: j.progress, error: j.error && userError(j.error),
  clipId: j.clipId, sourceId: j.sid, position: j.state === 'queued' ? queue.indexOf(j) + 1 : 0 };
const activeJobsOf = (owner) => [...jobs.values()].filter((j) => j.owner === owner && (j.state === 'queued' || j.state === 'running')).length;

function prepareJob(s) {
  return enqueue({
    kind: 'prepare', sid: s.id, owner: s.owner,
    run: async (progress) => {
      const meta = store.getSource(s.id); if (!meta) return;
      meta.status = 'preparing'; store.saveSource(meta);
      const r = await prepare(path.join(store.sourceDir(s.id), meta.file), store.sourceDir(s.id), meta.info, progress);
      const m = store.getSource(s.id); if (!m) return;
      markTracks(m, r.audio);
      Object.assign(m, { status: 'ready', preview: r.preview });
      if (r.direct) Object.assign(m, { direct: r.direct, directFile: r.directFile });
      store.saveSource(m);
    },
    onError: (e) => { const m = store.getSource(s.id); if (m) { m.status = 'error'; m.error = userError(e.message); store.saveSource(m); } },
  });
}
// Converting the preview only when an editor asks for it (its browser can't play the recording itself), so it
// doesn't keep the GPU/CPU busy or hold up exports for nothing.
function previewJob(s) {
  return enqueue({
    kind: 'preview', sid: s.id, owner: s.owner,
    run: async (progress) => {
      const meta = store.getSource(s.id); if (!meta) return;
      console.log(await convertPreview(path.join(store.sourceDir(s.id), meta.file), store.sourceDir(s.id), meta.info, progress));
      const m = store.getSource(s.id); if (!m) return;
      m.preview = 'ready'; if (m.directFile === 'original.mp4') delete m.directFile;
      store.saveSource(m);
    },
    onError: (e) => { const m = store.getSource(s.id); if (m) { m.preview = 'error'; m.previewError = userError(e.message); store.saveSource(m); } },
  });
}

// Per-track facts from prepare(): silent, or the same sound as an earlier track (shown in the editor)
function markTracks(meta, facts) {
  for (const f of facts) {
    const a = meta.info.audio[f.n]; if (!a) continue;
    a.silent = f.silent; if (f.sameAs !== null) a.sameAs = f.sameAs; else delete a.sameAs;
  }
  meta.tracksChecked = true;
}
// Recordings prepared before tracks were checked: compare their waveforms instead (identical waveforms over
// a whole recording means the same sound in practice).
function checkOldTracks(s) {
  if (s.status !== 'ready' || s.tracksChecked) return;
  try {
    const seen = new Map();
    markTracks(s, s.info.audio.map((a) => {
      const peaks = JSON.parse(fs.readFileSync(path.join(store.sourceDir(s.id), `peaks-${a.n}.json`), 'utf8')).peaks;
      const silent = maxOf(peaks) <= 3, key = peaks.join(',');
      const sameAs = !silent && seen.has(key) ? seen.get(key) : null;
      if (!seen.has(key)) seen.set(key, a.n);
      return { n: a.n, silent, sameAs };
    }));
    store.saveSource(s);
  } catch (e) { console.error(`checking tracks of ${s.id}:`, e.message); }
}

// After a restart: redo interrupted preparing, mark interrupted exports as failed.
for (const s of store.listSources()) {
  if (s.status === 'preparing' || s.status === 'queued') prepareJob(s);
  else if (s.status === 'ready' && s.preview === 'converting') previewJob(s);
  checkOldTracks(s);
  let changed = false;
  for (const x of s.exports || []) if (x.state === 'queued' || x.state === 'running') { x.state = 'error'; x.error = 'interrupted by a restart'; changed = true; }
  if (changed) store.saveSource(s);
}

// ---- housekeeping: stale uploads, optional expiry of old recordings ----
function housekeeping() {
  try {
    uploads.sweepUploads();
    if (config.sourceRetentionDays > 0) {
      const cutoff = Date.now() - config.sourceRetentionDays * 86400e3;
      for (const s of store.listSources()) {
        if (s.created < cutoff && ![...jobs.values()].some((j) => j.sid === s.id && j.state !== 'done' && j.state !== 'error')) {
          store.deleteSource(s.id); console.log(`deleted recording ${s.id} (older than ${config.sourceRetentionDays} days; its clips stay)`);
        }
      }
    }
    store.forgetUsage();
  } catch (e) { console.error('housekeeping:', e.message); }
}
setInterval(housekeeping, 3600e3).unref();
setTimeout(housekeeping, 5000).unref();

// ---- validation ----
function cleanEdit(info, e) {
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const start = num(e.start, 0, info.duration, 0);
  const end = num(e.end, 0, info.duration, info.duration);
  if (end - start < 0.5) throw new Error('the clip must be at least half a second long');
  const tracks = info.audio.map((a) => {
    const t = (Array.isArray(e.tracks) ? e.tracks : []).find((x) => Number(x?.n) === a.n) || {};
    return { n: a.n, volume: num(t.volume, 0, 4, 1), muted: !!t.muted, level: t.level in LEVELING ? t.level : 'off' };
  });
  return {
    start, end, tracks,
    fadeIn: num(e.fadeIn, 0, 10, 0), fadeOut: num(e.fadeOut, 0, 10, 0), videoFade: !!e.videoFade,
    normalize: e.normalize !== false,
    title: String(e.title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200),
    thumbTime: num(e.thumbTime, start, end, start),
    preset: e.preset in PRESETS ? e.preset : 'discord',
    resolution: ['auto', 'source', '2160', '1440', '1080', '720', '480'].includes(String(e.resolution)) ? String(e.resolution) : 'auto',
    fps: ['source', '60', '30'].includes(String(e.fps)) ? String(e.fps) : 'source',
    gpu: !!e.gpu,
  };
}
const cleanTitle = (t) => String(t ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);

function exportJob(s, edit) {
  const clipId = store.randomId();
  const meta = store.getSource(s.id);
  meta.edit = edit;
  meta.exports = [{ clipId, created: Date.now(), state: 'queued', title: edit.title }, ...(meta.exports || [])];
  store.saveSource(meta);
  const setState = (patch) => {
    const m = store.getSource(s.id); if (!m) return;
    const x = (m.exports || []).find((y) => y.clipId === clipId); if (x) Object.assign(x, patch);
    store.saveSource(m);
  };
  return enqueue({
    kind: 'render', sid: s.id, clipId, owner: s.owner,
    run: async (progress) => {
      setState({ state: 'running' });
      const m = store.getSource(s.id);
      if (!m) throw new Error('the upload was deleted');
      const tmp = path.join(store.TMP, `${clipId}.mp4`), tmpJpg = path.join(store.TMP, `${clipId}.jpg`);
      const r = await render(path.join(store.sourceDir(s.id), m.file), m.info, edit, tmp, store.TMP, progress);
      let hasThumb = false;
      try { await thumbnail(tmp, edit.thumbTime - edit.start, tmpJpg); hasThumb = true; } catch (e) { console.error('thumbnail:', e.message); }
      fs.renameSync(tmp, store.clipFile(clipId, 'mp4'));
      if (hasThumb) fs.renameSync(tmpJpg, store.clipFile(clipId, 'jpg'));
      store.saveClip({ id: clipId, owner: m.owner, title: edit.title || m.name.replace(/\.[^.]+$/, ''), created: Date.now(),
        width: r.plan.w, height: r.plan.h, fps: r.plan.fps, duration: r.plan.dur, size: r.bytes, hasThumb, sourceId: s.id,
        preset: r.plan.preset, gpu: r.gpu, edit });
      setState({ state: 'done', size: r.bytes });
    },
    onError: (e) => {
      for (const ext of ['mp4', 'jpg']) fs.rmSync(path.join(store.TMP, `${clipId}.${ext}`), { force: true });
      setState({ state: 'error', error: userError(e.message) });
    },
  });
}

// ---- views ----
const clipView = (req, c) => c && { ...c, ownerName: auth.userName(c.owner),
  sourceGone: !c.sourceId || !store.getSource(c.sourceId),   // the recording was deleted: the clip stays, no editing
  url: `${publicBase(req)}/${c.id}`, mp4: `${publicBase(req)}/${c.id}.mp4` };
function sourceView(req, s) {
  if (!s) return null;
  return { ...s, ownerName: auth.userName(s.owner),
    jobs: [...jobs.values()].filter((j) => j.sid === s.id && j.state !== 'done').map(jobView),
    exports: (s.exports || []).map((x) => ({ ...x, clip: x.state === 'done' ? clipView(req, store.getClip(x.clipId)) : null })) };
}
const mine = (user, obj) => obj && (user.admin || obj.owner === user.id);
function usageView(user) {
  const used = store.usageByOwner()[user.id] || 0;
  return { used, quota: user.admin ? null : user.quota };
}

const body = async (req) => { const t = await readBody(req); try { return t ? JSON.parse(t) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); } };
const sendErr = (res, e) => json(res, e.status || 400, { error: e.message }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});

// ---- router: returns true if it handled the request ----
export async function handleApi(req, res, url, user) {
  const p = url.pathname, m = req.method;
  let r;

  if (p === '/api/status' && m === 'GET') {
    const out = { user: { ...user, ...usageView(user) }, queue: queue.length + (running ? 1 : 0), siteName: config.siteName,
      presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, cap: v.cap }])),
      leveling: Object.keys(LEVELING), loudnessTarget: LOUDNESS.I, gpu: { available: gpu.available, default: gpu.available && config.gpuDefault },
      chunkSize: config.chunkBytes, maxUpload: config.maxUploadBytes, publicBase: publicBase(req) };
    if (user.admin) Object.assign(out, { diskFree: store.diskFree(), ffmpeg: FFMPEG_VERSION, gpu: { ...gpu, default: gpu.available && config.gpuDefault }, running: jobView(running),
      retentionDays: config.sourceRetentionDays });
    return json(res, 200, out);
  }

  // ---- your own account: rename yourself ----
  if (p === '/api/me' && m === 'PATCH') {
    try { const b = await body(req); auth.rename(user.id, b.name); return json(res, 200, { user: auth.getUser(user.id) }); }
    catch (e) { return sendErr(res, e); }
  }

  if (p === '/api/me/password' && m === 'POST') {
    try { const b = await body(req); await auth.changePassword(req, user, b.current, b.password); return json(res, 200, { ok: true }); }
    catch (e) { return sendErr(res, e); }
  }

  // ---- invite links (admin only) ----
  if (p === '/api/invites' || p.startsWith('/api/invites/')) {
    if (!user.admin) return json(res, 403, { error: 'admin only' });
    if (p === '/api/invites' && m === 'GET') return json(res, 200, { invites: auth.listInvites(), defaultQuotaGB: config.defaultQuotaBytes / 1e9 });
    if (p === '/api/invites' && m === 'POST') {
      try { const r2 = auth.createInvite(await body(req)); return json(res, 201, { invite: r2.invite, url: `${publicBase(req)}/invite#${r2.token}` }); }
      catch (e) { return sendErr(res, e); }
    }
    const im = /^\/api\/invites\/([A-Za-z0-9]{10})$/.exec(p);
    if (im && m === 'DELETE') return auth.revokeInvite(im[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such invite' });
  }

  // ---- uploads (chunked) ----
  if (p === '/api/uploads' && m === 'POST') {
    try { const u = uploads.startUpload(user, await body(req)); return json(res, 201, { id: u.id, chunkSize: u.chunk, received: u.received, size: u.size, pieces: u.pieces }); }
    catch (e) { return sendErr(res, e); }
  }
  if ((r = /^\/api\/uploads\/([A-Za-z0-9]{20})(\/complete)?$/.exec(p))) {
    const u = uploads.getUpload(r[1]);
    if (!u || u.owner !== user.id) return json(res, 404, { error: 'no such upload' });
    if (!r[2] && m === 'GET') return json(res, 200, { id: u.id, name: u.name, size: u.size, received: u.received, chunkSize: u.chunk, pieces: u.pieces });
    if (!r[2] && m === 'DELETE') { uploads.removeUpload(u.id); return json(res, 200, { ok: true }); }
    if (!r[2] && m === 'PUT') {
      try { const v = await uploads.writeChunk(u, req, Number(url.searchParams.get('offset'))); return json(res, 200, { received: v.received, pieces: v.pieces }); }
      catch (e) { req.resume(); return sendErr(res, e); }
    }
    if (r[2] && m === 'POST') {
      if (u.received !== u.size) return json(res, 409, { error: `only ${u.received} of ${u.size} bytes arrived` });
      let info;
      try { info = await probe(uploads.partPath(u.id)); } catch (e) {
        uploads.removeUpload(u.id);
        return json(res, 400, { error: `could not read that video: ${userError(e.message)}` });
      }
      const sid = store.randomId(16);
      uploads.finishUpload(u, sid);
      const s = { id: sid, owner: user.id, name: u.name, file: `source.${u.ext}`, size: u.size, created: Date.now(), status: 'queued', info, exports: [] };
      store.saveSource(s); store.forgetUsage();
      prepareJob(s);
      return json(res, 201, sourceView(req, s));
    }
  }

  // ---- library ----
  if (p === '/api/sources' && m === 'GET') {
    const owner = url.searchParams.get('owner');
    return json(res, 200, store.listSources().filter((s) => mine(user, s) && (!owner || s.owner === owner)).map((s) => sourceView(req, s)));
  }
  if (p === '/api/clips' && m === 'GET') {
    const owner = url.searchParams.get('owner');
    return json(res, 200, store.listClips().filter((c) => mine(user, c) && (!owner || c.owner === owner)).map((c) => clipView(req, c)));
  }
  if ((r = /^\/api\/jobs\/([A-Za-z0-9]{10})$/.exec(p)) && m === 'GET') {
    const j = jobs.get(r[1]);
    return j && (user.admin || j.owner === user.id) ? json(res, 200, jobView(j)) : json(res, 404, { error: 'no such job' });
  }
  if ((r = /^\/api\/clips\/([A-Za-z0-9]{12})(\.mp4|\.jpg)?$/.exec(p))) {
    const c = store.getClip(r[1]);
    if (!mine(user, c)) return json(res, 404, { error: 'no such clip' });
    if (r[2] && m === 'GET') return sendFile(req, res, store.clipFile(c.id, r[2].slice(1)), { 'Cache-Control': 'private, max-age=3600' });
    if (r[2]) return json(res, 405, { error: 'method not allowed' });
    if (m === 'GET') return json(res, 200, clipView(req, c));
    if (m === 'PATCH') { const b = await body(req); if (typeof b.title === 'string') c.title = cleanTitle(b.title); store.saveClip(c); return json(res, 200, clipView(req, c)); }
    if (m === 'DELETE') {
      store.deleteClip(c.id); store.forgetUsage();
      const s = c.sourceId && store.getSource(c.sourceId);
      if (s) { s.exports = (s.exports || []).filter((x) => x.clipId !== c.id); store.saveSource(s); }
      return json(res, 200, { ok: true });
    }
  }

  if ((r = /^\/api\/sources\/([A-Za-z0-9]{16})(?:\/(.*))?$/.exec(p))) {
    const s = store.getSource(r[1]);
    if (!mine(user, s)) return json(res, 404, { error: 'no such upload' });
    const sub = r[2] || '';
    const srcFile = path.join(store.sourceDir(s.id), s.file);
    if (sub === '' && m === 'GET') return json(res, 200, sourceView(req, s));
    if (sub === '' && m === 'PATCH') {
      const b = await body(req);
      try { if (b.edit) s.edit = cleanEdit(s.info, b.edit); } catch (e) { return sendErr(res, e); }
      if (typeof b.name === 'string' && b.name.trim()) s.name = cleanTitle(b.name);
      store.saveSource(s); return json(res, 200, sourceView(req, s));
    }
    if (sub === '' && m === 'DELETE') {
      if ([...jobs.values()].some((j) => j.sid === s.id && j.state === 'running')) return json(res, 409, { error: 'a job for this upload is running' });
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].sid === s.id) { jobs.delete(queue[i].id); queue.splice(i, 1); }
      store.deleteSource(s.id); store.forgetUsage();
      return json(res, 200, { ok: true });
    }
    const xm = /^exports\/([A-Za-z0-9]{12})$/.exec(sub);
    if (xm && m === 'DELETE') {
      const x = (s.exports || []).find((y) => y.clipId === xm[1]);
      if (!x) return json(res, 404, { error: 'no such export' });
      if (x.state === 'queued' || x.state === 'running') return json(res, 409, { error: 'that export is still running' });
      if (x.state === 'done') store.deleteClip(x.clipId);
      s.exports = s.exports.filter((y) => y.clipId !== xm[1]); store.saveSource(s);
      return json(res, 200, { ok: true });
    }
    if (sub === 'leveled' && m === 'POST') {
      const b = await body(req), a = s.info.audio[Number(b.n)];
      if (!a || !(b.level in LEVELING)) return json(res, 400, { error: 'bad track or leveling' });
      const name = `audio-${a.n}-${b.level}.m4a`, out = path.join(store.sourceDir(s.id), name);
      try { await once(`${s.id}/${name}`, () => (fs.existsSync(out) ? null : sideFfmpeg(() => makeLeveledPreview(srcFile, a.n, b.level, out)))); }
      catch (e) { return json(res, 500, { error: userError(e.message) }); }
      return json(res, 200, { url: `/api/sources/${s.id}/${name}`, peaks: `/api/sources/${s.id}/peaks-${a.n}-${b.level}.json` });
    }
    if (sub === 'loudness' && m === 'POST') {
      const b = await body(req);
      const want = (Array.isArray(b.tracks) ? b.tracks : []).filter((t) => s.info.audio[Number(t?.n)]);
      const cache = s.loudness || {};
      try {
        const out = [];
        for (const t of want) {
          const level = t.level in LEVELING ? t.level : 'off', key = `${Number(t.n)}:${level}`;
          if (!(key in cache)) {
            const v = await once(`${s.id}/loud/${key}`, () => sideFfmpeg(() => measureTrack(srcFile, Number(t.n), level)));
            cache[key] = Number.isFinite(v) ? v : null;
          }
          out.push({ n: Number(t.n), level, lufs: cache[key] });
        }
        const fresh = store.getSource(s.id); if (fresh) { fresh.loudness = { ...(fresh.loudness || {}), ...cache }; store.saveSource(fresh); }
        return json(res, 200, out);
      } catch (e) { return json(res, 500, { error: userError(e.message) }); }
    }
    if (sub === 'preview' && m === 'POST') {
      if (s.status !== 'ready') return json(res, 409, { error: 'this upload is still being prepared' });
      if (s.preview === 'needed' || s.preview === 'error') {
        s.preview = 'converting'; delete s.previewError; store.saveSource(s);
        previewJob(s);
      }
      return json(res, 200, sourceView(req, s));
    }
    if (sub === 'poster.jpg' && m === 'GET') {
      if (s.status !== 'ready' || posterFailures.has(s.id)) return json(res, 404, { error: 'no poster available' });
      const out = path.join(store.sourceDir(s.id), 'poster.jpg');
      try {
        await once(`${s.id}/poster`, () => (fs.existsSync(out) ? null : sideFfmpeg(() => makePoster(srcFile, Math.min(s.info.duration * 0.1, 5), out))));
      } catch (e) {
        posterFailures.add(s.id); fs.rmSync(out, { force: true });
        return json(res, 404, { error: 'no poster available' });
      }
      return sendFile(req, res, out, { 'Cache-Control': 'private, max-age=86400' });
    }
    if (sub === 'plan' && m === 'POST') {
      try { return json(res, 200, plan(s.info, cleanEdit(s.info, await body(req)))); } catch (e) { return sendErr(res, e); }
    }
    if (sub === 'export' && m === 'POST') {
      if (s.status !== 'ready') return json(res, 409, { error: 'this upload is still being prepared' });
      if (!user.admin && (store.usageByOwner(true)[user.id] || 0) >= user.quota) return json(res, 413, { error: 'you are at your storage limit; delete old recordings or clips, or ask the admin for more space' });
      const free = store.diskFree();
      if (free !== null && free < config.minFreeBytes) return json(res, 507, { error: 'not enough disk space on the server' });
      if (!user.admin && activeJobsOf(user.id) >= config.maxJobsPerUser) return json(res, 429, { error: `you already have ${config.maxJobsPerUser} exports waiting; wait for one to finish` });
      let edit;
      try { edit = cleanEdit(s.info, await body(req)); plan(s.info, edit); } catch (e) { return sendErr(res, e); }
      return json(res, 202, jobView(exportJob(s, edit)));
    }
    if (m === 'GET') {
      const f = /^(preview\.mp4|audio-\d+(?:-(?:light|strong))?\.m4a|peaks-\d+(?:-(?:light|strong))?\.json)$/.exec(sub);
      if (f) return sendFile(req, res, path.join(store.sourceDir(s.id), f[1]), { 'Cache-Control': 'private, max-age=86400' });
      // the recording itself, for browsers that can play it while the preview is converted
      if (sub === 'original.mp4' && s.directFile && s.preview !== 'ready') return sendFile(req, res, path.join(store.sourceDir(s.id), s.directFile), { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=86400' });
    }
  }

  // ---- user management (admin only) ----
  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (!user.admin) return json(res, 403, { error: 'admin only' });
    const usage = store.usageByOwner(true);
    const counts = {};
    for (const s of store.listSources()) (counts[s.owner] ||= { uploads: 0, clips: 0 }).uploads++;
    for (const c of store.listClips()) (counts[c.owner] ||= { uploads: 0, clips: 0 }).clips++;
    const view = (u) => ({ ...u, used: usage[u.id] || 0, ...(counts[u.id] || { uploads: 0, clips: 0 }) });
    if (p === '/api/users' && m === 'GET') {
      return json(res, 200, { admin: { id: 'admin', name: auth.userName('admin'), used: usage.admin || 0, ...(counts.admin || { uploads: 0, clips: 0 }) },
        users: auth.listUsers().map(view), defaultQuotaGB: config.defaultQuotaBytes / 1e9 });
    }
    if (p === '/api/users' && m === 'POST') {
      try { const r2 = await auth.createUser(await body(req)); return json(res, 201, { user: view(r2.user), password: r2.password }); }
      catch (e) { return sendErr(res, e); }
    }
    const um = /^\/api\/users\/([A-Za-z0-9]{10})$/.exec(p);
    if (um && m === 'PATCH') {
      try { const r2 = await auth.updateUser(um[1], await body(req)); return json(res, 200, { user: view(r2.user), password: r2.password }); }
      catch (e) { return sendErr(res, e); }
    }
    if (um && m === 'DELETE') {
      const alsoData = url.searchParams.get('data') === 'delete';
      if (!auth.deleteUser(um[1])) return json(res, 404, { error: 'no such user' });
      if (alsoData) {
        for (const s of store.listSources()) if (s.owner === um[1]) store.deleteSource(s.id);
        for (const c of store.listClips()) if (c.owner === um[1]) store.deleteClip(c.id);
      } else {   // keep their clips online, owned by the admin from now on
        for (const s of store.listSources()) if (s.owner === um[1]) store.saveSource({ ...s, owner: 'admin' });
        for (const c of store.listClips()) if (c.owner === um[1]) store.saveClip({ ...c, owner: 'admin' });
      }
      store.forgetUsage();
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not found' });
}

// runs fn once per key at a time; concurrent callers share the promise
const inflight = new Map();
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, Promise.resolve().then(fn).finally(() => inflight.delete(key)));
  return inflight.get(key);
}
