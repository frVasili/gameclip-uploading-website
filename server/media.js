// ffmpeg/ffprobe work: probing uploads, making the editor's preview files, and rendering finished clips
// to a size Discord will embed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const NICE = String(config.encodeNice);       // share the machine: encodes run at low priority
const THREADS = String(config.encodeThreads);

// Uploaded files are untrusted. ffmpeg will happily follow playlists (HLS, concat, ...) that point at other
// files, which can leak server files into a "video". So every read of an upload only allows plain local
// files and real video containers.
const DEMUXERS = 'mov,mp4,m4a,matroska,webm,avi,flv,mpegts,asf';
const SAFE = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS];
const SAFE_FORMAT = /^(mov|mp4|m4a|3gp|3g2|mj2|matroska|webm|avi|flv|mpegts|asf)(,|$)/;

// Size presets. Discord embeds were tested on 2026-11-05: every file up to 273 MB embedded, 290-401 MB were
// hit or miss, 421 MB+ never. 250 MB keeps a margin. Smaller files also embed faster: Discord downloads the
// whole file (twice) before it shows the player.
export const PRESETS = {
  discord: { label: `Discord · ${config.embedCapMB} MB`, cap: config.embedCapMB * 1e6, audioKbps: 160 },
  medium: { label: 'Fast embed · 100 MB', cap: 100e6, audioKbps: 160 },
  small: { label: 'Small · 50 MB', cap: 50e6, audioKbps: 128 },
  upload: { label: 'Free Discord upload · 10 MB', cap: 10e6, audioKbps: 96 },
  original: { label: 'Best quality · no size limit', cap: null, audioKbps: 192 },
  custom: { label: 'Custom', cap: null, audioKbps: 160, custom: true },   // cap comes from edit.customMB
};
export const CUSTOM_MB = { min: 1, max: 100000, def: 100 };
// The preset with its cap filled in (custom: the size the user typed; audio gets thinner for small files).
export function presetFor(edit) {
  const p = PRESETS[edit.preset] || PRESETS.discord;
  if (!p.custom) return p;
  const mb = Math.min(CUSTOM_MB.max, Math.max(CUSTOM_MB.min, Number(edit.customMB) || CUSTOM_MB.def));
  const cap = mb * 1e6;
  return { ...p, label: `Custom · ${mb} MB`, cap, audioKbps: cap <= 10e6 ? 96 : cap <= 50e6 ? 128 : 160 };
}

// Video bitrate that already looks very good for game footage; we never go above it even when the cap
// would allow more, so typical clips stay small and embed quickly. 12 Mbit/s at 1080p60, scaled by pixel rate.
export function qualityCeilingKbps(w, h, fps) {
  return Math.round(12000 * Math.pow((w * h * fps) / (1920 * 1080 * 60), 0.75));
}

