// Invite page: the token is in the URL #fragment (never sent to the server until the API calls below).
import { api, $ } from './common.js';

const token = location.hash.slice(1);
history.replaceState(null, '', '/invite');   // keep the token out of the address bar and history afterwards

(async () => {
  try {
    if (!token) throw new Error('This invite link is invalid, already used, or expired.');
    const d = await api('/api/invite/check', { method: 'POST', body: { token } });
    document.title = `Join ${d.siteName}`; $('#title').textContent = d.siteName;
    $('#intro').hidden = true;
    $('#form').hidden = false;
  } catch (e) {
    $('#title').textContent = 'Invite not valid'; $('#intro').textContent = e.message;
    $('#form').hidden = true;
  }
})();

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#error'); err.hidden = true;
  if ($('#pw').value !== $('#pw2').value) { err.textContent = 'The two passwords are different.'; err.hidden = false; return; }
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try {
    await api('/api/invite/accept', { method: 'POST', body: { token, name: $('#name').value, password: $('#pw').value } });
    localStorage.setItem('clips-name', $('#name').value.trim());
    location.href = '/home';
  } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
};
