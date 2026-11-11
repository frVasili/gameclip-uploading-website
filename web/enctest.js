// Diagnostic page: could this browser/PC encode clips locally (WebCodecs) faster than the server?
import { $, esc, copy, renderHeader, requireUser } from './common.js';

const W = 1920, H = 1080, FPS = 60, BITRATE = 12_000_000, FRAMES = 300, DISTINCT = 30;
const CODECS = [
  { name: 'H.264 High L5.2', codec: 'avc1.640034' },
  { name: 'H.264 High L4.2', codec: 'avc1.64002A' },
  { name: 'HEVC', codec: 'hvc1.1.6.L153.B0' },
  { name: 'AV1', codec: 'av01.0.09M.08' },
  { name: 'VP9', codec: 'vp09.00.41.08' },
];
const HW = ['prefer-hardware', 'prefer-software'];
const modeName = (h) => (h === 'prefer-hardware' ? 'hardware' : 'software');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && (e.message || e.name)) || e);

const rows = []; // for the plain-text summary
let running = false;

// Pre-render DISTINCT noisy, moving frames once. Frame drawing is therefore NOT part of the measured time:
// the timed loop only wraps these canvases in VideoFrames and feeds the encoder, so fps reflects the encoder.
function makeSources() {
  const tile = new ImageData(256, 256);
  for (let i = 0; i < tile.data.length; i += 4) {
    tile.data[i] = Math.random() * 255; tile.data[i + 1] = Math.random() * 255; tile.data[i + 2] = Math.random() * 255; tile.data[i + 3] = 255;
  }
  const tc = new OffscreenCanvas(256, 256); tc.getContext('2d').putImageData(tile, 0, 0);
  const out = [];
  for (let f = 0; f < DISTINCT; f++) {
    const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, `hsl(${(f * 12) % 360},70%,40%)`); grad.addColorStop(1, `hsl(${(f * 12 + 120) % 360},70%,25%)`);
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.55;
    for (let y = -256; y < H; y += 256) for (let x = -256; x < W; x += 256) g.drawImage(tc, x + ((f * 37) % 256), y + ((f * 23) % 256));
    g.globalAlpha = 1;
    for (let k = 0; k < 40; k++) {
      g.fillStyle = `hsl(${(k * 47 + f * 9) % 360},80%,60%)`;
      g.beginPath(); g.arc((k * 197 + f * (20 + k)) % W, (k * 131 + f * (11 + k % 7)) % H, 20 + (k % 5) * 12, 0, 7); g.fill();
    }
    g.fillStyle = '#fff'; g.font = 'bold 64px sans-serif';
    for (let k = 0; k < 6; k++) g.fillText('ENCODER TEST ' + f, (f * 31 + k * 300) % W, 120 + k * 160);
    out.push(c);
  }
  return out;
}

