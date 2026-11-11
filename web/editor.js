// Editor: preview with live audio mixing, waveform timeline with trim handles, export.
import { api, $, esc, fmtBytes, fmtTime, fmtDuration, parseTime, toast, copy, debounce, sleep, waitJob, jobText, renderHeader, requireUser, icon } from './common.js';

const sid = location.pathname.split('/').pop();
const base = `/api/sources/${sid}`;
const COLORS = ['#2f7fe0', '#4aa52a', '#e08a12', '#8a52d6', '#d9457a', '#1fa88a'];
const MIN_LEN = 0.5;

const video = $('#video'), canvas = $('#timeline'), overlay = $('#overlay'), fadeOverlay = $('#fadeOverlay');
let source, info, edit, presets = {}, gpuDefault = false;
let peaks = [];                 // per track: array of 0-255, 100 per second
let view = { t0: 0, t1: 1 };    // visible timeline range (seconds)
let dirtyWave = true;           // waveform cache needs a redraw
let rulerLabels = [];           // { x, text } of the ruler's time labels (drawn over the cache so they can dodge the trim handles)
let dirty = true;               // the overlay (handles, playhead, ...) needs a redraw
let lanes = [];                 // indexes of the audio tracks shown as lanes
let showAll = false;            // the user expanded the hidden copies / silent tracks

$('#play').innerHTML = `${icon('play')}<span>Play</span>`;
$('#keysBtn').innerHTML = icon('keyboard');
$('#zoomOut').innerHTML = icon('minus');
$('#zoomIn').innerHTML = icon('plus');

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
video.addEventListener('play', () => { $('#play').innerHTML = `${icon('pause')}<span>Pause</span>`; });
video.addEventListener('pause', () => { $('#play').innerHTML = `${icon('play')}<span>Play</span>`; });
video.addEventListener('click', togglePlay);
$('#play').onclick = togglePlay;

function fadeFactor(t) {
  let f = 1;
  if (edit.fadeIn > 0) f = Math.min(f, (t - edit.start) / edit.fadeIn);
  if (edit.fadeOut > 0) f = Math.min(f, (edit.end - t) / edit.fadeOut);
  return Math.min(1, Math.max(0, f));
}

// One animation frame: keep the fade/loop logic running, but only touch the DOM and the canvas when something changed.
let lastT = -1, shownTime = '', lastF = -1, lastOp = '';
function frame() {
  const t = video.currentTime;
  if (!video.paused && t >= edit.end - 0.02) {
    if ($('#loop').checked) video.currentTime = edit.start;
    else { video.pause(); video.currentTime = edit.end; }
  }
  const f = fadeFactor(t);
  if (f !== lastF) { lastF = f; if (master) master.gain.value = f; }
  const op = edit.videoFade ? String(1 - f) : '0';
  if (op !== lastOp) { lastOp = op; fadeOverlay.style.opacity = op; }
  const ts = fmtTime(t);
  if (ts !== shownTime) { shownTime = ts; $('#timeNow').textContent = ts; }
  // keep the playhead visible while playing zoomed in
  if (!video.paused && !drag && (t > view.t1 || t < view.t0)) { const span = view.t1 - view.t0; setView(t - span * 0.05, t + span * 0.95); }
  if (dirty || dirtyWave || t !== lastT) { lastT = t; dirty = false; draw(); }
  requestAnimationFrame(frame);
}

// ======================= timeline =======================
const RULER = 22, MARK = 12;
const narrowMq = matchMedia('(max-width: 799px)'), coarseMq = matchMedia('(pointer: coarse)');
const laneH = () => (narrowMq.matches ? 44 : lanes.length <= 1 ? 72 : 56);
const HIT = () => (coarseMq.matches ? 18 : 9);
const waveCanvas = document.createElement('canvas');
let W = 0, H = 0, dpr = 1;

