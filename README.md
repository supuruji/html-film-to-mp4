# html-film-to-mp4

Turn an auto-playing, narrated **HTML "film"** (a 도해 / mind-map slide reel with embedded
audio — e.g. what the [`journal-issue-video`](https://github.com/supuruji/journal-issue-video)
skill produces) into a real **MP4** for YouTube — **without screen-recording**.

```bash
node scripts/render_mp4.mjs film_ko.html            # -> film_ko.mp4
node scripts/render_mp4.mjs film_en.html out.mp4 30 # custom name / fps
```

Needs only **Node 18+, Google Chrome and ffmpeg** (no `npm install`).

## What it does

- Opens the film in a **headless Chrome** (nothing appears on screen) and captures it in real
  time over the DevTools protocol.
- Rebuilds the narration track from the audio clips **embedded in the HTML**, placing each clip
  at its caption's start time, then muxes a clean **1920×1080 / 30 fps** MP4 with sound.

## Why headless (not screen capture)

Screen-recording catches other windows and sessions, breaks on any pop-up, and on a
multi-monitor desktop can record the wrong screen. Headless rendering is reproducible and
never touches the user's display.

## Charset note

If the film lacks `<meta charset="utf-8">`, a browser may guess EUC-KR and show Korean as
mojibake. The script serves the file as UTF-8 to prevent this; still, author films with a
`<!DOCTYPE html>` + `<meta charset="utf-8">` at the top.

See **SKILL.md** for the full workflow, including publishing to YouTube.
