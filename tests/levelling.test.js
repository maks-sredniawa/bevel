import assert from 'node:assert/strict';
import { test } from 'node:test';

let behaviour = 'reply';

class FakeWorker {
  constructor() {
    this.terminated = false;
  }

  postMessage({ id }) {
    if (this.terminated || behaviour === 'throw') throw new Error('cannot post');
    if (behaviour === 'reply') queueMicrotask(() => this.onmessage({ data: { id, lufs: -14, peak: 0.9 } }));
    if (behaviour === 'crash') queueMicrotask(() => this.onerror(new Error('worker failed')));
  }

  terminate() {
    this.terminated = true;
  }
}

globalThis.Worker = FakeWorker;
const { measureBuffer } = await import('../docs/src/levelling.js');

const buffer = { numberOfChannels: 2, sampleRate: 44100, getChannelData: () => new Float32Array(8) };
const UNMEASURED = { lufs: null, peak: 0 };

test('a measured song returns its loudness and peak', async () => {
  behaviour = 'reply';
  assert.deepEqual(await measureBuffer(buffer), { lufs: -14, peak: 0.9 });
});

test('a crashed worker leaves every waiting song unmeasured and the next one gets a fresh worker', async () => {
  behaviour = 'crash';
  assert.deepEqual(await Promise.all([measureBuffer(buffer), measureBuffer(buffer)]), [UNMEASURED, UNMEASURED]);
  behaviour = 'reply';
  assert.deepEqual(await measureBuffer(buffer), { lufs: -14, peak: 0.9 });
});

test('a song that cannot be sent to the worker is left unmeasured', async () => {
  behaviour = 'throw';
  assert.deepEqual(await measureBuffer(buffer), UNMEASURED);
});

test('a worker that never answers gives up after thirty seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  behaviour = 'hang';
  const measuring = measureBuffer(buffer);
  t.mock.timers.tick(30000);
  assert.deepEqual(await measuring, UNMEASURED);
});