function layout() {
  dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  const lh = laneH(), n = Math.max(1, lanes.length);
  H = RULER + n * lh + MARK;
  canvas.style.height = `${H}px`;
  $('#tl').style.setProperty('--lane', `${lh}px`);
  document.documentElement.style.setProperty('--lanes-h', `${n * lh}px`);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  waveCanvas.width = canvas.width; waveCanvas.height = canvas.height;
  dirtyWave = true;
}
const PAD = 12;   // room at both ends so the trim handles are never cut off by the edge
const xOf = (t) => PAD + ((t - view.t0) / (view.t1 - view.t0)) * (W - 2 * PAD);
const tOf = (x) => view.t0 + ((x - PAD) / (W - 2 * PAD)) * (view.t1 - view.t0);

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
  const lh = laneH(), bottom = H - MARK;
  // lanes (drawn first so the grid shows on top)
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  lanes.forEach((_, k) => { c.fillStyle = k % 2 ? '#f6f8fb' : '#fff'; c.fillRect(0, RULER + k * lh, W, lh); });
  // ruler
  { const g = c.createLinearGradient(0, 0, 0, RULER); g.addColorStop(0, '#f7f7f7'); g.addColorStop(1, '#dedede'); c.fillStyle = g; c.fillRect(0, 0, W, RULER); }
  c.fillStyle = '#9a9a9a'; c.fillRect(0, RULER - 1, W, 1);
  const span = view.t1 - view.t0;
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => (s / span) * W >= 70) || 3600;
  c.strokeStyle = 'rgba(0,0,0,.09)'; c.lineWidth = 1;
  rulerLabels = [];   // the labels are drawn in draw(), where the trim handles are known
  for (let t = Math.ceil(view.t0 / step) * step; t <= view.t1; t += step) {
    const x = Math.round(xOf(t)) + 0.5;
    c.beginPath(); c.moveTo(x, RULER - 6); c.lineTo(x, bottom); c.stroke();
    rulerLabels.push({ x, text: fmtTime(t, step < 1 ? 1 : 0) });
  }
  // lane separators and waveforms
  lanes.forEach((_, k) => { c.fillStyle = '#c9ced6'; c.fillRect(0, RULER + (k + 1) * lh - 1, W, 1); });
  if (!info.audio.length) {
    c.fillStyle = '#55585e'; c.font = '13px Inter, sans-serif'; c.fillText('This video has no audio tracks', 12, RULER + lh / 2);
  }
  lanes.forEach((ti, k) => {
    const y0 = RULER + k * lh, mid = y0 + lh / 2, e = edit.tracks[ti], p = peaks[ti];
    if (!p) return;
    c.fillStyle = COLORS[ti % COLORS.length];
    c.globalAlpha = e.muted ? 0.2 : 0.92;
    const gainShown = e.muted ? 1 : Math.min(2, e.volume);   // louder tracks draw taller (up to 2x)
    const amp = lh / 2 - 3;
    for (let x = 0; x < W; x++) {
      if (tOf(x + 1) <= 0 || tOf(x) >= info.duration) continue;   // the padding at both ends
      const i0 = Math.max(0, Math.floor(tOf(x) * 100)), i1 = Math.min(p.length, Math.max(i0 + 1, Math.ceil(tOf(x + 1) * 100)));
      let m = 0; for (let q = i0; q < i1; q++) if (p[q] > m) m = p[q];
      const h = Math.min(amp, (m / 255) * amp * gainShown);
      if (h > 0.3) c.fillRect(x, mid - h, 1, h * 2);
    }
    c.globalAlpha = 1;
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
  // ruler labels, except where a trim handle's grip sits or where they would run off the right edge
  c.font = '500 11px Inter, sans-serif'; c.fillStyle = '#4a4d52'; c.textBaseline = 'middle';
  for (const l of rulerLabels) {
    const w = c.measureText(l.text).width;
    if (l.x + 4 + w > W - 4 || [xs, xe].some((h) => Math.abs(l.x - h) < 26 || (l.x + 4 < h + 12 && l.x + 4 + w > h - 12))) continue;
    c.fillText(l.text, l.x + 4, RULER / 2);
  }
  // dim what gets cut
  c.fillStyle = 'rgba(150,155,165,.55)';
  if (xs > 0) c.fillRect(0, RULER, Math.min(W, xs), bottom - RULER);
  if (xe < W) c.fillRect(Math.max(0, xe), RULER, W - Math.max(0, xe), bottom - RULER);
  // fades
  c.fillStyle = 'rgba(47,132,245,.2)';
  if (edit.fadeIn > 0) { c.beginPath(); c.moveTo(xs, RULER); c.lineTo(xOf(edit.start + edit.fadeIn), RULER); c.lineTo(xs, bottom); c.fill(); }
  if (edit.fadeOut > 0) { c.beginPath(); c.moveTo(xe, RULER); c.lineTo(xOf(edit.end - edit.fadeOut), RULER); c.lineTo(xe, bottom); c.fill(); }
  // trim handles
  for (const [x, side] of [[xs, 1], [xe, -1]]) {
    if (x < -10 || x > W + 10) continue;
    c.save();

    c.fillStyle = '#2f84f5'; c.fillRect(x - 1, RULER, 2, bottom - RULER);
    c.beginPath(); c.roundRect(side > 0 ? x - 1 : x - 9, 0, 10, RULER, 3); c.fill();
    c.restore();
    c.fillStyle = '#fff'; c.fillRect(side > 0 ? x + 2 : x - 5, 6, 2, RULER - 12);
    c.fillRect(side > 0 ? x + 5 : x - 8, 6, 1, RULER - 12);
  }
  // thumbnail marker
  const xt = xOf(edit.thumbTime);
  if (xt >= 0 && xt <= W) {
    c.fillStyle = '#e8a010'; c.beginPath(); c.moveTo(xt, bottom + 1); c.lineTo(xt - 5, H); c.lineTo(xt + 5, H); c.fill();
  }
  // playhead
  const xp = xOf(video.currentTime);
  if (xp >= 0 && xp <= W) {
    c.save();
    c.fillStyle = '#b3261e'; c.fillRect(Math.round(xp) - 0.5, RULER - 4, 1.5, bottom - RULER + 4);
    c.beginPath(); c.moveTo(xp - 5, RULER - 8); c.lineTo(xp + 5, RULER - 8); c.lineTo(xp, RULER - 2); c.fill();
    c.restore();
  }
}

let drag = null;
function hit(x) {
  const z = HIT();
  const ds = Math.abs(x - xOf(edit.start)), de = Math.abs(x - xOf(edit.end));
  if (ds <= z && ds <= de) return 'start';
  if (de <= z) return 'end';
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
new ResizeObserver(() => { if (info && edit) layout(); }).observe(canvas);
document.fonts?.ready.then(() => { dirtyWave = true; });

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
  dirty = true;
}

// Checked on the server when the upload was prepared: tracks with exactly the same sound as an earlier track
// (OBS can record one mix to several tracks), and silent tracks. Those lanes are hidden while they are muted.
const hideable = (i) => info.audio.length > 1 && (info.audio[i].sameAs != null || !!info.audio[i].silent);
const trackName = (i) => info.audio[i].title || `Track ${i + 1}`;
const soloed = (i) => edit.tracks.every((t, j) => (j === i ? !t.muted : t.muted));
const levelBusy = new Set();
const LEVELS = [['off', 'Voices: as recorded'], ['light', 'Even out voices: light'], ['strong', 'Even out voices: strong']];

function refreshLanes() {
  const all = info.audio.map((_, i) => i);
  lanes = all.filter((i) => !(hideable(i) && edit.tracks[i].muted && !showAll));
  if (!lanes.length) lanes = all;
}
function laneHtml(i) {
  const a = info.audio[i], e = edit.tracks[i], multi = info.audio.length > 1, pct = Math.round(e.volume * 100);
  const desc = [a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} ch`, a.language].filter(Boolean).join(' · ');
  const tag = a.sameAs != null ? `copy of ${a.sameAs + 1}` : hideable(i) ? 'silent' : '';
  const nm = trackName(i);
  return `<div class="lane ${e.muted ? 'muted' : ''} ${levelBusy.has(i) ? 'busy' : ''}" style="--c:${COLORS[i % COLORS.length]}">
    <div class="l1"><span class="swatch"></span>
      <span class="tname" title="${esc(`${nm} · ${desc}`)}">${multi && a.title ? `${i + 1}. ` : ''}${esc(nm)}</span>
      ${tag ? `<span class="tag">${tag}</span>` : ''}
      <button class="small tg ${e.muted ? 'on' : ''}" data-mute="${i}" data-k="m${i}" aria-pressed="${e.muted}" title="Mute" aria-label="Mute ${esc(nm)}">M</button>
      ${multi ? `<button class="small tg ${soloed(i) ? 'on' : ''}" data-solo="${i}" data-k="s${i}" aria-pressed="${soloed(i)}" title="Solo" aria-label="Solo ${esc(nm)}">S</button>` : ''}</div>
    <div class="l2">
      <input type="range" min="0" max="400" step="5" value="${pct}" data-vol="${i}" data-k="v${i}" title="Volume (double-click to reset)" aria-label="Volume of ${esc(nm)}">
      <span class="vol num">${pct}%</span>
      <select class="lsel" data-level="${i}" data-k="l${i}" title="Evens out volume differences inside this track" aria-label="Voice leveling of ${esc(nm)}">
        ${LEVELS.map(([v, l]) => `<option value="${v}" ${e.level === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div></div>`;
}
function dupText(items, verb) {
  const copies = items.filter((i) => info.audio[i].sameAs != null), silent = items.filter((i) => info.audio[i].sameAs == null);
  const parts = [];
  for (const orig of new Set(copies.map((i) => info.audio[i].sameAs))) {
    const n = copies.filter((i) => info.audio[i].sameAs === orig).length;
    parts.push(`${n} identical ${n > 1 ? 'copies' : 'copy'} of Track ${orig + 1}`);
  }
  if (silent.length) parts.push(`${silent.length} silent ${silent.length > 1 ? 'tracks' : 'track'}`);
  return `${parts.join(' · ')} ${verb}`;
}
function renderTracks() {
  const focus = document.activeElement?.dataset?.k;
  const prevN = lanes.length;
  refreshLanes();
  const box = $('#laneHeads');
  box.innerHTML = info.audio.length ? lanes.map(laneHtml).join('') : '<div class="lane empty">No audio tracks</div>';
  $('#trackCount').textContent = info.audio.length ? `${info.audio.length} ${info.audio.length > 1 ? 'tracks' : 'track'}` : '';
  $('#matchLevels').hidden = info.audio.length < 2;
  const all = info.audio.map((_, i) => i).filter(hideable), hidden = all.filter((i) => !lanes.includes(i));
  const row = $('#dupRow');
  row.hidden = !(all.length && (hidden.length || showAll));
  if (!row.hidden) {
    row.innerHTML = `<span>${esc(dupText(showAll ? all : hidden, showAll ? 'shown' : 'hidden'))}</span><button class="small" data-dup data-k="dup">${showAll ? 'Hide' : 'Show'}</button>`;
  }
  document.documentElement.style.setProperty('--dup-h', row.hidden ? '0px' : '42px');
  if (focus) document.querySelector(`#tl [data-k="${focus}"]`)?.focus();
  if (W && lanes.length !== prevN) layout();
  dirtyWave = true;
}
$('#dupRow').addEventListener('click', (ev) => { if (ev.target.closest('[data-dup]')) { showAll = !showAll; renderTracks(); } });
$('#laneHeads').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.mute !== undefined) { const t = edit.tracks[d.mute]; t.muted = !t.muted; }
  else if (d.solo !== undefined) {
    const i = Number(d.solo), already = soloed(i);
    edit.tracks.forEach((t, j) => { t.muted = already ? hideable(j) : j !== i; });   // solo again = back to the default mix
  } else return;
  renderTracks(); changed();
});
$('#laneHeads').addEventListener('change', (ev) => {
  const i = ev.target.dataset.level; if (i === undefined) return;
  edit.tracks[i].level = ev.target.value;
  useLevel(Number(i)); changed();
});
$('#laneHeads').addEventListener('input', (ev) => {
  const i = ev.target.dataset.vol; if (i === undefined) return;
  edit.tracks[i].volume = Number(ev.target.value) / 100;
  ev.target.nextElementSibling.textContent = `${ev.target.value}%`;
  changed();
});
$('#laneHeads').addEventListener('dblclick', (ev) => {
  const i = ev.target.dataset.vol; if (i === undefined) return;
  edit.tracks[i].volume = 1; renderTracks(); changed();
});

