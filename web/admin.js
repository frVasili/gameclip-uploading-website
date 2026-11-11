// Account page. Admin: server status and everyone who can sign in. Others: their own account (change name, storage).
import { api, $, esc, fmtBytes, ago, toast, copy, renderHeader, requireUser, initials, icon, blocks, ask, confirmDialog, promptDialog, menu } from './common.js';

let me = null, people = new Map();

function secretBox(name, pw) {
  return `<div class="secret"><span class="slabel">Sign in as ${esc(name)}</span>
    <div class="sval"><code>${esc(pw)}</code><button class="small primary" data-copypw="${esc(pw)}" type="button">${icon('link')}Copy</button></div>
    <span class="snote">Shown once. Send it privately.</span></div>`;
}

const storage = (u) => (u.isAdmin || !u.quota
  ? `<span class="num">${fmtBytes(u.used)}</span>`
  : `<span class="store">${blocks(Math.min(1, u.used / u.quota), 12)}<span class="num">${esc(fmtBytes(u.used))} / ${esc(fmtBytes(u.quota))}</span></span>`);

// Everyone but the admin sees just their own account.
async function loadSelf() {
  const [st, sources, clips] = await Promise.all([api('/api/status'), api('/api/sources'), api('/api/clips')]);
  $('#selfView').hidden = false;
  $('#pwUser').value = me.name;
  const u = st.user, f = u.quota ? Math.min(1, u.used / u.quota) : 0;
  $('#meCard').innerHTML = `<div class="mehead"><span class="avatar big">${esc(initials(me.name))}</span><h2 class="mename">${esc(me.name)}</h2>
      <button type="button" data-rename="me" data-name="${esc(me.name)}">${icon('edit')}Change name</button></div>
    <div class="mestats">
      <div class="mestat"><span class="k">Storage</span>${u.quota ? `<span class="store">${blocks(f)}<span class="num">${esc(fmtBytes(u.used))} / ${esc(fmtBytes(u.quota))}</span></span>` : `<span class="num">${esc(fmtBytes(u.used))}</span>`}</div>
      <div class="mestat"><span class="k">Recordings</span><span class="num v">${sources.length}</span></div>
      <div class="mestat"><span class="k">Clips</span><span class="num v">${clips.length}</span></div></div>`;
}

