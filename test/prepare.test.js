// npm test  (needs ffmpeg): preparing an upload in one ffmpeg run, and spotting copied / silent audio tracks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-test-'));
process.env.ADMIN_PASSWORD ||= 'unit-test-password';
const { probe, prepare, convertPreview } = await import('../server/media.js');

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
