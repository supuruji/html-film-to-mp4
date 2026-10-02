#!/usr/bin/env node
// render_mp4.mjs — render an auto-playing narrated HTML film to an MP4 (headless; no screen recording).
//
// Supports BOTH player styles this project produces:
//   • "film"  (journal-issue-video video_film): per-LINE embedded audio (line.a), SLIDES + startShow() + ended.
//   • "reel"  (논문-도해영상 scene-reel):       per-SCENE audio (__KO_AUDIO/__ZH_AUDIO), SCENES + setPlay() + playing.
// In both cases it captures the page in real time over CDP and rebuilds the narration from the
// clips embedded in the HTML, placing each clip at the moment its scene/line actually appears.
//
// REQUIREMENTS: Node 18+ (built-in fetch + WebSocket; no npm install), Google Chrome, ffmpeg on PATH.
// USAGE:  node render_mp4.mjs <film.html> [out.mp4] [fps]
//   (override the browser with CHROME=/path/to/chrome)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const IN = process.argv[2];
if (!IN) { console.error('usage: node render_mp4.mjs <film.html> [out.mp4] [fps]'); process.exit(1); }
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
const SETUP = `(function(){var st=document.createElement('style');st.textContent='#transport,.transport,.controls,#controls,.hint,.note{display:none!important}#player{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;border-radius:0!important;margin:0!important}html,body{margin:0!important;overflow:hidden!important;background:#060912!important}::-webkit-scrollbar{display:none}';document.head.appendChild(st);return 'ok';})()`;

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

  const ev = async (expr, byVal = true) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: byVal })).result.value;
  const mode = await ev(`((typeof startShow==='function' && typeof SLIDES!=='undefined') ? 'film' : ((typeof SCENES!=='undefined' && typeof setPlay==='function') ? 'reel' : 'unknown'))`);
  console.log('player mode:', mode);
  if (mode === 'unknown') throw new Error('unrecognised player (no SLIDES/startShow or SCENES/setPlay)');

  // ---------- gather embedded audio clips ----------
  const clips = []; // {file, startMs?}  (startMs filled for film mode now; reel mode after capture)
  let totalMsFilm = 0;
  if (mode === 'film') {
    const lines = JSON.parse(await ev(`JSON.stringify(SLIDES.flatMap(function(s){return (s.lines||[]).map(function(l){return {d:l.d,a:l.a||null};});}))`));
    let cum = 0;
    lines.forEach((ln) => {
      if (ln.a && String(ln.a).includes('base64,')) {
        const file = path.join(TMP, `clip_${clips.length}.mp3`);
        fs.writeFileSync(file, Buffer.from(ln.a.split('base64,')[1], 'base64'));
        clips.push({ file, startMs: cum + 200 });
      }
      cum += ln.d;
    });
    totalMsFilm = cum;
  }

  // ---------- real-time screencast capture ----------
  const frames = []; let seq = 0, lastKept = -1, started = false; const MINDT = 1 / FPS - 0.002;
  const relNow = () => (frames.length ? frames[frames.length - 1].rel : 0);
  cdp.on(async (method, params) => {
    if (method !== 'Page.screencastFrame') return;
    try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch { /* ignore */ }
    if (!started) return;
    const ts = params.metadata.timestamp;
    if (lastKept < 0 || (ts - lastKept) >= MINDT) {
      lastKept = ts;
      const name = `f_${String(seq++).padStart(6, '0')}.jpg`;
      fs.writeFileSync(path.join(FRAMEDIR, name), Buffer.from(params.data, 'base64'));
      frames.push({ name, ts, rel: frames.length ? ts - frames[0].ts : 0 });
    }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: 1920, maxHeight: 1080 });
  await sleep(400);
  started = true;

  const sceneStart = {}; // reel mode: idx -> rel seconds
  if (mode === 'film') {
    await ev('startShow()');
    const deadline = Date.now() + totalMsFilm + 6000;
    while (Date.now() < deadline) {
      await sleep(300);
      if (await ev('(typeof ended!=="undefined"&&ended)?1:0')) break;
    }
  } else { // reel
    const nScenes = await ev('SCENES.length');
    await ev('try{setPlay(true);}catch(e){}');
    let sawPlaying = false; const hardStop = Date.now() + 20 * 60 * 1000;
    while (Date.now() < hardStop) {
      await sleep(120);
      const st = JSON.parse(await ev('JSON.stringify({idx:idx,playing:!!playing,n:SCENES.length})'));
      if (sceneStart[st.idx] === undefined) sceneStart[st.idx] = relNow();
      if (st.playing) sawPlaying = true;
      if (sawPlaying && st.idx >= st.n - 1 && !st.playing) { await sleep(300); break; }
    }
    // fetch the per-scene clips for the active language
    const lang = await ev(`(typeof lang!=='undefined'?lang:'ko')`);
    const mapName = (lang === 'zh') ? '__ZH_AUDIO' : '__KO_AUDIO';
    for (let i = 0; i < nScenes; i++) {
      const a = await ev(`(function(){try{return (${mapName}&&${mapName}[${i}])||null;}catch(e){return null;}})()`);
      if (a && String(a).includes('base64,') && sceneStart[i] !== undefined) {
        const file = path.join(TMP, `clip_${i}.mp3`);
        fs.writeFileSync(file, Buffer.from(a.split('base64,')[1], 'base64'));
        clips.push({ file, startMs: Math.round(sceneStart[i] * 1000) });
      }
    }
  }

  await sleep(400);
  await cdp.send('Page.stopScreencast');
  cdp.close(); try { proc.kill(); } catch { /* ignore */ }
  srv.close();
  if (!frames.length) throw new Error('no frames captured');
  console.log(`mode=${mode} frames=${frames.length} dur=${frames[frames.length - 1].rel.toFixed(1)}s clips=${clips.length}`);

  // ---------- assemble silent video ----------
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

  // ---------- rebuild narration + mux ----------
  const totalS = frames[frames.length - 1].rel + 1;
  if (clips.length) {
    const nar = path.join(TMP, 'narration.wav');
    const a = ['-y', '-f', 'lavfi', '-t', totalS.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo'];
    clips.forEach(c => a.push('-i', c.file));
    let fc = ''; const labels = ['[0:a]'];
    clips.forEach((c, k) => { const d = Math.max(0, c.startMs); fc += `[${k + 1}:a]aresample=48000,adelay=${d}|${d}[a${k + 1}];`; labels.push(`[a${k + 1}]`); });
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

function ff(args, cwd) { execFileSync('ffmpeg', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] }); }

main().catch(e => { console.error('ERR', e.message || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
