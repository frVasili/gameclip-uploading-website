# API

JSON in and out. Errors: `{ "error": "message" }` with a 4xx/5xx status.
- Every `/api/*` route except `login`, `logout`, `me` and `invite/*` needs a session cookie (`clips_session`), else 401.
- Every non-GET request needs the header `X-Clips: 1` (CSRF guard), else 403.
- Users see and change only their own uploads and clips; the admin sees everything. Someone else's object
  answers 404, as if it didn't exist.

## Pages (no login needed to load them; their data needs one)
`/` → 302 `/home` · `/home` sign-in + library · `/invite#<token>` accept an invite · `/edit/<sourceId>` editor · `/admin` users & server (admin) ·
`/static/<file>` · `/healthz` · `/<clipId>` public watch page · `/<clipId>.mp4` (`?download`: saved under the clip's title) · `/<clipId>.jpg`

## Sign in
| method | path | |
|---|---|---|
| POST | `/api/login` | `{ name, password }` → `{ user }` + cookie. The name is the display name (case-insensitive; the admin's too). 401 "Wrong name or password." (same answer for an unknown name), 429 too many tries (per client address: 10 wrong tries in 15 min lock that client; a much higher global ceiling only slows mass guessing) with a `Retry-After` header |
| POST | `/api/logout` | ends the session |
| GET | `/api/me` | `{ user: { id, name, admin } \| null, siteName }` |
| PATCH | `/api/me` | `{ name }` rename yourself (anyone signed in, the admin too) → `{ user }`. Names are 1-40 characters and unique, ignoring case. The name is also the sign-in name |
| POST | `/api/me/password` | `{ current, password }` change your own password (friends only; the admin gets 400, its password is `ADMIN_PASSWORD`). Wrong `current` → 400 and counts as a failed login; new password 8-200 characters. Your other sessions end → `{ ok }` |
| POST | `/api/invite/check` | public, `{ token }` → `{ ok, siteName }`, or 404 if invalid, used or expired (rate limited like login) |
| POST | `/api/invite/accept` | public, `{ token, name, password }` → creates the user (quota from the invite), consumes the invite, signs in → `{ user }` + cookie. Same errors as creating a user (name taken, password too short) |

## Objects
**Source** (an uploaded recording):
```
{ id: "16 chars", owner, ownerName, name, size, created, status: "queued"|"preparing"|"ready"|"error", error?,
  preview?: "needed"|"converting"|"ready"|"error", previewError?,   // the editor's H.264 preview.mp4 (absent = ready)
  direct?: "hvc1.1.6.L153.B0",   // codec string: if video.canPlayType() says yes, original.mp4 plays instead
  info: { duration, width, height, fps, vcodec, vprofile?, vtag?, pixFmt, container, bitrate,
          audio: [ { n, codec, channels, layout, title, language, silent?, sameAs? } ] },  // after preparing: silent track, or
                                                   // sameAs = n of an earlier track with exactly the same sound
  edit?: Edit, jobs: [Job], exports: [ { clipId, created, state, error?, size?, title, clip: Clip|null } ] }
```
**Edit** (the server clamps and validates it):
```
{ start, end,                                   // seconds into the source
  tracks: [ { n, volume: 0..4, muted, level: "off"|"light"|"strong" } ],   // mixed into one output track
  fadeIn: 0..10, fadeOut: 0..10, videoFade: bool,
  normalize: bool (default true),               // -14 LUFS, one constant gain + -1.5 dBTP limiter
  title, thumbTime,                             // thumbTime in source seconds, within start..end
  preset: "discord"|"medium"|"small"|"upload"|"original"|"custom",
  customMB: 1..100000 (default 100),           // size cap in MB when preset is "custom"
  resolution: "auto"|"source"|"2160"|"1440"|"1080"|"720"|"480", fps: "source"|"60"|"30",
  gpu: bool }                                   // VAAPI encode if the server has it (default: GPU_DEFAULT)
```
**Job**: `{ id: "10 chars", kind: "prepare"|"preview"|"render", state: "queued"|"running"|"done"|"error", progress: 0..1, error?, clipId?, sourceId, position }`

**Clip**: `{ id: "12 chars", owner, ownerName, title, created, width, height, fps, duration, size, hasThumb, sourceId, sourceGone, preset, gpu, edit?: Edit, url, mp4 }` (sourceGone: the recording was deleted; the clip stays). `edit` is the cleaned settings used to make a finished clip; it is available only through signed-in clip API routes, never public pages or files.

## Uploads (in pieces)
| method | path | |
|---|---|---|
| POST | `/api/uploads` | `{ name, size }` → 201 `{ id: "20 chars", chunkSize, received: 0, size, pieces: [] }`. Checks type, size, disk, quota first; unfinished uploads reserve their full declared size for quota and disk checks. The same `name` + `size` as one of your unfinished uploads returns that upload (with its `received` and `pieces`) to continue |
| GET | `/api/uploads/<id>` | `{ received, size, chunkSize, pieces }` (to resume: `pieces` = numbers of the pieces that arrived) |
| PUT | `/api/uploads/<id>?offset=N` | piece number N / chunkSize: raw bytes, exactly `chunkSize` (less for the last). Any order, several at once; a piece sent again is accepted → `{ received, pieces }` |
| POST | `/api/uploads/<id>/complete` | probes the file → 201 Source (then prepared in the background), or 400 if it isn't a usable video |
| DELETE | `/api/uploads/<id>` | cancel. Unfinished uploads untouched for 24 h are deleted |

## Library and editor
| method | path | |
|---|---|---|
| GET | `/api/status` | `{ user: { …, used, quota }, queue, siteName, presets, leveling, loudnessTarget, gpu: { available }, chunkSize, maxUpload, publicBase }`; the admin also gets `diskFree, ffmpeg, gpu details, running, retentionDays` |
| GET | `/api/sources[?owner=<id>]` | Source[] newest first (`owner` filter: admin) |
| GET / PATCH / DELETE | `/api/sources/<sid>` | read; `{ edit?, name? }` autosave; delete the recording (its clips stay online) |
| POST | `/api/sources/<sid>/plan` | Edit → `{ w, h, fps, dur, audioKbps, cap, estBytes, maxBytes, mode, activeTracks, … }` or 400. `mode.kind` "2pass": lands near `estBytes`; "crf" (quality-based): `estBytes` is a rough guess and `maxBytes` (null if unknown) an upper bound |
| POST | `/api/sources/<sid>/export` | Edit → 202 Job. 409 not ready, 413 when a friend is at quota (delete recordings/clips or ask the admin), 507 when free disk is below the configured reserve, 429 too many waiting exports (friends) |
| POST | `/api/sources/<sid>/preview` | → Source. Starts converting preview.mp4 if `preview` is "needed" or "error" (the editor calls this when the browser can't play the recording) |
| POST | `/api/sources/<sid>/leveled` | `{ n, level }` → `{ url, peaks }` leveled preview of a track (made once, cached) |
| POST | `/api/sources/<sid>/loudness` | `{ tracks: [{ n, level }] }` → `[{ n, level, lufs }]` |
| GET | `/api/sources/<sid>/poster.jpg` | Owner/admin only. Lazily creates and caches a 480px JPEG recording thumbnail; 404 when the recording is not ready or a poster cannot be made |
| DELETE | `/api/sources/<sid>/exports/<clipId>` | dismiss a failed export (a finished one is deleted with its clip) |
| GET | (Range requests to editor and library media are answered in pieces of at most 8 MiB) `/api/sources/<sid>/preview.mp4`, `original.mp4` (if `direct` and the preview isn't made), `audio-<n>[-light\|-strong].m4a`, `peaks-<n>[-light\|-strong].json` | editor media |
| GET | `/api/jobs/<id>` | Job |
| GET | `/api/clips[?owner=<id>]` | Clip[] |
| GET / PATCH / DELETE | `/api/clips/<id>` | read; `{ title }`; delete (the link stops working) |
| GET | `/api/clips/<id>.jpg` / `.mp4` | files, for the library |

## Invite links (admin only)
| method | path | |
|---|---|---|
| GET | `/api/invites` | `{ invites: [ { id, created, expires, quota, note } ], defaultQuotaGB }` (pending only; tokens are never stored) |
| POST | `/api/invites` | `{ quotaGB?, note? }` → `{ invite, url }`; `url` is `<publicBase>/invite#<token>`, shown only once. Works once, expires after 7 days |
| DELETE | `/api/invites/<id>` | revoke |

## Users (admin only)
| method | path | |
|---|---|---|
| GET | `/api/users` | `{ admin: {…usage}, users: [ { id, name, created, quota, disabled, lastLogin, used, uploads, clips } ], defaultQuotaGB }` |
| POST | `/api/users` | `{ name, quotaGB?, password? }` → `{ user, password }` (password generated if not given; shown only here). Passwords need not be unique |
| PATCH | `/api/users/<id>` | `{ name? (rename), quotaGB?, disabled?, resetPassword?: true, password? }` → `{ user, password? }`. Disabling or a new password signs them out |
| DELETE | `/api/users/<id>?data=keep\|delete` | keep: their recordings/clips become the admin's; delete: removes them |

Only one ffmpeg job runs at a time; the rest wait in a queue.
