// Editor: preview with live audio mixing, waveform timeline with trim handles, export.
import { api, $, esc, fmtBytes, fmtTime, fmtDuration, parseTime, toast, copy, debounce, sleep, waitJob, jobText, renderHeader, requireUser } from './common.js';

const sid = location.pathname.split('/').pop();
const base = `/api/sources/${sid}`;
const COLORS = ['#7c5cff', '#3ecf8e', '#f5b84b', '#4bb8f5', '#ff5c7a', '#c77dff'];
const MIN_LEN = 0.5;

const video = $('#video'), canvas = $('#timeline'), overlay = $('#overlay'), fadeOverlay = $('#fadeOverlay');
let source, info, edit, presets = {}, gpuDefault = false;
let peaks = [];                 // per track: array of 0-255, 100 per second
let view = { t0: 0, t1: 1 };    // visible timeline range (seconds)
let dirtyWave = true;           // waveform cache needs a redraw

// ======================= audio preview =======================
// The preview video has no sound. Each source track plays from its own <audio>, routed through Web Audio so the
// volume (up to 400%), mute and fades are heard live. The <audio> elements are kept in sync with the video.
const tracks = [];   // { el, gain }
let actx = null, master = null;

function setupAudioElements() {
  for (const a of info.audio) {
    const el = new Audio(`${base}/audio-${a.n}.m4a`);
    el.preload = 'auto';
    tracks.push({ el, gain: null });
  }
}
function ensureAudioContext() {   // must happen inside a user gesture (autoplay rules)
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  actx = new AudioContext();
  master = actx.createGain();
  master.connect(actx.destination);
  for (const t of tracks) {
    t.gain = actx.createGain();
    actx.createMediaElementSource(t.el).connect(t.gain).connect(master);
  }
  applyGains();
}
function applyGains() {
  if (!actx) return;
  tracks.forEach((t, i) => { const e = edit.tracks[i]; t.gain.gain.value = e.muted ? 0 : e.volume; });
}
function syncAudio(play) {
  for (const t of tracks) {
    if (Math.abs(t.el.currentTime - video.currentTime) > 0.03) t.el.currentTime = video.currentTime;
    t.el.playbackRate = video.playbackRate;
    if (play && actx) t.el.play().catch(() => {}); else if (!play) t.el.pause();
  }
}
video.addEventListener('playing', () => syncAudio(true));
video.addEventListener('play', () => syncAudio(true));
video.addEventListener('pause', () => syncAudio(false));
video.addEventListener('waiting', () => tracks.forEach((t) => t.el.pause()));
video.addEventListener('seeked', () => syncAudio(!video.paused));
video.addEventListener('ratechange', () => syncAudio(!video.paused));
setInterval(() => {   // drift correction
  if (video.paused || video.seeking) return;
  for (const t of tracks) if (!t.el.paused && Math.abs(t.el.currentTime - video.currentTime) > 0.08) t.el.currentTime = video.currentTime;
}, 250);

// ======================= playback =======================
let pendingSeek = null;
function seek(t) {   // throttled: dragging a handle would otherwise queue hundreds of seeks
  t = Math.min(Math.max(0, t), info.duration);
  if (video.seeking) { pendingSeek = t; return; }
  video.currentTime = t;
}
video.addEventListener('seeked', () => { if (pendingSeek !== null) { const t = pendingSeek; pendingSeek = null; video.currentTime = t; } });

function togglePlay() {
  ensureAudioContext();
  if (video.paused) {
    if (video.currentTime < edit.start - 0.05 || video.currentTime >= edit.end - 0.05) video.currentTime = edit.start;
    video.play().catch((e) => toast(`Can't play: ${e.message}`, true));
  } else video.pause();
}
video.addEventListener('play', () => { $('#play').textContent = '❚❚ Pause'; });
video.addEventListener('pause', () => { $('#play').textContent = '▶ Play'; });
video.addEventListener('click', togglePlay);
$('#play').onclick = togglePlay;

