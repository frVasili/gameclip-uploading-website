// npm test  (pure logic; no ffmpeg needed): metadata cache, sign-in rate limits, password hash upgrade
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-unit-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'unit-test-password';
process.env.TRUST_PROXY = 'cloudflare';
const store = await import('../server/store.js');
const auth = await import('../server/auth.js');

test('store cache: list, mutate through the store API, list again; callers get copies', () => {
  const sid = store.randomId(16), cid = store.randomId(12);
  fs.mkdirSync(store.sourceDir(sid), { recursive: true });
  store.saveSource({ id: sid, owner: 'u1', name: 'a.mp4', created: 1, exports: [] });
  store.saveClip({ id: cid, owner: 'u1', title: 't', created: 2, size: 1000 });
  assert.deepEqual(store.listSources().map((s) => s.id), [sid]);
  assert.equal(store.usageByOwner(true).u1 >= 1000, true);
  // mutating a returned object without saving does not change the store
  store.getSource(sid).name = 'oops'; store.listClips()[0].title = 'oops';
  assert.equal(store.getSource(sid).name, 'a.mp4'); assert.equal(store.getClip(cid).title, 't');
  // mutate + save is visible, and on disk
  const c = store.getClip(cid); c.title = 'new'; c.size = 5000; store.saveClip(c);
  assert.equal(store.listClips()[0].title, 'new');
  assert.equal(JSON.parse(fs.readFileSync(store.clipFile(cid, 'json'), 'utf8')).title, 'new');
  assert.equal(store.usageByOwner().u1 >= 5000, true, 'usage follows the save');
  // upload records go through the store too
  const uid = store.randomId(20);
  store.saveUploadMeta({ id: uid, owner: 'u1', size: 10, received: 4 });
  assert.equal(store.listUploadMeta().length, 1);
  store.deleteUploadMeta(uid);
  assert.equal(store.listUploadMeta().length, 0);
  assert.equal(fs.existsSync(path.join(store.UPLOADS, `${uid}.json`)), false);
  // deletes
  assert.equal(store.deleteClip(cid), true); assert.equal(store.getClip(cid), null); assert.equal(store.listClips().length, 0);
  store.deleteSource(sid); assert.equal(store.getSource(sid), null); assert.equal(store.listSources().length, 0);
  assert.equal(store.usageByOwner().u1 || 0, 0);
});

test('store cache: a cold start sees what is on disk, old files without an owner belong to the admin', async () => {
  const cid = store.randomId(12);
  fs.writeFileSync(store.clipFile(cid, 'json'), JSON.stringify({ id: cid, title: 'old', created: 3 }));
  const again = await import(`../server/store.js?again=${Date.now()}`);   // second module instance = cold cache
  assert.equal(again.getClip(cid).owner, 'admin');
  assert.equal(again.listClips().some((c) => c.id === cid), true);
});

const fakeReq = (ip) => ({ headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': '6.6.6.6' }, socket: { remoteAddress: '127.0.0.1' } });
const fakeRes = () => ({ setHeader() {} });

test('login rate limit is per client: 10 failures lock that client only; Retry-After is given', async () => {
  const a = fakeReq('203.0.113.1');
  for (let i = 0; i < 10; i++) assert.equal((await auth.login(a, fakeRes(), 'nobody', 'wrongpass')).status, 401);
  const locked = await auth.login(a, fakeRes(), 'nobody', 'wrongpass');
  assert.equal(locked.status, 429); assert.ok(locked.retryAfter > 0 && locked.retryAfter <= 900);
  assert.equal((await auth.login(a, fakeRes(), 'Admin', 'unit-test-password')).status, 429, 'even the right password waits');
  // another client is not affected
  assert.equal((await auth.login(fakeReq('203.0.113.2'), fakeRes(), 'Admin', 'unit-test-password')).ok, true);
});

test('clientIp: cloudflare header; socket address otherwise', () => {
  assert.equal(auth.clientIp(fakeReq('203.0.113.9')), '203.0.113.9');
  assert.equal(auth.clientIp({ headers: {}, socket: { remoteAddress: '10.1.1.1' } }), '10.1.1.1');
});

test('old scrypt hash (N=16384, no parameters) still signs in and is upgraded to N=65536', async () => {
  const salt = crypto.randomBytes(16), pw = 'old-format-password';
  const old = `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  const file = path.join(dir, 'auth.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  db.users = [{ id: 'olduser01', name: 'Olive', hash: old, created: 1, quota: 1e9 }];
  fs.writeFileSync(file, JSON.stringify(db));
  auth._reload();
  assert.equal((await auth.login(fakeReq('203.0.113.50'), fakeRes(), 'olive', 'wrong-password')).status, 401);
  const r = await auth.login(fakeReq('203.0.113.50'), fakeRes(), 'olive', pw);
  assert.equal(r.ok, true);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.id === 'olduser01').hash;
  assert.notEqual(stored, old);
  assert.match(stored, /^scrypt\$[^$]+\$[^$]+\$N=65536,r=8,p=1$/);
  auth._reload();
  assert.equal((await auth.login(fakeReq('203.0.113.50'), fakeRes(), 'olive', pw)).ok, true, 'the upgraded hash verifies');
  assert.equal((await auth.login(fakeReq('203.0.113.50'), fakeRes(), 'olive', 'wrong-password')).status, 401);
});
