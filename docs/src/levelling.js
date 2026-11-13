const MEASURE_RATE = 44100;

let worker = null;
let nextJob = 1;
const jobs = new Map();

export function measureBuffer(buffer) {
  worker ??= new Worker(new URL('./loudness-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: { id, lufs, peak } }) => {
    jobs.get(id)?.({ lufs, peak });
    jobs.delete(id);
  };
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) => new Float32Array(buffer.getChannelData(index)));
  const id = nextJob++;
  return new Promise((resolve) => {
    jobs.set(id, resolve);
    worker.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((channel) => channel.buffer));
  });
}

export async function measureFile(file) {
  const context = new OfflineAudioContext(1, 1, MEASURE_RATE);
  return measureBuffer(await context.decodeAudioData(await file.arrayBuffer()));
}
