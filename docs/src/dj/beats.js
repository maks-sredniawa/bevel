const HOP_SECONDS = 0.0058;
const MIN_BPM = 70;
const MAX_BPM = 185;
const PREFERRED_BPM = 120;
const TEMPO_SPREAD_OCTAVES = 0.9;
const LOW_CUTOFF_HZ = 150;
const ANALYSIS_RATE = 11025;
const FFT_SIZE = 512;
const COMPRESSION = 100;
const FOLLOW_WINDOW = 0.05;
const BEATS_PER_BAR = 4;
const LAG_MULTIPLES = 4;

function fft(real, imaginary) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let wReal = 1;
      let wImaginary = 0;
      for (let k = 0; k < length / 2; k++) {
        const a = start + k;
        const b = a + length / 2;
        const tReal = real[b] * wReal - imaginary[b] * wImaginary;
        const tImaginary = real[b] * wImaginary + imaginary[b] * wReal;
        real[b] = real[a] - tReal;
        imaginary[b] = imaginary[a] - tImaginary;
        real[a] += tReal;
        imaginary[a] += tImaginary;
        const nextReal = wReal * stepReal - wImaginary * stepImaginary;
        wImaginary = wReal * stepImaginary + wImaginary * stepReal;
        wReal = nextReal;
      }
    }
  }
}

function decimate(samples, factor) {
  const output = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < output.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += samples[i * factor + j];
    output[i] = sum / factor;
  }
  return output;
}

export function onsetEnvelope(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
  const signal = decimate(samples, factor);
  const rate = sampleRate / factor;
  const hop = Math.max(1, Math.round(rate * HOP_SECONDS));
  const window = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const bins = FFT_SIZE / 2;
  const lowBins = Math.max(2, Math.round((LOW_CUTOFF_HZ * FFT_SIZE) / rate));
  const count = Math.max(0, Math.floor((signal.length - FFT_SIZE) / hop));
  const envelope = new Float32Array(count);
  const kick = new Float32Array(count);
  const real = new Float32Array(FFT_SIZE);
  const imaginary = new Float32Array(FFT_SIZE);
  let previous = new Float32Array(bins);
  let current = new Float32Array(bins);
  for (let frame = 0; frame < count; frame++) {
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = signal[frame * hop + i] * window[i];
      imaginary[i] = 0;
    }
    fft(real, imaginary);
    let flux = 0;
    let lowFlux = 0;
    for (let bin = 1; bin < bins; bin++) {
      current[bin] = Math.log1p(COMPRESSION * Math.hypot(real[bin], imaginary[bin]));
      const rise = Math.max(0, current[bin] - previous[bin]);
      flux += rise;
      if (bin <= lowBins) lowFlux += rise;
    }
    if (frame > 0) {
      envelope[frame] = flux;
      kick[frame] = lowFlux;
    }
    [previous, current] = [current, previous];
  }
  const mean = envelope.reduce((sum, value) => sum + value, 0) / (count || 1);
  for (let frame = 0; frame < count; frame++) envelope[frame] = Math.max(0, envelope[frame] - mean);
  return { envelope, kick, frameSeconds: hop / rate, latency: FFT_SIZE / 2 / rate };
}

function tempoWeight(bpm) {
  return Math.exp(-0.5 * (Math.log2(bpm / PREFERRED_BPM) / TEMPO_SPREAD_OCTAVES) ** 2);
}

function correlate(envelope, lag) {
  let sum = 0;
  for (let i = lag; i < envelope.length; i++) sum += envelope[i] * envelope[i - lag];
  return sum / (envelope.length - lag);
}

export function findPeriod(envelope, frameSeconds) {
  const shortest = Math.floor(60 / MAX_BPM / frameSeconds);
  const longest = Math.ceil(60 / MIN_BPM / frameSeconds);
  let best = shortest;
  let bestScore = -Infinity;
  for (let lag = shortest; lag <= longest; lag++) {
    let aligned = 0;
    for (let multiple = 1; multiple <= LAG_MULTIPLES; multiple++) aligned += correlate(envelope, lag * multiple);
    const score = aligned * tempoWeight(60 / (lag * frameSeconds));
    if (score > bestScore) {
      best = lag;
      bestScore = score;
    }
  }

  const multiple = 8;
  const far = best * multiple;
  let refined = far;
  let refinedScore = -Infinity;
  for (let lag = far - multiple; lag <= far + multiple; lag++) {
    const score = correlate(envelope, lag);
    if (score > refinedScore) {
      refined = lag;
      refinedScore = score;
    }
  }
  return refined / multiple;
}

function bestPhase(envelope, period) {
  const steps = Math.ceil(period);
  let phase = 0;
  let bestScore = -Infinity;
  for (let candidate = 0; candidate < steps; candidate++) {
    let score = 0;
    for (let at = candidate; at < envelope.length; at += period) score += envelope[Math.round(at)] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      phase = candidate;
    }
  }
  return phase;
}

function followBeats(envelope, period, phase) {
  const reach = Math.max(1, Math.round(period * FOLLOW_WINDOW));
  const frames = [];
  let expected = phase;
  while (expected < envelope.length) {
    const centre = Math.round(expected);
    let best = centre;
    let bestValue = -Infinity;
    for (let frame = centre - reach; frame <= centre + reach; frame++) {
      const value = (envelope[frame] ?? 0) * (1 - (0.5 * Math.abs(frame - centre)) / (reach + 1));
      if (value > bestValue) {
        bestValue = value;
        best = frame;
      }
    }
    const placed = Math.max(0, best);
    frames.push(placed);
    expected = 0.85 * (expected + period) + 0.15 * (placed + period);
  }
  return frames;
}

function firstDownbeat(kick, frames) {
  let best = 0;
  let bestScore = -Infinity;
  for (let offset = 0; offset < BEATS_PER_BAR; offset++) {
    let score = 0;
    let count = 0;
    for (let i = offset; i < frames.length; i += BEATS_PER_BAR) {
      score += kick[frames[i]] ?? 0;
      count++;
    }
    if (count > 0 && score / count > bestScore) {
      bestScore = score / count;
      best = offset;
    }
  }
  return best;
}

export function correctedBpm(bpm) {
  if (bpm > 160) return bpm / 2;
  if (bpm < 75) return bpm * 2;
  return bpm;
}

export function detectBeats(samples, sampleRate) {
  const { envelope, kick, frameSeconds, latency } = onsetEnvelope(samples, sampleRate);
  let period = findPeriod(envelope, frameSeconds);
  const corrected = correctedBpm(60 / (period * frameSeconds));
  period = 60 / corrected / frameSeconds;
  const frames = followBeats(envelope, period, bestPhase(envelope, period));
  return {
    bpm: Math.round(corrected * 10) / 10,
    beats: frames.map((frame) => frame * frameSeconds + latency),
    downbeat: firstDownbeat(kick, frames),
  };
}
