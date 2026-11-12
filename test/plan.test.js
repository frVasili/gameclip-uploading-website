// npm test  (pure logic; no ffmpeg needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/clips-test-');
process.env.ADMIN_PASSWORD ||= 'unit-test-password';
const { plan, qualityCeilingKbps, PRESETS } = await import('../server/media.js');
const { randomId, CLIP_ID } = await import('../server/store.js');

const info = { duration: 600, width: 1920, height: 1080, fps: 60, audio: [{ n: 0 }, { n: 1 }] };
const edit = (o) => ({ start: 0, end: 30, tracks: [{ n: 0, volume: 1 }, { n: 1, volume: 1 }], preset: 'discord', resolution: 'auto', fps: 'source', ...o });

test('short clip at discord preset: full res, CRF capped at the quality ceiling, far below 250 MB', () => {
  const p = plan(info, edit({}));
  assert.equal(p.h, 1080); assert.equal(p.fps, 60); assert.equal(p.mode.kind, 'crf');
  assert.ok(p.estBytes < 60e6, `estimate ${p.estBytes}`);
});
test('budget never exceeds the cap', () => {
  for (const [key, pr] of Object.entries(PRESETS)) {
    if (!pr.cap) continue;
    for (const end of [10, 60, 180, 590]) {
      let p; try { p = plan(info, edit({ end, preset: key })); } catch { continue; }
      const maxV = p.mode.kind === '2pass' ? p.mode.kbps : p.mode.maxrate;
      assert.ok((maxV + p.audioKbps) * 125 * p.dur <= pr.cap, `${key} ${end}s`);
    }
  }
});
test('tight budget downscales instead of starving 1080p', () => {
  const p = plan(info, edit({ end: 300, preset: 'upload' }));
  assert.ok(p.h < 1080); assert.equal(p.mode.kind, '2pass');
});
test('too long for the preset throws a readable error', () => {
  assert.throws(() => plan(info, edit({ end: 600, preset: 'upload' })), /too long/);
});
test('never above 4K (Discord limit) and dimensions are even', () => {
  const p = plan({ ...info, width: 5120, height: 2880 }, edit({ preset: 'original', resolution: 'source' }));
  assert.ok(p.w <= 3840 && p.h <= 2160); assert.equal(p.w % 2, 0); assert.equal(p.h % 2, 0);
  const v = plan({ ...info, width: 1081, height: 1921 }, edit({}));
  assert.equal(v.w % 2, 0); assert.equal(v.h % 2, 0);
});
test('muted tracks drop the audio stream entirely', () => {
  const p = plan(info, edit({ tracks: [{ n: 0, muted: true }, { n: 1, volume: 0 }] }));
  assert.equal(p.audioKbps, 0); assert.equal(p.activeTracks.length, 0);
});
test('ceiling scales with pixel rate', () => {
  assert.equal(qualityCeilingKbps(1920, 1080, 60), 12000);
  assert.ok(qualityCeilingKbps(1280, 720, 30) < qualityCeilingKbps(1920, 1080, 30));
});
test('ids are 12 chars base62 and unique', () => {
  const s = new Set(Array.from({ length: 2000 }, () => randomId()));
  assert.equal(s.size, 2000); for (const id of s) assert.match(id, CLIP_ID);
});

const { filters, normGain, LEVELING } = await import('../server/media.js');
test('audio graph: leveling per track, constant-gain normalization, true-peak limiter', () => {
  const e = edit({ tracks: [{ n: 0, volume: 1, level: 'strong' }, { n: 1, volume: 0.5, level: 'off' }] });
  const p = plan(info, e);
  const g = filters(info, e, p, { I: -20 });
  assert.ok(g.includes(`[0:a:0]`) && g.includes(LEVELING.strong));
  assert.equal(g.split('dynaudnorm').length - 1, 1, 'only the strong track is leveled');
  assert.match(g, /volume=6\.00dB/);              // -20 LUFS -> -14 target
  assert.match(g, /alimiter=limit=0\.841/);       // -1.5 dBTP
  assert.ok(!/loudnorm/.test(g), 'no dynamic loudnorm in the render graph');
  const plain = filters(info, e, p, null);
  assert.ok(!/volume=[-0-9.]+dB/.test(plain)); assert.match(plain, /alimiter=limit=0\.97/);
  assert.match(filters(info, e, p, 'measure'), /loudnorm=.*print_format=json\[a\]$/);
});
test('normalization gain is capped', () => {
  assert.equal(normGain(-60), 24); assert.equal(normGain(10), -24); assert.equal(normGain(-14), 0);
});

