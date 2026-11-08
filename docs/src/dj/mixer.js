import { Deck } from './deck.js';
import {
  BLEND_LIMIT_PERCENT, beatIndexAt, chooseSection, clamp, crossfadeGains, matchingTempo, orderWithoutRepeats, phaseCorrection, transitionFor,
} from './mixing.js';

const BEATS_PER_BAR = 4;
const BLEND_BARS = 8;
const POLL_MS = 15;
const ROLL_BEATS = 4;
const STYLES = ['blend', 'echo', 'roll', 'tape', 'mixed'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function barLevels(buffer, beats, downbeat) {
  const channel = buffer.getChannelData(0);
  const levels = [];
  for (let i = downbeat; i + BEATS_PER_BAR < beats.length; i += BEATS_PER_BAR) {
    const from = Math.floor(beats[i] * buffer.sampleRate);
    const to = Math.floor(beats[i + BEATS_PER_BAR] * buffer.sampleRate);
    let sum = 0;
    for (let s = from; s < to; s += 64) sum += channel[s] ** 2;
    levels.push(Math.sqrt(sum / ((to - from) / 64 || 1)));
  }
  return levels;
}

export function createDJ({ engine, visualiser, pauseNormalPlayer, getPlaylists }) {
  let decks = null;
  let enabled = false;
  let crossfader = -1;
  const levels = { a: 1, b: 1 };
  let auto = { running: false, status: 'Off' };
  const listeners = new Set();

  const notify = () => listeners.forEach((listener) => listener());
  const deckOf = (name) => {
    if (!decks) throw new Error('DJ mode is off');
    return decks[name];
  };
  const other = (name) => decks[name === 'a' ? 'b' : 'a'];

  function applyCrossfader() {
    const { a, b } = crossfadeGains(crossfader);
    const now = engine.context.currentTime;
    decks.a.crossfade.gain.setTargetAtTime(a, now, 0.01);
    decks.b.crossfade.gain.setTargetAtTime(b, now, 0.01);
  }

  async function ensureDecks() {
    await engine.start();
    if (!decks) {
      decks = { a: new Deck(engine.context, engine.input, 'a'), b: new Deck(engine.context, engine.input, 'b') };
      applyCrossfader();
    }
  }

  function library(playlistName) {
    return getPlaylists()
      .filter((playlist) => !playlistName || playlist.name.startsWith(playlistName))
      .flatMap((playlist) => playlist.tracks.map((track) => ({
        title: track.title, artist: track.artist, duration: track.duration, playlist: playlist.name, file: track.file,
      })));
  }

  function find(query, playlistName) {
    const wanted = query.toLowerCase();
    const songs = library(playlistName);
    return songs.find((song) => song.title.toLowerCase() === wanted || song.artist.toLowerCase() === wanted)
      ?? songs.find((song) => `${song.artist} ${song.title} ${song.title} ${song.artist}`.toLowerCase().includes(wanted));
  }

  async function loadSong(name, song) {
    const deck = deckOf(name);
    notify();
    const loading = deck.load(song.file, { title: song.title, artist: song.artist, playlist: song.playlist });
    notify();
    await loading;
    notify();
    return deck;
  }

  function play(name) {
    pauseNormalPlayer();
    deckOf(name).play();
    visualiser.run();
    notify();
  }

  function setSync(name, on) {
    const deck = deckOf(name);
    const master = other(name);
    deck.synced = on;
    if (!on) {
      deck.setPitch(0);
    } else if (master.bpm && deck.bpm) {
      const rate = matchingTempo(master.bpm * master.rate, deck.bpm);
      deck.setRate(rate);
      deck.pitch = (rate - 1) * 100;
      if (master.playing && deck.playing) deck.seek(deck.position + phaseCorrection(master.beatIndex, deck.beatIndex) * deck.beatSeconds);
    }
    notify();
  }

  async function waitForBeat(deck, beat, token) {
    while (token.alive && deck.playing && deck.beatIndex < beat) await sleep(POLL_MS);
  }

  function resetDeckEq(deck) {
    ['high', 'mid', 'low'].forEach((band) => {
      deck.setKill(band, false);
      deck.setEq(band, 0);
    });
    deck.setFilter(0);
  }

  function setCrossfader(value) {
    crossfader = clamp(value, -1, 1);
    applyCrossfader();
    notify();
  }

  function cueSection(deck, wantedBars) {
    const levels = barLevels(deck.buffer, deck.beats, deck.downbeat);
    const bar = chooseSection(levels, wantedBars);
    const startBeat = deck.downbeat + bar * BEATS_PER_BAR;
    deck.seekBeat(startBeat);
    return startBeat;
  }

  async function blend(from, to, fromExitBeat, side, token) {
    const blendBeats = BLEND_BARS * BEATS_PER_BAR;
    const start = fromExitBeat - blendBeats;
    await waitForBeat(from, start, token);
    if (!token.alive) return;
    auto.status = `Blending into ${to.track.title}`;
    to.setKill('low', true);
    to.play();
    to.seek(to.position + phaseCorrection(from.beatIndex, to.beatIndex) * to.beatSeconds);
    notify();
    const startedAt = from.beatIndex;
    let swapped = false;
    while (token.alive && from.playing && from.beatIndex < fromExitBeat) {
      const progress = clamp((from.beatIndex - startedAt) / blendBeats, 0, 1);
      setCrossfader(side * (2 * progress - 1));
      if (!swapped && progress >= 0.5) {
        swapped = true;
        from.setKill('low', true);
        to.setKill('low', false);
      }
      await sleep(POLL_MS * 2);
    }
    if (!token.alive) return;
    setCrossfader(side);
    from.pause();
    resetDeckEq(from);
  }

  async function runAuto({ playlist, style = 'mixed', bars = 32 }, token) {
    const chosen = STYLES.includes(style) ? style : 'mixed';
    const songs = orderWithoutRepeats(library(playlist));
    if (songs.length < 2) throw new Error('Auto DJ needs at least two songs');
    let current = 'a';
    let index = 0;
    let turn = 0;
    auto.status = `Loading ${songs[0].title}`;
    notify();
    resetDeckEq(decks.a);
    resetDeckEq(decks.b);
    setCrossfader(-1);
    let deck = await loadSong('a', songs[0]);
    let entry = cueSection(deck, bars);
    if (!token.alive) return;
    play('a');
    while (token.alive) {
      const nextSong = songs[(index + 1) % songs.length];
      const nextName = current === 'a' ? 'b' : 'a';
      auto.status = `Now: ${deck.track.title}. Next: ${nextSong.title}`;
      notify();
      const incoming = await loadSong(nextName, nextSong);
      if (!token.alive) return;
      const gap = Math.abs((incoming.bpm - deck.bpm * deck.rate) / (deck.bpm * deck.rate)) * 100;
      const transition = transitionFor(chosen, gap, turn);
      const usable = transition === 'blend' && gap > BLEND_LIMIT_PERCENT ? 'echo' : transition;
      cueSection(incoming, bars);
      incoming.setPitch(0);
      const lastBeat = Math.min(entry + bars * BEATS_PER_BAR, deck.beats.length - 1);
      const side = nextName === 'b' ? 1 : -1;

      if (usable === 'blend') {
        incoming.setRate(matchingTempo(deck.bpm * deck.rate, incoming.bpm));
        incoming.pitch = (incoming.rate - 1) * 100;
        await blend(deck, incoming, lastBeat, side, token);
      } else {
        const exitBeat = usable === 'roll' ? lastBeat - ROLL_BEATS : lastBeat;
        await waitForBeat(deck, exitBeat, token);
        if (!token.alive) return;
        auto.status = { echo: 'Echo out', roll: 'Beat roll', tape: 'Tape stop', cut: 'Cut' }[usable];
        notify();
        if (usable === 'cut') {
          deck.pause();
        } else if (usable === 'roll') {
          for (const [size, repeats] of [[1, 2], [0.5, 2], [0.25, 4]]) {
            if (!token.alive) return;
            deck.setLoop(size);
            await sleep(size * deck.beatSeconds * repeats * 1000);
            deck.setLoop(null);
          }
          deck.pause();
        } else if (usable === 'echo') {
          deck.echoOut();
          await sleep(deck.beatSeconds * 1000);
        } else {
          deck.tapeStop();
          await sleep(1800);
        }
        if (!token.alive) return;
        setCrossfader(side);
        incoming.play();
      }
      if (!token.alive) return;
      current = nextName;
      deck = incoming;
      entry = deck.beatIndex;
      index = (index + 1) % songs.length;
      turn++;
    }
  }

  const api = {
    async enable(on) {
      if (on) await ensureDecks();
      enabled = on;
      if (!on) {
        api.stopAuto();
        decks?.a.pause();
        decks?.b.pause();
      }
      notify();
      return enabled;
    },
    get enabled() {
      return enabled;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state() {
      const describe = (deck) => (deck ? {
        track: deck.track?.title ?? null,
        artist: deck.track?.artist ?? null,
        analysing: Boolean(deck.track?.analysing),
        bpm: deck.bpm,
        position: deck.position,
        duration: deck.duration,
        beat: deck.beatIndex,
        playing: deck.playing,
        pitch: deck.pitch,
        rate: deck.rate,
        sync: deck.synced,
        eq: deck.eqState(),
        filter: deck.filter,
        loop: deck.loop,
        cues: [...deck.cues],
      } : null);
      return { enabled, a: describe(decks?.a), b: describe(decks?.b), crossfader, levels: { ...levels }, auto: { status: auto.status, running: auto.running } };
    },
    library: (playlistName) => library(playlistName).map(({ file, ...song }) => song),
    async load(name, query, playlistName) {
      await ensureDecks();
      const song = find(query, playlistName);
      if (!song) throw new Error(`No song matches "${query}"`);
      if (deckOf(name).playing) throw new Error(`Deck ${name.toUpperCase()} is playing`);
      await loadSong(name, song);
      return api.state()[name];
    },
    play,
    pause(name) {
      deckOf(name).pause();
      notify();
    },
    seek: (name, seconds) => deckOf(name).seek(seconds),
    seekBeat: (name, beat) => deckOf(name).seekBeat(beat),
    sync: setSync,
    pitch(name, percent) {
      deckOf(name).setPitch(clamp(percent, -8, 8));
      notify();
    },
    eq(name, band, db) {
      deckOf(name).setEq(band, db);
      notify();
    },
    kill(name, band, on) {
      deckOf(name).setKill(band, on);
      notify();
    },
    filter(name, value) {
      deckOf(name).setFilter(value);
      notify();
    },
    crossfade: setCrossfader,
    level(name, value) {
      levels[name] = clamp(value, 0, 1);
      deckOf(name).level.gain.setTargetAtTime(levels[name], engine.context.currentTime, 0.01);
      notify();
    },
    loop(name, bars) {
      deckOf(name).setLoop(bars === null ? null : bars * BEATS_PER_BAR);
      notify();
    },
    setCue(name, index, position) {
      deckOf(name).setCue(index, position);
      notify();
    },
    clearCue(name, index) {
      deckOf(name).clearCue(index);
      notify();
    },
    grid(name) {
      const deck = deckOf(name);
      return { bpm: deck.bpm, rate: deck.rate, beats: [...deck.beats], downbeat: deck.downbeat };
    },
    correctTempo(name, factor) {
      deckOf(name).correctTempo(factor);
      notify();
    },
    nudge: (name, seconds) => deckOf(name).nudge(seconds),
    peaks: (name, buckets) => deckOf(name).peaks(buckets),
    pauseDecks() {
      api.stopAuto();
      decks?.a.pause();
      decks?.b.pause();
      notify();
    },
    async loadTrack(name, track, playlist) {
      await ensureDecks();
      if (deckOf(name).playing) throw new Error(`Deck ${name.toUpperCase()} is playing`);
      await loadSong(name, { ...track, playlist });
      return api.state()[name];
    },
    jumpCue: (name, index) => deckOf(name).jumpCue(index),
    roll: (name, beats, repeats) => deckOf(name).roll(beats, repeats),
    echo: (name) => deckOf(name).echoOut(),
    tape: (name) => deckOf(name).tapeStop(),
    async auto(options = {}) {
      await ensureDecks();
      api.stopAuto();
      const token = { alive: true };
      auto = { running: true, status: 'Starting', token };
      notify();
      try {
        await runAuto(options, token);
      } catch (error) {
        auto.status = `Stopped: ${error.message}`;
      }
      if (auto.token === token) auto = { running: false, status: auto.status };
      notify();
    },
    stopAuto() {
      if (auto.token) auto.token.alive = false;
      auto = { running: false, status: 'Off' };
      notify();
    },
    beatIndexAt,
  };
  return api;
}
