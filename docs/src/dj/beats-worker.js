import { detectBeats } from './beats.js';

self.onmessage = ({ data: { id, samples, sampleRate } }) => {
  self.postMessage({ id, ...detectBeats(samples, sampleRate) });
};
