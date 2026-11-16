import { correlate, findPeriod, onsetEnvelope } from './dj/beats.js';

const BLOCK_SECONDS = 0.4;
const SILENCE_DB = -60;
const MID_LOW_HZ = 500;
const MID_HIGH_HZ = 3000;
const TREBLE_HZ = 4000;
const PULSE_SECONDS = 60;

// Centroids measured on 190 songs from labelled rock, dance and pop folders; nearest-centroid places 76% of them correctly.
const SOUND_CENTROIDS = [
  ['Rock', { midDb: -5.5, trebleDb: -12.2, pulse: 0.41 }],
  ['Dance', { midDb: -7.6, trebleDb: -13.5, pulse: 0.7 }],
  ['Pop', { midDb: -6.3, trebleDb: -15, pulse: 0.46 }],
];
const SOUND_SPREAD = { midDb: 1.9, trebleDb: 2.4, pulse: 0.18 };
const CLASSICAL_RANGE_DB = 16;
const CLASSICAL_PULSE = 0.25;

function biquad(b0, b1, b2, a0, a1, a2) {
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  const [f0, f1, f2, g1, g2] = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  return (x) => {
    const y = f0 * x + f1 * x1 + f2 * x2 - g1 * y1 - g2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function lowPass(frequency, sampleRate) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const b = (1 - Math.cos(w)) / 2;
  return biquad(b, 2 * b, b, 1 + alpha, -2 * Math.cos(w), 1 - alpha);
}

function highPass(frequency, sampleRate) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const b = (1 + Math.cos(w)) / 2;
  return biquad(b, -2 * b, b, 1 + alpha, -2 * Math.cos(w), 1 - alpha);
}

const toDb = (power) => 10 * Math.log10(power);
const round = (value, decimals) => Number(value.toFixed(decimals));

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const mono = new Float32Array(channels[0].length);
  for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
  return mono;
}

function balance(samples, sampleRate) {
  const midLow = highPass(MID_LOW_HZ, sampleRate);
  const midHigh = lowPass(MID_HIGH_HZ, sampleRate);
  const treble = highPass(TREBLE_HZ, sampleRate);
  const blockLength = Math.round(sampleRate * BLOCK_SECONDS);
  let total = 0; let mid = 0; let high = 0;
  const levels = [];
  for (let start = 0; start + blockLength <= samples.length; start += blockLength) {
    let blockTotal = 0; let blockMid = 0; let blockHigh = 0;
    for (let i = start; i < start + blockLength; i++) {
      const x = samples[i];
      const m = midHigh(midLow(x));
      const h = treble(x);
      blockTotal += x * x; blockMid += m * m; blockHigh += h * h;
    }
    const level = toDb(blockTotal / blockLength);
    if (level <= SILENCE_DB) continue;
    levels.push(level);
    total += blockTotal; mid += blockMid; high += blockHigh;
  }
  if (levels.length === 0) return null;
  levels.sort((a, b) => a - b);
  const at = (fraction) => levels[Math.min(levels.length - 1, Math.floor(fraction * levels.length))];
  return { midDb: toDb(mid / total), trebleDb: toDb(high / total), rangeDb: at(0.95) - at(0.1) };
}

function pulse(samples, sampleRate) {
  const length = Math.min(samples.length, Math.round(PULSE_SECONDS * sampleRate));
  const start = Math.floor((samples.length - length) / 2);
  const { envelope, frameSeconds } = onsetEnvelope(samples.subarray(start, start + length), sampleRate);
  const energy = correlate(envelope, 0);
  if (!(energy > 0)) return 0;
  return correlate(envelope, Math.round(findPeriod(envelope, frameSeconds))) / energy;
}

export function soundProfile(channels, sampleRate) {
  const samples = mixToMono(channels);
  const levels = balance(samples, sampleRate);
  if (!levels) return null;
  return {
    midDb: round(levels.midDb, 1),
    trebleDb: round(levels.trebleDb, 1),
    rangeDb: round(levels.rangeDb, 1),
    pulse: round(pulse(samples, sampleRate), 2),
  };
}

export function presetForSound(profile) {
  if (!profile || !Object.keys(SOUND_SPREAD).every((feature) => Number.isFinite(profile[feature]))) return null;
  if (profile.rangeDb > CLASSICAL_RANGE_DB && profile.pulse < CLASSICAL_PULSE) return 'Classical';
  const distance = (centroid) => Object.entries(SOUND_SPREAD)
    .reduce((sum, [feature, spread]) => sum + ((profile[feature] - centroid[feature]) / spread) ** 2, 0);
  return SOUND_CENTROIDS.reduce((best, entry) => (distance(entry[1]) < distance(best[1]) ? entry : best))[0];
}
