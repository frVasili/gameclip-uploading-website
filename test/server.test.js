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
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: ADMIN_PW, UPLOAD_CHUNK_MB: '1', ENCODE_THREADS: '2', ACCESS_LOG: 'false' },
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
function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, raw, headers = {}, csrf = true } = {}) => {
    const h = { ...headers };
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
});

test('login: wrong password refused, right one sets an HttpOnly cookie', async () => {
  assert.equal((await anon('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const r = await admin('/api/login', { method: 'POST', body: { password: ADMIN_PW } });
  assert.equal(r.status, 200); assert.equal(r.json.user.admin, true);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
});

test('state changes need the X-Clips header (CSRF)', async () => {
  assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'x' }, csrf: false })).status, 403);
});

test('admin creates a friend; passwords must be unique; friend can sign in', async () => {
  const r = await admin('/api/users', { method: 'POST', body: { name: 'Alex', quotaGB: 1 } });
  assert.equal(r.status, 201); alexPassword = r.json.password;
  assert.ok(alexPassword.length >= 16);
  assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'Sam', password: ADMIN_PW } })).status, 400);
  assert.equal((await admin('/api/users', { method: 'POST', body: { name: 'alex' } })).status, 400, 'duplicate name');
  const l = await alex('/api/login', { method: 'POST', body: { password: alexPassword } });
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

async function upload(c, file, name) {
  const buf = fs.readFileSync(file);
  const s = await c('/api/uploads', { method: 'POST', body: { name, size: buf.length } });
  assert.equal(s.status, 201, s.text);
  let off = 0;
  while (off < buf.length) {
    const piece = buf.subarray(off, off + s.json.chunkSize);
    const r = await c(`/api/uploads/${s.json.id}?offset=${off}`, { method: 'PUT', raw: piece });
    assert.equal(r.status, 200, r.text);
    off = r.json.received;
  }
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
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', f]);
  assert.equal(g.status, 0, String(g.stderr));
  const r = await upload(alex, f, 'in.mkv');
  assert.equal(r.status, 201, r.text);
  const sid = r.json.id;
  assert.equal(r.json.ownerName, 'Alex');
  for (let i = 0; i < 100 && (await alex(`/api/sources/${sid}`)).json.status !== 'ready'; i++) await new Promise((x) => setTimeout(x, 300));
  // the admin sees it, an anonymous visitor does not, and a second friend does not
  assert.equal((await admin(`/api/sources/${sid}`)).status, 200);
  assert.equal((await anon(`/api/sources/${sid}`)).status, 401);
  const sam = client();
  const created = await admin('/api/users', { method: 'POST', body: { name: 'Sam' } });
  await sam('/api/login', { method: 'POST', body: { password: created.json.password } });
  assert.equal((await sam(`/api/sources/${sid}`)).status, 404);
  assert.equal((await sam('/api/sources')).json.length, 0);

  const job = await alex(`/api/sources/${sid}/export`, { method: 'POST', body: { start: 0.5, end: 3.5, title: 'E2E <clip>', preset: 'small' } });
  assert.equal(job.status, 202, job.text);
  let j;
  for (let i = 0; i < 300; i++) { j = (await alex(`/api/jobs/${job.json.id}`)).json; if (j.state === 'done' || j.state === 'error') break; await new Promise((x) => setTimeout(x, 300)); }
  assert.equal(j.state, 'done', j.error);
  const page = await anon(`/${j.clipId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /og:video" content="http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9]{12}\.mp4"/);
  assert.match(page.text, /E2E &lt;clip&gt;/); assert.match(page.text, /by Alex/);
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
  assert.equal((await client()('/api/login', { method: 'POST', body: { password: alexPassword } })).status, 401);
});

test('unknown clip ids and paths give the same 404', async () => {
  assert.equal((await anon('/AAAAAAAAAAAA')).status, 404);
  assert.equal((await anon('/AAAAAAAAAAAA.mp4')).status, 404);
  assert.equal((await anon('/whatever')).status, 404);
});
