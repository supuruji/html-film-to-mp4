#!/usr/bin/env node
// render_mp4.mjs — turn a video_film_*.html (with embedded CLOVA narration) into an MP4.
//
// WHY THIS EXISTS
//   A film is an auto-playing HTML "player"; YouTube needs a video file. The old way was
//   to full-screen the film and SCREEN-RECORD it. That hijacks the user's display, catches
//   whatever else is on screen (other windows / sessions), and breaks on any pop-up — and on
//   a multi-monitor desktop the film window may not even be the foreground. This renders the
//   film in a HEADLESS Chrome instead (nothing touches the user's screen) and rebuilds the
//   narration audio deterministically from the clips already embedded in the HTML, then muxes
//   with ffmpeg. Output: a clean 1920x1080 30fps MP4 with sound.
//
// REQUIREMENTS: Node 18+ (built-in fetch + WebSocket; no npm install), Google Chrome, ffmpeg on PATH.
// USAGE:  node scripts/render_mp4.mjs <video_film_ko.html> [out.mp4] [fps]
//   Run scripts/clova_tts.py first so the film has embedded narration (line.a); without it the
//   video still renders but is silent.
//
// NOTE: the film's visuals advance on wall-clock (requestAnimationFrame), so capture is
// real-time (a 2.5-min film takes ~2.5 min). Each narration clip is placed at its line's
// cumulative start + 200ms (the player's caption-reveal delay), matching the on-screen caption.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const IN = process.argv[2];
if (!IN) { console.error('usage: node render_mp4.mjs <video_film.html> [out.mp4] [fps]'); process.exit(1); }
const OUT = process.argv[3] || IN.replace(/\.html?$/i, '') + '.mp4';
const FPS = parseInt(process.argv[4] || '30', 10);
const FILE = path.resolve(IN);
const DIR = path.dirname(FILE);
const BASENAME = path.basename(FILE);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'filmcap-'));
const FRAMEDIR = path.join(TMP, 'frames'); fs.mkdirSync(FRAMEDIR);

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['chrome'], { encoding: 'utf8' });
  if (w.status === 0) return w.stdout.trim().split(/\r?\n/)[0];
  throw new Error('Chrome not found — set CHROME=/path/to/chrome');
}

// tiny static server that always declares UTF-8 for html (prevents mojibake)
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      const fp = path.join(dir, p);
      if (!fp.startsWith(dir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(fp).toLowerCase();
      const ct = (ext === '.html' || ext === '.htm') ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      fs.createReadStream(fp).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// minimal CDP-over-WebSocket client (page-level connection)
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.waiting = new Map(); this.handlers = []; }
  ready() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(e);
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && this.waiting.has(msg.id)) {
          const { resolve, reject } = this.waiting.get(msg.id); this.waiting.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) { this.handlers.forEach(h => h(msg.method, msg.params)); }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SETUP = `(function(){var st=document.createElement('style');st.textContent='#transport{display:none!important}#player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;border-radius:0!important;margin:0!important}html,body{margin:0!important;overflow:hidden!important;background:#060912!important}::-webkit-scrollbar{display:none}';document.head.appendChild(st);return 'ok';})()`;
const LINEDATA = `JSON.stringify(SLIDES.flatMap(function(s){return (s.lines||[]).map(function(l){return {d:l.d,a:l.a||null};});}))`;

function ff(args, cwd) { execFileSync('ffmpeg', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] }); }

