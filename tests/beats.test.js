import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctedBpm, detectBeats } from '../docs/src/dj/beats.js';

const SAMPLE_RATE = 22050;

function clickTrack(bpm, seconds, { accentEvery = 4, offset = 0.25 } = {}) {
  const samples = new Float32Array(SAMPLE_RATE * seconds);
  const beat = 60 / bpm;
  for (let n = 0; offset + n * beat < seconds - 0.1; n++) {
    const start = Math.round((offset + n * beat) * SAMPLE_RATE);
    const strength = n % accentEvery === 0 ? 1 : 0.45;
    for (let i = 0; i < 1500; i++) samples[start + i] += strength * Math.exp(-i / 300) * Math.sin((2 * Math.PI * 70 * i) / SAMPLE_RATE);
  }
  return samples;
}

for (const bpm of [92, 105, 117, 128, 140, 174 / 2]) {
  test(`finds ${bpm} BPM`, () => {
    assert.ok(Math.abs(detectBeats(clickTrack(bpm, 45), SAMPLE_RATE).bpm - bpm) < 1);
  });
}

test('beats land on the clicks', () => {
  const beat = 60 / 120;
  const { beats } = detectBeats(clickTrack(120, 30), SAMPLE_RATE);
  const errors = beats.slice(2, 50).map((time) => {
    const nearest = Math.round((time - 0.25) / beat);
    return Math.abs(time - (0.25 + nearest * beat));
  });
  assert.ok(Math.max(...errors) < 0.03, String(Math.max(...errors)));
});

test('the accented beat is the downbeat', () => {
  const result = detectBeats(clickTrack(120, 30), SAMPLE_RATE);
  const beatNumber = Math.round((result.beats[result.downbeat] - 0.25) / 0.5);
  assert.equal(Math.abs(beatNumber % 4), 0);
});

test('double and half tempo readings are folded back', () => {
  assert.equal(correctedBpm(184), 92);
  assert.equal(correctedBpm(68), 136);
  assert.equal(correctedBpm(120), 120);
});
