const MEASURE_RATE = 44100;
const MEASURE_TIMEOUT_MS = 30000;
const UNMEASURED = { lufs: null, peak: 0 };

let worker = null;
let nextJob = 1;
const jobs = new Map();

function settle(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  clearTimeout(job.timer);
  job.resolve(result);
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  [...jobs.keys()].forEach((id) => settle(id, UNMEASURED));
}

function startWorker() {
  const started = new Worker(new URL('./loudness-worker.js', import.meta.url), { type: 'module' });
  started.onmessage = ({ data: { id, lufs, peak } }) => settle(id, { lufs, peak });
  started.onerror = () => {
    if (worker === started) stopWorker();
  };
  return started;
}

export function measureBuffer(buffer) {
  return new Promise((resolve) => {
    const id = nextJob++;
    jobs.set(id, { resolve, timer: setTimeout(stopWorker, MEASURE_TIMEOUT_MS) });
    try {
      worker ??= startWorker();
      const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) => new Float32Array(buffer.getChannelData(index)));
      worker.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((channel) => channel.buffer));
    } catch {
      settle(id, UNMEASURED);
    }
  });
}

export async function measureFile(file) {
  const context = new OfflineAudioContext(1, 1, MEASURE_RATE);
  return measureBuffer(await context.decodeAudioData(await file.arrayBuffer()));
}