function fadeFactor(t) {
  let f = 1;
  if (edit.fadeIn > 0) f = Math.min(f, (t - edit.start) / edit.fadeIn);
  if (edit.fadeOut > 0) f = Math.min(f, (edit.end - t) / edit.fadeOut);
  return Math.min(1, Math.max(0, f));
}

function frame() {
  const t = video.currentTime;
  if (!video.paused && t >= edit.end - 0.02) {
    if ($('#loop').checked) video.currentTime = edit.start;
    else { video.pause(); video.currentTime = edit.end; }
  }
  const f = fadeFactor(t);
  if (master) master.gain.value = f;
  fadeOverlay.style.opacity = edit.videoFade ? String(1 - f) : '0';
  $('#time').textContent = `${fmtTime(t)} / ${fmtTime(info.duration)}`;
  // keep the playhead visible while playing zoomed in
  if (!video.paused && !drag && (t > view.t1 || t < view.t0)) { const span = view.t1 - view.t0; setView(t - span * 0.05, t + span * 0.95); }
  draw();
  requestAnimationFrame(frame);
}

// ======================= timeline =======================
const RULER = 22, MARK = 12;
const laneH = () => (info.audio.length <= 1 ? 64 : info.audio.length <= 3 ? 46 : 34);
const waveCanvas = document.createElement('canvas');
let W = 0, H = 0, dpr = 1;

function layout() {
  dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  H = RULER + Math.max(1, info.audio.length) * laneH() + MARK;
  canvas.style.height = `${H}px`;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  waveCanvas.width = canvas.width; waveCanvas.height = canvas.height;
  dirtyWave = true;
}
const xOf = (t) => ((t - view.t0) / (view.t1 - view.t0)) * W;
const tOf = (x) => view.t0 + (x / W) * (view.t1 - view.t0);

function setView(t0, t1) {
  const minSpan = Math.min(1, info.duration), span = Math.min(info.duration, Math.max(minSpan, t1 - t0));
  t0 = Math.min(Math.max(0, t0), info.duration - span);
  view = { t0, t1: t0 + span };
  dirtyWave = true;
}
function zoomAround(t, factor) {
  const span = (view.t1 - view.t0) * factor, r = (t - view.t0) / (view.t1 - view.t0);
  setView(t - span * r, t - span * r + span);
}

function drawWaves() {   // cached: only redrawn when the view, the tracks or the size change
  const c = waveCanvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  // ruler
  c.fillStyle = '#15151e'; c.fillRect(0, 0, W, RULER);
  const span = view.t1 - view.t0;
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => (s / span) * W >= 70) || 3600;
  c.font = '11px system-ui'; c.fillStyle = '#8b8b9e'; c.strokeStyle = '#2a2a38'; c.textBaseline = 'middle';
  for (let t = Math.ceil(view.t0 / step) * step; t <= view.t1; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    c.beginPath(); c.moveTo(x, RULER - 6); c.lineTo(x, H - MARK); c.stroke();
    c.fillText(fmtTime(t, step < 1 ? 1 : 0), x + 3, RULER / 2);
  }
  // lanes
  const lh = laneH();
  if (!info.audio.length) {
    c.fillStyle = '#8b8b9e'; c.fillText('This video has no audio tracks', 10, RULER + lh / 2);
  }
  info.audio.forEach((a, i) => {
    const y0 = RULER + i * lh, mid = y0 + lh / 2, e = edit.tracks[i], p = peaks[i];
    c.fillStyle = i % 2 ? '#13131b' : '#111118'; c.fillRect(0, y0, W, lh);
    if (!p) return;
    c.fillStyle = COLORS[i % COLORS.length];
    c.globalAlpha = e.muted ? 0.18 : 0.9;
    const gainShown = e.muted ? 1 : Math.min(2, e.volume);   // louder tracks draw taller (up to 2x)
    for (let x = 0; x < W; x++) {
      const i0 = Math.max(0, Math.floor(tOf(x) * 100)), i1 = Math.min(p.length, Math.max(i0 + 1, Math.ceil(tOf(x + 1) * 100)));
      let m = 0; for (let k = i0; k < i1; k++) if (p[k] > m) m = p[k];
      const h = Math.min(lh / 2 - 2, (m / 255) * (lh / 2 - 2) * gainShown);
      if (h > 0.3) c.fillRect(x, mid - h, 1, h * 2);
    }
    c.globalAlpha = 1;
    c.fillStyle = '#e6e6eecc'; c.font = '11px system-ui'; c.textBaseline = 'top';
    c.fillText(`${a.title || `Track ${i + 1}`}${e.muted ? ' (muted)' : e.volume !== 1 ? ` ${Math.round(e.volume * 100)}%` : ''}`, 6, y0 + 3);
    c.textBaseline = 'middle';
  });
  dirtyWave = false;
}