// "Even out voices" per track. Measured 2026-11-05 on a test conversation (3 s turns, one speaker 20 dB
// quieter): light closes the gap to ~13 dB, strong to ~1 dB. A slower window (10 s) did not help at all, and
// ffmpeg's speechnorm did not either. Strong reacts fast, so it also squashes loud game moments a bit.
export const LEVELING = {
  light: 'dynaudnorm=f=200:g=15:p=0.9:m=10',
  strong: 'dynaudnorm=f=150:g=11:p=0.9:m=20,acompressor=threshold=0.125:ratio=3:attack=10:release=250',
};
// Whole-clip loudness target: -14 LUFS integrated (YouTube/Spotify level), true peak -1.5 dBTP.
export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 };
const loudnormArgs = `I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
export const normGain = (measuredI) => Math.max(-30, Math.min(24, LOUDNESS.I - measuredI)); // dB, capped

const trackPrep = 'aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
const levelFilter = (level) => (LEVELING[level] ? `,${LEVELING[level]}` : '');

// loudnorm's analysis prints a JSON block at the end of stderr
function parseLoudnorm(stderr) {
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(stderr);
  if (!m) throw new Error('loudness analysis printed no result');
  const j = JSON.parse(m[0]);
  const num = (k) => Number(j[k]);
  return { I: num('input_i'), TP: num('input_tp'), LRA: num('input_lra'), thresh: num('input_thresh'), offset: num('target_offset') };
}

// Integrated loudness (LUFS) of one source track, optionally after leveling. -Infinity for silence.
export async function measureTrack(src, n, level = 'off') {
  const err = await run(FFMPEG, ['-hide_banner', '-nostdin', '-nostats', ...SAFE, '-i', src, '-map', `0:a:${n}`, '-vn', '-sn',
    '-af', `${trackPrep}${levelFilter(level)},loudnorm=${loudnormArgs}:print_format=json`, '-f', 'null', '-'], { stderr: true });
  return parseLoudnorm(err).I;
}

// Editor preview of a leveled track (the browser can't run dynaudnorm), cached next to the plain one.
export async function makeLeveledPreview(src, n, level, outFile) {
  if (!LEVELING[level]) throw new Error('unknown leveling');
  const tmp = `${outFile}.tmp.m4a`;
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...SAFE, '-i', src, '-map', `0:a:${n}`, '-vn', '-sn',
    '-af', `${trackPrep}${levelFilter(level)}`, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
  writePeaks(await pcmOf(tmp, '0:a:0'), outFile.replace(/^(.*)audio-(\d+-\w+)\.m4a$/, '$1peaks-$2.json'));
  fs.renameSync(tmp, outFile);
}

// A small private library poster. Like every read of an upload, this keeps ffmpeg on the safe protocols/demuxers.
export async function makePoster(src, at, outFile) {
  const tmp = `${outFile}.tmp.jpg`;
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...SAFE, '-ss', String(at), '-i', src, '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=480:-2', '-q:v', '4', tmp]);
  fs.renameSync(tmp, outFile);
}

function run(bin, args, { duration, onProgress, nice = true, capture = false, stderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const full = nice ? ['-n', NICE, bin, ...args] : args;
    const child = spawn(nice ? 'nice' : bin, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0), err = '', buf = '';
    child.stdout.on('data', (d) => {
      if (capture) { out = Buffer.concat([out, d]); return; }
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stderr ? err : out) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)));
  });
}

const parseRate = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : a || 0; };

export async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', ...SAFE, '-print_format', 'json', '-show_format', '-show_streams', file], { nice: false, capture: true });
  const j = JSON.parse(out.toString('utf8'));
  if (!SAFE_FORMAT.test(j.format?.format_name || '')) throw new Error(`unsupported container (${j.format?.format_name || 'unknown'})`);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Error('no video stream found');
  let width = v.width, height = v.height;
  const rot = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  const duration = Number(j.format?.duration || v.duration || 0);
  if (!(duration > 0)) throw new Error('could not read the video duration');
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s, n) => ({
    n, codec: s.codec_name, channels: s.channels, layout: s.channel_layout,
    title: s.tags?.title || s.tags?.handler_name?.replace(/^(Sound|Audio)Handler$/i, '') || '',
    language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : '',
  }));
  return {
    duration, width, height, fps: Math.round(parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30),
    vcodec: v.codec_name, vprofile: v.profile || '', vtag: v.codec_tag_string || '', pixFmt: v.pix_fmt, container: j.format?.format_name, bitrate: Number(j.format?.bit_rate || 0),
    audio,
  };
}

// Editor files, made right after an upload: each audio track separately (copied as is when browsers can play
// it, which is quick), waveform peaks, and a way to show the video:
//  - H.264 that every browser plays: copied into preview.mp4, done.
//  - Anything else (e.g. HEVC from OBS): the editor shows the recording itself to browsers that can play its
//    codec (most can play HEVC now): the source file when it is an MP4/MOV, else a copy of its video stream in
//    original.mp4. Other browsers ask for convertPreview(), which makes a 720p H.264 preview.mp4.
// Returns { audio: [{ n, silent, sameAs }], preview: 'ready'|'needed', direct?, directFile? } where sameAs is
// the n of an earlier track with exactly the same decoded sound (OBS can write the same mix to several tracks)
// and direct is the codec string the browser checks (canPlayType) before playing directFile.
export async function prepare(src, dir, info, onProgress = () => {}) {
  const playable = isPlayable(info);
  const direct = playable ? null : directCodec(info);
  const asIs = direct && /(^|,)(mov|mp4)(,|$)/.test(info.container || '') && (info.vcodec !== 'hevc' || info.vtag === 'hvc1');
  const pcm = (n) => path.join(dir, `pcm-${n}.tmp`);
  const head = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
  const prog = { v: playable || (direct && !asIs) ? 0 : 1, a: info.audio.length ? 0 : 1 };
  const report = () => onProgress(Math.min(prog.v, prog.a) * 0.97);
  const t0 = Date.now(), took = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

  const video = async () => {
    if (prog.v === 1) return asIs ? 'video: the recording itself' : 'video: preview to convert';
    const out = playable ? 'preview.mp4' : 'original.mp4';
    await run(FFMPEG, [...head, ...SAFE, '-i', src, '-map', '0:v:0', '-c:v', 'copy', ...(info.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      '-an', '-sn', '-dn', ...(playable ? ['-movflags', '+faststart'] : []), path.join(dir, out)],
    { duration: info.duration, onProgress: (f) => { prog.v = f; report(); } });
    return `video copied in ${took()}`;
  };
  const audio = async () => {
    if (!info.audio.length) return 'no audio';
    const outs = [];
    for (const a of info.audio) {
      const copy = a.codec === 'aac' && a.channels <= 2;   // the browser plays it as it is
      outs.push('-map', `0:a:${a.n}`, ...(copy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']), '-movflags', '+faststart', path.join(dir, `audio-${a.n}.m4a`));
      outs.push('-map', `0:a:${a.n}`, '-ac', '1', '-ar', '8000', '-f', 's16le', pcm(a.n));   // for the waveform
    }
    await run(FFMPEG, [...head, ...SAFE, '-i', src, '-vn', '-sn', '-dn', ...outs], { duration: info.duration, onProgress: (f) => { prog.a = f; report(); } });
    return `audio in ${took()}`;
  };

  try {
    const times = await Promise.all([video(), audio()]);
    console.log(`prepared ${path.basename(dir)}: ${Math.round(info.duration)} s of ${info.vcodec} ${info.width}x${info.height}, ${info.audio.length} audio track(s) in ${took()}: ${times.join(', ')}`);

    const seen = new Map();   // hash of the decoded sound -> first track with it
    const facts = info.audio.map((a) => {
      const buf = fs.readFileSync(pcm(a.n));
      const silent = maxOf(writePeaks(buf, path.join(dir, `peaks-${a.n}.json`))) <= 3;   // nothing above about -70 dBFS
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      const sameAs = !silent && seen.has(hash) ? seen.get(hash) : null;
      if (!seen.has(hash)) seen.set(hash, a.n);
      return { n: a.n, silent, sameAs };
    });
    onProgress(1);
    return { audio: facts, preview: playable ? 'ready' : 'needed', ...(direct ? { direct, directFile: asIs ? path.basename(src) : 'original.mp4' } : {}) };
  } finally {
    for (const a of info.audio) fs.rmSync(pcm(a.n), { force: true });
  }
}
export const isPlayable = (info) => info.vcodec === 'h264' && info.pixFmt === 'yuv420p' && info.height <= 1440;

// The codec string a browser needs to say it can play the recording itself (video.canPlayType), or null
// when the codec can't go in an MP4 for browsers at all.
export function directCodec(info) {
  const deep = /10|12/.test(info.pixFmt || '');
  if (info.vcodec === 'hevc') return /10/.test(info.vprofile) || deep ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L153.B0';
  if (info.vcodec === 'h264') return 'avc1.640033';
  if (info.vcodec === 'av1') return deep ? 'av01.0.12M.10' : 'av01.0.12M.08';
  if (info.vcodec === 'vp9') return deep ? 'vp09.02.51.10' : 'vp09.00.51.08';
  return null;
}

// The 720p H.264 preview for videos browsers can't all play, when an editor asks for it; the GPU does
// decode, scaling and encoding when there is one (PREVIEW_HW). Returns a line for the log.
export async function convertPreview(src, dir, info, onProgress = () => {}) {
  const outH = even(Math.min(720, info.height)), outW = even(outH * info.width / info.height);
  const make = (mode) => {
    const hw = mode === 'gpu' ? ['-init_hw_device', `vaapi=va:${gpu.device}`, '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi']
      : mode === 'hybrid' ? ['-hwaccel', 'vaapi', '-hwaccel_device', gpu.device] : [];
    const v = mode === 'gpu' ? ['-vf', `scale_vaapi=w=${outW}:h=${outH}:format=nv12`, '-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '26', '-g', '30']
      : ['-vf', `scale=${outW}:${outH}:flags=bicubic,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '30', '-threads', THREADS];
    return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...hw, ...SAFE, '-i', src, '-map', '0:v:0', ...v,
      '-an', '-sn', '-dn', '-movflags', '+faststart', path.join(dir, 'preview.tmp.mp4')], { duration: info.duration, onProgress });
  };
  if (config.previewHw !== 'off') await recheckGpu();
  const t0 = Date.now();
  let mode = gpu.available && config.previewHw !== 'off' ? (config.previewHw === 'full' ? 'gpu' : 'hybrid') : 'cpu';
  try { await make(mode); } catch (e) {
    if (mode === 'cpu') throw e;
    console.error(`GPU preview (${mode}) failed, using the CPU:`, e.message);   // e.g. a codec this GPU can't decode
    mode = 'cpu'; await make(mode);
  }
  fs.renameSync(path.join(dir, 'preview.tmp.mp4'), path.join(dir, 'preview.mp4'));   // never a half-written preview
  fs.rmSync(path.join(dir, 'original.mp4'), { force: true });   // not needed any more
  onProgress(1);
  return `preview of ${path.basename(dir)}: ${Math.round(info.duration)} s converted in ${((Date.now() - t0) / 1000).toFixed(1)} s (${mode})`;
}
// largest value without spreading (a long recording has millions of peaks)
export const maxOf = (xs) => { let m = 0; for (const x of xs) if (x > m) m = x; return m; };

