// Logins. There is one admin (password from ADMIN_PASSWORD / ADMIN_PASSWORD_FILE) and any number of users
// the admin creates (directly, or through a one-time invite link). Everyone signs in with name + password.
//   - passwords: scrypt with a per-user salt; plaintext is shown once when created/reset, never stored
//   - sessions: random 256-bit token in an HttpOnly cookie; only its SHA-256 is stored
//   - failed logins are rate limited per client IP and globally
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { DATA_DIR, writeJson, readJson, randomId } from './store.js';

const FILE = path.join(DATA_DIR, 'auth.json');
const COOKIE = 'clips_session';
const loadDb = () => { const d = readJson(FILE) || {}; return { ...d, users: d.users || [], sessions: d.sessions || {}, invites: d.invites || [] }; };
let db = loadDb();
const pruneInvites = () => { const now = Date.now(); db.invites = db.invites.filter((i) => i.expires > now); };
const save = () => { pruneInvites(); writeJson(FILE, db, 0o600); };

// ---- admin password: from the environment, or generated once on first start ----
let adminPassword = config.adminPassword;
if (!adminPassword) {
  const f = path.join(DATA_DIR, 'admin-password.txt');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, `${generatePassword()}\n`, { mode: 0o600 });
    console.log(`No ADMIN_PASSWORD set: generated one in ${f} (inside the data volume). Set ADMIN_PASSWORD to choose your own.`);
  }
  adminPassword = fs.readFileSync(f, 'utf8').trim();
}
if (adminPassword.length < 8) console.warn('WARNING: the admin password is shorter than 8 characters.');
const adminDigest = crypto.createHash('sha256').update(adminPassword).digest();

