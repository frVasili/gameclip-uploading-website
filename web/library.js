// Home page: sign in, upload recordings (in resumable pieces), list clips and recordings.
import { api, $, esc, fmtBytes, fmtDuration, ago, toast, copy, jobText, renderHeader, ownerTag, sleep } from './common.js';

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
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in'; }
};

// ======================= upload =======================
// Files go up in pieces (status.chunkSize). The upload id is remembered per file, so choosing the same file
// again after a dropped connection or a closed tab continues where it stopped.
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

function putPiece(url, blob, onProgress, xhrRef) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhrRef.current = xhr;
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
  el.innerHTML = `<div class="row spread"><span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(file.name)}</span>
    <span class="muted small" data-stat>starting…</span><button class="small danger" data-cancel>Cancel</button></div>
    <div class="progress"><div></div></div>`;
  $('#uploads').append(el);
  const bar = el.querySelector('.progress > div'), stat = el.querySelector('[data-stat]');
  const xhrRef = { current: null };
  let cancelled = false, up = null;
  el.querySelector('[data-cancel]').onclick = () => {
    cancelled = true; xhrRef.current?.abort();
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

    let offset = up.received, tries = 0;
    const t0 = performance.now(), startOffset = offset;
    while (offset < file.size) {
      if (cancelled) throw new Error('cancelled');
      const end = Math.min(file.size, offset + up.chunkSize);
      try {
        const r = await putPiece(`/api/uploads/${up.id}?offset=${offset}`, file.slice(offset, end), (loaded) => {
          const done = offset + loaded, secs = (performance.now() - t0) / 1000, rate = (done - startOffset) / Math.max(secs, 0.001);
          bar.style.width = `${((done / file.size) * 100).toFixed(1)}%`;
          stat.textContent = `${Math.round((done / file.size) * 100)}% · ${fmtBytes(rate)}/s · ${fmtDuration(rate > 0 ? (file.size - done) / rate : 0)} left · ${fmtBytes(file.size)}`;
        }, xhrRef);
        offset = r.received; tries = 0;
      } catch (e) {
        if (e.message === 'cancelled') throw e;
        if (e.status && e.status !== 409 && e.status < 500 && e.status !== 429) throw e;   // a real refusal: don't retry
        if (++tries > 8) throw new Error(`${e.message} (gave up after 8 retries; choose the file again to resume)`);
        const wait = Math.min(30, 2 ** tries);
        stat.textContent = `${e.message}, retrying in ${wait} s…`;
        await sleep(wait * 1000);
        offset = (await api(`/api/uploads/${up.id}`)).received;   // ask where the server got to
      }
    }
    stat.textContent = 'checking the video…';
    const src = await api(`/api/uploads/${up.id}/complete`, { method: 'POST' });
    localStorage.removeItem(resumeKey(file));
    return src;
  } catch (e) {
    if (e.status && e.status >= 400 && e.status < 500 && e.status !== 409) localStorage.removeItem(resumeKey(file));
    throw e;
  } finally { el.remove(); }
}

const fileInput = $('#file'), drop = $('#drop');
drop.onclick = () => fileInput.click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); if (me) drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) drop.classList.remove('over'); });
document.addEventListener('drop', (e) => { if (me) addFiles(e.dataTransfer.files); });
window.addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

// ======================= lists =======================
function clipCard(c) {
  return `<div class="card">
    <a class="thumb" href="${esc(c.url)}" target="_blank" rel="noopener" style="${c.hasThumb ? `background-image:url('/api/clips/${c.id}.jpg')` : ''}">
      <span class="dur">${fmtDuration(c.duration)}</span></a>
    <div class="body">
      <div class="title" title="${esc(c.title)}">${esc(c.title)}</div>
      <div class="small muted">${c.height}p${c.fps || ''} · ${fmtBytes(c.size)} · ${ago(c.created)}</div>
      ${me.admin && c.owner !== me.id ? ownerTag(c.ownerName) : ''}
      <div class="actions">
        <button class="primary small" data-copy="${esc(c.url)}">Copy link</button>
        ${c.sourceId ? `<a href="/edit/${c.sourceId}"><button class="small" title="Open the recording this came from">Edit</button></a>` : ''}
        <button class="small danger" data-delclip="${c.id}" title="Delete the link">✕</button>
      </div>
    </div></div>`;
}