// Waveform for the editor: 100 peaks per second, 0-255, from 8 kHz mono 16-bit PCM. Returns the peaks.
function writePeaks(pcm, outFile) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = 80, peaks = new Array(Math.ceil(samples.length / per));
  for (let i = 0; i < peaks.length; i++) {
    let max = 0;
    for (let j = i * per, e = Math.min(samples.length, j + per); j < e; j++) { const v = Math.abs(samples[j]); if (v > max) max = v; }
    peaks[i] = Math.round(Math.sqrt(max / 32768) * 255); // sqrt so quiet audio is still visible
  }
  fs.writeFileSync(outFile, JSON.stringify({ rate: 100, peaks }));
  return peaks;
}
const pcmOf = (src, map) => run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', ...SAFE, '-i', src, '-map', map, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { capture: true });

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

// Picks output size/fps/bitrate. Exported for tests and for the editor's size estimate.
export function plan(info, edit) {
  const preset = presetFor(edit);
  const dur = Math.max(0.1, edit.end - edit.start);
  const activeTracks = (edit.tracks || []).filter((t) => !t.muted && t.volume > 0 && info.audio[t.n]);
  const audioKbps = activeTracks.length ? preset.audioKbps : 0;
  const budget = preset.cap ? (preset.cap * 0.96 * 8) / dur / 1000 - audioKbps : Infinity; // video kbps
  if (budget < 150) throw new Error(`a ${dur.toFixed(0)} s clip is too long for "${preset.label}"; trim it or pick a bigger size`);

  const srcFps = Math.min(60, info.fps || 30);
  const aspect = info.width / info.height;
  let maxH = info.height;
  if (maxH > 2160) maxH = 2160;                         // Discord refuses anything above 3840x2160
  if (maxH * aspect > 3840) maxH = Math.floor(3840 / aspect);
  const want = { source: maxH, 2160: 2160, 1440: 1440, 1080: 1080, 720: 720, 480: 480 }[edit.resolution];
  const fpsWant = edit.fps === '30' ? 30 : edit.fps === '60' ? 60 : null;

  const choose = (h, f) => ({ h: even(h), w: even(h * aspect), fps: f });
  // The source's own video bitrate (audio assumed ~128 kbps per track). It says how easy the content is: a
  // lecture that looks fine at 4K on 2 Mbit/s needs far fewer bits per pixel than fast game footage.
  const srcVideoKbps = info.bitrate > 0 && info.width && info.height ? info.bitrate / 1000 - 128 * Math.max(1, info.audio.length) : 0;
  // bits the source spent on a picture this size (bitrate scales with pixel rate^0.75)
  const sourceNeed = (c) => srcVideoKbps > 0 ? srcVideoKbps * Math.pow((c.w * c.h * c.fps) / (info.width * info.height * srcFps), 0.75) : Infinity;
  let out;
  if (want) out = choose(Math.min(want, maxH), Math.min(fpsWant || srcFps, srcFps));
  else {
    // auto: the biggest size that still gets enough bits per pixel to look clean
    const heights = [...new Set([maxH, 1440, 1080, 720, 540, 480, 360].filter((h) => h <= maxH))].sort((a, b) => b - a);
    const fpsList = fpsWant ? [Math.min(fpsWant, srcFps)] : [...new Set([srcFps, Math.min(30, srcFps)])];
    outer: for (const f of fpsList) {
      for (const h of heights) {
        const c = choose(h, f);
        // enough bits per pixel for game footage, or at least what the source itself used at this size
        if ((budget * 1000) / (c.w * c.h * f) >= 0.045 || budget >= sourceNeed(c)) { out = c; break outer; }
      }
    }
    if (!out) out = choose(Math.min(360, maxH), Math.min(30, srcFps));
  }
  // Never spend more bits than the source had: re-encoding a small, low-bitrate video must not make it bigger.
  // (Not scaled with the picture: a 4K recording shrunk to 540p still deserves the bits the size allows.)
  // Source audio is assumed to be ~128 kbps per track.
  const srcKbps = srcVideoKbps > 0 ? Math.max(300, srcVideoKbps) : Infinity;
  const ceiling = Math.round(Math.min(qualityCeilingKbps(out.w, out.h, out.fps), srcKbps));
  let mode;
  if (!preset.cap) mode = { kind: 'crf', crf: 18, ...(Number.isFinite(srcKbps) ? { maxrate: Math.round(srcKbps) } : {}) };
  else if (ceiling <= budget) mode = { kind: 'crf', crf: 20, maxrate: Math.round(Math.min(ceiling * 1.6, budget, srcKbps)) };
  else mode = { kind: '2pass', kbps: Math.round(budget) };
  // rough: CRF usually lands well under the ceiling on game footage; 2-pass hits its target
  const vEst = mode.kind === '2pass' ? budget : Math.min(ceiling, budget) * 0.7;
  const estBytes = (vEst + audioKbps) * 125 * dur;
  return { preset: edit.preset in PRESETS ? edit.preset : 'discord', cap: preset.cap, dur, ...out, audioKbps, activeTracks, budget, ceiling, mode, estBytes: Math.round(estBytes) };
}