async function load() {
  if (!me.admin) return loadSelf();
  const [st, data] = await Promise.all([api('/api/status'), api('/api/users')]);
  $('#adminView').hidden = false;
  const g = st.gpu || {};
  const tiles = [
    ['Free disk space', `<span class="num">${st.diskFree != null ? esc(fmtBytes(st.diskFree)) : '?'}</span>`],
    ['Encodes queued', `<span class="num">${st.queue}</span>`],
    ['GPU encoding', g.available ? `<span class="num ok" title="${esc(g.device)}${g.default ? ', on by default' : ', off by default'}">available</span>` : `<span class="num muted" title="${esc(g.error || '')}">off</span>`],
    ['Auto-delete', `<span class="num">${st.retentionDays ? `after ${st.retentionDays} days` : 'never'}</span>`],
    ['ffmpeg', `<span class="num" title="${esc(st.ffmpeg)}">${esc((String(st.ffmpeg).match(/version\s+(\S+)/) || [, st.ffmpeg])[1])}</span>`],
  ];
  $('#stats').innerHTML = tiles.map(([k, v]) => `<div class="tile"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  if (!$('#newQuota').value) $('#newQuota').value = data.defaultQuotaGB;
  loadInvites().catch((e) => toast(e.message, true));
  const rows = [{ ...data.admin, isAdmin: true, self: true }, ...data.users];
  people = new Map(rows.map((u) => [u.self ? 'me' : u.id, u]));
  $('#userCount').textContent = rows.length;
  renderRows(rows);
}

async function loadInvites() {
  const d = await api('/api/invites');
  if (!$('#invQuota').value) $('#invQuota').value = d.defaultQuotaGB;
  $('#inviteCount').textContent = d.invites.length;
  $('#invites').innerHTML = d.invites.map((i) => `<tr><td class="inote">${i.note ? esc(i.note) : '<span class="muted">No note</span>'}</td>
    <td class="num">${esc(fmtBytes(i.quota))}</td><td class="num nowrap">expires ${esc(new Date(i.expires).toLocaleDateString())}</td>
    <td class="r"><button class="small ghost danger" data-revoke="${i.id}" type="button">Revoke</button></td></tr>`).join('');
}

function renderRows(rows) {
  $('#users').innerHTML = rows.map((u) => {
    const key = u.self ? 'me' : u.id;
    return `<tr class="${u.disabled ? 'disabled' : ''}">
      <td><span class="who"><span class="avatar">${esc(initials(u.name))}</span><b>${esc(u.name)}</b>
        ${u.isAdmin ? '<span class="badge">admin</span>' : ''}${u.disabled ? '<span class="badge error">disabled</span>' : ''}</span></td>
      <td class="hide-sm num">${u.uploads} / ${u.clips}</td>
      <td>${storage(u)}</td>
      <td class="hide-sm num">${u.self ? 'you' : u.lastLogin ? esc(ago(u.lastLogin)) : 'never'}</td>
      <td class="r"><button class="icon small" data-umenu="${esc(key)}" type="button" aria-label="Actions for ${esc(u.name)}" aria-haspopup="menu">${icon('more')}</button></td>
    </tr><tr hidden${u.id ? ` data-secret="${u.id}"` : ''}><td colspan="5"></td></tr>`;
  }).join('');
}

// ---- person actions ----
async function rename(key, name) {
  const v = await promptDialog(`Rename ${name}`, { label: 'Name' , value: name });
  if (v === null || !v.trim() || v.trim() === name) return;
  if (key === 'me') await api('/api/me', { method: 'PATCH', body: { name: v } });
  else await api(`/api/users/${key}`, { method: 'PATCH', body: { name: v } });
  toast('Name changed');
  if (key === 'me') { setTimeout(() => location.reload(), 600); return; }
  load();
}

async function personAction(fn) { try { await fn(); } catch (ex) { toast(ex.message, true); } }

function userMenu(btn, key) {
  const u = people.get(key); if (!u) return;
  const items = [{ label: 'Rename', run: () => personAction(() => rename(key, u.name)) }];
  if (!u.self) {
    items.push(
      { label: 'New password', run: () => personAction(async () => {
        if (!(await confirmDialog(`New password for ${u.name}?`, 'The old one stops working and they are signed out.', { ok: 'New password', danger: true }))) return;
        const r = await api(`/api/users/${u.id}`, { method: 'PATCH', body: { resetPassword: true } });
        await load();
        const row = document.querySelector(`[data-secret="${u.id}"]`);
        row.hidden = false; row.firstElementChild.innerHTML = secretBox(r.user.name, r.password);
      }) },
      { label: 'Storage limit', run: () => personAction(async () => {
        const v = await promptDialog('Storage limit', { label: 'Storage limit (GB)', type: 'number', value: String(+(u.quota / 1e9).toFixed(2)), attrs: 'min="0" step="1"' });
        if (v === null) return;
        if (v.trim() === '' || !(Number(v) >= 0)) return toast('Enter a number of GB', true);
        await api(`/api/users/${u.id}`, { method: 'PATCH', body: { quotaGB: Number(v) } });
        load();
      }) },
      { label: u.disabled ? 'Enable' : 'Disable', run: () => personAction(async () => {
        await api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }); load();
      }) },
      '-',
      { label: 'Delete', danger: true, run: () => personAction(async () => {
        const how = await ask({ title: `Delete ${u.name}?`, body: 'Their account stops working.', actions: [
          { label: 'Cancel', value: null },
          { label: 'Delete account, keep clips', value: 'keep' },
          { label: 'Delete account and everything', value: 'delete', kind: 'danger solid' }] });
        if (!how) return;
        await api(`/api/users/${u.id}?data=${how}`, { method: 'DELETE' });
        toast(how === 'delete' ? `${u.name} and their uploads deleted` : `${u.name} deleted; their clips are now yours`);
        load();
      }) },
    );
  }
  menu(btn, items);
}

$('#addForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    const r = await api('/api/users', { method: 'POST', body: { name: $('#newName').value, quotaGB: $('#newQuota').value, password: $('#newPw').value || undefined } });
    $('#newResult').innerHTML = secretBox(r.user.name, r.password);
    $('#newName').value = ''; $('#newPw').value = '';
    load();
  } catch (ex) { toast(ex.message, true); }
  btn.disabled = false;
};

$('#inviteForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    const r = await api('/api/invites', { method: 'POST', body: { quotaGB: $('#invQuota').value, note: $('#invNote').value } });
    $('#inviteResult').innerHTML = `<div class="secret"><span class="slabel">Invite link</span>
      <div class="sval"><code>${esc(r.url)}</code><button class="small primary" data-copypw="${esc(r.url)}" data-what="Link copied" type="button">${icon('link')}Copy</button></div>
      <span class="snote">Shown once. Send it privately.</span></div>`;
    $('#invNote').value = '';
    loadInvites();
  } catch (ex) { toast(ex.message, true); }
  btn.disabled = false;
};

$('#pwForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('#newPw1').value !== $('#newPw2').value) return toast('The two new passwords are different', true);
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    await api('/api/me/password', { method: 'POST', body: { current: $('#curPw').value, password: $('#newPw1').value } });
    e.target.reset(); $('#pwUser').value = me.name;
    toast('Password changed');
  } catch (ex) { toast(ex.message, true); }
  btn.disabled = false;
};

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  try {
    if (d.copypw) return copy(d.copypw, d.what || 'Password copied');
    if (d.umenu) return userMenu(b, d.umenu);
    if (d.rename) return await rename(d.rename, d.name);
    if (d.revoke) {
      if (!(await confirmDialog('Revoke this invite link?', 'It stops working.', { ok: 'Revoke', danger: true }))) return;
      await api(`/api/invites/${d.revoke}`, { method: 'DELETE' });
      loadInvites();
    }
  } catch (ex) { toast(ex.message, true); }
});

(async () => {
  const { user, siteName } = await requireUser();
  me = user;
  renderHeader(user, siteName, { page: 'admin' });
  load().catch((e) => toast(e.message, true));
})();