function draw() {
  if (!W) return;
  if (dirtyWave) drawWaves();
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.drawImage(waveCanvas, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const xs = xOf(edit.start), xe = xOf(edit.end), bottom = H - MARK;
  // dim what gets cut
  c.fillStyle = 'rgba(0,0,0,.6)';
  if (xs > 0) c.fillRect(0, RULER, Math.min(W, xs), bottom - RULER);
  if (xe < W) c.fillRect(Math.max(0, xe), RULER, W - Math.max(0, xe), bottom - RULER);
  // fades
  c.fillStyle = 'rgba(124,92,255,.18)';
  if (edit.fadeIn > 0) { c.beginPath(); c.moveTo(xs, RULER); c.lineTo(xOf(edit.start + edit.fadeIn), RULER); c.lineTo(xs, bottom); c.fill(); }
  if (edit.fadeOut > 0) { c.beginPath(); c.moveTo(xe, RULER); c.lineTo(xOf(edit.end - edit.fadeOut), RULER); c.lineTo(xe, bottom); c.fill(); }
  // trim handles
  for (const [x, side] of [[xs, 1], [xe, -1]]) {
    if (x < -10 || x > W + 10) continue;
    c.fillStyle = '#7c5cff'; c.fillRect(x - 1, RULER, 2, bottom - RULER);
    c.beginPath(); c.roundRect(side > 0 ? x - 1 : x - 9, 0, 10, RULER, 3); c.fill();
    c.fillStyle = '#fff'; c.fillRect(side > 0 ? x + 2 : x - 5, 6, 2, RULER - 12);
  }
  // thumbnail marker
  const xt = xOf(edit.thumbTime);
  if (xt >= 0 && xt <= W) {
    c.fillStyle = '#f5b84b'; c.beginPath(); c.moveTo(xt, bottom + 1); c.lineTo(xt - 5, H); c.lineTo(xt + 5, H); c.fill();
  }
  // playhead
  const xp = xOf(video.currentTime);
  if (xp >= 0 && xp <= W) {
    c.fillStyle = '#fff'; c.fillRect(Math.round(xp) - 0.5, RULER - 4, 1.5, bottom - RULER + 4);
    c.beginPath(); c.moveTo(xp - 5, RULER - 8); c.lineTo(xp + 5, RULER - 8); c.lineTo(xp, RULER - 2); c.fill();
  }
}

let drag = null;
function hit(x) {
  if (Math.abs(x - xOf(edit.start)) <= 9) return 'start';
  if (Math.abs(x - xOf(edit.end)) <= 9) return 'end';
  return 'seek';
}
const px = (e) => e.clientX - canvas.getBoundingClientRect().left;
canvas.addEventListener('pointerdown', (e) => {
  const x = px(e);
  drag = hit(x);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
  moveDrag(x);
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) moveDrag(px(e));
  else canvas.style.cursor = hit(px(e)) === 'seek' ? 'crosshair' : 'ew-resize';
});
canvas.addEventListener('pointerup', () => { if (drag && drag !== 'seek') changed(); drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });
function moveDrag(x) {
  const t = Math.round(Math.min(Math.max(0, tOf(x)), info.duration) * 1000) / 1000;
  if (drag === 'start') { edit.start = Math.min(t, edit.end - MIN_LEN); seek(edit.start); showTrim(); }
  else if (drag === 'end') { edit.end = Math.max(t, edit.start + MIN_LEN); seek(edit.end); showTrim(); }
  else seek(t);
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const span = view.t1 - view.t0, d = (e.deltaX || e.deltaY) / W * span;
    setView(view.t0 + d, view.t1 + d);
  } else zoomAround(tOf(px(e)), Math.exp(e.deltaY * 0.0015));
}, { passive: false });
$('#zoomIn').onclick = () => zoomAround(video.currentTime, 0.5);
$('#zoomOut').onclick = () => zoomAround(video.currentTime, 2);
$('#zoomFit').onclick = () => setView(0, info.duration);
$('#zoomSel').onclick = () => { const pad = (edit.end - edit.start) * 0.06; setView(edit.start - pad, edit.end + pad); };
new ResizeObserver(() => { if (info) layout(); }).observe(canvas);