async function speedTest(cfg, sources) {
  let err = null, bytes = 0, chunks = 0;
  const enc = new VideoEncoder({ output: (chunk) => { bytes += chunk.byteLength; chunks++; }, error: (e) => { err = e; } });
  enc.configure(cfg);
  const t0 = performance.now();
  for (let i = 0; i < FRAMES && !err; i++) {
    while (enc.encodeQueueSize > 4 && !err) await sleep(1);
    const frame = new VideoFrame(sources[i % DISTINCT], { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    try { enc.encode(frame, { keyFrame: i % 120 === 0 }); } finally { frame.close(); }
  }
  if (!err) await enc.flush();
  const secs = (performance.now() - t0) / 1000;
  try { enc.close(); } catch { /* already closed after an error */ }
  if (err) throw err;
  if (!chunks) throw new Error('no output produced');
  return { fps: FRAMES / secs, bytes, secs, chunks };
}

const yn = (b) => `<span class="${b ? 'yes' : 'no'}">${b ? 'yes' : 'no'}</span>`;

async function run() {
  if (running) return;
  running = true;
  const btn = $('#run'), prog = $('#progress');
  btn.disabled = true; $('#copy').hidden = true; rows.length = 0;
  $('#out').hidden = false;
  const apis = { VideoEncoder: typeof VideoEncoder, VideoDecoder: typeof VideoDecoder, AudioEncoder: typeof AudioEncoder };
  $('#apis').innerHTML = Object.entries(apis).map(([k, v]) => `<tr><td>${k}</td><td>${yn(v !== 'undefined')}</td></tr>`).join('');
  rows.push('APIs: ' + Object.entries(apis).map(([k, v]) => `${k}=${v !== 'undefined' ? 'yes' : 'no'}`).join(' '));
  $('#enc').innerHTML = ''; $('#dec').innerHTML = '';

  // decoding support (HEVC first: the owner's recordings)
  rows.push('', 'Decoding 1080p60:');
  const decOrder = [CODECS[2], CODECS[0], CODECS[3], CODECS[4]];
  for (const c of decOrder) for (const hw of HW) {
    let ok = false, note = '';
    try {
      if (typeof VideoDecoder === 'undefined') throw new Error('VideoDecoder missing');
      const r = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: W, codedHeight: H, hardwareAcceleration: hw });
      ok = !!r.supported;
    } catch (e) { note = errText(e); }
    $('#dec').insertAdjacentHTML('beforeend', `<tr><td>${esc(c.name)}</td><td>${modeName(hw)}</td><td>${yn(ok)}${note ? ' ' + esc(note) : ''}</td></tr>`);
    rows.push(`  ${c.name} (${c.codec}) ${modeName(hw)}: ${ok ? 'yes' : 'no'}${note ? ' [' + note + ']' : ''}`);
  }

  // encoding support, then a speed test for each supported config
  rows.push('', `Encoding ${W}x${H} @${FPS} fps, ${BITRATE / 1e6} Mbit/s, ${FRAMES} frames:`);
  const todo = [];
  for (const c of CODECS) for (const hw of HW) {
    const cfg = { codec: c.codec, width: W, height: H, bitrate: BITRATE, framerate: FPS, hardwareAcceleration: hw };
    let ok = false, note = '';
    try {
      if (typeof VideoEncoder === 'undefined') throw new Error('VideoEncoder missing');
      const r = await VideoEncoder.isConfigSupported(cfg);
      ok = !!r.supported;
    } catch (e) { note = errText(e); }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(c.name)}</td><td>${modeName(hw)}</td><td>${yn(ok)}</td><td class="num">${ok ? 'waiting' : ''}</td><td class="num"></td><td>${esc(note)}</td>`;
    $('#enc').append(tr);
    const row = { c, hw, ok, note, tr, line: null };
    rows.push(row);
    if (ok) todo.push({ row, cfg });
  }

  let sources = null;
  if (todo.length) {
    prog.textContent = 'Preparing test frames...';
    await sleep(30);
    try { sources = makeSources(); } catch (e) { prog.textContent = 'Could not draw test frames: ' + errText(e); }
  }
  let n = 0;
  for (const { row, cfg } of todo) {
    if (!sources) { row.note = 'no test frames'; row.tr.cells[3].textContent = ''; row.tr.cells[5].textContent = row.note; continue; }
    n++;
    prog.textContent = `Testing ${n} of ${todo.length}: ${row.c.name}, ${modeName(row.hw)}...`;
    row.tr.cells[3].textContent = 'running';
    await sleep(30);
    try {
      const r = await speedTest(cfg, sources);
      row.fps = r.fps; row.bytes = r.bytes;
      row.tr.cells[3].textContent = r.fps.toFixed(1) + ' fps';
      row.tr.cells[4].textContent = (r.bytes / 1048576).toFixed(1) + ' MB';
      row.tr.cells[5].innerHTML = '<span class="yes">ok</span>';
      row.note = 'ok';
    } catch (e) {
      row.note = 'error: ' + errText(e);
      row.tr.cells[3].textContent = '';
      row.tr.cells[5].innerHTML = `<span class="no">${esc(row.note)}</span>`;
    }
  }
  prog.textContent = 'Done.';
  btn.disabled = false; running = false;
  $('#copy').hidden = false;
}

function summary() {
  const lines = ['Encoding test', 'User agent: ' + navigator.userAgent, 'Logical CPU cores: ' + navigator.hardwareConcurrency, ''];
  for (const r of rows) {
    if (typeof r === 'string') { lines.push(r); continue; }
    lines.push(`  ${r.c.name} (${r.c.codec}) ${modeName(r.hw)}: supported ${r.ok ? 'yes' : 'no'}` +
      (r.ok ? `, ${r.fps ? r.fps.toFixed(1) + ' fps, ' + (r.bytes / 1048576).toFixed(1) + ' MB, ' : ''}${r.note}` : r.note ? ` [${r.note}]` : ''));
  }
  lines.push('', 'Server today: about 82 fps for 1080p60 with its graphics card, about 39 fps without.');
  return lines.join('\n');
}

const { user, siteName } = await requireUser();
renderHeader(user, siteName, { title: 'Encoding test' });
$('#run').onclick = run;
$('#copy').onclick = () => copy(summary(), 'Results copied');
