// Home page: sign in, upload recordings (in resumable pieces), list clips and recordings.
import { api, $, esc, fmtBytes, fmtDuration, ago, toast, copy, jobText, renderHeader, ownerTag, sleep, icon, ask, confirmDialog, promptDialog, menu, blocks, play } from './common.js';

let me = null, status = null, pollTimer = null, ownerFilter = '';

// ======================= sign in =======================
async function start() {
  const res = await fetch('/api/me');
  const d = await res.json().catch(() => ({}));
  const siteName = d.siteName || 'Clips';
  if (!res.ok || !d.user) {
    document.title = siteName; $('#loginTitle').textContent = siteName;
    $('#login').hidden = false;
    $('#name').value = localStorage.getItem('clips-name') || '';
    ($('#name').value ? $('#password') : $('#name')).focus();
    return;
  }
  me = d.user;
  renderHeader(me, siteName, { page: 'home' });
  $('header.top').hidden = false; $('#app').hidden = false;
  if (me.admin) {
    const u = await api('/api/users').catch(() => null);
    if (u?.users.length) {
      $('#ownerFilterWrap').hidden = false;
      $('#ownerFilter').innerHTML = `<option value="">Everyone</option><option value="admin">Admin (you)</option>${u.users.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}`;
      $('#ownerFilter').onchange = (e) => { ownerFilter = e.target.value; refresh(); };
    }
  }
  refresh();
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#loginError'); err.hidden = true;
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await api('/api/login', { method: 'POST', body: { name: $('#name').value, password: $('#password').value } });
    localStorage.setItem('clips-name', $('#name').value.trim());
    location.reload();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in'; play(e.target, 'shake', 450); }
};

// ======================= upload =======================
// Files go up in pieces (status.chunkSize), UPLOAD_PARALLEL at a time: one request through Cloudflare is often
// slower than the connection, and the proxy holds each piece before passing it on. The upload id is remembered per file, so choosing the same file
// again after a dropped connection or a closed tab continues where it stopped.
const UPLOAD_PARALLEL = 3;
const pending = [];
let uploading = false;
const resumeKey = (f) => `clips-upload:${f.name}:${f.size}:${f.lastModified}`;

function addFiles(files) {
  const list = [...files].filter((f) => f.size > 0);
  if (!list.length) return;
  const single = list.length === 1 && !uploading && !pending.length;
  pending.push(...list.map((f) => ({ file: f, single })));
  pumpUploads();
}
async function pumpUploads() {
  if (uploading || !pending.length) return;
  uploading = true;
  const { file, single } = pending.shift();
  try {
    const src = await uploadOne(file);
    if (single && !pending.length) { uploading = false; location.href = `/edit/${src.id}`; return; }
    refresh();
  } catch (e) {
    if (e.message !== 'cancelled') toast(`${file.name}: ${e.message}`, true);
  } finally { uploading = false; pumpUploads(); }
}

