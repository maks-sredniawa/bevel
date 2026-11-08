import glob
import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
NOISE = HERE / 'noise.wav'
TONES = '+'.join(f'sin(2*PI*{hz}*t)' for hz in [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'aevalsrc=0.05*({TONES}):s=44100:d=300', '-ac', '1', str(NOISE)], check=True)
SONG = sorted(glob.glob(os.path.expanduser('~/Music/CD01/*Uptown*.mp3')))[0]
BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
PRESETS = {
    'Rock': [5, 4, 2, -1, -2, 0, 2, 4, 5, 5], 'Pop': [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
    'Dance': [7, 5, 2, 0, 0, -2, -1, 0, 4, 5], 'Bass': [8, 7, 5, 2, 0, 0, 0, 0, 0, 0],
    'Treble': [0, 0, 0, 0, 0, 1, 3, 5, 7, 8], 'Vocal': [-3, -2, 0, 2, 4, 5, 4, 2, 0, -1],
}

HOOK = """
window.__gains = [];
const makeAnalyser = AudioContext.prototype.createAnalyser;
AudioContext.prototype.createAnalyser = function () { const n = makeAnalyser.call(this); window.__an = n; window.__rate = this.sampleRate; return n; };
const makeGain = AudioContext.prototype.createGain;
AudioContext.prototype.createGain = function () { const n = makeGain.call(this); window.__gains.push(n); return n; };
"""

MEASURE = """async (bands) => {
  const an = window.__an; an.smoothingTimeConstant = 0; an.fftSize = 32768;
  const n = an.frequencyBinCount, hz = window.__rate / 2 / n, sums = bands.map(() => 0);
  const frames = 18;
  for (let f = 0; f < frames; f++) {
    const d = new Float32Array(n); an.getFloatFrequencyData(d);
    bands.forEach((c, b) => {
      const lo = Math.max(1, Math.round(c * 0.93 / hz)), hi = Math.max(lo, Math.round(c * 1.07 / hz));
      let p = 0; for (let i = lo; i <= hi; i++) p += 10 ** (d[i] / 10);
      sums[b] += p / (hi - lo + 1);
    });
    await new Promise(r => setTimeout(r, 60));
  }
  return sums.map(s => 10 * Math.log10(s / frames));
}"""

results = []


def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('ok  ' if ok else 'FAIL'), name, detail)


