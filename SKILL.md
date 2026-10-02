---
name: html-film-to-mp4
description: >-
  Convert an auto-playing, self-contained HTML "film" (a 도해 / mind-map slide reel with
  embedded narration audio — e.g. what the journal-issue-video skill produces) into a real
  MP4 for YouTube. Renders the film in a HEADLESS Chrome (nothing appears on screen),
  rebuilds the narration track from the audio clips embedded in the HTML, and muxes a
  1920x1080 / 30fps video with sound — no screen-recording. Also documents how to publish
  the MP4 to the right YouTube channel. Use when the user wants to turn a narrated HTML film /
  도해 영상 into a video file, "html 영상을 mp4로", "도해 영상 동영상으로", "유튜브 올릴 mp4",
  "필름 html 영상화", or an MP4 "without screen recording".
---

# HTML film → MP4

Turn an auto-playing narrated HTML film into a clean `.mp4` **without screen-recording**.

The films this targets are a single self-contained HTML "player": a dark 16:9 stage that
advances itself with `requestAnimationFrame`, shows timed captions, and narrates each line
from an **embedded** audio clip (`line.a`, a `data:audio/...;base64,...` URI). The player
exposes `SLIDES`, `startShow()` and an `ended` flag on the page — which is all this tool needs.

## Quick start

```bash
node scripts/render_mp4.mjs film_ko.html                 # -> film_ko.mp4
node scripts/render_mp4.mjs film_en.html out.mp4 30      # custom output name / fps
```

Requirements: **Node 18+, Google Chrome, ffmpeg** on PATH. No `npm install` — the script
uses Node's built-in `fetch` and `WebSocket` to drive Chrome over the DevTools protocol.
(Override the browser with `CHROME=/path/to/chrome`.)

## How it works

1. Serves the film over a tiny localhost HTTP server **with `charset=utf-8`** (see the
   charset note below), then opens it in a **headless** Chrome (`--headless=new`).
2. Reads `SLIDES` to build an audio plan: each narration line's on-screen duration (`d`, ms)
   and its embedded clip (`a`). The clip for line *k* starts at the cumulative sum of all
   earlier `d` **+ 200 ms** (the player's caption-reveal delay), so audio lines up with the
   caption that announces it.
3. Captures the film in **real time** via CDP `Page.startScreencast` (the visuals advance on
   wall-clock, so a 2.5-minute film takes ~2.5 minutes), writing JPEG frames with timestamps.
4. ffmpeg assembles the frames into a constant-30fps 1920x1080 H.264 video, rebuilds the
   narration track (`anullsrc` base + one `adelay`+`amix` per clip), and muxes them to MP4.

## Why not screen-record

Screen-recording the film full-screen *seems* simpler but is fragile and invasive:

- It captures **whatever else is on the desktop** — other windows, other Claude sessions,
  notifications — not just the film.
- Any pop-up, alert, or window switch **ruins the take**.
- On a **multi-monitor** machine the film window may not even be the foreground, so the
  recording grabs the wrong screen.

Headless rendering avoids all of that, is reproducible, and never touches the user's screen.

## Charset gotcha (Korean/CJK mojibake)

If the film HTML has **no `<meta charset="utf-8">`** and is served without a `charset`
header, a browser may guess **EUC-KR** and render Korean as `` (U+FFFD). Two safeguards:

- Make sure the film starts with `<!DOCTYPE html>` + `<meta charset="utf-8">`.
- `render_mp4.mjs` serves the file with an explicit `Content-Type: text/html; charset=utf-8`
  header regardless, so it renders correctly even if the meta tag is missing.

## Publishing to YouTube

Uploading is a **manual, signed-in** step — do not try to automate the password.

- Confirm the browser is logged into the **target channel's** Google account
  (`youtube.com/account`). Switching accounts / typing passwords is the user's job.
- The Google profile a browser-automation tool controls can differ from the window the user
  is looking at — if the account is wrong, the login must be done **in the exact window/tab
  the automation controls**, or the automation re-pointed at the window where the user is
  already signed in. (Opening `accounts.google.com/AddSession` in the controlled tab forces
  the login into the right profile.)
- Then: YouTube Studio → Create → Upload → pick the `.mp4`, set title/description (keep the
  ko and en films consistent), audience **"not made for kids"**, and the visibility. A public
  upload is outward-facing and hard to undo — confirm account + visibility before publishing.

## Files

- `scripts/render_mp4.mjs` — the renderer (Node built-ins + Chrome + ffmpeg; no install).

## Notes / limits

- The film must already contain its narration (embedded `line.a` clips). Without them the
  video still renders but is **silent** — add narration first (e.g. the journal-issue-video
  skill's `clova_tts.py`).
- Tune each line's `d` so it is ≥ its clip length, or the next line will cut the clip short
  (the same constraint the player itself has).
- Output is padded/letterboxed to exactly 1920x1080 if the captured frame isn't 16:9.