// ---- hashing ----
// Stored as scrypt$<salt>$<hash>$N=<n>,r=<r>,p=<p>. Older hashes have no 4th field: they were made with
// N=16384, r=8, p=1. They still verify, and login() re-hashes them with the current cost.
const LEGACY_PARAMS = { N: 16384, r: 8, p: 1 };
const CURRENT_PARAMS = { N: 65536, r: 8, p: 1 };
const paramString = (q) => `N=${q.N},r=${q.r},p=${q.p}`;
const scrypt = (pw, salt, q) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 32, { ...q, maxmem: 128 * q.N * q.r + 8 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
function parseHash(stored) {
  const [kind, salt, hash, ps] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return null;
  let q = LEGACY_PARAMS;
  if (ps !== undefined) {
    const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(ps);
    q = m && { N: +m[1], r: +m[2], p: +m[3] };
    // refuse absurd costs from a damaged file (power-of-two N, bounded memory)
    if (!q || q.N < 1024 || q.N > 2 ** 20 || (q.N & (q.N - 1)) || q.r < 1 || q.r > 16 || q.p < 1 || q.p > 4) return null;
  }
  return { salt: Buffer.from(salt, 'base64'), want: Buffer.from(hash, 'base64'), q };
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, CURRENT_PARAMS)).toString('base64')}$${paramString(CURRENT_PARAMS)}`;
}
async function verifyPassword(pw, stored) {
  const h = parseHash(stored);
  if (!h) return false;
  const got = await scrypt(pw, h.salt, h.q);
  return got.length === h.want.length && crypto.timingSafeEqual(got, h.want);
}
const needsRehash = (stored) => { const h = parseHash(stored); return !!h && paramString(h.q) !== paramString(CURRENT_PARAMS); };
// Easy to type and read out, ~70 bits: e.g. "k7qm-3xvt-9hpe-wd2r-ty"
export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(18)) { if (s.replace(/-/g, '').length % 4 === 0 && s) s += '-'; s += chars[b % chars.length]; }
  return s.slice(0, 22);
}

// ---- rate limiting of failed logins ----
// Per client: 10 failures per 15 minutes lock that client out. Once 300 failures have been seen from all
// clients together in 15 minutes, every client is cut to a single wrong try (see limited()). Client
// addresses live in memory only (never logged or written to disk), and the map is bounded.
const WINDOW = 15 * 60e3, PER_CLIENT = 10, GLOBAL = 300, MAX_CLIENTS = 5000;
const fails = new Map();   // client -> { n, until }   (insertion order = oldest first)
let globalFails = { n: 0, since: Date.now() };
let lastLimitedFor = WINDOW;   // ms until the lock ends, for Retry-After
function limited(ip) {
  const now = Date.now();
  if (now - globalFails.since > WINDOW) globalFails = { n: 0, since: now };
  const f = fails.get(ip);
  if (f && f.until > now && f.n >= PER_CLIENT) { lastLimitedFor = f.until - now; return true; }
  // during a flood from many addresses, only clients that already got it wrong in this window are held back:
  // someone who types the right password first time still gets in, so a flood can't lock the owner out
  if (globalFails.n >= GLOBAL && f && f.until > now) { lastLimitedFor = Math.min(f.until, globalFails.since + WINDOW) - now; return true; }
  return false;
}
function recordFail(ip) {
  const now = Date.now();
  const f = fails.get(ip);
  if (!f || f.until < now) {
    fails.delete(ip);
    fails.set(ip, { n: 1, until: now + WINDOW });
    if (fails.size > MAX_CLIENTS) {   // drop expired entries first, then the oldest: never "clear all" (that would reset everyone)
      for (const [k, v] of fails) if (v.until < now) fails.delete(k);
      for (const k of fails.keys()) { if (fails.size <= MAX_CLIENTS) break; fails.delete(k); }
    }
  } else f.n++;
  if (now - globalFails.since > WINDOW) globalFails = { n: 0, since: now };
  globalFails.n++;
}
const tooMany = () => Object.assign(new Error('Too many wrong tries. Try again in 15 minutes.'), { status: 429, retryAfter: Math.max(1, Math.ceil(lastLimitedFor / 1000)) });

// The client address, for rate limiting only. TRUST_PROXY=cloudflare: CF-Connecting-IP. TRUST_PROXY=proxy: the
// last X-Forwarded-For entry (the one our own proxy appended; earlier ones can be forged by the client).
// Otherwise the socket address; forwarding headers are ignored.
export function clientIp(req) {
  if (config.trustProxy === 'cloudflare' && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim();
  if (config.trustProxy === 'proxy' && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',').pop().trim();
  return req.socket.remoteAddress || '?';
}

// ---- sessions ----
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('base64url');
function cookieToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
export function isHttps(req) {
  if (config.secureCookies === 'always') return true;
  if (config.secureCookies === 'never') return false;
  if (req.socket.encrypted) return true;
  const xfp = String(req.headers['x-forwarded-proto'] || ''), cfv = String(req.headers['cf-visitor'] || '');
  return xfp.startsWith('https') || cfv.includes('https') || config.publicUrl.startsWith('https://') && req.headers.host === new URL(config.publicUrl).host;
}
function setCookie(req, res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`);
}

function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now) delete db.sessions[k];
}

// The admin's display name can be changed (stored in auth.json); its id is always "admin".
const adminName = () => db.adminName || 'Admin';
const adminUser = () => ({ id: 'admin', name: adminName(), admin: true });
function userById(id) {
  if (id === 'admin') return adminUser();
  const u = db.users.find((x) => x.id === id);
  return u && !u.disabled ? { id: u.id, name: u.name, admin: false, quota: u.quota } : null;
}

// The signed-in user for a request, or null.
export function currentUser(req) {
  const t = cookieToken(req);
  if (!t) return null;
  const s = db.sessions[tokenHash(t)];
  if (!s || s.expires < Date.now()) return null;
  return userById(s.uid);
}

// A hash nobody's password matches, so unknown names cost the same time as wrong passwords.
const DUMMY_HASH = `scrypt$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(32).toString('base64')}$${paramString(CURRENT_PARAMS)}`;
const normName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();

function startSession(req, res, uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  pruneSessions();
  db.sessions[tokenHash(token)] = { uid, created: Date.now(), expires: Date.now() + config.sessionDays * 86400e3 };
  save();
  setCookie(req, res, token, config.sessionDays * 86400);
}