// ======================= edit state =======================
function defaultEdit() {
  return { start: 0, end: info.duration, tracks: info.audio.map((a) => ({ n: a.n, volume: 1, muted: false, level: 'off' })),
    fadeIn: 0, fadeOut: 0, videoFade: false, normalize: true, gpu: gpuDefault, title: '', thumbTime: Math.min(1, info.duration / 2),
    preset: 'discord', resolution: 'auto', fps: 'source' };
}
function normalize(e) {
  const d = defaultEdit();
  e = { ...d, ...(e || {}) };
  e.tracks = info.audio.map((a) => ({ ...d.tracks[a.n], ...((e.tracks || []).find((t) => t.n === a.n) || {}) }));
  return e;
}

function showTrim() {
  if (document.activeElement !== $('#start')) $('#start').value = fmtTime(edit.start, 2);
  if (document.activeElement !== $('#end')) $('#end').value = fmtTime(edit.end, 2);
  $('#dur').textContent = fmtTime(edit.end - edit.start, 2);
}

function renderTracks() {
  const box = $('#tracks');
  if (!info.audio.length) { box.innerHTML = '<p class="muted">This video has no audio.</p>'; $('#mixHint').hidden = true; return; }
  $('#mixHint').hidden = info.audio.length < 2;
  const soloed = (i) => edit.tracks.every((t, j) => (j === i ? !t.muted : t.muted));
  box.innerHTML = info.audio.map((a, i) => {
    const e = edit.tracks[i];
    const desc = [a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`, a.language].filter(Boolean).join(' · ');
    return `<div class="track ${e.muted ? 'muted' : ''}">
      <span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>
      <span class="tname" title="${esc(a.title)}">${info.audio.length > 1 && a.title ? `${i + 1}. ` : ''}${esc(a.title || `Track ${i + 1}`)} <span class="muted small">${esc(desc)}</span></span>
      <button class="small ${e.muted ? 'on' : ''}" data-mute="${i}">${e.muted ? 'Muted' : 'Mute'}</button>
      ${info.audio.length > 1 ? `<button class="small ${soloed(i) ? 'on' : ''}" data-solo="${i}">Solo</button>` : '<span></span>'}
      <select class="level" data-level="${i}" title="Even out volume differences inside this track" aria-label="Even out">
        ${[['off', 'Even out: off'], ['light', 'Even out: light'], ['strong', 'Even out: strong']].map(([v, l]) => `<option value="${v}" ${e.level === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input type="range" min="0" max="400" step="5" value="${Math.round(e.volume * 100)}" data-vol="${i}" title="Double-click to reset to 100%" aria-label="Volume">
      <span class="vol" data-volshow="${i}">${levelBusy.has(i) ? '…' : `${Math.round(e.volume * 100)}%`}</span></div>`;
  }).join('');
  renderDupHint();
}
// Checked on the server when the upload was prepared: tracks in the file with exactly the same sound as an
// earlier track (OBS can record one mix to several tracks), and silent tracks.
function renderDupHint() {
  const nums = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : `${xs[0]}`);
  const tracksText = (ns) => `track${ns.length > 1 ? 's' : ''} ${nums(ns.map((n) => n + 1))}`;
  const copies = info.audio.filter((a) => a.sameAs != null), silent = info.audio.filter((a) => a.silent);
  const parts = [];
  for (const orig of new Set(copies.map((a) => a.sameAs))) {
    const same = copies.filter((a) => a.sameAs === orig).map((a) => a.n);
    parts.push(`${tracksText(same)} ${same.length > 1 ? 'are exact copies' : 'is an exact copy'} of ${tracksText([orig])}`);
  }
  if (silent.length && info.audio.length > 1) parts.push(`${tracksText(silent.map((a) => a.n))} ${silent.length > 1 ? 'are' : 'is'} silent`);
  const hint = $('#dupHint');
  hint.hidden = !parts.length;
  if (!parts.length) return;
  const loudCopies = copies.filter((a) => !edit.tracks[a.n].muted);
  const txt = `In the uploaded file itself, ${parts.join('; ')}. ` + (copies.length
    ? 'This usually means the recorder (e.g. OBS: Settings → Output → Recording → Audio Track) saved the same audio to several tracks. Playing copies together just makes it louder.'
    : '');
  hint.innerHTML = `${esc(txt)} ${loudCopies.length ? '<button class="small" id="muteCopies">Mute the copies</button>' : ''}`;
  if (loudCopies.length) $('#muteCopies').onclick = () => { for (const a of copies) edit.tracks[a.n].muted = true; renderTracks(); changed(); };
}
$('#tracks').addEventListener('click', (ev) => {
  const d = ev.target.dataset;
  if (d.mute !== undefined) { const t = edit.tracks[d.mute]; t.muted = !t.muted; }
  else if (d.solo !== undefined) {
    const i = Number(d.solo), already = edit.tracks.every((t, j) => (j === i ? !t.muted : t.muted));
    edit.tracks.forEach((t, j) => { t.muted = already ? false : j !== i; });   // solo again = unmute everything
  } else return;
  renderTracks(); changed();
});
$('#tracks').addEventListener('change', (ev) => {
  const i = ev.target.dataset.level; if (i === undefined) return;
  edit.tracks[i].level = ev.target.value;
  useLevel(Number(i)); changed();
});
$('#tracks').addEventListener('input', (ev) => {
  const i = ev.target.dataset.vol; if (i === undefined) return;
  edit.tracks[i].volume = Number(ev.target.value) / 100;
  ev.target.nextElementSibling.textContent = `${ev.target.value}%`;
  changed();
});
$('#tracks').addEventListener('dblclick', (ev) => {
  const i = ev.target.dataset.vol; if (i === undefined) return;
  edit.tracks[i].volume = 1; renderTracks(); changed();
});

// Leveling can't run in the browser: the server renders a leveled copy of the track and we swap it in.
const levelBusy = new Set();
async function useLevel(i) {
  const t = tracks[i], level = edit.tracks[i].level;
  let url = `${base}/audio-${info.audio[i].n}.m4a`, peaksUrl = `${base}/peaks-${info.audio[i].n}.json`;
  if (level !== 'off') {
    levelBusy.add(i); renderTracks();
    try { ({ url, peaks: peaksUrl } = await api(`${base}/leveled`, { method: 'POST', body: { n: info.audio[i].n, level } })); }
    catch (e) { toast(`Could not preview the leveling: ${e.message}`, true); }
    levelBusy.delete(i); renderTracks();
    if (edit.tracks[i].level !== level) return;   // changed again meanwhile
  }
  api(peaksUrl).then((d) => { if (edit.tracks[i].level === level) { peaks[i] = d.peaks; dirtyWave = true; } }).catch(() => {});
  if (t.el.src.endsWith(url)) return;
  const playing = !video.paused;
  t.el.src = url;
  t.el.addEventListener('loadedmetadata', () => { t.el.currentTime = video.currentTime; if (playing && actx) t.el.play().catch(() => {}); }, { once: true });
}

$('#matchLevels').onclick = async () => {
  const btn = $('#matchLevels'), active = edit.tracks.filter((t) => !t.muted);
  if (active.length < 2) return toast('Needs at least two tracks that are not muted');
  btn.disabled = true; btn.textContent = 'Measuring…';
  try {
    const res = await api(`${base}/loudness`, { method: 'POST', body: { tracks: active.map((t) => ({ n: t.n, level: t.level })) } });
    const ok = res.filter((r) => Number.isFinite(r.lufs));
    if (ok.length < 2) throw new Error('the tracks are silent');
    const target = ok.reduce((a, r) => a + r.lufs, 0) / ok.length;   // meet in the middle: quiet ones up, loud ones down
    for (const r of ok) {
      const t = edit.tracks.find((x) => x.n === r.n);
      t.volume = Math.min(4, Math.max(0.05, Math.round(Math.pow(10, (target - r.lufs) / 20) * 20) / 20));
    }
    renderTracks(); changed();
    toast(`Levels matched (${ok.map((r) => `${info.audio[r.n].title || `Track ${r.n + 1}`} ${Math.round(r.lufs)} LUFS`).join(', ')})`);
  } catch (e) { toast(`Could not measure: ${e.message}`, true); }
  btn.disabled = false; btn.textContent = 'Match track levels';
};

function fillFields() {
  showTrim();
  $('#fadeIn').value = edit.fadeIn; $('#fadeOut').value = edit.fadeOut; $('#videoFade').checked = edit.videoFade;
  $('#normalize').checked = edit.normalize; $('#matchLevels').hidden = info.audio.length < 2;
  $('#gpu').checked = !!edit.gpu;
  $('#title').value = edit.title; $('#preset').value = edit.preset; $('#resolution').value = edit.resolution; $('#fps').value = edit.fps;
  renderTracks();
}

for (const k of ['start', 'end']) {
  $(`#${k}`).addEventListener('change', (ev) => {
    const t = parseTime(ev.target.value);
    if (Number.isFinite(t)) {
      if (k === 'start') edit.start = Math.min(Math.max(0, t), edit.end - MIN_LEN);
      else edit.end = Math.max(Math.min(info.duration, t), edit.start + MIN_LEN);
      seek(edit[k]);
    } else toast('Use a time like 1:23.4 or 83.4', true);
    ev.target.blur(); showTrim(); changed();
  });
  $(`#${k}`).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });
}
$('#resetTrim').onclick = () => { edit.start = 0; edit.end = info.duration; showTrim(); changed(); };
for (const k of ['fadeIn', 'fadeOut']) $(`#${k}`).addEventListener('input', (ev) => { edit[k] = Math.min(10, Math.max(0, Number(ev.target.value) || 0)); changed(); });
$('#videoFade').onchange = (ev) => { edit.videoFade = ev.target.checked; changed(); };
$('#normalize').onchange = (ev) => { edit.normalize = ev.target.checked; changed(); };
$('#gpu').onchange = (ev) => { edit.gpu = ev.target.checked; changed(); };
$('#title').addEventListener('input', (ev) => { edit.title = ev.target.value; changed(); });
for (const k of ['preset', 'resolution', 'fps']) $(`#${k}`).onchange = (ev) => { edit[k] = ev.target.value; changed(); };
$('#setStart').onclick = () => { edit.start = Math.min(video.currentTime, edit.end - MIN_LEN); showTrim(); changed(); };
$('#setEnd').onclick = () => { edit.end = Math.max(video.currentTime, edit.start + MIN_LEN); showTrim(); changed(); };
$('#setThumb').onclick = () => { edit.thumbTime = Math.min(Math.max(video.currentTime, edit.start), edit.end); changed(); toast('Thumbnail set to this frame'); };

