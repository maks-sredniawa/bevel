export const TARGET_LUFS = -16;
export const LEVEL_MAX_SECONDS = 20 * 60;
const LEVEL_MAX_BYTES_UNKNOWN_LENGTH = 60 * 1024 * 1024;
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = -24;
const PEAK_MARGIN_DB = 0.5;
const BLOCK_SECONDS = 0.4;
const STEP_SECONDS = 0.1;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

function biquad(b0, b1, b2, a1, a2) {
  return { b0, b1, b2, a1, a2 };
}

// ITU-R BS.1770 K-weighting, with coefficients derived for any sample rate.
export function kWeighting(sampleRate) {
  let K = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
  const Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = biquad((Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0);
  K = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
  const Qh = 0.5003270373238773;
  a0 = 1 + K / Qh + K * K;
  const highPass = biquad(1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Qh + K * K) / a0);
  return [shelf, highPass];
}

function segmentPowers(samples, sampleRate, stepLength) {
  const [s, h] = kWeighting(sampleRate);
  const powers = new Float64Array(Math.floor(samples.length / stepLength));
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  let u1 = 0; let u2 = 0; let z1 = 0; let z2 = 0;
  let peak = 0;
  for (let segment = 0; segment < powers.length; segment++) {
    let sum = 0;
    for (let i = segment * stepLength, end = i + stepLength; i < end; i++) {
      const x = samples[i];
      const magnitude = Math.abs(x);
      if (magnitude > peak) peak = magnitude;
      const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const z = h.b0 * y + h.b1 * u1 + h.b2 * u2 - h.a1 * z1 - h.a2 * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      sum += z * z;
    }
    powers[segment] = sum;
  }
  return { powers, peak };
}

const toLufs = (power) => -0.691 + 10 * Math.log10(power);

export function measureLoudness(channels, sampleRate) {
  const stepLength = Math.round(sampleRate * STEP_SECONDS);
  const blockSteps = Math.round(BLOCK_SECONDS / STEP_SECONDS);
  const measured = channels.map((samples) => segmentPowers(samples, sampleRate, stepLength));
  const peak = Math.max(0, ...measured.map((channel) => channel.peak));
  const segments = measured[0]?.powers.length ?? 0;
  const blocks = [];
  for (let start = 0; start + blockSteps <= segments; start++) {
    let power = 0;
    for (const { powers } of measured) {
      for (let i = start; i < start + blockSteps; i++) power += powers[i];
    }
    blocks.push((power * (measured.length === 1 ? 2 : 1)) / (blockSteps * stepLength));
  }
  const loud = blocks.filter((power) => toLufs(power) > ABSOLUTE_GATE);
  if (loud.length === 0) return { lufs: null, peak };
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const gate = toLufs(mean(loud)) + RELATIVE_GATE;
  const gated = loud.filter((power) => toLufs(power) > gate);
  return { lufs: toLufs(mean(gated)), peak };
}

export function levelGainDb(loudness, target = TARGET_LUFS) {
  if (!Number.isFinite(loudness?.lufs)) return 0;
  let gain = target - loudness.lufs;
  if (gain > 0 && loudness.peak > 0) gain = Math.max(0, Math.min(gain, -20 * Math.log10(loudness.peak) - PEAK_MARGIN_DB));
  return Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, gain));
}

export function tooLongToLevel(seconds, bytes = 0) {
  return Number.isFinite(seconds) ? seconds > LEVEL_MAX_SECONDS : bytes > LEVEL_MAX_BYTES_UNKNOWN_LENGTH;
}