// Returns { ok, user } or { ok:false, status, error }. Only the named account's password is checked.
export async function login(req, res, name, password) {
  const ip = clientIp(req);
  if (limited(ip)) { const e = tooMany(); return { ok: false, status: 429, error: e.message, retryAfter: e.retryAfter }; }
  password = String(password || '');
  const n = normName(name);
  let user = null, good = false;
  if (n && password && password.length <= 200) {
    const isAdmin = n === adminName().toLowerCase();
    const u = isAdmin ? null : db.users.find((x) => x.name.toLowerCase() === n && !x.disabled);
    if (isAdmin) {
      await verifyPassword(password, DUMMY_HASH);   // same cost as a user check
      good = crypto.timingSafeEqual(crypto.createHash('sha256').update(password).digest(), adminDigest);
      if (good) user = adminUser();
    } else {
      good = await verifyPassword(password, u ? u.hash : DUMMY_HASH);
      if (good && u) {
        user = userById(u.id);
        if (needsRehash(u.hash)) {   // old cost: upgrade now that we hold the plaintext; never fail the sign-in over it
          const old = u.hash;
          try { const nh = await hashPassword(password); if (u.hash === old) { u.hash = nh; save(); } } catch (e) { console.error('re-hashing a password failed:', e.message); }
        }
      }
    }
  }
  if (!user) {
    recordFail(ip);
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return { ok: false, status: 401, error: 'Wrong name or password.' };
  }
  startSession(req, res, user.id);
  return { ok: true, user };
}

// A signed-in friend changes their own password. Other sessions of theirs end; this one stays.
export async function changePassword(req, user, current, password) {
  if (user.admin) throw Object.assign(new Error('The admin password is set on the server (ADMIN_PASSWORD).'), { status: 400 });
  const ip = clientIp(req);
  if (limited(ip)) throw tooMany();
  const u = db.users.find((x) => x.id === user.id);
  if (!u) throw new Error('No such user.');
  if (!(await verifyPassword(String(current || '').slice(0, 200), u.hash))) {
    recordFail(ip);
    throw Object.assign(new Error('Your current password is wrong.'), { status: 400 });
  }
  password = String(password ?? '');
  checkNewPassword(password);
  u.hash = await hashPassword(password);
  const keep = tokenHash(cookieToken(req) || '');
  for (const [k, s] of Object.entries(db.sessions)) if (s.uid === u.id && k !== keep) delete db.sessions[k];
  save();
}

export function logout(req, res) {
  const t = cookieToken(req);
  if (t && db.sessions[tokenHash(t)]) { delete db.sessions[tokenHash(t)]; save(); }
  setCookie(req, res, '', 0);
}

// ---- user management (admin) ----
const userView = (u) => ({ id: u.id, name: u.name, created: u.created, quota: u.quota, disabled: !!u.disabled,
  lastLogin: Math.max(0, ...Object.values(db.sessions).filter((s) => s.uid === u.id).map((s) => s.created)) || null });
export const listUsers = () => db.users.map(userView);
export const getUser = (id) => userById(id);
export const userName = (id) => (id === 'admin' ? adminName() : db.users.find((u) => u.id === id)?.name || 'deleted user');

// Names: 1-40 characters, no control characters, unique (case-insensitive) across everyone incl. the admin.
function cleanName(name, forId) {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) throw new Error('Give a name.');
  const taken = (forId !== 'admin' && adminName().toLowerCase() === n.toLowerCase())
    || db.users.some((u) => u.id !== forId && u.name.toLowerCase() === n.toLowerCase());
  if (taken) throw new Error('Someone already has that name.');
  return n;
}
// Rename anyone (the admin, or a user by id). Returns the new name.
export function rename(id, name) {
  const n = cleanName(name, id);
  if (id === 'admin') db.adminName = n;
  else { const u = db.users.find((x) => x.id === id); if (!u) throw new Error('No such user.'); u.name = n; }
  save();
  return n;
}

function checkNewPassword(pw) {
  pw = String(pw ?? '');
  if (pw.length < 8) throw new Error('Passwords need at least 8 characters.');
  if (pw.length > 200) throw new Error('That password is too long.');
}

