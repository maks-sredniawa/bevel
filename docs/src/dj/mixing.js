const MIN_FILTER_HZ = 120;
const MAX_FILTER_HZ = 18000;
const HIGH_PASS_MAX_HZ = 6000;
const HIGH_PASS_MIN_HZ = 20;
const FILTER_DEAD_ZONE = 0.02;

const MIXED_EXITS = ['echo', 'cut', 'tape', 'cut', 'roll', 'cut'];

export const PITCH_LIMIT = 8;
export const BLEND_LIMIT_PERCENT = 6;
export const EQ_MIN_DB = -24;
export const EQ_MAX_DB = 6;

export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function crossfadeGains(position) {
  const angle = ((clamp(position, -1, 1) + 1) / 2) * (Math.PI / 2);
  return { a: Math.cos(angle), b: Math.sin(angle) };
}

export function filterFrequencies(value) {
  const amount = clamp(value, -1, 1);
  if (Math.abs(amount) < FILTER_DEAD_ZONE) return { lowPass: MAX_FILTER_HZ, highPass: HIGH_PASS_MIN_HZ };
  if (amount < 0) return { lowPass: MAX_FILTER_HZ * (MIN_FILTER_HZ / MAX_FILTER_HZ) ** -amount, highPass: HIGH_PASS_MIN_HZ };
  return { lowPass: MAX_FILTER_HZ, highPass: HIGH_PASS_MIN_HZ * (HIGH_PASS_MAX_HZ / HIGH_PASS_MIN_HZ) ** amount };
}

export function beatIndexAt(beats, time) {
  if (beats.length === 0) return 0;
  if (time <= beats[0]) return 0;
  if (time >= beats.at(-1)) return beats.length - 1;
  let low = 0;
  let high = beats.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (beats[middle] <= time) low = middle;
    else high = middle;
  }
  return low + (time - beats[low]) / (beats[low + 1] - beats[low]);
}

export function matchingTempo(masterBpm, deckBpm) {
  let target = masterBpm;
  while (target / deckBpm > 1.5) target /= 2;
  while (target / deckBpm < 0.75) target *= 2;
  return target / deckBpm;
}

export function pitchToReachRate(rate) {
  return clamp((rate - 1) * 100, -PITCH_LIMIT, PITCH_LIMIT);
}

export function phaseCorrection(masterBeat, deckBeat) {
  const master = masterBeat % 1;
  const deck = deckBeat % 1;
  let difference = master - deck;
  if (difference > 0.5) difference -= 1;
  if (difference < -0.5) difference += 1;
  return difference;
}

export function loopRange(beats, position, beatCount, fallbackBeat) {
  if (beats.length < 2) return { start: position, end: position + beatCount * fallbackBeat };
  const index = Math.floor(beatIndexAt(beats, position));
  const start = beats[index];
  const endIndex = index + beatCount;
  const whole = Number.isInteger(beatCount) && endIndex < beats.length;
  const spacing = index + 1 < beats.length ? beats[index + 1] - start : fallbackBeat;
  const end = whole ? beats[endIndex] : start + beatCount * spacing;
  return { start, end };
}

export function wrapLoop(position, loop) {
  if (!loop || position < loop.end) return position;
  const length = loop.end - loop.start;
  return loop.start + ((position - loop.start) % length);
}

export function chooseSection(barLevels, wantedBars) {
  if (barLevels.length <= wantedBars) return 0;
  const mean = (from, to) => {
    const part = barLevels.slice(Math.max(0, from), to);
    return part.reduce((sum, value) => sum + value, 0) / (part.length || 1);
  };
  let best = 0;
  let bestScore = -Infinity;
  for (let start = 0; start <= barLevels.length - wantedBars; start += 4) {
    const lift = start >= 4 ? mean(start, start + 8) - mean(start - 4, start) : 0;
    const score = mean(start, start + wantedBars) + 0.6 * lift;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return best;
}

export function orderWithoutRepeats(tracks, random = Math.random) {
  const pool = [...tracks];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const name = (track) => track.artist?.toLowerCase() ?? '';
  const canFinish = (rest, last) => {
    const counts = new Map();
    rest.forEach((track) => counts.set(name(track), (counts.get(name(track)) ?? 0) + 1));
    return [...counts].every(([artist, count]) => count <= rest.length - count + (artist === last ? 0 : 1));
  };
  const ordered = [];
  while (pool.length > 0) {
    const last = ordered.length ? name(ordered.at(-1)) : null;
    const fits = pool.findIndex((track, index) => name(track) !== last && canFinish(pool.filter((_, other) => other !== index), name(track)));
    const different = pool.findIndex((track) => name(track) !== last);
    ordered.push(...pool.splice(Math.max(fits >= 0 ? fits : different, 0), 1));
  }
  return ordered;
}

export function transitionFor(style, bpmGapPercent, turn) {
  if (style !== 'mixed') return style;
  if (bpmGapPercent <= BLEND_LIMIT_PERCENT) return 'blend';
  return MIXED_EXITS[turn % MIXED_EXITS.length];
}
