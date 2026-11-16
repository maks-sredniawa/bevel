import { soundProfile } from './sound.js';

self.onmessage = ({ data: { id, channels, sampleRate } }) => {
  try {
    self.postMessage({ id, profile: soundProfile(channels, sampleRate) });
  } catch {
    self.postMessage({ id, profile: null });
  }
};