// Leveling can't run in the browser: the server renders a leveled copy of the track and we swap it in.
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
    toast(`Levels matched (${ok.map((r) => `${trackName(r.n)} ${Math.round(r.lufs)} LUFS`).join(', ')})`);
  } catch (e) { toast(`Could not measure: ${e.message}`, true); }
  btn.disabled = false; btn.textContent = 'Match levels';
};

// Size choices: one radio row per preset.
function renderSizes() {
  $('#sizes').innerHTML = Object.entries(presets).map(([k, p]) =>
    `<label class="size"><input type="radio" name="preset" value="${esc(k)}"><span>${esc(p.label)}</span></label>`).join('');
  syncSizes();
}
function syncSizes() {
  for (const l of document.querySelectorAll('#sizes .size')) {
    const r = l.querySelector('input'); r.checked = r.value === edit.preset; l.classList.toggle('on', r.checked);
  }
}
$('#sizes').addEventListener('change', (ev) => { edit.preset = ev.target.value; syncSizes(); changed(); });

function fillFields() {
  showTrim();
  $('#fadeIn').value = edit.fadeIn; $('#fadeOut').value = edit.fadeOut; $('#videoFade').checked = edit.videoFade;
  $('#normalize').checked = edit.normalize;
  $('#gpu').checked = !!edit.gpu;
  $('#title').value = edit.title; $('#resolution').value = edit.resolution; $('#fps').value = edit.fps;
  syncSizes();
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
for (const k of ['resolution', 'fps']) $(`#${k}`).onchange = (ev) => { edit[k] = ev.target.value; changed(); };
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

let savedTimer = 0;
function showSaved(text, fade) {   // the status text in the toolbar; "saved" fades away after ~2 s
  const el = $('#saved'); clearTimeout(savedTimer);
  el.textContent = text; el.style.opacity = '1';
  if (fade) savedTimer = setTimeout(() => { el.style.opacity = '0'; savedTimer = setTimeout(() => { el.textContent = ''; }, 450); }, 2000);
}
const save = debounce(async () => {
  showSaved('saving…');
  try { await api(base, { method: 'PATCH', body: { edit } }); showSaved('settings saved', true); }
  catch (e) { showSaved(`not saved: ${e.message}`); toast(`Not saved: ${e.message}`, true); }
}, 800);

let planSeq = 0;
const updatePlan = debounce(async () => {
  const seq = ++planSeq, el = $('#plan');
  try {
    const p = await api(`${base}/plan`, { method: 'POST', body: edit });
    if (seq !== planSeq) return;
    const cap = presets.discord?.cap || 250e6;
    const note = info.audio.length && !p.audioKbps ? '<div class="note bad">All audio muted</div>'
      : !p.cap ? `<div class="note warn">Over ${esc(fmtBytes(cap))} will not embed in Discord</div>`
      : p.mode.kind === '2pass' ? '<div class="note soft">Compressed harder to fit</div>' : '';
    el.innerHTML = `<div class="main num">${p.w}×${p.h} · ${p.fps} fps · ${fmtDuration(p.dur)} · ≈ ${fmtBytes(p.estBytes)}</div>${note}`;
  } catch (e) {
    if (seq === planSeq) el.innerHTML = `<div class="note bad">${esc(e.message)}</div>`;
  }
}, 250);

// ======================= shortcuts popover =======================
{
  const btn = $('#keysBtn'), pop = $('#keys');
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = () => { pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); };
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
}