function putPiece(url, blob, onProgress, xhrs) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhrs.add(xhr);
    xhr.onloadend = () => xhrs.delete(xhr);
    xhr.open('PUT', url); xhr.setRequestHeader('X-Clips', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300 && d) resolve(d);
      else reject(Object.assign(new Error(d?.error || `upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('connection lost'), { status: 0 }));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(blob);
  });
}

async function uploadOne(file) {
  const el = document.createElement('div');
  el.className = 'upload';
  el.innerHTML = `<div class="urow"><span class="uname" title="${esc(file.name)}">${esc(file.name)}</span><button class="small" data-cancel type="button">Cancel</button></div>
    <div class="progress"><div></div></div><div class="ustat num" data-stat>starting…</div>`;
  $('#uploads').append(el); syncEmpty();
  const bar = el.querySelector('.progress > div'), stat = el.querySelector('[data-stat]');
  const xhrs = new Set();
  let cancelled = false, up = null;
  el.querySelector('[data-cancel]').onclick = () => {
    cancelled = true; for (const x of xhrs) x.abort();
    if (up) api(`/api/uploads/${up.id}`, { method: 'DELETE' }).catch(() => {});
    localStorage.removeItem(resumeKey(file));
  };
  try {
    // resume or start
    const saved = localStorage.getItem(resumeKey(file));
    if (saved) up = await api(`/api/uploads/${saved}`).catch(() => null);
    if (!up) {
      up = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size } });
      localStorage.setItem(resumeKey(file), up.id);
    } else toast(`Resuming ${file.name} at ${Math.round((up.received / file.size) * 100)}%`);

    // pieces still missing; each worker takes the next one. Progress counts finished pieces plus what is in flight.
    const size = (k) => Math.min(up.chunkSize, file.size - k * up.chunkSize);
    const have = new Set(up.pieces || [...Array(Math.floor(up.received / up.chunkSize)).keys()]);
    const todo = [...Array(Math.ceil(file.size / up.chunkSize)).keys()].filter((k) => !have.has(k));
    const inFlight = new Map();
    let done = [...have].reduce((n, k) => n + size(k), 0), failures = 0;
    const t0 = performance.now(), startDone = done;
    const show = () => {
      const now = done + [...inFlight.values()].reduce((a, b) => a + b, 0);
      const secs = (performance.now() - t0) / 1000, rate = (now - startDone) / Math.max(secs, 0.001);
      bar.style.width = `${((now / file.size) * 100).toFixed(1)}%`;
      stat.textContent = `${Math.round((now / file.size) * 100)}% · ${fmtBytes(rate)}/s · ${fmtDuration(rate > 0 ? (file.size - now) / rate : 0)} left · ${fmtBytes(file.size)}`;
    };
    const worker = async () => {
      while (todo.length) {
        const k = todo.shift(), offset = k * up.chunkSize;
        for (;;) {
          if (cancelled) throw new Error('cancelled');
          try {
            inFlight.set(k, 0);
            await putPiece(`/api/uploads/${up.id}?offset=${offset}`, file.slice(offset, offset + size(k)), (loaded) => { inFlight.set(k, loaded); show(); }, xhrs);
            inFlight.delete(k); done += size(k); failures = 0; show();
            break;
          } catch (e) {
            inFlight.delete(k);
            if (e.message === 'cancelled' || cancelled) throw new Error('cancelled');
            if (e.status && e.status < 500 && e.status !== 429) throw e;   // a real refusal: don't retry
            if (++failures > 8) throw new Error(`${e.message} (gave up after 8 retries; choose the file again to resume)`);
            const wait = Math.min(30, 2 ** Math.min(failures, 5));
            stat.textContent = `${e.message}, retrying in ${wait} s…`;
            await sleep(wait * 1000);
          }
        }
      }
    };
    let firstError = null;   // one worker giving up stops the others
    await Promise.all([...Array(UPLOAD_PARALLEL)].map(() => worker().catch((e) => {
      if (!firstError) { firstError = e; cancelled = true; for (const x of xhrs) x.abort(); }
    })));
    if (firstError) throw firstError;
    stat.textContent = 'checking the video…';
    const src = await api(`/api/uploads/${up.id}/complete`, { method: 'POST' });
    localStorage.removeItem(resumeKey(file));
    return src;
  } catch (e) {
    if (e.status && e.status >= 400 && e.status < 500 && e.status !== 409) localStorage.removeItem(resumeKey(file));
    throw e;
  } finally { el.remove(); syncEmpty(); }
}

// ---- drop / pick ----
const fileInput = $('#file'), veil = $('#dropveil');
const pick = () => fileInput.click();
$('#uploadBtn').onclick = pick; $('#emptyUpload').onclick = pick;
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); if (me && hasFiles(e)) veil.hidden = false; });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) veil.hidden = true; });
document.addEventListener('drop', (e) => { if (me) addFiles(e.dataTransfer.files); });
window.addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

// ======================= lists =======================
// A list's DOM is only replaced when its HTML changed, so hover, focus and loaded images survive the polling.
const lastHtml = new WeakMap();
// Clips and recordings that were not on the page a moment ago pop into place (not on the first load).
let seen = null;
function arrive() {
  const els = [...document.querySelectorAll('.card[data-id], .rec[data-id]')];
  if (seen) for (const el of els) if (!seen.has(el.dataset.id)) play(el, 'arrive', 450);
  seen = new Set(els.map((el) => el.dataset.id));
}
function setHtml(el, html) { if (lastHtml.get(el) !== html) { lastHtml.set(el, html); el.innerHTML = html; } }

let clipsById = new Map(), sourcesById = new Map(), counts = { clips: 0, sources: 0 };
const failedImgs = new Set();   // images that did not load (no thumbnail yet): show the placeholder instead
const meta = (parts) => parts.filter(Boolean).map((t, i, a) => `<span class="mi">${t}${i < a.length - 1 ? ' ·' : ''}</span>`).join(' ');
const placeholder = (kind) => `<span class="ph" aria-hidden="true">${icon(kind)}</span>`;
const img = (src, cls) => (failedImgs.has(src) ? '' : `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async">`);
document.addEventListener('error', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLImageElement) || !t.dataset.ph) return;
  failedImgs.add(t.getAttribute('src'));
  t.replaceWith(Object.assign(document.createElement('span'), { className: 'ph', innerHTML: icon(t.dataset.ph) }));
}, true);

