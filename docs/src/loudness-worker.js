import { measureLoudness } from './loudness.js';

self.onmessage = ({ data: { id, channels, sampleRate } }) => {
  try {
    self.postMessage({ id, ...measureLoudness(channels, sampleRate) });
  } catch {
    self.postMessage({ id, lufs: null, peak: 0 });
  }
};