// ======================= keyboard =======================
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey || !info || !edit) return;
  const onButton = e.target.closest?.('button, summary, a');
  const step = e.shiftKey ? 1 : 1 / (info.fps || 30);
  const k = e.key.toLowerCase();
  if (k === ' ') { if (onButton) return; e.preventDefault(); togglePlay(); }
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
  if (big) return `<div class="result"><span class="badge ready">Ready</span>
      <div class="link num">${esc(c.url)}</div>
      <div class="row"><button class="primary" data-copy="${esc(c.url)}">${icon('link')}Copy link</button><a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">${icon('open')}Open</a>
      <span class="meta num">${fmtBytes(c.size)} · ${c.width}×${c.height}</span></div>
      ${c.hasThumb ? `<img src="/api/clips/${c.id}.jpg?${c.created}" alt="Thumbnail">` : ''}</div>`;
  return `<div class="mini">
    ${c.hasThumb ? `<img src="/api/clips/${c.id}.jpg" alt="" loading="lazy">` : '<div class="ph"></div>'}
    <div class="t"><div title="${esc(c.title)}">${esc(c.title)}</div>
    <div class="num">${fmtDuration(c.duration)} · ${fmtBytes(c.size)}</div></div>
    <button class="small primary" data-copy="${esc(c.url)}">Copy</button></div>`;
}
async function renderExports() {
  const s = await api(base).catch(() => null); if (!s) return;
  const done = s.exports.filter((x) => x.clip);
  $('#exportsPanel').hidden = !done.length;
  $('#exports').innerHTML = done.map((x) => clipCard(x.clip)).join('');
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copy(b.dataset.copy); });

