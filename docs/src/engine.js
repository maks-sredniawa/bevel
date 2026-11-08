import { BAND_FREQUENCIES, dbToLinear, headroomDb } from './equalizer.js';

const BAND_Q = 1.2;
const RESUME_LIMIT_MS = 3000;

export class AudioEngine {
  #context = null;
  #preamp = null;
  #filters = [];
  #master = null;
  #eq = { enabled: true, preamp: 0, gains: BAND_FREQUENCIES.map(() => 0) };
  #volume = 1;
  #muted = false;

  constructor(audio) {
    this.audio = audio;
    this.analyser = null;
    this.noOutput = false;
  }

  async start() {
    if (!this.#context) this.#build();
    this.noOutput = false;
    if (this.#context.state !== 'suspended') return;
    const limit = new Promise((resolve) => setTimeout(resolve, RESUME_LIMIT_MS, false));
    this.noOutput = !(await Promise.race([this.#context.resume().then(() => true), limit]));
  }

  get context() {
    return this.#context;
  }

  get input() {
    return this.#preamp;
  }

  get sampleRate() {
    return this.#context?.sampleRate ?? 44100;
  }

  setEq(eq) {
    this.#eq = eq;
    this.#applyEq();
  }

  setVolume(volume, muted) {
    this.#volume = volume;
    this.#muted = muted;
    this.#applyVolume();
  }

  #build() {
    const context = new AudioContext();
    const source = context.createMediaElementSource(this.audio);
    this.#preamp = context.createGain();
    this.#filters = BAND_FREQUENCIES.map((frequency) => {
      const filter = context.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = frequency;
      filter.Q.value = BAND_Q;
      return filter;
    });
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.#master = context.createGain();

    const chain = [source, this.#preamp, ...this.#filters, this.analyser, this.#master, context.destination];
    chain.slice(0, -1).forEach((node, index) => node.connect(chain[index + 1]));
    this.#context = context;
    this.#applyEq();
    this.#applyVolume();
  }

  #applyEq() {
    if (!this.#context) return;
    const { enabled, preamp, gains } = this.#eq;
    this.#preamp.gain.value = enabled ? dbToLinear(preamp + headroomDb(gains)) : 1;
    this.#filters.forEach((filter, index) => {
      filter.gain.value = enabled ? gains[index] : 0;
    });
  }

  #applyVolume() {
    if (this.#context) this.#master.gain.value = this.#muted ? 0 : this.#volume ** 2;
  }
}