// gpu: false (all on the CPU), 'upload' (CPU filters, frames go to the GPU encoder) or 'full' (frames stay on the
// GPU from decoding to encoding; no video fades then, they only exist as CPU filters)
export function filters(info, edit, p, loud = null, gpu = false) {
  const vf = [];
  if (gpu === 'full') vf.push(`scale_vaapi=w=${p.w}:h=${p.h}:format=nv12`);
  else if (p.w !== info.width || p.h !== info.height) vf.push(`scale=${p.w}:${p.h}:flags=lanczos`);
  if (p.fps < (info.fps || 30) - 0.5) vf.push(`fps=${p.fps}`);
  const fi = Math.max(0, Number(edit.fadeIn) || 0), fo = Math.max(0, Number(edit.fadeOut) || 0);
  if (edit.videoFade && fi) vf.push(`fade=t=in:st=0:d=${fi}`);
  if (edit.videoFade && fo) vf.push(`fade=t=out:st=${Math.max(0, p.dur - fo).toFixed(3)}:d=${fo}`);
  if (gpu !== 'full') vf.push(gpu ? 'format=nv12,hwupload' : 'format=yuv420p');
  const parts = [`[0:v:0]${vf.join(',')}[v]`];
  if (p.activeTracks.length) {
    const labels = p.activeTracks.map((t, i) => {
      const vol = Math.min(4, Math.max(0, Number(t.volume)));
      parts.push(`[0:a:${t.n}]${trackPrep}${levelFilter(t.level)},volume=${vol.toFixed(3)}[a${i}]`);
      return `[a${i}]`;
    });
    let chain = labels.length > 1 ? `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest` : `${labels[0]}anull`;
    if (loud === 'measure') return `${parts.slice(1).join(';')};${chain},loudnorm=${loudnormArgs}:print_format=json[a]`;
    // one constant gain to the target loudness. (Not loudnorm's own second pass: it silently switches to
    // dynamic compression whenever the gain would push peaks over the limit, which changed the balance.)
    if (loud) chain += `,volume=${normGain(loud.I).toFixed(2)}dB`;
    if (fi) chain += `,afade=t=in:st=0:d=${fi}`;
    if (fo) chain += `,afade=t=out:st=${Math.max(0, p.dur - fo).toFixed(3)}:d=${fo}`;
    // peak limiter: catches what the gain pushed over the top (true-peak target when normalized)
    chain += `,alimiter=limit=${loud ? Math.pow(10, LOUDNESS.TP / 20).toFixed(3) : '0.97'}:level=false:latency=true`;
    parts.push(`${chain}[a]`);
  }
  return parts.join(';');
}

