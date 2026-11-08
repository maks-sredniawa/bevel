export const BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const MAX_GAIN_DB = 12;

export const PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 4, 2, -1, -2, 0, 2, 4, 5, 5],
  Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
  Dance: [7, 5, 2, 0, 0, -2, -1, 0, 4, 5],
  Bass: [8, 7, 5, 2, 0, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 1, 3, 5, 7, 8],
  Vocal: [-3, -2, 0, 2, 4, 5, 4, 2, 0, -1],
};

export function clampGain(gain) {
  return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, gain));
}

export function headroomDb(gains) {
  return 0 - Math.max(0, ...gains);
}

export function dbToLinear(db) {
  return 10 ** (db / 20);
}
