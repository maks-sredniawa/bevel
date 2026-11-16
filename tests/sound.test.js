import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presetForSound, soundProfile } from '../docs/src/sound.js';

const RATE = 44100;
const tone = (hz, seconds, amplitude = 0.3) => Float32Array.from({ length: RATE * seconds }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / RATE));

function clicks(bpm, seconds) {
  const samples = new Float32Array(RATE * seconds);
  const spacing = Math.round(RATE * 60 / bpm);
  for (let start = 0; start < samples.length; start += spacing) {
    for (let i = 0; i < 2000 && start + i < samples.length; i++) samples[start + i] = 0.8 * Math.exp(-i / 300) * Math.sin(2 * Math.PI * 60 * i / RATE);
  }
  return samples;
}

function noise(seconds) {
  let seed = 1;
  return Float32Array.from({ length: RATE * seconds }, () => {
    seed = (seed * 16807) % 2147483647;
    return 0.2 * (seed / 2147483647 - 0.5);
  });
}

test('silence has no profile and picks no preset', () => {
  const silence = new Float32Array(RATE * 5);
  assert.equal(soundProfile([silence, silence], RATE), null);
  assert.equal(presetForSound(null), null);
});

test('the balance follows where the sound sits', () => {
  const mid = soundProfile([tone(1000, 5)], RATE);
  const high = soundProfile([tone(8000, 5)], RATE);
  assert.ok(mid.midDb > -1 && mid.trebleDb < -15, JSON.stringify(mid));
  assert.ok(high.trebleDb > -1 && high.midDb < -15, JSON.stringify(high));
});

test('a song that goes from quiet to loud has a wide range', () => {
  const quiet = tone(1000, 10, 0.01);
  const loud = tone(1000, 10, 0.5);
  const both = new Float32Array(quiet.length + loud.length);
  both.set(quiet);
  both.set(loud, quiet.length);
  assert.ok(Math.abs(soundProfile([both], RATE).rangeDb - 34) < 1);
  assert.ok(soundProfile([loud], RATE).rangeDb < 1);
});

test('a steady beat has a strong pulse and noise has a weak one', () => {
  const beat = soundProfile([clicks(124, 30)], RATE).pulse;
  const hiss = soundProfile([noise(30)], RATE).pulse;
  assert.ok(beat > 0.6, `beat ${beat}`);
  assert.ok(hiss < 0.4 && beat - hiss > 0.3, `noise ${hiss}`);
});

test('a guess picks the nearest measured genre', () => {
  assert.equal(presetForSound({ midDb: -5, trebleDb: -11.5, rangeDb: 6, pulse: 0.38 }), 'Rock');
  assert.equal(presetForSound({ midDb: -8, trebleDb: -13.5, rangeDb: 7, pulse: 0.78 }), 'Dance');
  assert.equal(presetForSound({ midDb: -6.3, trebleDb: -16, rangeDb: 8, pulse: 0.45 }), 'Pop');
  assert.equal(presetForSound({ midDb: -6, trebleDb: -18, rangeDb: 22, pulse: 0.12 }), 'Classical');
});

test('a saved profile from another version is ignored rather than guessed from', () => {
  assert.equal(presetForSound({ bassDb: -3, trebleDb: -12 }), null);
});
