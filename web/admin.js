// Admin page: server status and the people who can sign in.
import { api, $, esc, fmtBytes, ago, toast, copy, renderHeader, requireUser, initials } from './common.js';

let base = location.origin;

function secretBox(name, pw) {
  return `<div class="secret"><b>Password for ${esc(name)}</b><br><span class="pw">${esc(pw)}</span>
    <button class="small primary" data-copypw="${esc(pw)}">Copy</button>
    <div class="small muted">Send it privately. They sign in at <span class="mono">${esc(base)}/home</span>. It won't be shown again; you can always make a new one.</div></div>`;
}

async function load() {
  const [st, data] = await Promise.all([api('/api/status'), api('/api/users')]);
  base = st.publicBase || location.origin;
  const g = st.gpu || {};
  $('#stats').innerHTML = [
    ['Free disk space', st.diskFree != null ? fmtBytes(st.diskFree) : '?'],
    ['Encodes running / waiting', String(st.queue)],
    ['GPU encoding', g.available ? `<span class="ok">available</span> <span class="small muted">${esc(g.device)}</span>` : `<span class="muted">off</span> <span class="small muted" title="${esc(g.error || '')}">${esc((g.error || '').slice(0, 60))}</span>`],
    ['Recordings auto-delete', st.retentionDays ? `after ${st.retentionDays} days` : 'never'],
    ['ffmpeg', `<span class="small">${esc(st.ffmpeg)}</span>`],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  if (!$('#newQuota').value) $('#newQuota').value = data.defaultQuotaGB;

  const rows = [{ ...data.admin, isAdmin: true }, ...data.users];
  $('#userCount').textContent = rows.length;
  $('#users').innerHTML = rows.map((u) => {
    const f = u.quota ? Math.min(1, u.used / u.quota) : 0;
    return `<tr class="${u.disabled ? 'disabled' : ''}">
      <td><span class="row" style="flex-wrap:nowrap"><span class="avatar">${esc(initials(u.name))}</span><b>${esc(u.name)}</b>
        ${u.isAdmin ? '<span class="badge">admin</span>' : ''}${u.disabled ? '<span class="badge error">disabled</span>' : ''}</span></td>
      <td>${u.uploads} / ${u.clips}</td>
      <td>${u.isAdmin ? `${fmtBytes(u.used)} <span class="muted small">no limit</span>`
        : `<div class="row" style="flex-wrap:nowrap"><div class="meter ${f > 0.9 ? 'full' : ''}" style="width:90px"><div style="width:${f * 100}%"></div></div>
           <span class="small">${fmtBytes(u.used)} / ${fmtBytes(u.quota)}</span></div>`}</td>
      <td class="hide-sm small muted">${u.isAdmin ? 'set by the server config' : u.lastLogin ? ago(u.lastLogin) : 'never'}</td>
      <td style="text-align:right;white-space:nowrap">${u.isAdmin ? '' : `
        <button class="small" data-reset="${u.id}" data-name="${esc(u.name)}">New password</button>
        <button class="small" data-quota="${u.id}" data-cur="${u.quota / 1e9}">Limit</button>
        <button class="small" data-toggle="${u.id}" data-dis="${u.disabled ? 1 : 0}">${u.disabled ? 'Enable' : 'Disable'}</button>
        <button class="small danger" data-del="${u.id}" data-name="${esc(u.name)}">Delete</button>`}</td>
    </tr>${u.id ? `<tr hidden data-secret="${u.id}"><td colspan="5"></td></tr>` : ''}`;
  }).join('');
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

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  try {
    if (d.copypw) return copy(d.copypw, 'Password copied');
    if (d.reset) {
      if (!confirm(`Make a new password for ${d.name}? The old one stops working and they are signed out.`)) return;
      const r = await api(`/api/users/${d.reset}`, { method: 'PATCH', body: { resetPassword: true } });
      await load();
      const row = document.querySelector(`[data-secret="${d.reset}"]`);
      row.hidden = false; row.firstElementChild.innerHTML = secretBox(r.user.name, r.password);
      return;
    }
    if (d.quota) {
      const v = prompt('Storage limit in GB (recordings + clips):', d.cur);
      if (v === null) return;
      if (!(Number(v) >= 0)) return toast('Enter a number of GB', true);
      await api(`/api/users/${d.quota}`, { method: 'PATCH', body: { quotaGB: Number(v) } });
    } else if (d.toggle) {
      await api(`/api/users/${d.toggle}`, { method: 'PATCH', body: { disabled: d.dis !== '1' } });
    } else if (d.del) {
      if (!confirm(`Delete ${d.name}? Their password stops working.`)) return;
      const wipe = confirm(`Also delete everything ${d.name} uploaded?\n\nOK = delete their recordings and clips (links stop working)\nCancel = keep their clips online (they become yours)`);
      await api(`/api/users/${d.del}?data=${wipe ? 'delete' : 'keep'}`, { method: 'DELETE' });
      toast(wipe ? `${d.name} and their uploads deleted` : `${d.name} deleted; their clips are now yours`);
    } else return;
    load();
  } catch (ex) { toast(ex.message, true); }
});

(async () => {
  const { user, siteName } = await requireUser();
  if (!user.admin) { location.href = '/home'; return; }
  renderHeader(user, siteName, { page: 'admin' });
  load().catch((e) => toast(e.message, true));
})();
