# API

JSON in and out. Errors: `{ "error": "message" }` with a 4xx/5xx status.
- Every `/api/*` route except `login`, `logout` and `me` needs a session cookie (`clips_session`), else 401.
- Every non-GET request needs the header `X-Clips: 1` (CSRF guard), else 403.
- Users see and change only their own uploads and clips; the admin sees everything. Someone else's object
  answers 404, as if it didn't exist.

## Pages (no login needed to load them; their data needs one)
`/` → 302 `/home` · `/home` sign-in + library · `/edit/<sourceId>` editor · `/admin` users & server (admin) ·
`/static/<file>` · `/healthz` · `/<clipId>` public watch page · `/<clipId>.mp4` · `/<clipId>.jpg`

## Sign in
| method | path | |
|---|---|---|
| POST | `/api/login` | `{ password }` → `{ user }` + cookie. 401 wrong, 429 too many tries (per IP, 15 min) |
| POST | `/api/logout` | ends the session |
| GET | `/api/me` | `{ user: { id, name, admin } \| null, siteName }` |
| PATCH | `/api/me` | `{ name }` rename yourself (anyone signed in, the admin too) → `{ user }`. Names are 1-40 characters and unique, ignoring case |

## Objects
**Source** (an uploaded recording):
```
{ id: "16 chars", owner, ownerName, name, size, created, status: "queued"|"preparing"|"ready"|"error", error?,
  info: { duration, width, height, fps, vcodec, pixFmt, container, bitrate,
          audio: [ { n, codec, channels, layout, title, language } ] },
  edit?: Edit, jobs: [Job], exports: [ { clipId, created, state, error?, size?, title, clip: Clip|null } ] }
```
**Edit** (the server clamps and validates it):
```
{ start, end,                                   // seconds into the source
  tracks: [ { n, volume: 0..4, muted, level: "off"|"light"|"strong" } ],   // mixed into one output track
  fadeIn: 0..10, fadeOut: 0..10, videoFade: bool,
  normalize: bool (default true),               // -14 LUFS, one constant gain + -1.5 dBTP limiter
  title, thumbTime,                             // thumbTime in source seconds, within start..end
  preset: "discord"|"medium"|"small"|"upload"|"original",
  resolution: "auto"|"source"|"2160"|"1440"|"1080"|"720"|"480", fps: "source"|"60"|"30",
  gpu: bool }                                   // VAAPI encode if the server has it (default: GPU_DEFAULT)
```
**Job**: `{ id: "10 chars", kind: "prepare"|"render", state: "queued"|"running"|"done"|"error", progress: 0..1, error?, clipId?, sourceId, position }`

**Clip**: `{ id: "12 chars", owner, ownerName, title, created, width, height, fps, duration, size, hasThumb, sourceId, preset, gpu, url, mp4 }`

## Uploads (in pieces)
| method | path | |
|---|---|---|
| POST | `/api/uploads` | `{ name, size }` → 201 `{ id: "20 chars", chunkSize, received: 0, size }`. Checks type, size, disk, quota first |
| GET | `/api/uploads/<id>` | `{ received, size, chunkSize }` (to resume) |
| PUT | `/api/uploads/<id>?offset=N` | raw bytes, at most `chunkSize`, in order → `{ received }`. 409 = wrong offset (GET and continue) |
| POST | `/api/uploads/<id>/complete` | probes the file → 201 Source (then prepared in the background), or 400 if it isn't a usable video |
| DELETE | `/api/uploads/<id>` | cancel. Unfinished uploads untouched for 24 h are deleted |

## Library and editor
| method | path | |
|---|---|---|
| GET | `/api/status` | `{ user: { …, used, quota }, queue, siteName, presets, leveling, loudnessTarget, gpu: { available }, chunkSize, maxUpload, publicBase }`; the admin also gets `diskFree, ffmpeg, gpu details, running, retentionDays` |
| GET | `/api/sources[?owner=<id>]` | Source[] newest first (`owner` filter: admin) |
| GET / PATCH / DELETE | `/api/sources/<sid>` | read; `{ edit?, name? }` autosave; delete the recording (its clips stay online) |
| POST | `/api/sources/<sid>/plan` | Edit → `{ w, h, fps, dur, audioKbps, cap, estBytes, mode, activeTracks, … }` or 400 |
| POST | `/api/sources/<sid>/export` | Edit → 202 Job. 409 not ready, 429 too many waiting exports (friends) |
| POST | `/api/sources/<sid>/leveled` | `{ n, level }` → `{ url, peaks }` leveled preview of a track (made once, cached) |
| POST | `/api/sources/<sid>/loudness` | `{ tracks: [{ n, level }] }` → `[{ n, level, lufs }]` |
| DELETE | `/api/sources/<sid>/exports/<clipId>` | dismiss a failed export (a finished one is deleted with its clip) |
| GET | `/api/sources/<sid>/preview.mp4`, `audio-<n>[-light\|-strong].m4a`, `peaks-<n>[-light\|-strong].json` | editor media |
| GET | `/api/jobs/<id>` | Job |
| GET | `/api/clips[?owner=<id>]` | Clip[] |
| GET / PATCH / DELETE | `/api/clips/<id>` | read; `{ title }`; delete (the link stops working) |
| GET | `/api/clips/<id>.jpg` / `.mp4` | files, for the library |

## Users (admin only)
| method | path | |
|---|---|---|
| GET | `/api/users` | `{ admin: {…usage}, users: [ { id, name, created, quota, disabled, lastLogin, used, uploads, clips } ], defaultQuotaGB }` |
| POST | `/api/users` | `{ name, quotaGB?, password? }` → `{ user, password }` (password generated if not given; shown only here) |
| PATCH | `/api/users/<id>` | `{ name? (rename), quotaGB?, disabled?, resetPassword?: true, password? }` → `{ user, password? }`. Disabling or a new password signs them out |
| DELETE | `/api/users/<id>?data=keep\|delete` | keep: their recordings/clips become the admin's; delete: removes them |

Only one ffmpeg job runs at a time; the rest wait in a queue.
