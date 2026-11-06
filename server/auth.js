// Logins. There is one admin (password from ADMIN_PASSWORD / ADMIN_PASSWORD_FILE) and any number of users
// the admin creates. Every user signs in with just a password, so passwords must be unique.
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
let db = readJson(FILE) || { users: [], sessions: {} };
const save = () => writeJson(FILE, db, 0o600);

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
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Easy to type and read out, ~70 bits: e.g. "k7qm-3xvt-9hpe-wd2r-ty"
export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(18)) { if (s.replace(/-/g, '').length % 4 === 0 && s) s += '-'; s += chars[b % chars.length]; }
  return s.slice(0, 22);
}

// ---- rate limiting of failed logins ----
const fails = new Map();   // ip -> { n, until }
let globalFails = { n: 0, since: Date.now() };
function limited(ip) {
  const f = fails.get(ip);
  if (f && f.until > Date.now() && f.n >= 8) return true;
  if (Date.now() - globalFails.since > 15 * 60e3) globalFails = { n: 0, since: Date.now() };
  return globalFails.n >= 100;
}
function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || f.until < Date.now()) fails.set(ip, { n: 1, until: Date.now() + 15 * 60e3 });
  else f.n++;
  globalFails.n++;
  if (fails.size > 10000) fails.clear();
}

export function clientIp(req) {
  if (config.trustProxy === 'cloudflare' && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
  if (config.trustProxy === 'proxy' && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

// ---- sessions ----
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('base64url');
function cookieToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function isHttps(req) {
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

// Returns { ok, user } or { ok:false, status, error }
export async function login(req, res, password) {
  const ip = clientIp(req);
  if (limited(ip)) return { ok: false, status: 429, error: 'Too many wrong passwords. Try again in 15 minutes.' };
  password = String(password || '');
  let user = null;
  if (password && password.length <= 200) {
    const d = crypto.createHash('sha256').update(password).digest();
    if (crypto.timingSafeEqual(d, adminDigest)) user = adminUser();
    else {
      for (const u of db.users) {
        if (!u.disabled && await verifyPassword(password, u.hash)) { user = userById(u.id); break; }
      }
    }
  }
  if (!user) {
    recordFail(ip);
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    return { ok: false, status: 401, error: 'Wrong password.' };
  }
  const token = crypto.randomBytes(32).toString('base64url');
  pruneSessions();
  db.sessions[tokenHash(token)] = { uid: user.id, created: Date.now(), expires: Date.now() + config.sessionDays * 86400e3 };
  save();
  setCookie(req, res, token, config.sessionDays * 86400);
  return { ok: true, user };
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

async function passwordInUse(pw, exceptId) {
  if (crypto.timingSafeEqual(crypto.createHash('sha256').update(pw).digest(), adminDigest)) return true;
  for (const u of db.users) if (u.id !== exceptId && await verifyPassword(pw, u.hash)) return true;
  return false;
}
function checkNewPassword(pw) {
  if (pw.length < 8) throw new Error('Passwords need at least 8 characters.');
  if (pw.length > 200) throw new Error('That password is too long.');
}

export async function createUser({ name, password, quotaGB }) {
  name = cleanName(name, null);
  const pw = password ? String(password) : generatePassword();
  checkNewPassword(pw);
  if (await passwordInUse(pw)) throw new Error('That password is already used by someone else. Everyone signs in with just a password, so they have to be different.');
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
    if (await passwordInUse(newPassword, id)) throw new Error('That password is already used by someone else.');
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

// for tests
export function _reload() { db = readJson(FILE) || { users: [], sessions: {} }; }