def fmt(values):
    return ' '.join(f'{v:+5.1f}' for v in values)


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 950})
    context.add_init_script(HOOK)
    page = context.new_page()
    page.goto('http://127.0.0.1:8766/index.html')
    page.set_input_files('#file-input', str(NOISE))
    page.wait_for_function("document.querySelectorAll('#tracks .row').length === 1", polling=100)
    page.click('#play')
    page.wait_for_function("window.__an && !document.getElementById('audio').paused", polling=100)
    page.evaluate("window.__an.fftSize = 32768")
    page.wait_for_timeout(1100)

    measure = lambda: page.evaluate(MEASURE, BANDS)
    def settle():
        page.wait_for_timeout(900)
    def delta(base):
        return [a - b for a, b in zip(measure(), base)]
    flat = measure()
    again = delta(flat)
    print('band Hz          ', ' '.join(f'{b:>5}' for b in BANDS))
    print('noise floor check', fmt(again))
    check('measurement is steady (flat vs flat)', max(abs(v) for v in again) < 0.3, f'worst {max(abs(v) for v in again):.1f} dB')

    faders = page.locator('#faders .fader input')
    for index, hz in enumerate(BANDS):
        slider = faders.nth(index + 1)
        slider.focus(); page.keyboard.press('Home'); settle()
        shown = page.locator('#faders .fader output').nth(index + 1).inner_text()
        d = delta(flat)
        print(f'{hz:>5} Hz at -12    ', fmt(d))
        check(f'{hz} Hz fader cuts its own band by about 12 dB', abs(d[index] + 12) <= 0.5 and shown == '-12', f'{d[index]:+.1f} dB')
        far = [abs(v) for b, v in enumerate(d) if abs(b - index) >= 3]
        check(f'{hz} Hz fader leaves far bands alone', max(far) < 1.5, f'worst {max(far):.1f} dB')
        page.click('#eq-reset'); settle()

    for name, gains in PRESETS.items():
        page.select_option('#eq-preset', name); settle()
        d = delta(flat)
        headroom = -max(0, *gains)
        wanted = [g + headroom for g in gains]
        errors = [abs(a - b) for a, b in zip(d, wanted)]
        print(f'{name:>8} wanted    ', fmt(wanted))
        print(f'{name:>8} measured  ', fmt(d))
        check(f'{name} preset shapes the sound as labelled', max(errors) <= 4, f'worst error {max(errors):.1f} dB')
        shown = [page.locator('#faders .fader output').nth(i + 1).inner_text() for i in range(10)]
        check(f'{name} preset moves the faders', [int(s) for s in shown] == gains)

    page.select_option('#eq-preset', 'Bass'); settle()
    page.uncheck('#eq-enabled'); settle()
    d = delta(flat)
    check('Enabled off bypasses a preset', max(abs(v) for v in d) < 1.2, f'worst {max(abs(v) for v in d):.1f} dB')
    page.check('#eq-enabled'); settle()
    d = delta(flat)
    check('Enabled on brings it back', d[0] - d[6] > 5, f'31 Hz vs 2 kHz {d[0] - d[6]:+.1f} dB')
    page.click('#eq-reset'); settle()

    preamp = faders.nth(0)
    preamp.focus()
    for _ in range(6):
        page.keyboard.press('ArrowDown')
    settle()
    d = delta(flat)
    print('preamp -6        ', fmt(d))
    check('Preamp lowers every band by 6 dB', all(abs(v + 6) < 0.3 for v in d), page.locator('#faders .fader output').nth(0).inner_text())
    page.click('#eq-reset'); settle()

    master = lambda: page.evaluate("window.__gains.at(-1).gain.value")
    check('volume reaches the output', abs(master() - 0.72 ** 2) < 0.01, f'{master():.3f}')
    page.click('#mute'); wait = page.wait_for_timeout; wait(80)
    check('mute silences the output', master() == 0, master())
    page.click('#mute'); wait(80)

    page.select_option('#eq-preset', 'Rock'); settle()
    page.reload()
    page.wait_for_function("document.querySelectorAll('#tracks .row').length >= 1", polling=100)
    wait(400)
    check('preset is remembered', page.input_value('#eq-preset') == 'Rock')
    page.click('#play')
    page.wait_for_function("window.__an && !document.getElementById('audio').paused", polling=100)
    wait(600)
    d = delta(flat)
    print('Rock after reload', fmt(d))
    check('remembered preset is really applied to the sound', d[8] - d[4] > 4, f'8 kHz vs 500 Hz {d[8] - d[4]:+.1f} dB')
    page.click('#stop'); page.click('#eq-reset'); page.click('#clear'); wait(200)

    page.set_input_files('#file-input', SONG)
    page.wait_for_function("document.querySelectorAll('#tracks .row').length === 1", polling=100)
    page.click('#play')
    page.wait_for_function("window.__an && !document.getElementById('audio').paused", polling=100)
    wait(400)

    def segment():
        page.evaluate("document.getElementById('audio').currentTime = 60")
        wait(850)
        return measure()

    song_flat = segment()
    print('real song: Uptown Funk')
    print('flat again       ', fmt([a - b for a, b in zip(segment(), song_flat)]))
    page.select_option('#eq-preset', 'Bass'); settle()
    bass = [a - b for a, b in zip(segment(), song_flat)]
    print('Bass             ', fmt(bass))
    check('real song: Bass lifts lows against highs', (sum(bass[:2]) / 2) - (sum(bass[6:9]) / 3) > 5, f'{(sum(bass[:2]) / 2) - (sum(bass[6:9]) / 3):+.1f} dB')
    page.select_option('#eq-preset', 'Treble'); settle()
    treble = [a - b for a, b in zip(segment(), song_flat)]
    print('Treble           ', fmt(treble))
    check('real song: Treble lifts highs against lows', (sum(treble[7:9]) / 2) - (sum(treble[:3]) / 3) > 4, f'{(sum(treble[7:9]) / 2) - (sum(treble[:3]) / 3):+.1f} dB')
    state = page.evaluate("({ paused: document.getElementById('audio').paused, error: document.getElementById('audio').error?.message })")
    check('real song keeps playing through every change', not state['paused'] and not state.get('error'), state)
    browser.close()

NOISE.unlink()
print(sum(results), 'of', len(results))
sys.exit(0 if all(results) else 1)
