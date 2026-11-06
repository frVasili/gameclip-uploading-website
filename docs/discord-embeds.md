# How Discord embeds videos from a link (measured November 2026)

Discord publishes no official limit, and the numbers online (50 MiB, ~100 MB) were out of date. So we measured:
1080p60 test videos (60 s, noise so the bitrate is real, size printed on screen) were served by this app and
pasted one link per message into a private Discord channel. Each size was tried as a direct `.mp4` link and as a
watch page with `og:video` tags, each link exactly once (Discord caches a failed embed per URL). The app's
access log showed how Discord fetched them.

| file size | direct .mp4 | watch page (og:video) |
|---|---|---|
| 51 MB, 221 MB, 273 MB | embedded | embedded |
| 290.9 MB | no | - |
| 310.9 MB | embedded | embedded |
| 330.9, 350.7, 376.1, 401.2 MB | no | - |
| 421 MB, 1052 MB | no | no |

What Discord does with a link:
1. Its bot (`Discordbot/2.0`) fetches the page, then the thumbnail, then **downloads the whole video in one
   request, without Range**. It did that even for files it then refused to embed. It gave up partway through a 1 GB file.
2. Only for files it embeds, a second client (its media proxy, user agent "Firefox/38.0") downloads the whole
   file again a few seconds later. From then on viewers stream from Discord, not from your server.

Conclusions used by this app:
- Above ~273 MB embedding is unreliable, so the largest preset is 250 MB (`EMBED_CAP_MB`).
- How long an embed takes to appear = two full downloads + Discord's processing. Smaller files embed faster, so
  the encoder stops at a quality target instead of filling the cap: a 30 s 1080p60 clip is typically 20-45 MB.
- Each embed costs the server about two downloads of the file; after that Discord serves it.
- Discord shows the video at the `og:video:width/height` aspect ratio and hides `og:description` under a player.
- Resolutions above 3840×2160 never embed, so the encoder never outputs more than that.
