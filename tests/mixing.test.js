import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beatIndexAt, chooseSection, crossfadeGains, filterFrequencies, loopRange, matchingTempo, orderWithoutRepeats, phaseCorrection, pitchToReachRate, transitionFor, wrapLoop,
} from '../docs/src/dj/mixing.js';

const near = (actual, expected, margin = 1e-6) => assert.ok(Math.abs(actual - expected) < margin, `${actual} vs ${expected}`);

test('crossfader is equal power: full at each end, -3 dB in the middle', () => {
  near(crossfadeGains(-1).a, 1);
  near(crossfadeGains(-1).b, 0);
  near(crossfadeGains(1).b, 1);
  near(crossfadeGains(0).a, Math.SQRT1_2);
  near(crossfadeGains(0).a ** 2 + crossfadeGains(0).b ** 2, 1);
});

test('filter is open at centre and closes in each direction', () => {
  const open = filterFrequencies(0);
  assert.equal(open.lowPass, 18000);
  assert.equal(open.highPass, 20);
  assert.ok(filterFrequencies(-1).lowPass < 200);
  assert.ok(filterFrequencies(1).highPass > 3000);
  assert.ok(filterFrequencies(-0.5).lowPass > filterFrequencies(-0.9).lowPass);
});

test('beat position interpolates between beats and stays in range', () => {
  const beats = [1, 2, 3];
  near(beatIndexAt(beats, 1.5), 0.5);
  near(beatIndexAt(beats, 0), 0);
  near(beatIndexAt(beats, 99), 2);
  near(beatIndexAt([], 5), 0);
});

test('tempo match takes the closest octave', () => {
  near(matchingTempo(120, 120), 1);
  near(matchingTempo(126, 120), 1.05);
  near(matchingTempo(174, 90), 87 / 90);
  near(matchingTempo(85, 170), 1);
});

test('pitch needed is limited to the fader range', () => {
  near(pitchToReachRate(1.05), 5, 1e-9);
  assert.equal(pitchToReachRate(1.5), 8);
  assert.equal(pitchToReachRate(0.5), -8);
});

test('phase correction takes the short way round the beat', () => {
  near(phaseCorrection(10.1, 20.9), 0.2);
  near(phaseCorrection(10.9, 20.1), -0.2);
  near(phaseCorrection(10.25, 20.25), 0);
});

test('loops snap to beats and run past the last beat safely', () => {
  const beats = [0, 0.5, 1, 1.5, 2];
  assert.deepEqual(loopRange(beats, 0.7, 2, 0.5), { start: 0.5, end: 1.5 });
  assert.deepEqual(loopRange(beats, 1.9, 4, 0.5), { start: 1.5, end: 3.5 });
  assert.deepEqual(loopRange([], 3, 4, 0.5), { start: 3, end: 5 });
  assert.deepEqual(loopRange(beats, 0.7, 0.5, 0.5), { start: 0.5, end: 0.75 });
});

test('position wraps inside a loop and ignores no loop', () => {
  const loop = { start: 10, end: 12 };
  near(wrapLoop(11, loop), 11);
  near(wrapLoop(13, loop), 11);
  near(wrapLoop(16.5, loop), 10.5);
  near(wrapLoop(16.5, null), 16.5);
});

test('the chosen section is the loud one, on a four-bar boundary', () => {
  const levels = [...new Array(16).fill(0.2), ...new Array(16).fill(0.9), ...new Array(16).fill(0.3)];
  assert.equal(chooseSection(levels, 16), 16);
  assert.equal(chooseSection([0.5, 0.5], 16), 0);
});

test('the order never puts one artist twice in a row when it can be avoided', () => {
  const tracks = ['a', 'a', 'a', 'b', 'c', 'd', 'e', 'f'].map((artist, id) => ({ id, artist }));
  for (let run = 0; run < 50; run++) {
    const order = orderWithoutRepeats(tracks);
    assert.equal(order.length, tracks.length);
    const repeats = order.slice(1).filter((track, i) => track.artist === order[i].artist);
    assert.equal(repeats.length, 0);
  }
});

test('mixed style blends close tempos and varies the rest', () => {
  assert.equal(transitionFor('mixed', 3, 0), 'blend');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((turn) => transitionFor('mixed', 20, turn)), ['echo', 'cut', 'tape', 'cut', 'roll', 'cut']);
  assert.equal(transitionFor('echo', 1, 0), 'echo');
});
