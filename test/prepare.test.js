// npm test  (needs ffmpeg): preparing an upload in one ffmpeg run, and spotting copied / silent audio tracks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-test-'));
process.env.ADMIN_PASSWORD ||= 'unit-test-password';
const { probe, prepare, convertPreview, render, makePoster } = await import('../server/media.js');

test('prepare: preview, per-track audio + peaks; copies and silent tracks are flagged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-prep-')), src = path.join(dir, 'in.mkv');
  // tracks: 440 Hz, 880 Hz, silence, 440 Hz again (a copy of track 0); mpeg4 video forces the re-encode path
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=440:d=3', '-f', 'lavfi', '-i', 'sine=880:d=3', '-f', 'lavfi', '-i', 'anullsrc=d=3',
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', src]);
  const info = await probe(src);
  const r = await prepare(src, dir, info);
  assert.deepEqual(r.audio.map((a) => [a.silent, a.sameAs]), [[false, null], [false, null], [true, null], [false, 0]]);
  for (const f of ['audio-0.m4a', 'audio-3.m4a', 'peaks-0.json', 'peaks-3.json']) assert.ok(fs.statSync(path.join(dir, f)).size > 0, f);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'temporary PCM files are removed');
  const codec = execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(dir, 'audio-0.m4a')]);
  assert.equal(String(codec).trim(), 'aac', 'AAC tracks are copied as they are');
  // mpeg4 plays in no browser: no direct playing, the preview has to be converted
  assert.equal(r.preview, 'needed'); assert.equal(r.direct, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'preview.mp4')));
  await convertPreview(src, dir, info);
  assert.equal((await probe(path.join(dir, 'preview.mp4'))).vcodec, 'h264');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp')), 'no half-written preview left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prepare: HEVC in MP4 is played as it is until the preview is converted; in MKV its video is copied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-prep-'));
  for (const ext of ['mp4', 'mkv']) {
    const src = path.join(dir, `in.${ext}`);
    execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=2', '-f', 'lavfi', '-i', 'sine=440:d=2',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const r = await prepare(src, dir, await probe(src));
    assert.equal(r.preview, 'needed'); assert.equal(r.direct, 'hvc1.1.6.L153.B0');
    assert.equal(r.directFile, ext === 'mp4' ? 'in.mp4' : 'original.mp4');
    if (ext === 'mkv') assert.equal((await probe(path.join(dir, 'original.mp4'))).vcodec, 'hevc');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// average saturation of the first frame (signalstats SATAVG)
const saturation = (file) => Number(/SATAVG=([\d.]+)/.exec(execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1',
  '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' }))[1]);

test('HDR (HLG, as phones record it): exports, previews and posters are tone mapped to normal video', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-hdr-')), src = path.join(dir, 'in.mov');
  // HLG with SDR white at 203 nits (BT.2408), 10-bit HEVC, like an iPhone recording
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2',
    '-vf', 'zscale=tin=bt709:pin=bt709:min=bt709:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv:npl=203,format=yuv420p10le',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', src]);
  const info = await probe(src);
  assert.equal(info.color.trc, 'arib-std-b67'); assert.equal(info.rotation, 0);
  const { color, ...stored } = info;   // a recording probed before colours were stored: looked up again
  await render(src, stored, { start: 0, end: 2, preset: 'discord', tracks: [] }, path.join(dir, 'out.mp4'), dir);
  await convertPreview(src, dir, info);
  await makePoster(src, 1, path.join(dir, 'poster.jpg'), info);
  const out = JSON.parse(execFileSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,color_transfer,color_primaries', '-of', 'json', path.join(dir, 'out.mp4')])).streams[0];
  assert.deepEqual([out.pix_fmt, out.color_transfer, out.color_primaries], ['yuv420p', 'bt709', 'bt709']);
  // the SDR original has ~114; squeezed to 8-bit without tone mapping it was ~40 (washed out)
  for (const f of ['out.mp4', 'preview.mp4', 'poster.jpg']) assert.ok(saturation(path.join(dir, f)) > 85, `${f} keeps its colours`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audio ffmpeg cannot decode is left out; the other tracks keep their own sound', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-prep-')), made = path.join(dir, 'made.mov'), src = path.join(dir, 'in.mov');
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=440:d=2', '-f', 'lavfi', '-i', 'anullsrc=d=2', '-f', 'lavfi', '-i', 'sine=880:d=2',
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', made]);
  // turn the second audio track into a codec ffmpeg doesn't know (like a new phone's spatial audio)
  const b = fs.readFileSync(made);
  const entries = [];   // 'mp4a' sample entry boxes (a box starts with its size; other 'mp4a' bytes don't)
  for (let at = b.indexOf('mp4a'); at >= 0; at = b.indexOf('mp4a', at + 1)) { const size = b.readUInt32BE(at - 4); if (size > 20 && size < 400) entries.push(at); }
  assert.equal(entries.length, 3);
  b.write('apac', entries[1]); b.write('xxxx', b.indexOf('esds', entries[1]));
  fs.writeFileSync(src, b);
  const info = await probe(src);
  assert.deepEqual(info.audio.map((a) => [a.n, a.stream]), [[0, 0], [1, 2]]);
  const r = await prepare(src, dir, info);
  assert.deepEqual(r.audio.map((a) => a.silent), [false, false], 'track 1 is the 880 Hz stream, not the silent one');
  await render(src, info, { start: 0, end: 1.5, preset: 'discord', tracks: [{ n: 0, volume: 1, muted: true }, { n: 1, volume: 1 }] }, path.join(dir, 'out.mp4'), dir);
  const vd = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-i', path.join(dir, 'out.mp4'), '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  assert.ok(Number(/mean_volume: (-?[\d.]+) dB/.exec(vd)[1]) > -40, 'the export carries the 880 Hz track, not the silent one');
  fs.rmSync(dir, { recursive: true, force: true });
});