// Renders the clip. onProgress(0..1). Returns { bytes, plan }.
// Hardware encoding (VAAPI). Checked once at startup with a tiny test encode.
export const gpu = { device: config.vaapiDevice, available: false, error: config.vaapiDevice ? 'not checked yet' : 'not configured (VAAPI_DEVICE)' };
// The test encode sometimes fails right after the container starts, so: a few tries at startup, and when it's
// still off, another check before a job that could use it (at most every 10 minutes).
export async function detectGpu(tries = 3) {
  for (let i = 0; i < tries; i++) {
    await testGpu();
    if (gpu.available || !config.vaapiDevice) break;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 3000));
  }
  return gpu;
}
let lastGpuCheck = 0;
async function recheckGpu() {
  if (gpu.available || !config.vaapiDevice || Date.now() - lastGpuCheck < 600e3) return;
  await detectGpu(1);
  if (gpu.available) console.log(`GPU encoding available now (${gpu.device})`);
}
async function testGpu() {
  lastGpuCheck = Date.now();
  if (!config.vaapiDevice) return gpu;
  // verbose, so libva says which driver it tried and why it failed
  const r = await new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'verbose', '-init_hw_device', `vaapi=va:${config.vaapiDevice}`, '-filter_hw_device', 'va',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LIBVA_MESSAGING_LEVEL: '2' } });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('error', (e) => resolve({ code: -1, err: e.message }));
    child.on('close', (code) => resolve({ code, err }));
  });
  const info = r.err.split('\n').filter((l) => /libva|vaapi|VA-API|Driver|driver|error|fail/i.test(l)).slice(-8).join(' | ');
  if (r.code === 0) Object.assign(gpu, { available: true, error: null, info: info.slice(0, 500) });
  else Object.assign(gpu, { available: false, error: (info || r.err.split('\n').slice(-3).join(' | ')).slice(0, 700) });
  return gpu;
}