function sourceRow(s) {
  const i = s.info, job = s.jobs?.[0];
  const pending = s.exports.filter((x) => x.state === 'queued' || x.state === 'running');
  const failed = s.exports.filter((x) => x.state === 'error');
  const st = s.status === 'ready' ? (pending.length ? `<span class="badge busy">${esc(jobText(s.jobs.find((j) => j.kind === 'render')) || 'exporting')}</span>` : '<span class="badge ready">ready</span>')
    : s.status === 'error' ? '<span class="badge error">error</span>' : `<span class="badge busy">${esc(job ? jobText(job) : 'preparing')}</span>`;
  const tracks = i.audio.length ? `${i.audio.length} audio track${i.audio.length > 1 ? 's' : ''}` : 'no audio';
  const done = s.exports.filter((x) => x.state === 'done').length;
  return `<div class="rec"><div class="info">
      <div class="name">${esc(s.name)}</div>
      <div class="small muted">${fmtDuration(i.duration)} · ${i.width}×${i.height} · ${i.fps} fps · ${tracks} · ${fmtBytes(s.size)} · ${ago(s.created)}${done ? ` · ${done} clip${done > 1 ? 's' : ''}` : ''}</div>
      ${me.admin && s.owner !== me.id ? ownerTag(s.ownerName) : ''}
      ${s.status === 'error' ? `<div class="bad small">${esc(s.error)}</div>` : ''}
      ${failed.length ? `<div class="fails">${failed.map((x) => `<div class="small"><span class="bad">Export "${esc(x.title || 'untitled')}" failed: ${esc(x.error)}</span>
        <button class="small ghost" data-forget="${s.id}/${x.clipId}">dismiss</button></div>`).join('')}</div>` : ''}
    </div>
    ${st}
    <a href="/edit/${s.id}"><button class="${s.status === 'ready' ? 'primary' : ''}">${done ? 'Make another clip' : 'Edit'}</button></a>
    <button class="danger" data-delsrc="${s.id}" title="Delete the recording (clips you shared keep working)">Delete</button>
  </div>`;
}

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const q = ownerFilter ? `?owner=${encodeURIComponent(ownerFilter)}` : '';
    const [sources, clips, st] = await Promise.all([api(`/api/sources${q}`), api(`/api/clips${q}`), api('/api/status')]);
    status = st;
    $('#clips').innerHTML = clips.map(clipCard).join('') || '<div class="empty" style="grid-column:1/-1">No clips yet. Upload a recording, trim it and export.</div>';
    $('#sources').innerHTML = sources.map(sourceRow).join('') || '<div class="empty">No recordings.</div>';
    $('#clipCount').textContent = clips.length; $('#recCount').textContent = sources.length;
    const u = st.user;
    if (u.quota) {
      $('#usage').hidden = false;
      $('#usageText').textContent = `${fmtBytes(u.used)} of ${fmtBytes(u.quota)} used`;
      const f = Math.min(1, u.used / u.quota);
      $('#usageMeter').classList.toggle('full', f > 0.9); $('#usageMeter > div').style.width = `${f * 100}%`;
    } else if (st.diskFree != null) {
      $('#usage').hidden = false; $('#usageText').textContent = `${fmtBytes(st.diskFree)} free on the server${st.queue ? ` · ${st.queue} job${st.queue > 1 ? 's' : ''} running/queued` : ''}`;
      $('#usageMeter').hidden = true;
    }
    if (st.retentionDays) { $('#retention').hidden = false; $('#retention').textContent = `Recordings are deleted automatically after ${st.retentionDays} days. Clips stay.`; }
    const busy = sources.some((s) => (s.status !== 'ready' && s.status !== 'error') || s.exports.some((x) => x.state === 'queued' || x.state === 'running'));
    pollTimer = setTimeout(refresh, busy ? 2000 : 20000);
  } catch (e) {
    $('#clips').innerHTML = `<div class="empty bad" style="grid-column:1/-1">Could not load: ${esc(e.message)}</div>`;
    pollTimer = setTimeout(refresh, 5000);
  }
}

$('#app').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  try {
    if (d.copy) return copy(d.copy);
    if (d.delclip) {
      if (!confirm('Delete this clip? Its link stops working (Discord may keep showing an embed it already loaded for a while).')) return;
      await api(`/api/clips/${d.delclip}`, { method: 'DELETE' }); toast('Clip deleted');
    } else if (d.forget) {
      const [sid, clipId] = d.forget.split('/');
      await api(`/api/sources/${sid}/exports/${clipId}`, { method: 'DELETE' });
    } else if (d.delsrc) {
      if (!confirm('Delete this recording and its editor files? Clips you already shared keep working.')) return;
      await api(`/api/sources/${d.delsrc}`, { method: 'DELETE' }); toast('Recording deleted');
    } else return;
  } catch (err) { toast(err.message, true); }
  refresh();
});

start();
