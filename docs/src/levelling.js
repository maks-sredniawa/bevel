const DECODE_RATE = 44100;
const ANALYSIS_TIMEOUT_MS = 30000;

function workerRunner(script, { unmeasured, read }) {
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
    [...jobs.keys()].forEach((id) => settle(id, unmeasured));
  }

  function startWorker() {
    const started = new Worker(new URL(script, import.meta.url), { type: 'module' });
    started.onmessage = ({ data }) => settle(data.id, read(data));
    started.onerror = () => {
      if (worker === started) stopWorker();
    };
    return started;
  }

  return (buffer) => new Promise((resolve) => {
    const id = nextJob++;
    jobs.set(id, { resolve, timer: setTimeout(stopWorker, ANALYSIS_TIMEOUT_MS) });
    try {
      worker ??= startWorker();
      const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, index) => new Float32Array(buffer.getChannelData(index)));
      worker.postMessage({ id, channels, sampleRate: buffer.sampleRate }, channels.map((channel) => channel.buffer));
    } catch {
      settle(id, unmeasured);
    }
  });
}

export const measureBuffer = workerRunner('./loudness-worker.js', {
  unmeasured: { lufs: null, peak: 0 },
  read: ({ lufs, peak }) => ({ lufs, peak }),
});

export const profileBuffer = workerRunner('./sound-worker.js', {
  unmeasured: null,
  read: ({ profile }) => profile,
});

async function decodeFile(file) {
  const context = new OfflineAudioContext(1, 1, DECODE_RATE);
  return context.decodeAudioData(await file.arrayBuffer());
}

export async function measureFile(file) {
  return measureBuffer(await decodeFile(file));
}

export async function profileFile(file) {
  return profileBuffer(await decodeFile(file));
}