// any change: clamp, redraw, re-plan, autosave
function changed() {
  edit.thumbTime = Math.min(Math.max(edit.thumbTime, edit.start), edit.end);
  dirtyWave = true;
  applyGains();
  updatePlan();
  save();
}

const save = debounce(async () => {
  $('#saved').textContent = 'saving…';
  try { await api(base, { method: 'PATCH', body: { edit } }); $('#saved').textContent = 'settings saved'; }
  catch (e) { $('#saved').textContent = `not saved: ${e.message}`; }
}, 800);

let planSeq = 0;
const updatePlan = debounce(async () => {
  const seq = ++planSeq, el = $('#plan');
  try {
    const p = await api(`${base}/plan`, { method: 'POST', body: edit });
    if (seq !== planSeq) return;
    const cap = p.cap ? ` (limit ${fmtBytes(p.cap)})` : '';
    const audio = !info.audio.length ? 'no audio' : !p.audioKbps ? '<span class="bad">all audio muted</span>'
      : `audio ${p.activeTracks.length > 1 ? 'mixed to one track' : 'kept'}${edit.normalize ? ', standard volume' : ''}${p.activeTracks.some((t) => t.level !== 'off') ? ', evened out' : ''}`;
    el.innerHTML = `<b>${p.w}×${p.h} · ${p.fps} fps · ${fmtDuration(p.dur)}</b><br>about ${fmtBytes(p.estBytes)}${cap} · ${audio}
      ${p.mode.kind === '2pass' ? '<br><span class="muted small">Compressed harder to fit the size limit.</span>' : ''}
      ${!p.cap ? '<br><span class="bad small">No size limit: over 250 MB will not embed in Discord.</span>' : ''}`;
  } catch (e) {
    if (seq === planSeq) el.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  }
}, 250);

