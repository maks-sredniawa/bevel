const CELL = 4;
const BAR_COUNT = 20;
const LOWEST_HZ = 31;
const HIGHEST_HZ = 16000;
const PEAK_FALL = 0.012;

export function logBands(frequencyData, sampleRate, count = BAR_COUNT) {
  const hzPerBin = sampleRate / 2 / frequencyData.length;
  const ratio = (HIGHEST_HZ / LOWEST_HZ) ** (1 / count);
  return Array.from({ length: count }, (_, band) => {
    const first = Math.floor((LOWEST_HZ * ratio ** band) / hzPerBin);
    const last = Math.min(Math.max(first + 1, Math.ceil((LOWEST_HZ * ratio ** (band + 1)) / hzPerBin)), frequencyData.length);
    let peak = 0;
    for (let bin = first; bin < last; bin++) peak = Math.max(peak, frequencyData[bin] ?? 0);
    return peak / 255;
  });
}

export class Visualiser {
  #canvas;
  #context;
  #getAnalyser;
  #getSampleRate;
  #peaks = new Array(BAR_COUNT).fill(0);
  #frame = null;

  constructor(canvas, { getAnalyser, getSampleRate }) {
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
    this.#getAnalyser = getAnalyser;
    this.#getSampleRate = getSampleRate;
    this.mode = 'spectrum';
  }

  run() {
    if (this.#frame === null) this.#loop();
  }

  stop() {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#peaks.fill(0);
    this.draw(true);
  }

  #loop() {
    this.draw();
    this.#frame = requestAnimationFrame(() => this.#loop());
  }

  draw(idle = false) {
    const ctx = this.#context;
    const canvas = this.#canvas;
    const ratio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const bright = styles.getPropertyValue('--viz').trim();
    const dim = styles.getPropertyValue('--viz-2').trim();
    const analyser = idle ? null : this.#getAnalyser();

    if (this.mode === 'off') {
      ctx.fillStyle = dim;
      ctx.font = '11px monospace';
      ctx.fillText('VISUALISER OFF', 8, 16);
    } else if (this.mode === 'scope') {
      this.#drawScope(ctx, width, height, analyser, bright);
    } else {
      this.#drawSpectrum(ctx, width, height, analyser, bright, dim);
    }
  }

  #drawSpectrum(ctx, width, height, analyser, bright, dim) {
    let levels = new Array(BAR_COUNT).fill(0);
    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      levels = logBands(data, this.#getSampleRate());
    }
    const barWidth = Math.max(CELL, Math.floor((width - 12) / BAR_COUNT / CELL) * CELL - CELL);
    const usable = height - 20;
    levels.forEach((level, index) => {
      const rows = Math.floor((level * usable) / CELL);
      const x = 6 + index * (barWidth + CELL);
      for (let row = 0; row < rows; row++) {
        ctx.fillStyle = row > rows * 0.7 ? bright : dim;
        for (let cell = 0; cell < barWidth; cell += CELL) ctx.fillRect(x + cell, height - 14 - (row + 1) * CELL, CELL - 1, CELL - 1);
      }
      this.#peaks[index] = Math.max(level, this.#peaks[index] - PEAK_FALL);
      if (this.#peaks[index] > 0.01) {
        const peakRow = Math.floor((this.#peaks[index] * usable) / CELL);
        ctx.fillStyle = bright;
        ctx.fillRect(x, height - 14 - (peakRow + 2) * CELL, barWidth - 1, CELL - 1);
      }
    });
  }

  #drawScope(ctx, width, height, analyser, bright) {
    ctx.fillStyle = bright;
    const middle = height / 2;
    if (!analyser) {
      for (let x = 0; x < width; x += CELL) ctx.fillRect(x, Math.round(middle / CELL) * CELL, CELL - 1, CELL - 1);
      return;
    }
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    for (let x = 0; x < width; x += CELL) {
      const sample = data[Math.floor((x / width) * data.length)] / 128 - 1;
      ctx.fillRect(x, Math.round((middle + sample * (middle - 8)) / CELL) * CELL, CELL - 1, CELL - 1);
    }
  }
}
