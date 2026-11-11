// End-to-end: starts the real server on a random port with a temporary data folder.
// The upload/encode part needs ffmpeg on PATH and is skipped without it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-e2e-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = 'e2e-admin-password';
let server;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: ADMIN_PW, UPLOAD_CHUNK_MB: '1', ENCODE_THREADS: '2', ACCESS_LOG: 'false', TRUST_PROXY: 'cloudflare' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

// tiny client with a cookie jar
let ipCounter = 0;
function client() {   // each client has its own fake IP (TRUST_PROXY=cloudflare) so failed-login rate limits don't leak between tests
  let cookie = '';
  const ip = `10.0.0.${++ipCounter}`;
  return async (p, { method = 'GET', body, raw, headers = {}, csrf = true } = {}) => {
    const h = { 'CF-Connecting-IP': ip, ...headers };
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET' && csrf) h['X-Clips'] = '1';
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
}

const admin = client(), alex = client(), anon = client();
let alexPassword;

test('front door: / redirects to /home, API needs a login', async () => {
  const r = await anon('/');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/home');
  assert.equal(r.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('strict-transport-security'), null, 'plain HTTP must not advertise HSTS');
  assert.equal((await anon('/home')).status, 200);
  assert.equal((await anon('/api/sources')).status, 401);
  assert.deepEqual((await anon('/api/me')).json.user, null);
});

test('pages link versioned assets that are cached forever; old/unversioned URLs are re-checked', async () => {
  const home = await anon('/home');
  const m = /\/static\/(v-[a-f0-9]{10})\/library\.js/.exec(home.text);
  assert.ok(m, 'home.html links a versioned script');
  const js = await fetch(`${BASE}/static/${m[1]}/library.js`);
  assert.equal(js.status, 200); assert.match(js.headers.get('cache-control'), /immutable/);
  const plain = await fetch(`${BASE}/static/library.js`);
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${BASE}/static/v-0000000000/library.js`)).headers.get('cache-control'), 'no-cache');
  assert.equal((await anon('/account')).status, 200);
  const again = await fetch(`${BASE}/home`, { headers: { 'If-None-Match': home.headers.get('etag') } });
  assert.equal(again.status, 304, 'app pages use the rewritten HTML ETag');
});

test('login: wrong password refused, right one sets an HttpOnly cookie', async () => {
  assert.equal((await anon('/api/login', { method: 'POST', body: { name: 'Admin', password: 'nope' } })).status, 401);
  assert.equal((await anon('/api/login', { method: 'POST', body: { name: 'nobody', password: ADMIN_PW } })).status, 401, 'wrong name');
  assert.equal((await anon('/api/login', { method: 'POST', body: { password: ADMIN_PW } })).status, 401, 'name is required');
  const r = await admin('/api/login', { method: 'POST', body: { name: 'admin', password: ADMIN_PW } });
  assert.equal(r.status, 200); assert.equal(r.json.user.admin, true);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
});

test('state changes need the X-Clips header (CSRF)', async () => {
  assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'x' }, csrf: false })).status, 403);
});

test('admin creates a friend; friend can sign in', async () => {
  const r = await admin('/api/users', { method: 'POST', body: { name: 'Alex', quotaGB: 1 } });
  assert.equal(r.status, 201); alexPassword = r.json.password;
  assert.ok(alexPassword.length >= 16);
  assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'alex' } })).status, 400, 'duplicate name');
  const l = await alex('/api/login', { method: 'POST', body: { name: 'ALEX', password: alexPassword } });
  assert.equal(l.json.user.name, 'Alex'); assert.equal(l.json.user.admin, false);
  assert.equal((await alex('/api/users')).status, 403, 'friends cannot manage users');
  const auth = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!auth.includes(alexPassword), 'plaintext password never stored');
  assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
});

test('quota is checked before any data is sent', async () => {
  const r = await alex('/api/uploads', { method: 'POST', body: { name: 'big.mp4', size: 2e9 } });
  assert.equal(r.status, 413); assert.match(r.json.error, /storage limit/);
  assert.equal((await alex('/api/uploads', { method: 'POST', body: { name: 'x.exe', size: 10 } })).status, 400);
});

test('unfinished uploads reserve their declared quota', async () => {
  const first = await alex('/api/uploads', { method: 'POST', body: { name: 'first.mp4', size: 600e6 } });
  assert.equal(first.status, 201, first.text);
  const second = await alex('/api/uploads', { method: 'POST', body: { name: 'second.mp4', size: 600e6 } });
  assert.equal(second.status, 413); assert.match(second.json.error, /storage limit/);
  const again = await alex('/api/uploads', { method: 'POST', body: { name: 'first.mp4', size: 600e6 } });
  assert.equal(again.status, 201, again.text); assert.equal(again.json.id, first.json.id, 'the same file again continues the unfinished upload');
  assert.equal((await alex(`/api/uploads/${first.json.id}`, { method: 'DELETE' })).status, 200);
});

async function upload(c, file, name) {
  const buf = fs.readFileSync(file);
  const s = await c('/api/uploads', { method: 'POST', body: { name, size: buf.length } });
  assert.equal(s.status, 201, s.text);
  // pieces in any order, two at a time, one sent twice (a retry)
  const n = Math.ceil(buf.length / s.json.chunkSize), order = [...Array(n).keys()].reverse();
  if (n > 1) {
    assert.equal((await c(`/api/uploads/${s.json.id}?offset=1`, { method: 'PUT', raw: buf.subarray(1, 10) })).status, 400, 'pieces start on a piece boundary');
    order.push(n - 1);
  }
  for (let i = 0; i < order.length; i += 2) {
    const rs = await Promise.all(order.slice(i, i + 2).map((k) => c(`/api/uploads/${s.json.id}?offset=${k * s.json.chunkSize}`,
      { method: 'PUT', raw: buf.subarray(k * s.json.chunkSize, (k + 1) * s.json.chunkSize) })));
    for (const r of rs) assert.equal(r.status, 200, r.text);
  }
  const st = await c(`/api/uploads/${s.json.id}`);
  assert.equal(st.json.received, buf.length); assert.equal(st.json.pieces.length, n);
  return c(`/api/uploads/${s.json.id}/complete`, { method: 'POST' });
}

test('a playlist disguised as a video is rejected', { skip: !HAVE_FFMPEG && 'needs ffmpeg' }, async () => {
  const f = path.join(dir, 'evil.mp4');
  fs.writeFileSync(f, '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
  const r = await upload(alex, f, 'evil.mp4');
  assert.equal(r.status, 400);
  assert.ok(!r.json.error.includes(dir), 'no server paths in errors');
});

test('upload in pieces, prepare, export, public page; others cannot see it', { skip: !HAVE_FFMPEG && 'needs ffmpeg', timeout: 180e3 }, async () => {
  const f = path.join(dir, 'in.mkv');
  const g = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-c:a', 'aac', f]);   // lossless: several 1 MB pieces
  assert.equal(g.status, 0, String(g.stderr));
  assert.ok(fs.statSync(f).size > 2 * 1024 * 1024, 'the test file needs several pieces');
  const r = await upload(alex, f, 'in.mkv');
  assert.equal(r.status, 201, r.text);
  const sid = r.json.id;
  assert.equal(r.json.ownerName, 'Alex');
  for (let i = 0; i < 100 && (await alex(`/api/sources/${sid}`)).json.status !== 'ready'; i++) await new Promise((x) => setTimeout(x, 300));
  const pv = await alex(`/api/sources/${sid}/preview`, { method: 'POST' });   // H.264: preview made already, nothing to convert
  assert.equal(pv.status, 200); assert.equal(pv.json.preview, 'ready'); assert.equal(pv.json.jobs.length, 0);
  // the admin sees it, an anonymous visitor does not, and a second friend does not
  assert.equal((await admin(`/api/sources/${sid}`)).status, 200);
  assert.equal((await anon(`/api/sources/${sid}`)).status, 401);
  const sam = client();
  const created = await admin('/api/users', { method: 'POST', body: { name: 'Sam' } });
  await sam('/api/login', { method: 'POST', body: { name: 'Sam', password: created.json.password } });
  assert.equal((await sam(`/api/sources/${sid}`)).status, 404);
  assert.equal((await sam('/api/sources')).json.length, 0);
  const poster = await alex(`/api/sources/${sid}/poster.jpg`);
  assert.equal(poster.status, 200, poster.text); assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.equal((await sam(`/api/sources/${sid}/poster.jpg`)).status, 404);

  const users = (await admin('/api/users')).json.users;
  const alexUser = users.find((u) => u.name === 'Alex');
  await admin(`/api/users/${alexUser.id}`, { method: 'PATCH', body: { quotaGB: 0 } });
  const overQuota = await alex(`/api/sources/${sid}/export`, { method: 'POST', body: { start: 0.5, end: 3.5, preset: 'small' } });
  assert.equal(overQuota.status, 413); assert.match(overQuota.json.error, /delete old recordings or clips/i);
  await admin(`/api/users/${alexUser.id}`, { method: 'PATCH', body: { quotaGB: 1 } });

  const job = await alex(`/api/sources/${sid}/export`, { method: 'POST', body: { start: 0.5, end: 3.5, title: 'E2E <clip>', preset: 'small', fadeIn: 1.25 } });
  assert.equal(job.status, 202, job.text);
  let j;
  for (let i = 0; i < 300; i++) { j = (await alex(`/api/jobs/${job.json.id}`)).json; if (j.state === 'done' || j.state === 'error') break; await new Promise((x) => setTimeout(x, 300)); }
  assert.equal(j.state, 'done', j.error);
  const page = await anon(`/${j.clipId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /og:video" content="http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9]{12}\.mp4"/);
  assert.match(page.text, /E2E &lt;clip&gt;/); assert.match(page.text, /by Alex/);
  assert.ok(!page.text.includes('fadeIn'), 'the public page never exposes saved edit settings');
  const saved = await alex(`/api/clips/${j.clipId}`);
  assert.equal(saved.json.edit.fadeIn, 1.25, 'the cleaned edit is kept with the finished clip');
  assert.equal((await alex(`/api/clips/${j.clipId}`, { method: 'PATCH', raw: '{' })).status, 400, 'bad API JSON is not a 500');
  const mp4 = await fetch(`${BASE}/${j.clipId}.mp4`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(mp4.status, 206);
  assert.equal((await sam(`/api/clips/${j.clipId}`, { method: 'DELETE' })).status, 404, 'others cannot delete it');
  assert.equal((await alex(`/api/clips/${j.clipId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await anon(`/${j.clipId}`)).status, 404);
});

test('renaming: yourself, the admin renames anyone, names stay unique', async () => {
  let r = await alex('/api/me', { method: 'PATCH', body: { name: '  Alexander   the  Great ' } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.user.name, 'Alexander the Great');
  assert.equal((await alex('/api/me')).json.user.name, 'Alexander the Great');
  assert.equal((await alex('/api/me', { method: 'PATCH', body: { name: 'admin' } })).status, 400, "can't take the admin's name");
  assert.equal((await alex('/api/me', { method: 'PATCH', body: { name: '   ' } })).status, 400, 'empty name');
  r = await admin('/api/me', { method: 'PATCH', body: { name: 'Boss' } });
  assert.equal(r.json.user.name, 'Boss'); assert.equal(r.json.user.admin, true);
  assert.equal((await admin('/api/me')).json.user.name, 'Boss');
  const users = (await admin('/api/users')).json;
  assert.equal(users.admin.name, 'Boss');
  const a = users.users.find((u) => u.name === 'Alexander the Great');
  assert.equal((await admin(`/api/users/${a.id}`, { method: 'PATCH', body: { name: 'boss' } })).status, 400, 'duplicate of the admin, any case');
  r = await admin(`/api/users/${a.id}`, { method: 'PATCH', body: { name: 'Alex' } });
  assert.equal(r.status, 200); assert.equal(r.json.user.name, 'Alex');
  assert.equal((await alex('/api/users/' + a.id, { method: 'PATCH', body: { name: 'x' } })).status, 403, 'friends cannot rename others');
});

test('disabling a user signs them out', async () => {
  const users = (await admin('/api/users')).json.users;
  const a = users.find((u) => u.name === 'Alex');
  await admin(`/api/users/${a.id}`, { method: 'PATCH', body: { disabled: true } });
  assert.equal((await alex('/api/sources')).status, 401);
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'Alex', password: alexPassword } })).status, 401);
});

test('unknown clip ids and paths give the same 404', async () => {
  assert.equal((await anon('/AAAAAAAAAAAA')).status, 404);
  assert.equal((await anon('/AAAAAAAAAAAA.mp4')).status, 404);
  assert.equal((await anon('/whatever')).status, 404);
});

test('login checks only the named account: passwords may be shared, other names do not work', async () => {
  const pw = 'shared-password-1';
  await admin('/api/users', { method: 'POST', body: { name: 'Twin1', password: pw } });
  assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'Twin2', password: ADMIN_PW } })).status, 201, 'even the admin password');
  const t2 = await admin('/api/users', { method: 'POST', body: { name: 'Twin3', password: pw } });
  assert.equal(t2.status, 201);
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'twin3', password: pw } })).json.user.name, 'Twin3');
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'Twin1', password: 'x'.repeat(10) } })).status, 401);
});

test('change own password: wrong current refused, new works, old fails, other sessions end; admin cannot', async () => {
  const c1 = client(), c2 = client(), pw = 'twin-pass-one', npw = 'brand-new-pass';
  await c1('/api/login', { method: 'POST', body: { name: 'Twin1', password: 'shared-password-1' } });
  await c2('/api/login', { method: 'POST', body: { name: 'Twin1', password: 'shared-password-1' } });
  assert.equal((await c1('/api/me/password', { method: 'POST', body: { current: 'wrong', password: npw } })).status, 400);
  assert.equal((await c1('/api/me/password', { method: 'POST', body: { current: 'shared-password-1', password: 'short' } })).status, 400);
  assert.equal((await c1('/api/me/password', { method: 'POST', body: { current: 'shared-password-1', password: npw }, csrf: false })).status, 403);
  assert.equal((await c1('/api/me/password', { method: 'POST', body: { current: 'shared-password-1', password: npw } })).status, 200);
  assert.equal((await c1('/api/sources')).status, 200, 'this session stays');
  assert.equal((await c2('/api/sources')).status, 401, 'other sessions end');
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'Twin1', password: 'shared-password-1' } })).status, 401);
  assert.equal((await client()('/api/login', { method: 'POST', body: { name: 'Twin1', password: npw } })).status, 200);
  assert.equal((await anon('/api/me/password', { method: 'POST', body: { current: pw, password: npw } })).status, 401);
  const a = await admin('/api/me/password', { method: 'POST', body: { current: ADMIN_PW, password: 'whatever-123' } });
  assert.equal(a.status, 400); assert.match(a.json.error, /ADMIN_PASSWORD/);
});

test('invite links: create, check, accept once, signed in; only the admin creates them', async () => {
  assert.equal((await alex('/api/invites', { method: 'POST', body: {} })).status, 401, 'disabled friend, no session');
  const twin = client(); await twin('/api/login', { method: 'POST', body: { name: 'Twin3', password: 'shared-password-1' } });
  assert.equal((await twin('/api/invites', { method: 'POST', body: {} })).status, 403);
  assert.equal((await twin('/api/invites')).status, 403);
  const r = await admin('/api/invites', { method: 'POST', body: { quotaGB: 3, note: 'for Pat' } });
  assert.equal(r.status, 201, r.text);
  const m = /^http:\/\/127\.0\.0\.1:\d+\/invite#([A-Za-z0-9_-]{43})$/.exec(r.json.url);
  assert.ok(m, r.json.url); const token = m[1];
  assert.ok(!fs.readFileSync(path.join(dir, 'auth.json'), 'utf8').includes(token), 'token itself never stored');
  const list = (await admin('/api/invites')).json.invites;
  assert.equal(list.length, 1); assert.equal(list[0].note, 'for Pat'); assert.equal(list[0].quota, 3e9); assert.ok(!JSON.stringify(list).includes(token));
  assert.equal((await anon('/invite')).status, 200);
  assert.equal((await anon('/api/invite/check', { method: 'POST', body: { token } })).json.ok, true);
  assert.equal((await anon('/api/invite/check', { method: 'POST', body: { token }, csrf: false })).status, 403);
  assert.equal((await anon('/api/invite/check', { method: 'POST', body: { token: 'A'.repeat(43) } })).status, 404);
  assert.equal((await anon('/api/invite/check', { method: 'POST', body: { token: 'short' } })).status, 404);
  // a bad name or password does not burn the invite
  const pat = client();
  assert.equal((await pat('/api/invite/accept', { method: 'POST', body: { token, name: 'alex', password: 'long-enough-pw' } })).status, 400, 'name taken');
  assert.equal((await pat('/api/invite/accept', { method: 'POST', body: { token, name: 'Pat', password: 'short' } })).status, 400);
  // two accepts at once: exactly one wins
  const rival = client();
  const [x, y] = await Promise.all([
    pat('/api/invite/accept', { method: 'POST', body: { token, name: 'Pat', password: 'pats-password' } }),
    rival('/api/invite/accept', { method: 'POST', body: { token, name: 'Pat2', password: 'pats-password' } })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 404]);
  const winner = x.status === 200 ? pat : rival;
  const me = (await winner('/api/me')).json.user;
  assert.match(me.name, /^Pat2?$/); assert.equal(me.admin, false);
  assert.equal((await winner('/api/status')).json.user.quota, 3e9);
  assert.equal((await anon('/api/invite/check', { method: 'POST', body: { token } })).status, 404, 'used up');
  assert.equal((await admin('/api/invites')).json.invites.length, 0);
  // revoke
  const r2 = await admin('/api/invites', { method: 'POST', body: {} });
  assert.equal((await admin(`/api/invites/${r2.json.invite.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await anon('/api/invite/check', { method: 'POST', body: { token: r2.json.url.split('#')[1] } })).status, 404);
});
