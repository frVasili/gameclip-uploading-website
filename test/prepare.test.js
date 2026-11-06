// npm test  (needs ffmpeg): preparing an upload in one ffmpeg run, and spotting copied / silent audio tracks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-test-'));
process.env.ADMIN_PASSWORD ||= 'unit-test-password';
const { probe, prepare } = await import('../server/media.js');

test('prepare: preview, per-track audio + peaks; copies and silent tracks are flagged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-prep-')), src = path.join(dir, 'in.mkv');
  // tracks: 440 Hz, 880 Hz, silence, 440 Hz again (a copy of track 0); mpeg4 video forces the re-encode path
  execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=440:d=3', '-f', 'lavfi', '-i', 'sine=880:d=3', '-f', 'lavfi', '-i', 'anullsrc=d=3',
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-map', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', src]);
  const info = await probe(src);
  const r = await prepare(src, dir, info);
  assert.deepEqual(r.audio.map((a) => [a.silent, a.sameAs]), [[false, null], [false, null], [true, null], [false, 0]]);
  for (const f of ['preview.mp4', 'audio-0.m4a', 'audio-3.m4a', 'peaks-0.json', 'peaks-3.json']) assert.ok(fs.statSync(path.join(dir, f)).size > 0, f);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'temporary PCM files are removed');
  assert.equal((await probe(path.join(dir, 'preview.mp4'))).vcodec, 'h264');
  fs.rmSync(dir, { recursive: true, force: true });
});
