// All settings come from environment variables (see .env.example). Nothing deployment-specific is hardcoded.
import fs from 'node:fs';

const env = process.env;
const num = (k, d) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) ? v : d; };
const str = (k, d = '') => (env[k] ?? '').trim() || d;
const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]));
function secret(k) {   // KEY or KEY_FILE (Docker secrets style)
  if (env[`${k}_FILE`]) {
    try { return fs.readFileSync(env[`${k}_FILE`], 'utf8').trim(); } catch (e) { throw new Error(`${k}_FILE: ${e.message}`); }
  }
  return (env[k] ?? '').trim();
}

const GB = 1e9;
export const config = {
  dataDir: str('DATA_DIR', '/data'),
  host: str('HOST', '0.0.0.0'),
  port: num('PORT', 8080),
  // Public address of the site, used for links and Discord embeds, e.g. https://clips.example.com.
  // Empty = work it out from each request (fine behind most proxies).
  publicUrl: str('PUBLIC_URL').replace(/\/+$/, ''),
  siteName: str('SITE_NAME', 'Clips'),
  adminPassword: secret('ADMIN_PASSWORD'),
  // Who to believe about the visitor's IP (login rate limiting): "cloudflare" (CF-Connecting-IP),
  // "proxy" (first X-Forwarded-For), or "none" (the TCP peer).
  trustProxy: str('TRUST_PROXY', 'none').toLowerCase(),
  // Optional: refuse requests whose Host header is not in this list (comma separated).
  allowedHosts: str('ALLOWED_HOSTS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  maxUploadBytes: num('MAX_UPLOAD_GB', 20) * GB,
  minFreeBytes: num('MIN_FREE_GB', 10) * GB,
  defaultQuotaBytes: num('DEFAULT_QUOTA_GB', 20) * GB,       // per friend; the admin has no quota
  sourceRetentionDays: num('SOURCE_RETENTION_DAYS', 0),      // delete uploaded recordings after N days (clips stay); 0 = never
  maxJobsPerUser: num('MAX_JOBS_PER_USER', 3),
  sessionDays: num('SESSION_DAYS', 30),
  chunkBytes: num('UPLOAD_CHUNK_MB', 32) * 1024 * 1024,      // must stay under any proxy body limit (Cloudflare: 100 MB)
  encodeThreads: num('ENCODE_THREADS', 4),
  encodeNice: num('ENCODE_NICE', 15),
  // Optional hardware encoding (AMD/Intel VAAPI), e.g. /dev/dri/renderD128. Off when empty.
  vaapiDevice: str('VAAPI_DEVICE'),
  embedCapMB: num('EMBED_CAP_MB', 250),                       // largest preset; see docs/discord-embeds.md
  secureCookies: str('SECURE_COOKIES', 'auto').toLowerCase(),  // auto | always | never
  logRequests: bool('ACCESS_LOG', true),
};

export function publicBase(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = config.trustProxy !== 'none' && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host || 'localhost'}`;
}
