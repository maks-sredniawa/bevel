import { EQ_MAX_DB, EQ_MIN_DB, beatIndexAt, clamp, filterFrequencies, loopRange, wrapLoop } from './mixing.js';

const LOW_SHELF_HZ = 250;
const MID_HZ = 1000;
const MID_Q = 0.7;
const HIGH_SHELF_HZ = 4000;
const FILTER_Q = 0.9;
const SMOOTHING_SECONDS = 0.012;
const ECHO_FEEDBACK = 0.6;
const ECHO_BEATS = 0.75;
const ECHO_TAIL_SECONDS = 6;
const TAPE_STOP_SECONDS = 1.8;
const TAPE_STOP_FLOOR = 0.05;
const DEFAULT_BEAT_SECONDS = 0.5;
const HOT_CUES = 4;
const KILL_DB = -60;
const REMEMBERED_SONGS = 4;

let worker = null;
let nextJob = 1;
const jobs = new Map();
const decoded = new Map();

function analyse(buffer) {
  worker ??= new Worker(new URL('./beats-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    jobs.get(data.id)?.(data);
    jobs.delete(data.id);
  };
  const samples = new Float32Array(buffer.getChannelData(0));
  if (buffer.numberOfChannels > 1) {
    const right = buffer.getChannelData(1);
    for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] + right[i]) / 2;
  }
  const id = nextJob++;
  return new Promise((resolve) => {
    jobs.set(id, resolve);
    worker.postMessage({ id, samples, sampleRate: buffer.sampleRate }, [samples.buffer]);
  });
}

async function decodeAndAnalyse(context, file) {
  const remembered = decoded.get(file);
  if (remembered) {
    decoded.delete(file);
    decoded.set(file, remembered);
    return remembered;
  }
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  const { bpm, beats, downbeat } = await analyse(buffer);
  const song = { buffer, bpm, beats, downbeat };
  decoded.set(file, song);
  if (decoded.size > REMEMBERED_SONGS) decoded.delete(decoded.keys().next().value);
  return song;
}

export class Deck {
  #context;
  #source = null;
  #startedAt = 0;
  #echoEndsAt = 0;
  #offset = 0;
  #rate = 1;
  #bands;
  #lowPass;
  #highPass;
  #echoSend;
  #echoDelay;
  #kills = { high: false, mid: false, low: false };
  #eqDb = { high: 0, mid: 0, low: 0 };
  #tapeTimer = null;
  #rollTimer = null;

