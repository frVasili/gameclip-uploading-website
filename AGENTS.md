# gameclip uploading website: notes for agents and contributors

Self-hosted game-clip editor and sharing site. One Node process (standard library only) plus ffmpeg, one Docker image.

**If `local/DEPLOYMENT.md` exists, read it first.** It describes the owner's live deployment (server, domain,
how it's run, what to ask before touching). It is git-ignored on purpose: nothing about a specific deployment,
person, hostname, domain, IP, path or account goes into tracked files. This repo is meant to be public.

## Layout
- `server/index.js`: the single HTTP server and routing: `/` → `/home`, app pages, `/static/*`, `/api/*`,
  public clip pages `/<12-char id>[.mp4|.jpg]`, `/healthz`.
- `server/config.js`: every setting, from env vars (documented in `.env.example`). Add new settings here and there.
- `server/auth.js`: admin password (env, or generated into `data/admin-password.txt`), users created by the
  admin (password-only sign-in, so passwords are unique), scrypt hashes, sessions (hashed tokens), rate limiting.
- `server/api.js`: signed-in API: chunked uploads, library, editor endpoints, exports, user management,
  the one-at-a-time ffmpeg job queue, housekeeping (stale uploads, optional retention).
- `server/uploads.js`: resumable upload in pieces (Cloudflare's 100 MB body limit; flaky connections).
- `server/media.js`: probe, editor previews (silent video, per-track audio, peaks, leveled previews), the size
  planner, the render (x264 two-pass / CRF, or VAAPI), audio graph (leveling, mix, normalization, limiter).
- `server/pages.js`: anonymous watch pages with Open Graph video tags, access log (no IPs).
- `server/store.js`: files under `DATA_DIR`; ids; usage per owner.
- `web/`: `home.html` + `library.js` (sign-in, upload, library), `editor.html` + `editor.js`, `admin.html` +
  `admin.js`, shared `common.js` and `app.css`. No framework, no build, no external requests (CSP enforces it).
- `docs/API.md` (API contract, keep it in sync), `docs/discord-embeds.md` (measured embed limits).
- `test/`: `npm test` (unit tests + an end-to-end test that starts the server; needs ffmpeg).
- `Dockerfile`, `compose.yml`, `examples/`, `.github/workflows/docker.yml` (tests, then multi-arch image to GHCR).

## Rules that keep it safe (don't break these)
- Anonymous visitors can only reach `/home` and other static pages, `/healthz`, and clip pages by exact id.
  Never add listings, search, sequential ids, or anything that reveals other clips or users.
- Every `/api/*` route except login/logout/me needs a session. Every object has an `owner`; non-admins only
  see and change their own (`mine()` in api.js). Admin-only routes check `user.admin`.
- Every state-changing request needs the `X-Clips: 1` header (CSRF). Cookies are HttpOnly + SameSite=Lax.
- Uploaded files are untrusted: every ffmpeg/ffprobe read of an upload uses `SAFE` (protocol and demuxer
  allow-lists) and `probe()` rejects other containers. Keep that for any new ffmpeg call on user files.
- Errors shown to users go through `userError()` (no server paths).
- Never store plaintext passwords or session tokens; show generated passwords once.
- The browser loads nothing external (CSP `default-src 'self'`).

## Measured facts the defaults rely on
- Discord embeds (tested 2026-11): files up to 273 MB embedded; 290-401 MB were hit or miss; 421 MB and up
  never. Discord's bot downloads the whole file, and its media proxy downloads it again, before the player shows.
  So the cap is 250 MB (`EMBED_CAP_MB`), and the encoder aims for quality, not for filling the cap. Details: docs/discord-embeds.md.
- Audio "Even out": `light`/`strong` in `LEVELING` (media.js). On a test conversation with one speaker 20 dB
  quieter they closed the gap to ~13 dB / ~1-2 dB. Normalization is one constant gain from a loudnorm
  measurement plus an alimiter at −1.5 dBTP. Don't use loudnorm's own second pass: it silently falls back to
  dynamic compression, which changed the balance between speakers in testing.

## Working on it
- Dev server: `ADMIN_PASSWORD=devpassword DATA_DIR=/tmp/clips-dev PORT=18090 HOST=127.0.0.1 node server/index.js`
  (ffmpeg on PATH). Front-end files are read from disk on each request; restart for server changes.
- Run `npm test` before committing. Use `node --check` for quick syntax checks.
- Before heavy work (big encodes, many test exports), check that the machine isn't busy.
- Commits: never put a personal email address in commits; use the GitHub noreply address.
- Before making anything public, grep the tree *and history* for personal data (names, hostnames, domains,
  IPs, paths, tokens, emails). History can't be cleaned after a push: use a fresh repo instead.