// codecs the GPU (VAAPI) decodes; others are decoded on the CPU. A failed GPU decode falls back to the CPU.
const FULL_GPU_CODECS = new Set(['h264', 'hevc']);

export async function render(src, info, edit, outFile, tmpDir, onProgress = () => {}) {
  const p = plan(info, edit);
  if (edit.gpu) await recheckGpu();
  const useGpu = !!edit.gpu && gpu.available;
  const t0 = Date.now();
  let loud = null;
  if (edit.normalize !== false && p.activeTracks.length) {
    // pass 0: measure the loudness of the exact mix (audio only, quick)
    const err = await run(FFMPEG, ['-hide_banner', '-nostdin', '-nostats', '-ss', edit.start.toFixed(3), '-t', p.dur.toFixed(3), ...SAFE, '-i', src,
      '-filter_complex', filters(info, edit, p, 'measure'), '-map', '[a]', '-f', 'null', '-'], { stderr: true });
    const m = parseLoudnorm(err);
    if (Number.isFinite(m.I) && m.I > -70) loud = m;   // silence: leave it alone
    onProgress(0.05);
  }
  // GPU: decode on the GPU too when it can (much less work for the CPU), else decode on the CPU and upload
  let gpuMode = !useGpu ? false : !edit.videoFade && FULL_GPU_CODECS.has(info.vcodec) && info.pixFmt === 'yuv420p' ? 'full' : 'upload';
  const preset = p.dur <= 120 ? 'medium' : p.dur <= 600 ? 'fast' : 'veryfast';
  const hwIn = () => gpuMode === 'full' ? ['-init_hw_device', `vaapi=va:${gpu.device}`, '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi', '-filter_hw_device', 'va']
    : gpuMode ? ['-init_hw_device', `vaapi=va:${gpu.device}`, '-filter_hw_device', 'va'] : [];
  const input = () => ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...hwIn(), '-ss', edit.start.toFixed(3), '-t', p.dur.toFixed(3), ...SAFE, '-i', src];
  const common = () => gpuMode
    ? ['-filter_complex', filters(info, edit, p, loud, gpuMode), '-map', '[v]', '-c:v', 'h264_vaapi', '-profile:v', 'high', '-g', String(p.fps * 2)]
    : ['-filter_complex', filters(info, edit, p, loud, false), '-map', '[v]', '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-g', String(p.fps * 2), '-threads', THREADS];
  const audio = p.activeTracks.length ? ['-map', '[a]', '-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ac', '2'] : ['-an'];
  const meta = ['-map_metadata', '-1', '-map_chapters', '-1', '-metadata', `title=${(edit.title || '').slice(0, 200)}`, '-movflags', '+faststart'];
  const passlog = path.join(tmpDir, `x264-${path.basename(outFile)}`);

  const twoPass = async (kbps, from, span) => {
    const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`];
    await run(FFMPEG, [...input(), ...common(), ...rate, '-pass', '1', '-passlogfile', passlog, ...audio, '-f', 'mp4', '/dev/null'],
      { duration: p.dur, onProgress: (f) => onProgress(from + f * span * 0.4) });
    await run(FFMPEG, [...input(), ...common(), ...rate, '-pass', '2', '-passlogfile', passlog, ...audio, ...meta, outFile],
      { duration: p.dur, onProgress: (f) => onProgress(from + span * 0.4 + f * span * 0.6) });
  };

  // GPU: one pass at a target bitrate (VAAPI has no 2-pass); the size check below tightens it if needed
  const gpuPass = async (kbps, from, span) => {
    const rate = kbps ? ['-rc_mode', 'VBR', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`] : ['-rc_mode', 'CQP', '-qp', '20'];
    const go = () => run(FFMPEG, [...input(), ...common(), ...rate, ...audio, ...meta, outFile], { duration: p.dur, onProgress: (f) => onProgress(from + f * span) });
    try { await go(); } catch (e) {
      if (gpuMode !== 'full') throw e;
      console.error('GPU decoding failed, decoding on the CPU:', e.message);
      gpuMode = 'upload'; await go();
    }
  };

  try {
    if (useGpu) {
      await gpuPass(p.cap ? Math.round(p.mode.kind === '2pass' ? p.mode.kbps * 0.97 : Math.min(p.ceiling, p.budget)) : (p.mode.maxrate || 0), 0.05, 0.85);
    } else if (p.mode.kind === 'crf') {
      const rate = ['-crf', String(p.mode.crf), ...(p.mode.maxrate ? ['-maxrate', `${p.mode.maxrate}k`, '-bufsize', `${p.mode.maxrate * 2}k`] : [])];
      await run(FFMPEG, [...input(), ...common(), ...rate, ...audio, ...meta, outFile], { duration: p.dur, onProgress: (f) => onProgress(0.05 + f * 0.85) });
    } else {
      await twoPass(p.mode.kbps, 0, 0.9);
    }
    // never hand out a file over the cap: re-encode tighter if the estimate was off
    let kbps = p.mode.kind === '2pass' ? p.mode.kbps : Math.min(p.ceiling, p.budget);
    for (let tries = 0; p.cap && fs.statSync(outFile).size > p.cap && tries < 3; tries++) {
      const ratio = (p.cap * 0.95) / fs.statSync(outFile).size;
      kbps = Math.max(100, Math.round(kbps * ratio));
      if (useGpu) await gpuPass(kbps, 0.9, 0.1); else await twoPass(kbps, 0.9, 0.1);
    }
    if (p.cap && fs.statSync(outFile).size > p.cap) throw new Error('could not get the clip under the size cap');
  } finally {
    for (const f of fs.readdirSync(tmpDir)) if (f.startsWith(path.basename(passlog))) fs.rmSync(path.join(tmpDir, f), { force: true });
  }
  onProgress(1);
  console.log(`rendered ${path.basename(outFile)}: ${p.dur.toFixed(1)} s at ${p.w}x${p.h} ${p.fps} fps in ${((Date.now() - t0) / 1000).toFixed(1)} s (${gpuMode ? `gpu ${gpuMode}` : 'cpu'}, ${p.mode.kind})`);
  return { bytes: fs.statSync(outFile).size, plan: p, gpu: useGpu, loudness: loud && { measured: loud.I, target: LOUDNESS.I } };
}

export async function thumbnail(videoFile, t, outFile, maxW = 1280) {
  await run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-ss', Math.max(0, t).toFixed(3), '-i', videoFile,
    '-frames:v', '1', '-vf', `scale='min(${maxW},iw)':-2`, '-q:v', '3', outFile]);
}