export async function createUser({ name, password, quotaGB }) {
  name = cleanName(name, null);
  const pw = password ? String(password) : generatePassword();
  checkNewPassword(pw);
  const u = { id: randomId(10), name, hash: await hashPassword(pw), created: Date.now(),
    quota: quotaGB === undefined || quotaGB === '' ? config.defaultQuotaBytes : Math.max(0, Number(quotaGB)) * 1e9 };
  db.users.push(u); save();
  return { user: userView(u), password: pw };
}

export async function updateUser(id, { name, quotaGB, disabled, resetPassword, password }) {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error('No such user.');
  let newPassword = null;
  if (name !== undefined) u.name = cleanName(name, id);
  if (quotaGB !== undefined) u.quota = Math.max(0, Number(quotaGB) || 0) * 1e9;
  if (disabled !== undefined) u.disabled = !!disabled;
  if (resetPassword || password) {
    newPassword = password ? String(password) : generatePassword();
    checkNewPassword(newPassword);
    u.hash = await hashPassword(newPassword);
  }
  if (u.disabled || newPassword) for (const [k, s] of Object.entries(db.sessions)) if (s.uid === id) delete db.sessions[k];
  save();
  return { user: userView(u), password: newPassword };
}

export function deleteUser(id) {
  const before = db.users.length;
  db.users = db.users.filter((u) => u.id !== id);
  for (const [k, s] of Object.entries(db.sessions)) if (s.uid === id) delete db.sessions[k];
  save();
  return db.users.length < before;
}

// ---- one-time invite links: the admin makes one, the invitee picks their own name and password ----
// Only the SHA-256 of the token is stored; the token itself lives in the link's #fragment.
const INVITE_DAYS = 7;
const inviteView = (i) => ({ id: i.id, created: i.created, expires: i.expires, quota: i.quota, note: i.note });
export const listInvites = () => { pruneInvites(); return db.invites.map(inviteView); };
export function createInvite({ quotaGB, note } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const i = { id: randomId(10), hash: tokenHash(token), created: Date.now(), expires: Date.now() + INVITE_DAYS * 86400e3,
    quota: quotaGB === undefined || quotaGB === '' || quotaGB === null ? config.defaultQuotaBytes : Math.max(0, Number(quotaGB) || 0) * 1e9,
    note: String(note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100), createdBy: 'admin' };
  db.invites.push(i); save();
  return { invite: inviteView(i), token };
}
export function revokeInvite(id) {
  const n = db.invites.length;
  db.invites = db.invites.filter((i) => i.id !== id);
  if (db.invites.length < n) save();
  return db.invites.length < n;
}
const BAD_INVITE = 'This invite link is invalid, already used, or expired.';
function findInvite(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const h = tokenHash(token);
  return db.invites.find((i) => i.hash === h && i.expires > Date.now()) || null;
}
const bad = (status, error) => Object.assign(new Error(error), { status });
export function checkInvite(req, token) {
  const ip = clientIp(req);
  if (limited(ip)) throw tooMany();
  if (!findInvite(token)) { recordFail(ip); throw bad(404, BAD_INVITE); }
  return { ok: true, siteName: config.siteName };
}
export async function acceptInvite(req, res, { token, name, password }) {
  const ip = clientIp(req);
  if (limited(ip)) throw tooMany();
  const inv = findInvite(token);
  if (!inv) { recordFail(ip); throw bad(404, BAD_INVITE); }
  const n = cleanName(name, null);                 // validate first so a typo doesn't burn the invite
  password = String(password ?? '');
  checkNewPassword(password);
  db.invites = db.invites.filter((i) => i !== inv);  // consume synchronously: a second accept finds nothing
  try {
    const hash = await hashPassword(password);
    const u = { id: randomId(10), name: cleanName(n, null), hash, created: Date.now(), quota: inv.quota };  // re-check: names may have been taken meanwhile
    db.users.push(u);
    startSession(req, res, u.id);
    return { user: userById(u.id) };
  } catch (e) { db.invites.push(inv); save(); throw e; }
}

// for tests
export function _reload() { db = loadDb(); }
