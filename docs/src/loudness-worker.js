import { measureLoudness } from './loudness.js';

self.onmessage = ({ data: { id, channels, sampleRate } }) => {
  self.postMessage({ id, ...measureLoudness(channels, sampleRate) });
};
