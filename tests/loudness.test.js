import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TARGET_LUFS, levelGainDb, measureLoudness } from '../docs/src/loudness.js';

const sine = (hz, dbfs, seconds, rate) => Float32Array.from({ length: rate * seconds }, (_, i) => 10 ** (dbfs / 20) * Math.sin(2 * Math.PI * hz * i / rate));

test('a stereo 997 Hz tone at -23 dBFS measures -23 LUFS at both common rates', () => {
  for (const rate of [44100, 48000]) {
    const tone = sine(997, -23, 10, rate);
    assert.ok(Math.abs(measureLoudness([tone, tone], rate).lufs + 23) < 0.1);
  }
});

test('a mono file counts as the same signal on both speakers', () => {
  const tone = sine(997, -23, 10, 44100);
  assert.ok(Math.abs(measureLoudness([tone], 44100).lufs - measureLoudness([tone, tone], 44100).lufs) < 0.01);
});

test('quiet passages below the relative gate do not drag the result down', () => {
  const loud = sine(997, -20, 10, 44100);
  const quiet = sine(997, -50, 10, 44100);
  const mixed = new Float32Array(loud.length + quiet.length);
  mixed.set(loud);
  mixed.set(quiet, loud.length);
  assert.ok(Math.abs(measureLoudness([mixed, mixed], 44100).lufs + 20) < 0.2);
});

test('silence has no loudness and is left at unity', () => {
  const silence = new Float32Array(44100 * 2);
  const result = measureLoudness([silence, silence], 44100);
  assert.equal(result.lufs, null);
  assert.equal(levelGainDb(result), 0);
});

test('a loud master is turned down to the target', () => {
  assert.equal(levelGainDb({ lufs: -8, peak: 1 }), TARGET_LUFS + 8);
});

test('a quiet song is boosted only as far as its peak allows', () => {
  assert.equal(levelGainDb({ lufs: TARGET_LUFS - 6, peak: 0.1 }), 6);
  assert.ok(Math.abs(levelGainDb({ lufs: TARGET_LUFS - 10, peak: 0.5 }) - (-20 * Math.log10(0.5) - 0.5)) < 1e-9);
  assert.equal(levelGainDb({ lufs: TARGET_LUFS - 10, peak: 1.2 }), 0);
});

test('unmeasured songs are left at unity', () => {
  assert.equal(levelGainDb(undefined), 0);
  assert.equal(levelGainDb(null), 0);
});
