const DECKS = ['a', 'b'];
const BANDS = ['high', 'mid', 'low'];
const LOOP_BARS = [1, 2, 4, 8];
const HOT_CUES = [0, 1, 2, 3];
const WAVE_BUCKETS = 4000;
const WAVE_WINDOW_SECONDS = 16;
const FLAG_HEIGHT = 12;
const ROLL_BEATS = 1;
const ROLL_REPEATS = 8;
const BEATS_PER_BAR = 4;

const byId = (id) => document.getElementById(id);

function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function formatSigned(value, digits, unit) {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}${unit}`;
}

export function bindPanel({ dj, getActivePlaylist, setRowDecks }) {
  const peaks = { a: [], b: [] };
  const peakTitle = { a: null, b: null };
  const cuePoint = { a: 0, b: 0 };
  const loopBars = { a: null, b: null };
  const dragging = new Set();
  let frame = null;

  const el = (deck, name) => byId(`deck-${deck}-${name}`);
  const run = async (action) => {
    await dj.enable(true);
    return action();
  };

  function drawWave(deck, state) {
    const canvas = el(deck, 'wave');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(document.documentElement);
    const bright = styles.getPropertyValue('--viz').trim();
    const dim = styles.getPropertyValue('--viz-2').trim();
    const ink = styles.getPropertyValue('--well-ink').trim();
    const middle = height / 2;
    if (!state?.duration) {
      ctx.fillStyle = dim;
      ctx.fillRect(0, Math.round(middle), width, 1);
      return;
    }
    const left = state.position - WAVE_WINDOW_SECONDS / 2;
    const toX = (time) => ((time - left) / WAVE_WINDOW_SECONDS) * width;

    if (state.loop) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = bright;
      ctx.fillRect(toX(state.loop.start), 0, toX(state.loop.end) - toX(state.loop.start), height);
      ctx.globalAlpha = 1;
    }

    const list = peaks[deck];
    if (list.length) {
      ctx.fillStyle = dim;
      for (let x = 0; x < width; x += 2) {
        const time = left + (x / width) * WAVE_WINDOW_SECONDS;
        if (time < 0 || time > state.duration) continue;
        const peak = list[Math.floor((time / state.duration) * (list.length - 1))] ?? 0;
        const bar = Math.max(1, peak * (middle - 2));
        ctx.fillRect(x, middle - bar, 1, bar * 2);
      }
    }

    const grid = dj.grid(deck);
    grid.beats.forEach((beat, index) => {
      if (beat < left || beat > left + WAVE_WINDOW_SECONDS) return;
      const downbeat = (index - grid.downbeat) % BEATS_PER_BAR === 0;
      ctx.fillStyle = downbeat ? ink : bright;
      ctx.globalAlpha = downbeat ? 0.9 : 0.4;
      const tick = downbeat ? height : height / 3;
      ctx.fillRect(Math.round(toX(beat)), height - tick, 1, tick);
    });
    ctx.globalAlpha = 1;

    state.cues.forEach((cue, index) => {
      if (cue === null || cue < left || cue > left + WAVE_WINDOW_SECONDS) return;
      const x = Math.round(toX(cue));
      ctx.fillStyle = ink;
      ctx.fillRect(x, 0, 1, height);
      ctx.fillRect(x, 0, FLAG_HEIGHT, FLAG_HEIGHT);
      ctx.fillStyle = dim;
      ctx.font = 'bold 10px monospace';
      ctx.fillText(String(index + 1), x + 3, FLAG_HEIGHT - 2);
    });

    ctx.fillStyle = ink;
    ctx.fillRect(Math.round(width / 2) - 1, 0, 2, height);
  }

  function deckStatus(deck, state) {
    if (!state.track) return 'Nothing loaded';
    if (state.analysing) return 'Finding the beat…';
    if (state.playing) return state.sync ? 'Playing · synced' : 'Playing';
    return 'Cued';
  }

  function setInput(input, value) {
    if (document.activeElement === input && dragging.has(input)) return;
    if (input.value !== String(value)) input.value = String(value);
  }

  function renderDeck(deck, state) {
    const fieldset = byId(`deck-${deck}`);
    const ready = Boolean(state?.duration) && !state.analysing;
    let mode = 'empty';
    if (state?.analysing) mode = 'analysing';
    else if (ready) mode = 'ready';
    fieldset.dataset.state = mode;
    fieldset.querySelectorAll('button, input').forEach((control) => {
      control.disabled = !ready;
    });

    el(deck, 'title').textContent = state?.track ?? 'No track';
    el(deck, 'artist').textContent = state?.artist ?? '';
    el(deck, 'bpm').textContent = state?.bpm ? (state.bpm * state.rate).toFixed(1) : '---.-';
    el(deck, 'status').textContent = state ? deckStatus(deck, state) : 'Nothing loaded';
    if (!state) return;

    el(deck, 'play').setAttribute('aria-pressed', String(state.playing));
    el(deck, 'play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el(deck, 'sync').setAttribute('aria-pressed', String(state.sync));

    setInput(el(deck, 'pitch'), Math.round(state.pitch * 10) / 10);
    el(deck, 'pitch-value').textContent = formatSigned(state.pitch, 1, '%');

    BANDS.forEach((band) => {
      setInput(el(deck, band), state.eq[band]);
      el(deck, `${band}-value`).textContent = `${state.eq[band].toFixed(1)} dB`;
      el(deck, `${band}-kill`).setAttribute('aria-pressed', String(state.eq.kills[band]));
    });

    const filter = Math.round(state.filter * 100);
    setInput(el(deck, 'filter'), filter);
    el(deck, 'filter').style.setProperty('--v', `${(filter + 100) / 2}%`);
    el(deck, 'filter').setAttribute('aria-valuetext', filter === 0 ? 'off' : `${filter < 0 ? 'low-pass' : 'high-pass'} ${Math.abs(filter)}%`);

    if (!state.loop) loopBars[deck] = null;
    LOOP_BARS.forEach((bars) => el(deck, `loop-${bars}`).setAttribute('aria-pressed', String(loopBars[deck] === bars)));

    HOT_CUES.forEach((index) => {
      const button = el(deck, `cue-${index + 1}`);
      const cue = state.cues[index];
      button.dataset.set = String(cue !== null);
      button.setAttribute('aria-label', `Hot cue ${index + 1}, ${cue === null ? 'empty' : formatClock(cue)}`);
    });
  }

  function renderTime(deck, state) {
    const time = el(deck, 'time');
    const elapsed = formatClock(state?.position ?? 0);
    const remaining = `-${formatClock((state?.duration ?? 0) - (state?.position ?? 0))}`;
    if (time.firstChild?.nodeValue !== elapsed || time.lastChild?.textContent !== remaining) {
      const small = document.createElement('small');
      small.textContent = remaining;
      time.replaceChildren(elapsed, small);
    }
  }

  function render() {
    const state = dj.state();
    DECKS.forEach((deck) => {
      const current = state[deck];
      if (current?.duration && peakTitle[deck] !== current.track) {
        peakTitle[deck] = current.track;
        peaks[deck] = dj.peaks(deck, WAVE_BUCKETS);
      }
      renderDeck(deck, current);
      renderTime(deck, current);
      drawWave(deck, current);
    });
    setInput(byId('crossfader'), Math.round(state.crossfader * 100));
    byId('crossfader').setAttribute('aria-valuetext', state.crossfader === 0 ? 'centre' : `${Math.abs(Math.round(state.crossfader * 100))}% ${state.crossfader < 0 ? 'A' : 'B'}`);
    DECKS.forEach((deck) => {
      const percent = Math.round(state.levels[deck] * 100);
      setInput(byId(`level-${deck}`), percent);
      byId(`level-${deck}-value`).textContent = `${percent}%`;
    });
    byId('auto-dj').setAttribute('aria-pressed', String(state.auto.running));
    byId('auto-status').textContent = state.auto.running ? state.auto.status : 'Off · press Auto DJ to let it mix';
    setRowDecks({ a: state.a?.track ?? null, b: state.b?.track ?? null });
  }

  function loop() {
    render();
    frame = requestAnimationFrame(loop);
  }

  function bindRange(input, onChange) {
    input.addEventListener('pointerdown', () => dragging.add(input));
    input.addEventListener('pointerup', () => dragging.delete(input));
    input.addEventListener('input', () => run(() => onChange(Number(input.value))));
  }

  DECKS.forEach((deck) => {
    el(deck, 'play').addEventListener('click', () => run(() => (dj.state()[deck].playing ? dj.pause(deck) : dj.play(deck))));
    el(deck, 'cue').addEventListener('click', () => run(() => {
      const state = dj.state()[deck];
      if (state.playing) {
        dj.pause(deck);
        dj.seek(deck, cuePoint[deck]);
      } else {
        cuePoint[deck] = state.position;
      }
      render();
    }));
    el(deck, 'sync').addEventListener('click', () => run(() => dj.sync(deck, !dj.state()[deck].sync)));
    bindRange(el(deck, 'pitch'), (value) => dj.pitch(deck, value));
    BANDS.forEach((band) => {
      bindRange(el(deck, band), (value) => dj.eq(deck, band, value));
      el(deck, `${band}-kill`).addEventListener('click', () => run(() => dj.kill(deck, band, !dj.state()[deck].eq.kills[band])));
    });
    bindRange(el(deck, 'filter'), (value) => dj.filter(deck, value / 100));
    LOOP_BARS.forEach((bars) => {
      el(deck, `loop-${bars}`).addEventListener('click', () => run(() => {
        const off = loopBars[deck] === bars;
        loopBars[deck] = off ? null : bars;
        dj.loop(deck, off ? null : bars);
      }));
    });
    HOT_CUES.forEach((index) => {
      el(deck, `cue-${index + 1}`).addEventListener('click', (event) => run(() => {
        if (event.shiftKey) dj.clearCue(deck, index);
        else if (dj.state()[deck].cues[index] === null) dj.setCue(deck, index);
        else dj.jumpCue(deck, index);
      }));
    });
    el(deck, 'roll').addEventListener('click', () => run(() => {
      const button = el(deck, 'roll');
      const state = dj.state()[deck];
      button.setAttribute('aria-pressed', 'true');
      dj.roll(deck, ROLL_BEATS, ROLL_REPEATS);
      setTimeout(() => button.setAttribute('aria-pressed', 'false'), (60 / (state.bpm * state.rate)) * ROLL_BEATS * ROLL_REPEATS * 1000);
    }));
    el(deck, 'echo').addEventListener('click', () => run(() => dj.echo(deck)));
    el(deck, 'tape').addEventListener('click', () => run(() => dj.tape(deck)));
    bindRange(byId(`level-${deck}`), (value) => dj.level(deck, value / 100));
  });
  bindRange(byId('crossfader'), (value) => dj.crossfade(value / 100));
  byId('auto-dj').addEventListener('click', () => run(() => {
    if (dj.state().auto.running) {
      dj.stopAuto();
      return;
    }
    dj.auto({ playlist: getActivePlaylist(), style: byId('auto-style').value, bars: Number(byId('auto-bars').value) || 64 });
  }));

  return {
    show() {
      if (frame === null) loop();
    },
    hide() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
    render,
  };
}
