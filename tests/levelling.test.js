import assert from 'node:assert/strict';
import { test } from 'node:test';

let behaviour = 'reply';
const workers = [];

class FakeWorker {
  constructor() {
    this.terminated = false;
    workers.push(this);
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

test('a hung worker is stopped on timeout, every waiting song is left unmeasured and the next one gets a fresh worker', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  behaviour = 'hang';
  const first = measureBuffer(buffer);
  t.mock.timers.tick(10000);
  const second = measureBuffer(buffer);
  const hung = workers.at(-1);
  t.mock.timers.tick(20000);
  const stillWaiting = new Promise((resolve) => setImmediate(() => resolve('still waiting')));
  assert.deepEqual(await Promise.race([Promise.all([first, second]), stillWaiting]), [UNMEASURED, UNMEASURED]);
  assert.equal(hung.terminated, true);
  behaviour = 'reply';
  assert.deepEqual(await measureBuffer(buffer), { lufs: -14, peak: 0.9 });
  assert.notEqual(workers.at(-1), hung);
});