test('custom size: cap is the typed MB, clamped, and the budget stays under it', () => {
  for (const mb of [8, 40, 300, 2000]) {
    const p = plan(info, edit({ end: 120, preset: 'custom', customMB: mb }));
    assert.equal(p.preset, 'custom'); assert.equal(p.cap, mb * 1e6);
    const maxV = p.mode.kind === '2pass' ? p.mode.kbps : p.mode.maxrate;
    assert.ok((maxV + p.audioKbps) * 125 * p.dur <= p.cap, `${mb} MB`);
  }
  assert.equal(plan(info, edit({ preset: 'custom', customMB: 'junk' })).cap, 100e6);
  assert.throws(() => plan(info, edit({ end: 600, preset: 'custom', customMB: 1 })), /Custom · 1 MB/);
});

test('a low-bitrate source is not inflated: the bitrate stays at or below the source', () => {
  const lecture = { duration: 2800, width: 854, height: 480, fps: 25, bitrate: 600e3, audio: [{ n: 0 }] };
  const p = plan(lecture, edit({ start: 0, end: 600, tracks: [{ n: 0, volume: 1 }], preset: 'discord' }));
  assert.equal(p.mode.kind, 'crf');
  assert.ok(p.mode.maxrate <= 600 - 128, `maxrate ${p.mode.maxrate}`);
  assert.ok(p.estBytes < 600e3 / 8 * 600, `estimate ${p.estBytes}`);
});

test('a downscaled big source still uses the size it is given (4K lecture, 47 min)', () => {
  const rec = { duration: 2812, width: 3840, height: 2160, fps: 25, bitrate: 2.4e6, audio: [{ n: 0 }] };
  const sizes = [250, 400, 800].map((mb) => plan(rec, edit({ end: 2812, tracks: [{ n: 0, volume: 1 }], preset: 'custom', customMB: mb })).estBytes);
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], sizes.join(' '));
  assert.ok(sizes[1] > 300e6 && sizes[1] <= 400e6, `400 MB -> ${sizes[1]}`);
});

test('best quality never asks for more than the source bitrate', () => {
  const p = plan({ duration: 600, width: 854, height: 480, fps: 25, bitrate: 600e3, audio: [{ n: 0 }] }, edit({ end: 300, tracks: [{ n: 0, volume: 1 }], preset: 'original' }));
  assert.equal(p.mode.kind, 'crf'); assert.ok(p.mode.maxrate <= 600 - 128);
  assert.ok(p.estBytes <= (600e3 / 8) * 300, `estimate ${p.estBytes}`);
});

test('auto resolution: easy content (low source bitrate) gets a sharper picture; game footage is unchanged', () => {
  const rec = { duration: 2812, width: 3840, height: 2160, fps: 25, bitrate: 2.4e6, audio: [{ n: 0 }] };
  const at = (mb) => plan(rec, edit({ end: 2812, tracks: [{ n: 0, volume: 1 }], preset: 'custom', customMB: mb })).h;
  assert.equal(at(400), 1080); assert.equal(at(250), 720);
  const game = { ...info, bitrate: 40e6 };   // OBS 1080p60 at 40 Mbit/s: same choice as with no bitrate known
  for (const end of [30, 120, 300]) assert.equal(plan(game, edit({ end })).h, plan(info, edit({ end })).h);
});

test('auto resolution: HEVC sources and GPU exports ask for more bits; starved sources do not keep a big size', () => {
  const lecture = { duration: 2812, width: 3840, height: 2160, fps: 25, bitrate: 2.4e6, audio: [{ n: 0 }], vcodec: 'h264' };
  const at = (src, o) => plan(src, edit({ end: 2812, tracks: [{ n: 0, volume: 1 }], preset: 'custom', customMB: 400, ...o })).h;
  assert.equal(at(lecture), 1080);
  assert.equal(at({ ...lecture, vcodec: 'hevc' }), 720);           // same bitrate in HEVC = more detail to keep
  assert.ok(at(lecture, { gpu: true }) <= 1080);
  // a heavily compressed 1080p source: 0.015 bits per pixel minimum, whatever the source spent
  const starved = { duration: 3600, width: 1920, height: 1080, fps: 30, bitrate: 400e3, audio: [{ n: 0 }], vcodec: 'h264' };
  // 300 MB for an hour: the budget covers what the source spent at 1080p, but that is only 0.008 bits per pixel
  const p = plan(starved, edit({ end: 3600, tracks: [{ n: 0, volume: 1 }], preset: 'custom', customMB: 300 }));
  assert.equal(p.h, 720);
});
test('quality-based sizes report an upper bound; fixed sizes do not', () => {
  const short = plan(info, edit({ end: 30 }));                     // discord, CRF under the cap
  assert.equal(short.mode.kind, 'crf'); assert.ok(short.maxBytes >= short.estBytes && short.maxBytes <= 250e6);
  const long = plan(info, edit({ end: 300, preset: 'upload' }));   // 2-pass
  assert.equal(long.maxBytes, null);
});