function clipCard(c) {
  const src = `/api/clips/${c.id}.jpg`;
  const thumb = c.hasThumb && !failedImgs.has(src) ? `<img class="timg" data-ph="play" src="${src}" alt="" loading="lazy" decoding="async">` : placeholder('play');
  return `<article class="card" data-id="${esc(c.id)}">
    <a class="thumb" data-clip="${esc(c.id)}" href="${esc(c.url)}" target="_blank" rel="noopener" aria-label="Open ${esc(c.title)}">${thumb}<span class="dur num">${fmtDuration(c.duration)}</span></a>
    <div class="cbody">
      <div class="ctitle" title="${esc(c.title)}">${esc(c.title)}</div>
      <div class="cmeta num">${meta([`${c.height}p${c.fps || ''}`, fmtBytes(c.size), ago(c.created)])}</div>
      ${me.admin && c.owner !== me.id ? ownerTag(c.ownerName) : ''}
      <div class="cact">
        <button class="primary small grow" data-copy="${esc(c.url)}" type="button">${icon('link')}Copy link</button>
        <button class="icon small" data-clipmenu="${c.id}" type="button" aria-label="More actions" aria-haspopup="menu">${icon('more')}</button>
      </div>
    </div></article>`;
}

function sourceRow(s) {
  const i = s.info, job = s.jobs?.[0];
  const pending = s.exports.filter((x) => x.state === 'queued' || x.state === 'running');
  const failed = s.exports.filter((x) => x.state === 'error');
  const st = s.status === 'ready' ? (pending.length ? `<span class="badge busy">${esc(jobText(s.jobs.find((j) => j.kind === 'render')) || 'exporting')}</span>` : '<span class="badge ready">ready</span>')
    : s.status === 'error' ? '<span class="badge error">error</span>' : `<span class="badge busy">${esc(job ? jobText(job) : 'preparing')}</span>`;
  const tracks = i.audio.length ? `${i.audio.length} audio track${i.audio.length > 1 ? 's' : ''}` : 'no audio';
  const done = s.exports.filter((x) => x.state === 'done').length;
  const posterSrc = `/api/sources/${s.id}/poster.jpg`;
  const poster = s.status === 'ready' && !failedImgs.has(posterSrc) ? `<img class="timg" data-ph="scissors" src="${posterSrc}" alt="" loading="lazy" decoding="async">` : placeholder('scissors');
  return `<article class="rec" data-id="${esc(s.id)}">
    <div class="poster">${poster}</div>
    <div class="rinfo">
      <div class="rname">${esc(s.name)}</div>
      <div class="rmeta num">${meta([fmtDuration(i.duration), `${i.width}×${i.height}`, `${i.fps} fps`, tracks, fmtBytes(s.size), ago(s.created), done ? `${done} clip${done > 1 ? 's' : ''}` : ''])}</div>
      ${me.admin && s.owner !== me.id ? ownerTag(s.ownerName) : ''}
      ${s.status === 'error' ? `<div class="bad small">${esc(s.error)}</div>` : ''}
      ${failed.length ? `<div class="fails">${failed.map((x) => `<div class="fail"><span class="bad small">Export "${esc(x.title || 'untitled')}" failed: ${esc(x.error)}</span>
        <button class="small ghost" data-forget="${s.id}/${x.clipId}" type="button">Dismiss</button></div>`).join('')}</div>` : ''}
    </div>
    <div class="ract">${st}
      <a class="btn ${s.status === 'ready' && !done ? 'primary' : ''}" href="/edit/${s.id}">${done ? 'New clip' : 'Edit'}</a>
      <button class="icon" data-srcmenu="${s.id}" type="button" aria-label="More actions" aria-haspopup="menu">${icon('more')}</button>
    </div></article>`;
}

