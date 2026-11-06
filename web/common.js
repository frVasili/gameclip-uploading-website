// Shared helpers for the library and editor pages.

// fetch wrapper: JSON in/out, sends the X-Clips header the server requires on every change, throws on errors
export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET') opts.headers['X-Clips'] = '1';
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith('/api/me') && !path.startsWith('/api/login')) {
    location.href = '/home';   // session ended: back to the sign-in page
    throw new Error('not signed in');
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

export const initials = (name) => (String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase();
export const ownerTag = (name) => `<span class="owner"><span class="avatar">${esc(initials(name))}</span>${esc(name)}</span>`;

// Header shared by every signed-in page. `title` is optional (e.g. the file being edited).
export function renderHeader(user, siteName, { page = '', title = '' } = {}) {
  document.title = title ? `${title} · ${siteName}` : siteName;
  const h = document.querySelector('header.top');
  h.innerHTML = `<a class="brand" href="/home"><img src="/static/favicon.svg" alt="">${esc(siteName)}</a>
    <nav><a href="/home" class="${page === 'home' ? 'active' : ''}">Library</a><a href="${user.admin ? '/admin' : '/account'}" class="${page === 'admin' ? 'active' : ''}">${user.admin ? 'Users &amp; server' : 'Account'}</a></nav>
    ${title ? `<h1>${esc(title)}</h1>` : ''}
    <div class="right"><span class="status" id="saved"></span>
      <button class="chip" id="me" title="Change your name"><span class="avatar">${esc(initials(user.name))}</span>${esc(user.name)}</button>
      <button class="small ghost" id="logout">Sign out</button></div>`;
  h.querySelector('#me').onclick = async () => {
    const name = prompt('Your name (shown to the admin and under your clips as "by …"):', user.name);
    if (name === null || name.trim() === user.name) return;
    try { await api('/api/me', { method: 'PATCH', body: { name } }); toast('Name changed'); setTimeout(() => location.reload(), 600); }
    catch (e) { toast(e.message, true); }
  };
  h.querySelector('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/home'; };
}

// For pages that need a session: returns { user, siteName } or sends the visitor to /home.
export async function requireUser() {
  const res = await fetch('/api/me');
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.user) { location.href = '/home'; throw new Error('not signed in'); }
  return d;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtBytes(n) {
  if (n == null) return '?';
  if (n === 0) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 100e9 ? 0 : n >= 10e9 ? 1 : 2).replace(/\.0+$/, '')} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 100e6 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
// 83.4 -> "1:23.4"; with hours "1:02:03.4"
export function fmtTime(s, decimals = 1) {
  if (!Number.isFinite(s)) return '-';
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
// "1:23.4", "83.4", "1:02:03" -> seconds (NaN if unreadable)
export function parseTime(str) {
  const parts = String(str).trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p)))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}
export const fmtDuration = (s) => fmtTime(s, 0);
export const ago = (ms) => {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

export function toast(msg, bad = false) {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.append(box); }
  const el = document.createElement('div');
  el.textContent = msg; if (bad) el.className = 'bad';
  box.append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 2500);
}

export async function copy(text, msg = 'Link copied - paste it in Discord') {
  try { await navigator.clipboard.writeText(text); toast(msg); return true; }
  catch {
    // fallback for browsers that refuse the async clipboard (e.g. no recent click)
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    toast(ok ? msg : 'Could not copy automatically - select the text and copy it', !ok);
    return ok;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Polls a job until it finishes; onUpdate(job) on every poll. Resolves with the final job.
export async function waitJob(id, onUpdate) {
  for (;;) {
    let job;
    try { job = await api(`/api/jobs/${id}`); } catch (e) { await sleep(2000); continue; }
    onUpdate?.(job);
    if (job.state === 'done' || job.state === 'error') return job;
    await sleep(job.state === 'queued' ? 2000 : 1000);
  }
}

export function jobText(job) {
  if (!job) return '';
  if (job.state === 'queued') return job.position > 1 ? `waiting (${job.position - 1} ahead)` : 'waiting';
  if (job.state === 'running') return `${job.kind === 'prepare' ? 'preparing' : 'encoding'} ${Math.round(job.progress * 100)}%`;
  if (job.state === 'error') return `failed: ${job.error}`;
  return 'done';
}
