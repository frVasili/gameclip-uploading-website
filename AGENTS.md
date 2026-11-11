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
- `server/uploads.js`: resumable upload in pieces, several at once, any order (Cloudflare's 100 MB body limit;
  flaky connections; one request through the proxy is slower than the line).
- `server/media.js`: probe, editor previews (silent video, per-track audio, peaks, leveled previews), the size
  planner, the render (x264 two-pass / CRF, or VAAPI), audio graph (leveling, mix, normalization, limiter).
- `server/pages.js`: anonymous watch pages with Open Graph video tags, access log (no IPs).
- `server/store.js`: files under `DATA_DIR`; ids; usage per owner.
- `web/`: `home.html` + `library.js` (sign-in, upload, library), `editor.html` + `editor.js`, `admin.html` +
  `admin.js`, `invite.html` + `invite.js`, shared `common.js` (API calls, header, icons, dialogs `ask`/`confirmDialog`/
  `promptDialog`, popover `menu`, storage `blocks`) and `app.css` (the design system: Aqua, glossy push buttons,
  switches, badges; page rules in `library.css`, `editor.css`, `admin.css`). One self-hosted font, Inter (`inter.woff2`, docs/font-licenses.md). No framework, no build, no external requests (CSP enforces it).
  The look is "Aqua" (old OS X / iTunes): grey gradient toolbar, source-list sidebar that becomes a bottom tab bar
  on phones, white content, glossy push buttons; light only. Motion (end of app.css) is short and physical: alerts pop, notices flip in,
  new items pop into place, deleted ones shrink away; all of it is off under `prefers-reduced-motion`. `/enctest` (`enctest.*`) measures the visitor's browser video encoders.
  UI rules: no grey helper paragraphs (use structure, defaults, labels, `title` tooltips); no `confirm()`/`prompt()`
  (use the dialogs); numbers and timecodes in `.num`.
  Pages are served with `/static/v-<hash>/` asset URLs (index.js `VERSION`, a hash of web/) cached as immutable,
  because CDNs (Cloudflare's default Browser Cache TTL is 4 h) override "no-cache" on scripts. Keep links to
  assets in HTML as `/static/<file>`: the server rewrites them; JS modules import each other relatively.
  `/admin` and `/account` are the same page: the full admin view, or a friend's own account row.
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
  (ffmpeg on PATH). Pages and the asset version are cached at startup: restart after changing anything in web/ or server/.
- Run `npm test` before committing (unit tests + end-to-end test; the e2e upload/export part needs ffmpeg).
  Use `node --check` for quick syntax checks. Before heavy work (big encodes, many test exports), check the machine isn't busy.
- Keep `docs/API.md`, `.env.example` and the README in sync with code changes.
- Delegating to subagents or other models is up to your judgement: hand off bounded work (searches, test runs,
  mechanical edits) to a smaller, cheaper model when it can do it well, and keep hard or context-heavy work yourself.
- Releasing: push to `main` -> GitHub Actions runs the tests, then builds and publishes
  `ghcr.io/frvasili/gameclip-uploading-website:latest` (amd64 + arm64). Deployments that pull `:latest` pick it up.

## Git identity and privacy (strict)
- **Never put a personal email address anywhere in this repo**: not in commits (author or committer), tags, files,
  commit messages, issues or PRs. Commit as `frVasili <64988759+frVasili@users.noreply.github.com>` (GitHub noreply).
  The repo's local git config sets that identity; never override it (`-c user.email=...`, env vars, other configs).
- The only other allowed commit email is `noreply@anthropic.com` (Claude, as author or `Co-Authored-By`).
- Before every push: `git log --format='%ae %ce' origin/main..HEAD | sort -u` must show only those noreply addresses.
  A local `pre-push` hook enforces this when present (it's in `.git/hooks`, not tracked).
- If a personal address ever gets pushed, rewriting history is not enough (GitHub keeps old commits reachable):
  stop and ask the owner; the fix is deleting and recreating the GitHub repo.
- The repo is public. Nothing about a specific deployment goes into tracked files: hostnames, domains, tailnet
  names, IPs, filesystem paths, account ids, tokens, people's names. That belongs in git-ignored `local/`.
  Before pushing docs or examples, grep the diff for such things.
- Commits written by an AI agent end with a `Co-Authored-By:` trailer naming the model. The project is openly
  AI-coded (README "Credits", AUTHORS.md); keep that credit.
