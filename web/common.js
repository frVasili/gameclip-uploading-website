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
  const account = user.admin ? '/admin' : '/account';
  h.innerHTML = `<a class="brand" href="/home"><img src="/static/favicon.svg" alt=""><span>${esc(siteName)}</span></a>
    <nav><a href="/home" class="${page === 'home' ? 'active' : ''}">Library</a><a href="${account}" class="${page === 'admin' ? 'active' : ''}">${user.admin ? 'People' : 'Account'}</a></nav>
    ${title ? `<h1 title="${esc(title)}">${esc(title)}</h1>` : ''}
    <div class="right"><span class="status" id="saved" aria-live="polite"></span>
      <a class="chip" href="${account}" title="Your account"><span class="avatar">${esc(initials(user.name))}</span><span class="who">${esc(user.name)}</span></a>
      <button class="small ghost" id="logout">Sign out</button></div>`;
  h.querySelector('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/home'; };
}

// Small line icons (inline SVG, 24x24 grid).
const ICONS = {
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16', link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  more: 'M5 12h.01M12 12h.01M19 12h.01', play: 'M7 4.5v15l12-7.5z', pause: 'M8 5v14M16 5v14', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4', check: 'M5 12.5l4.5 4.5L19 7.5', x: 'M6 6l12 12M18 6L6 18', download: 'M12 4v12M6 11l6 6 6-6M4 20h16',
  open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6', scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.1 7.9L20 20M8.1 16.1L20 4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01', keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10', plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
};
export const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;

// A modal dialog instead of the browser's confirm/prompt boxes. Resolves with the chosen action's `value`
// (or null when dismissed with Esc). `body` is HTML (escape user text with esc()). With `input`, the value of
// the primary action is the text typed: { label, value, type, placeholder }.
export function ask({ title, body = '', actions = [{ label: 'OK', value: true, kind: 'primary' }], input = null }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div class="body">${body}</div>
      ${input ? `<label for="dlgInput">${esc(input.label || '')}</label><input id="dlgInput" type="${input.type || 'text'}" value="${esc(input.value ?? '')}" placeholder="${esc(input.placeholder || '')}" ${input.attrs || ''}>` : ''}
      <div class="actions">${actions.map((a, i) => `<button type="${a.submit ? 'submit' : 'button'}" class="${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></form>`;
    document.body.append(d);
    // the answer is given at once; the box itself shrinks away for a moment first (see app.css "motion")
    const done = (v) => { resolve(v); d.classList.add('out'); setTimeout(() => { d.close(); d.remove(); }, calm() ? 0 : 130); };
    const pick = (a) => done(input && a.submit ? d.querySelector('#dlgInput').value : a.value);
    d.querySelector('form').onsubmit = (e) => { e.preventDefault(); const a = actions.find((x) => x.submit); if (a) pick(a); };
    d.querySelector('.actions').onclick = (e) => { const b = e.target.closest('button'); if (b && b.type === 'button') pick(actions[b.dataset.i]); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    d.addEventListener('click', (e) => { if (e.target === d) done(null); });   // click on the backdrop
    d.showModal();
    (d.querySelector('#dlgInput') || d.querySelector('.actions button:not(.danger)') || d).focus();
    d.querySelector('#dlgInput')?.select();
  });
}
// "Are you sure?" with a named action. Resolves true/false. The safe button has the focus.
export const confirmDialog = (title, body, { ok = 'OK', danger = false, cancel = 'Cancel' } = {}) =>
  ask({ title, body, actions: [{ label: cancel, value: false }, { label: ok, value: true, kind: danger ? 'danger solid' : 'primary' }] }).then((v) => v === true);
// One text field. Resolves with the text, or null when cancelled.
export const promptDialog = (title, { label = '', value = '', type = 'text', ok = 'Save', body = '', attrs = '' } = {}) =>
  ask({ title, body, input: { label, value, type, attrs }, actions: [{ label: 'Cancel', value: null }, { label: ok, submit: true, kind: 'primary' }] });

// A small popover menu under `anchor`. items: [{ label, icon?, danger?, run }] or '-' for a divider.
export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Plays a one-off animation class on an element and resolves when it ends (at once if motion is turned off).
export function play(el, cls, ms = 400) {
  if (!el || calm()) return Promise.resolve();
  return new Promise((res) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); setTimeout(() => { el.classList.remove(cls); res(); }, ms); });
}
export function menu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button role="menuitem" class="${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? icon(it.icon) : ''}${esc(it.label)}</button>`)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  const close = () => { m.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); window.removeEventListener('scroll', close, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  const key = (e) => {
    const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') { close(); anchor.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
  };
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; close(); items[b.dataset.i].run(); };
  document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); window.addEventListener('scroll', close, true);
  m.querySelector('button')?.focus();
}

// Storage gauge drawn as blocks: blocks(0.42) -> HTML. Red when nearly full.
export const blocks = (fraction, n = 20) => `<span class="blocks ${fraction > 0.9 ? 'full' : ''}" role="img" aria-label="${Math.round(fraction * 100)}% used">${
  [...Array(n)].map((_, i) => `<i class="${i < Math.ceil(Math.min(1, fraction) * n - 1e-9) ? 'on' : ''}"></i>`).join('')}</span>`;

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
  if (bad) el.style.setProperty('--stay', '5.7s');
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
  if (job.state === 'running') return `${{ prepare: 'preparing', preview: 'converting' }[job.kind] || 'encoding'} ${Math.round(job.progress * 100)}%`;
  if (job.state === 'error') return `failed: ${job.error}`;
  return 'done';
}