function usageHtml(st) {
  const u = st.user, busy = st.queue > 0 ? `<span class="badge busy">${st.queue} encoding</span>` : '';
  if (u.quota) {
    const f = Math.min(1, u.used / u.quota);
    return `<div class="gauge" title="${fmtBytes(u.used)} of ${fmtBytes(u.quota)} used">${blocks(f)}<span class="num">${esc(fmtBytes(u.used))} / ${esc(fmtBytes(u.quota))}</span></div>${busy}`;
  }
  return `${st.diskFree != null ? `<div class="gauge"><span class="num">${esc(fmtBytes(st.diskFree))} free</span></div>` : ''}${busy}`;
}

// One big drop zone instead of the lists when there is nothing at all
function syncEmpty() {
  const empty = !ownerFilter && counts.clips === 0 && counts.sources === 0 && !$('#uploads').children.length && !uploading && !pending.length && status;
  $('#bigEmpty').hidden = !empty; $('#lists').hidden = !!empty;
}

async function refresh() {
  clearTimeout(pollTimer);
  if (document.querySelector('.menu')) { pollTimer = setTimeout(refresh, 1000); return; }   // don't pull a menu out from under the user
  try {
    const q = ownerFilter ? `?owner=${encodeURIComponent(ownerFilter)}` : '';
    const [sources, clips, st] = await Promise.all([api(`/api/sources${q}`), api(`/api/clips${q}`), api('/api/status')]);
    if (document.querySelector('.menu')) { pollTimer = setTimeout(refresh, 1000); return; }
    status = st;
    clipsById = new Map(clips.map((c) => [c.id, c])); sourcesById = new Map(sources.map((s) => [s.id, s]));
    counts = { clips: clips.length, sources: sources.length };
    setHtml($('#clips'), clips.map(clipCard).join('') || '<div class="empty" style="grid-column:1/-1">No clips yet</div>');
    setHtml($('#sources'), sources.map(sourceRow).join('') || '<div class="empty">No recordings</div>');
    arrive();
    $('#clipCount').textContent = clips.length; $('#recCount').textContent = sources.length;
    setHtml($('#usage'), usageHtml(st));
    $('#retention').hidden = !st.retentionDays;
    if (st.retentionDays) $('#retention').textContent = `Recordings are deleted after ${st.retentionDays} days. Clips stay.`;
    syncEmpty();
    const busy = sources.some((s) => (s.status !== 'ready' && s.status !== 'error') || s.exports.some((x) => x.state === 'queued' || x.state === 'running'));
    pollTimer = setTimeout(refresh, busy ? 2000 : 20000);
  } catch (e) {
    $('#lists').hidden = false; $('#bigEmpty').hidden = true;
    setHtml($('#clips'), `<div class="empty bad" style="grid-column:1/-1">Could not load: ${esc(e.message)}</div>`);
    pollTimer = setTimeout(refresh, 5000);
  }
}