  constructor(context, output, name) {
    this.#context = context;
    this.name = name;
    this.track = null;
    this.buffer = null;
    this.beats = [];
    this.bpm = null;
    this.downbeat = 0;
    this.playing = false;
    this.pitch = 0;
    this.filter = 0;
    this.loop = null;
    this.cues = new Array(HOT_CUES).fill(null);
    this.synced = false;
    this.onEnded = null;

    const low = context.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = LOW_SHELF_HZ;
    const mid = context.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = MID_HZ;
    mid.Q.value = MID_Q;
    const high = context.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = HIGH_SHELF_HZ;
    this.#bands = { low, mid, high };

    this.#lowPass = context.createBiquadFilter();
    this.#lowPass.type = 'lowpass';
    this.#lowPass.Q.value = FILTER_Q;
    this.#highPass = context.createBiquadFilter();
    this.#highPass.type = 'highpass';
    this.#highPass.Q.value = FILTER_Q;

    this.input = context.createGain();
    this.level = context.createGain();
    this.crossfade = context.createGain();

    this.#echoSend = context.createGain();
    this.#echoSend.gain.value = 0;
    this.#echoDelay = context.createDelay(2);
    const feedback = context.createGain();
    feedback.gain.value = ECHO_FEEDBACK;

    this.input.connect(low).connect(mid).connect(high).connect(this.#lowPass).connect(this.#highPass).connect(this.level);
    this.level.connect(this.crossfade).connect(output);
    this.#highPass.connect(this.#echoSend).connect(this.#echoDelay);
    this.#echoDelay.connect(feedback).connect(this.#echoDelay);
    this.#echoDelay.connect(this.crossfade);
    this.setFilter(0);
  }

  get beatSeconds() {
    return this.bpm ? 60 / this.bpm : DEFAULT_BEAT_SECONDS;
  }

  get rate() {
    return this.#rate;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  get position() {
    if (!this.playing) return this.#offset;
    return wrapLoop(this.#offset + (this.#context.currentTime - this.#startedAt) * this.#rate, this.loop);
  }

  get beatIndex() {
    return beatIndexAt(this.beats, this.position);
  }

  async load(file, track) {
    this.stop();
    this.track = { ...track, analysing: true };
    this.buffer = null;
    this.beats = [];
    this.bpm = null;
    this.loop = null;
    this.cues.fill(null);
    this.#offset = 0;
    const { buffer, bpm, beats, downbeat } = await decodeAndAnalyse(this.#context, file);
    this.buffer = buffer;
    this.bpm = bpm;
    this.beats = beats;
    this.downbeat = downbeat;
    this.track = track;
    return this;
  }

  play() {
    if (this.playing || !this.buffer) return;
    this.#clearTape();
    this.#start(this.#offset);
  }

  pause() {
    if (!this.playing) return;
    this.#offset = this.position;
    this.#release();
    this.playing = false;
  }

  stop() {
    this.pause();
    this.#offset = 0;
  }

  seek(seconds) {
    const target = clamp(seconds, 0, this.duration);
    if (this.playing) {
      this.#release();
      this.#start(target);
    } else {
      this.#offset = target;
    }
  }

  seekBeat(index) {
    if (this.beats.length) this.seek(this.beats[clamp(Math.round(index), 0, this.beats.length - 1)]);
  }

  setRate(rate) {
    if (this.playing) {
      this.#offset = this.position;
      this.#startedAt = this.#context.currentTime;
      this.#source.playbackRate.setValueAtTime(rate, this.#context.currentTime);
    }
    this.#rate = rate;
  }

  setPitch(percent) {
    this.pitch = percent;
    this.setRate(1 + percent / 100);
  }

  setEq(band, db) {
    this.#eqDb[band] = clamp(db, EQ_MIN_DB, EQ_MAX_DB);
    this.#applyBand(band);
  }

  setKill(band, on) {
    this.#kills[band] = on;
    this.#applyBand(band);
  }

  eqState() {
    return { ...this.#eqDb, kills: { ...this.#kills } };
  }

  setFilter(value) {
    this.filter = clamp(value, -1, 1);
    const { lowPass, highPass } = filterFrequencies(this.filter);
    const now = this.#context.currentTime;
    this.#lowPass.frequency.setTargetAtTime(lowPass, now, SMOOTHING_SECONDS);
    this.#highPass.frequency.setTargetAtTime(highPass, now, SMOOTHING_SECONDS);
  }

  setLoop(beatCount) {
    if (beatCount === null) {
      const position = this.position;
      this.loop = null;
      this.#offset = position;
      if (this.playing) {
        this.#startedAt = this.#context.currentTime;
        this.#source.loop = false;
      }
      return;
    }
    this.#offset = this.position;
    this.loop = loopRange(this.beats, this.#offset, beatCount, this.beatSeconds);
    if (this.playing) {
      this.#startedAt = this.#context.currentTime;
      this.#source.loopStart = this.loop.start;
      this.#source.loopEnd = this.loop.end;
      this.#source.loop = true;
    }
  }

  setCue(index, position = this.position) {
    this.cues[index] = position;
  }

  clearCue(index) {
    this.cues[index] = null;
  }

  correctTempo(factor) {
    if (!this.bpm || factor === 1) return;
    if (factor < 1) {
      const step = Math.round(1 / factor);
      this.beats = this.beats.filter((_, index) => index % step === 0);
    } else {
      const step = Math.round(factor);
      this.beats = this.beats.flatMap((beat, index) => {
        const next = this.beats[index + 1];
        if (next === undefined) return [beat];
        return Array.from({ length: step }, (_, part) => beat + ((next - beat) * part) / step);
      });
    }
    this.bpm = Math.round(this.bpm * factor * 10) / 10;
    this.downbeat = 0;
  }

  nudge(seconds) {
    this.seek(this.position + seconds);
  }

  peaks(buckets) {
    if (!this.buffer) return [];
    const channel = this.buffer.getChannelData(0);
    const size = Math.floor(channel.length / buckets);
    return Array.from({ length: buckets }, (_, bucket) => {
      let peak = 0;
      for (let i = bucket * size; i < (bucket + 1) * size; i += 32) peak = Math.max(peak, Math.abs(channel[i]));
      return peak;
    });
  }

  jumpCue(index) {
    if (this.cues[index] !== null) this.seek(this.cues[index]);
  }

  roll(beats, repeats) {
    clearTimeout(this.#rollTimer);
    const resume = this.position + beats * this.beatSeconds * repeats;
    this.setLoop(beats);
    this.#rollTimer = setTimeout(() => {
      this.setLoop(null);
      this.seek(resume);
    }, (beats * this.beatSeconds * repeats * 1000) / this.#rate);
  }

  echoOut() {
    const now = this.#context.currentTime;
    this.#echoDelay.delayTime.setValueAtTime(this.beatSeconds * ECHO_BEATS, now);
    this.#echoSend.gain.setValueAtTime(1, now);
    this.#echoSend.gain.setValueAtTime(1, now + this.beatSeconds);
    this.#echoSend.gain.linearRampToValueAtTime(0, now + this.beatSeconds * 1.25);
    this.#echoEndsAt = now + this.beatSeconds * 1.25;
    setTimeout(() => this.pause(), this.beatSeconds * 1000);
    return ECHO_TAIL_SECONDS;
  }

  tapeStop(seconds = TAPE_STOP_SECONDS) {
    if (!this.playing) return;
    const now = this.#context.currentTime;
    this.#offset = this.position;
    this.#startedAt = now;
    const rate = this.#rate;
    this.#source.playbackRate.setValueAtTime(rate, now);
    this.#source.playbackRate.linearRampToValueAtTime(TAPE_STOP_FLOOR, now + seconds);
    this.#offset += ((rate + TAPE_STOP_FLOOR) / 2) * seconds;
    this.#tapeTimer = setTimeout(() => {
      this.#release();
      this.playing = false;
    }, seconds * 1000);
  }

  #clearTape() {
    clearTimeout(this.#tapeTimer);
  }

  #applyBand(band) {
    const db = this.#kills[band] ? KILL_DB : this.#eqDb[band];
    this.#bands[band].gain.setTargetAtTime(db, this.#context.currentTime, SMOOTHING_SECONDS);
  }

  #closeFinishedEcho() {
    const now = this.#context.currentTime;
    if (now < this.#echoEndsAt) return;
    this.#echoSend.gain.cancelScheduledValues(now);
    this.#echoSend.gain.setValueAtTime(0, now);
  }

  #start(offset) {
    this.#closeFinishedEcho();
    const source = this.#context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.#rate;
    if (this.loop) {
      source.loop = true;
      source.loopStart = this.loop.start;
      source.loopEnd = this.loop.end;
    }
    source.connect(this.input);
    source.onended = () => {
      if (this.#source !== source) return;
      this.#source = null;
      this.playing = false;
      this.#offset = 0;
      this.onEnded?.(this);
    };
    source.start(0, offset);
    this.#source = source;
    this.#startedAt = this.#context.currentTime;
    this.#offset = offset;
    this.playing = true;
  }

  #release() {
    clearTimeout(this.#rollTimer);
    this.#clearTape();
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped by a tape stop finishing at the same moment
      }
      source.disconnect();
    }
  }
}