// ======================= keyboard =======================
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey || !info) return;
  const step = e.shiftKey ? 1 : 1 / (info.fps || 30);
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'arrowleft') { e.preventDefault(); video.pause(); seek(video.currentTime - step); }
  else if (k === 'arrowright') { e.preventDefault(); video.pause(); seek(video.currentTime + step); }
  else if (k === 'home') { e.preventDefault(); seek(edit.start); }
  else if (k === 'end') { e.preventDefault(); seek(edit.end); }
  else if (k === 'i') $('#setStart').click();
  else if (k === 'o') $('#setEnd').click();
  else if (k === 't') $('#setThumb').click();
});

// ======================= export =======================
function clipCard(c, big = false) {
  return `<div class="${big ? 'result' : 'mini'}">
    ${big ? `<b class="ok">Your clip is ready</b>
      <span class="biglink">${esc(c.url)}</span>
      <div class="row"><button class="primary" data-copy="${esc(c.url)}">Copy link</button><a href="${esc(c.url)}" target="_blank" rel="noopener">Open</a>
      <span class="muted small">${fmtBytes(c.size)} · ${c.width}×${c.height}</span></div>
      <div class="hint">Paste it in Discord. The embed can take a few seconds to show; bigger files take longer.</div>
      ${c.hasThumb ? `<img src="/api/clips/${c.id}.jpg?${c.created}" alt="">` : ''}`
    : `${c.hasThumb ? `<img src="/api/clips/${c.id}.jpg" alt="" loading="lazy">` : '<div class="ph"></div>'}
      <div class="t"><div title="${esc(c.title)}">${esc(c.title)}</div>
      <div class="small muted">${fmtDuration(c.duration)} · ${fmtBytes(c.size)}${c.gpu ? ' · GPU' : ''}</div></div>
      <button class="small primary" data-copy="${esc(c.url)}">Copy</button>`}
  </div>`;
}
async function renderExports() {
  const s = await api(base).catch(() => null); if (!s) return;
  const done = s.exports.filter((x) => x.clip);
  $('#exportsPanel').hidden = !done.length;
  $('#exports').innerHTML = done.map((x) => clipCard(x.clip)).join('');
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copy(b.dataset.copy); });