// ---- actions ----
function clipMenu(btn, c) {
  menu(btn, [
    { label: 'Open page', icon: 'open', run: () => window.open(c.url, '_blank', 'noopener') },
    ...(!c.sourceGone ? [{ label: 'Edit', icon: 'edit', run: () => { location.href = `/edit/${c.sourceId}?clip=${c.id}`; } }] : []),
    { label: 'Rename', icon: 'edit', run: async () => {
      const title = await promptDialog('Rename clip', { label: 'Title', value: c.title });
      if (title === null || !title.trim() || title.trim() === c.title) return;
      try { await api(`/api/clips/${c.id}`, { method: 'PATCH', body: { title } }); } catch (e) { toast(e.message, true); }
      refresh();
    } },
    { label: 'Download', icon: 'download', run: () => { const a = Object.assign(document.createElement('a'), { href: c.mp4, download: '' }); document.body.append(a); a.click(); a.remove(); } },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      if (!(await confirmDialog('Delete this clip?', 'Its link stops working.', { ok: 'Delete', danger: true }))) return;
      try { await api(`/api/clips/${c.id}`, { method: 'DELETE' }); toast('Clip deleted'); await play(document.querySelector(`.card[data-id="${c.id}"]`), 'poof', 260); } catch (e) { toast(e.message, true); }
      refresh();
    } },
  ]);
}

async function deleteSource(s) {
  const clips = s.exports.filter((x) => x.state === 'done' && x.clip).map((x) => x.clip);
  const thumbs = clips.slice(0, 4).map((c) => (c.hasThumb ? `<img src="/api/clips/${c.id}.jpg" alt="" data-ph="play" loading="lazy">` : placeholder('play'))).join('');
  const body = `<div class="delsplit">
    <div class="delbox gone"><span class="dlabel">Removed</span><b>${esc(s.name)}</b><span class="num">${esc(fmtBytes(s.size))}</span></div>
    ${clips.length ? `<div class="delbox kept"><span class="dlabel">Kept</span><b class="num">${clips.length} clip${clips.length > 1 ? 's' : ''}</b><span class="minis">${thumbs}</span><span>links keep working</span></div>` : ''}</div>`;
  const ok = await ask({ title: 'Delete this recording?', body, actions: [{ label: 'Cancel', value: false }, { label: 'Delete recording', value: true, kind: 'danger solid' }] });
  if (ok !== true) return;
  try { await api(`/api/sources/${s.id}`, { method: 'DELETE' }); toast('Recording deleted'); await play(document.querySelector(`.rec[data-id="${s.id}"]`), 'poof', 260); } catch (e) { toast(e.message, true); }
  refresh();
}

function sourceMenu(btn, s) {
  menu(btn, [
    { label: 'Rename', icon: 'edit', run: async () => {
      const name = await promptDialog('Rename recording', { label: 'Name', value: s.name });
      if (name === null || !name.trim() || name.trim() === s.name) return;
      try { await api(`/api/sources/${s.id}`, { method: 'PATCH', body: { name } }); } catch (e) { toast(e.message, true); }
      refresh();
    } },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: () => deleteSource(s) },
  ]);
}

$('#app').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  try {
    if (d.copy) return copy(d.copy);
    if (d.clipmenu) { const c = clipsById.get(d.clipmenu); return c && clipMenu(b, c); }
    if (d.srcmenu) { const s = sourcesById.get(d.srcmenu); return s && sourceMenu(b, s); }
    if (d.forget) {
      const [sid, clipId] = d.forget.split('/');
      await api(`/api/sources/${sid}/exports/${clipId}`, { method: 'DELETE' });
      refresh();
    }
  } catch (err) { toast(err.message, true); }
});

start();

// Hovering a clip's picture plays it silently in place (mouse only; phones just open the clip).
if (matchMedia('(hover: hover)').matches) {
  let timer = 0, playing = null;
  const stop = () => { clearTimeout(timer); if (playing) { playing.removeAttribute('src'); playing.load(); playing.remove(); playing = null; } };
  document.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest?.('a.thumb[data-clip]');
    if (!t || (playing && playing.parentNode === t)) return;
    stop();
    timer = setTimeout(() => {
      if (!t.isConnected || !t.matches(':hover')) return;
      const v = document.createElement('video');
      v.className = 'tvid'; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.src = `/${t.dataset.clip}.mp4`;
      v.addEventListener('playing', () => v.classList.add('on'), { once: true });
      t.append(v); playing = v;
      v.play().catch(() => {});
    }, 350);
  });
  document.addEventListener('mouseout', (ev) => {
    const t = ev.target.closest?.('a.thumb[data-clip]');
    if (t && !t.contains(ev.relatedTarget)) stop();
  });
}