$('#export').onclick = async () => {
  const form = $('#exportForm'), out = $('#result');
  form.disabled = true;
  out.innerHTML = '<div class="job"><div class="row"><span class="num" id="jobText">starting…</span></div><div class="progress"><div id="jobBar"></div></div></div>';
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
    out.innerHTML = `<div class="failed">Export failed: ${esc(e.message)}</div>`;
  } finally { form.disabled = false; }
};

// ======================= start =======================
async function load() {
  const { user, siteName } = await requireUser();
  source = await api(base);
  info = source.info;
  renderHeader(user, siteName, { side: false, title: user.admin && source.owner !== user.id ? `${source.name} (${source.ownerName})` : source.name });
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
  if (info.width && info.height) video.style.aspectRatio = `${info.width} / ${info.height}`;
  $('#timeTotal').textContent = fmtTime(info.duration);

  // Re-editing a clip: /edit/<sid>?clip=<id> starts from the settings that clip was made with (if it has them).
  let clipEdit = null, clipTitle = '';
  const cid = new URLSearchParams(location.search).get('clip');
  if (cid && /^[\w-]{1,40}$/.test(cid)) {
    const c = await api(`/api/clips/${cid}`).catch(() => null);
    if (c && c.edit && typeof c.edit === 'object' && c.sourceId === sid) { clipEdit = c.edit; clipTitle = c.title || ''; }
  }
  edit = normalize(clipEdit || source.edit);
  edit.title = clipEdit ? clipTitle || edit.title : source.name.replace(/\.[^.]+$/, '');   // a new clip starts from the recording's name, not the last clip's title
  if (!clipEdit && !source.edit) info.audio.forEach((a, i) => { if (hideable(i)) edit.tracks[i].muted = true; });   // new recording: start without the copies
  renderSizes();
  setupAudioElements();
  peaks = await Promise.all(info.audio.map((a) => api(`${base}/peaks-${a.n}.json`).then((d) => d.peaks).catch(() => null)));
  video.addEventListener('loadedmetadata', () => { video.currentTime = Math.max(edit.start, video.currentTime || 0); overlay.remove(); });
  video.addEventListener('error', () => {
    if (!noDirect && video.src.endsWith('/original.mp4')) { noDirect = true; loadVideo().catch(showError); }   // wait for the converted preview
    else showError(new Error('The preview could not be played in this browser.'));
  });
  loadVideo().catch(showError);
  setView(0, info.duration);
  fillFields();
  layout();
  edit.tracks.forEach((t, i) => { if (t.level !== 'off') useLevel(i); });
  updatePlan();
  renderExports();
  if (clipEdit) toast(`Loaded the settings of “${clipTitle}”`);
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