$('#export').onclick = async () => {
  const btn = $('#export'), out = $('#result');
  btn.disabled = true;
  out.innerHTML = '<div class="plan"><div class="row spread"><span id="jobText">starting…</span></div><div class="progress" style="margin-top:6px"><div id="jobBar"></div></div></div>';
  try {
    await api(base, { method: 'PATCH', body: { edit } });
    const job = await api(`${base}/export`, { method: 'POST', body: edit });
    const final = await waitJob(job.id, (j) => {
      $('#jobText').textContent = jobText(j);
      $('#jobBar').style.width = `${Math.round(j.progress * 100)}%`;
    });
    if (final.state === 'error') throw new Error(final.error);
    const clip = await api(`/api/clips/${final.clipId}`);
    out.innerHTML = clipCard(clip, true);
    navigator.clipboard?.writeText(clip.url).then(() => toast('Link copied - paste it in Discord'), () => {});
    renderExports();
  } catch (e) {
    out.innerHTML = `<div class="plan bad">Export failed: ${esc(e.message)}</div>`;
  } finally { btn.disabled = false; }
};

// ======================= start =======================
async function load() {
  const { user, siteName } = await requireUser();
  source = await api(base);
  info = source.info;
  renderHeader(user, siteName, { title: user.admin && source.owner !== user.id ? `${source.name} (${source.ownerName})` : source.name });
  $('#title').placeholder = source.name.replace(/\.[^.]+$/, '');
  while (source.status !== 'ready') {
    if (source.status === 'error') { overlay.innerHTML = `<div class="bad">This video could not be prepared:<br>${esc(source.error)}</div>`; return; }
    const j = source.jobs?.[0];
    overlay.innerHTML = `<div>Getting the video ready for editing…<br><span class="muted">${esc(j ? jobText(j) : '')}</span></div>`;
    await sleep(1500);
    source = await api(base);
  }
  const status = await api('/api/status');
  presets = status.presets;
  $('#gpuWrap').hidden = !status.gpu?.available;
  gpuDefault = !!status.gpu?.default;
  $('#preset').innerHTML = Object.entries(presets).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');

  edit = normalize(source.edit);
  setupAudioElements();
  peaks = await Promise.all(info.audio.map((a) => api(`${base}/peaks-${a.n}.json`).then((d) => d.peaks).catch(() => null)));
  video.addEventListener('loadedmetadata', () => { video.currentTime = Math.max(edit.start, video.currentTime || 0); overlay.remove(); });
  video.addEventListener('error', () => {
    if (!noDirect && video.src.endsWith('/original.mp4')) { noDirect = true; loadVideo().catch(showError); }   // wait for the converted preview
    else showError(new Error('The preview could not be played in this browser.'));
  });
  loadVideo().catch(showError);
  setView(0, info.duration);
  layout();
  fillFields();
  edit.tracks.forEach((t, i) => { if (t.level !== 'off') useLevel(i); });
  updatePlan();
  renderExports();
  requestAnimationFrame(frame);
}
// The recording itself if this browser can play its codec (most can play HEVC from OBS now); else (or if it
// fails to play) the server converts a preview, and the editor waits for it. Uploads browsers all play have
// preview.mp4 from the start (preview absent or 'ready').
let noDirect = false;
const stage = overlay.parentNode;
async function loadVideo() {
  const playsDirect = () => !noDirect && source.direct && source.directFile && video.canPlayType(`video/mp4; codecs="${source.direct}"`) !== '';
  let asked = false;
  while (source.preview && source.preview !== 'ready') {
    if (playsDirect()) { video.src = `${base}/original.mp4`; return; }
    if (source.preview !== 'converting') {   // 'needed', or 'error' from an earlier try: ask (again) once
      if (asked) throw new Error(`This video could not be prepared for this browser: ${source.previewError || 'conversion failed'}`);
      asked = true; source = await api(`${base}/preview`, { method: 'POST' }); continue;
    }
    const j = source.jobs?.find((x) => x.kind === 'preview');
    if (!overlay.isConnected) stage.append(overlay);
    overlay.innerHTML = `<div>Converting the video so this browser can play it…<br><span class="muted">${esc(j ? jobText(j) : '')}</span></div>`;
    await sleep(1500);
    source = await api(base);
  }
  video.src = `${base}/preview.mp4`;
}
function showError(e) {
  if (!overlay.isConnected) stage.append(overlay);
  overlay.innerHTML = `<div class="bad">${esc(e.message)}</div>`;
}
load().catch(showError);

// for troubleshooting from the browser console: clipsDebug()
window.clipsDebug = () => ({ video: video.currentTime, paused: video.paused, ctx: actx?.state,
  tracks: tracks.map((t, i) => ({ time: t.el.currentTime, paused: t.el.paused, gain: t.gain?.gain.value, drift: +(t.el.currentTime - video.currentTime).toFixed(3) })),
  master: master?.gain.value, edit });