async function main() {
  const chrome = findChrome();
  const { srv, port } = await serve(DIR);
  const url = `http://127.0.0.1:${port}/${encodeURIComponent(BASENAME)}`;
  const udd = path.join(TMP, 'profile');
  const dport = 9000 + Math.floor(Math.random() * 1000);
  const args = ['--headless=new', `--remote-debugging-port=${dport}`, `--user-data-dir=${udd}`,
    '--window-size=1920,1080', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check', url];
  const proc = spawn(chrome, args, { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${dport}/json`)).json();
      const pg = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) wsUrl = pg.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error('could not connect to headless Chrome');

  const cdp = new CDP(wsUrl); await cdp.ready();
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await sleep(1200);
  await cdp.send('Runtime.evaluate', { expression: SETUP });

  // ---- audio plan from embedded clips ----
  const lines = JSON.parse((await cdp.send('Runtime.evaluate', { expression: LINEDATA, returnByValue: true })).result.value);
  let cum = 0; const clips = [];
  lines.forEach((ln) => {
    if (ln.a && ln.a.includes('base64,')) {
      const file = path.join(TMP, `clip_${clips.length}.mp3`);
      fs.writeFileSync(file, Buffer.from(ln.a.split('base64,')[1], 'base64'));
      clips.push({ file, startMs: cum });
    }
    cum += ln.d;
  });
  const totalMs = cum;
  console.log(`lines=${lines.length} clips=${clips.length} total=${(totalMs / 1000).toFixed(1)}s`);

  // ---- real-time screencast capture ----
  const frames = []; let seq = 0, lastKept = -1, started = false; const MINDT = 1 / FPS - 0.002;
  cdp.on(async (method, params) => {
    if (method !== 'Page.screencastFrame') return;
    try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch { /* ignore */ }
    if (!started) return;
    const ts = params.metadata.timestamp;
    if (lastKept < 0 || (ts - lastKept) >= MINDT) {
      lastKept = ts;
      const name = `f_${String(seq++).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(FRAMEDIR, name), Buffer.from(params.data, 'base64'));
      frames.push({ name, ts });
    }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: 1920, maxHeight: 1080 });
  await sleep(400);
  started = true;
  await cdp.send('Runtime.evaluate', { expression: 'startShow()' });
  const deadline = Date.now() + totalMs + 6000;
  while (Date.now() < deadline) {
    await sleep(300);
    const r = await cdp.send('Runtime.evaluate', { expression: '(typeof ended!=="undefined"&&ended)?1:0', returnByValue: true });
    if (r.result.value === 1) break;
  }
  await sleep(800);
  await cdp.send('Page.stopScreencast');
  cdp.close(); try { proc.kill(); } catch { /* ignore */ }
  srv.close();
  if (!frames.length) throw new Error('no frames captured');
  const base = frames[0].ts; frames.forEach(f => (f.rel = f.ts - base));
  console.log(`captured ${frames.length} frames over ${frames[frames.length - 1].rel.toFixed(1)}s`);

  // ---- assemble silent video (per-frame duration from timestamps) ----
  const list = [];
  for (let i = 0; i < frames.length; i++) {
    const dur = i < frames.length - 1 ? frames[i + 1].rel - frames[i].rel : 0.05;
    list.push(`file '${frames[i].name}'`); list.push(`duration ${Math.max(0.001, dur).toFixed(4)}`);
  }
  list.push(`file '${frames[frames.length - 1].name}'`);
  fs.writeFileSync(path.join(FRAMEDIR, 'list.txt'), list.join('\n'));
  const silent = path.join(TMP, 'silent.mp4');
  ff(['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
    '-vf', `fps=${FPS},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#060912,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-an', silent], FRAMEDIR);

  // ---- rebuild narration track, then mux ----
  if (clips.length) {
    const nar = path.join(TMP, 'narration.wav');
    const a = ['-y', '-f', 'lavfi', '-t', ((totalMs / 1000) + 1).toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
    clips.forEach(c => a.push('-i', c.file));
    let fc = ''; const labels = ['[0:a]'];
    clips.forEach((c, k) => { const d = Math.round(c.startMs + 200); fc += `[${k + 1}:a]aresample=48000,adelay=${d}|${d}[a${k + 1}];`; labels.push(`[a${k + 1}]`); });
    fc += labels.join('') + `amix=inputs=${labels.length}:normalize=0:dropout_transition=99999:duration=first[o]`;
    a.push('-filter_complex', fc, '-map', '[o]', '-ac', '2', '-ar', '48000', nar);
    ff(a);
    ff(['-y', '-i', silent, '-i', nar, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT]);
  } else {
    ff(['-y', '-i', silent, '-c', 'copy', '-movflags', '+faststart', OUT]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('wrote', OUT);
}

main().catch(e => { console.error('ERR', e.message || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
