import json
import math
import os
import pathlib
import struct
import sys
import tempfile
import threading
import time
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

DOCS = pathlib.Path(__file__).resolve().parents[2] / 'docs'
PORT = 8771
BASE = f'http://127.0.0.1:{PORT}/bevel/'
SITE_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "media-src 'self' blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self'; object-src 'none'; "
    "base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
)
POLICY = os.environ.get('BEVEL_CSP', SITE_POLICY)
STALLED_CONTEXT = """
Object.defineProperty(AudioContext.prototype, 'state', { get: () => 'suspended' });
AudioContext.prototype.resume = () => new Promise(() => {});
"""
SEEK_RATIO = "(() => { const seek = document.getElementById('seek'); return Number(seek.value) / Number(seek.max); })()"
SEEK_VALUE = "Number(document.getElementById('seek').value)"
TONE_RATE = 22050
TONE_HZ = 820
ANALYSER_HOOK = """
const makeAnalyser = AudioContext.prototype.createAnalyser;
AudioContext.prototype.createAnalyser = function () { window.__analyser = makeAnalyser.call(this); window.__rate = this.sampleRate; return window.__analyser; };
"""
TONE_LEVEL = """(tone) => {
  const analyser = window.__analyser;
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  const binHz = window.__rate / 2 / data.length;
  let loudest = -200;
  for (let i = Math.round(tone * 0.9 / binHz); i <= Math.round(tone * 1.1 / binHz); i++) loudest = Math.max(loudest, data[i]);
  return Math.round(loudest);
}"""
AUDIO_STATE = """(() => {
  const audio = document.getElementById('audio');
  return { paused: audio.paused, time: audio.currentTime, ready: audio.readyState, network: audio.networkState, duration: audio.duration, error: audio.error?.message ?? null };
})()"""


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        return super().translate_path(path.removeprefix('/bevel'))

    def end_headers(self):
        self.send_header('Content-Security-Policy', POLICY)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        super().end_headers()

    def log_message(self, *args):
        pass


def silent_song(path):
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(b'\0\0\0\0' * 44100 * 20)


def wait_until(page, expression, seconds=20):
    deadline = time.monotonic() + seconds
    while not page.evaluate(expression):
        if time.monotonic() > deadline:
            raise TimeoutError(f'never became true: {expression}')
        page.wait_for_timeout(100)


def check_handle_keeps_following(page):
    page.evaluate("document.getElementById('audio').pause()")
    page.wait_for_timeout(300)
    box = page.locator('#seek').bounding_box()
    ratio = page.evaluate(SEEK_RATIO)
    before = page.evaluate(SEEK_VALUE)
    page.mouse.move(box['x'] + 7 + (box['width'] - 14) * ratio, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.mouse.up()
    after = page.evaluate(SEEK_VALUE)
    if after != before:
        raise AssertionError(f'click missed the seek thumb: value went from {before} to {after}')
    page.evaluate("document.getElementById('audio').play()")
    wait_until(page, f"{SEEK_VALUE} > {before + 1}", seconds=10)


def check(driver, name, song):
    browser = getattr(driver, name).launch(headless=True, channel=os.environ.get('BROWSER_CHANNEL'))
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    page = context.new_page()
    page_errors, console_errors, outside, failed = [], [], [], []
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('request', lambda request: outside.append(request.url) if not request.url.startswith((BASE, 'blob:', 'data:')) else None)
    page.on('response', lambda response: failed.append((response.status, response.url)) if response.status >= 400 else None)
    page.goto(BASE + 'index.html')
    wait_until(page, 'window.retroDJ !== undefined')
    title = page.title()
    page.set_input_files('#file-input', str(song))
    wait_until(page, "document.querySelectorAll('#tracks .row').length === 1")
    page.click('#play')
    plays = name not in os.environ.get('BEVEL_NO_AUDIO', '').split()
    try:
        wait_until(page, "document.getElementById('audio').currentTime > 0.5" if plays else "document.getElementById('status').textContent.includes('No sound output')")
    except TimeoutError as error:
        audio = page.evaluate(AUDIO_STATE)
        raise TimeoutError(f'{error}; audio element: {json.dumps(audio)}; page errors: {page_errors}') from error
    if plays:
        check_handle_keeps_following(page)
    page.evaluate('retroDJ.enable(true)')
    page.wait_for_timeout(500)
    enabled = page.evaluate('retroDJ.state().enabled')
    page.evaluate('retroDJ.enable(false)')
    page.evaluate("Object.defineProperty(window, 'documentPictureInPicture', { value: undefined })")
    page.click('#mini-toggle')
    wait_until(page, "document.getElementById('app').classList.contains('mini')")
    mini = {'strip_shown': page.is_visible('#mini'), 'full_player_hidden': not page.is_visible('.work')}
    mini['label'] = page.inner_text('#mini-marquee')
    mini['focus_moved_in'] = page.evaluate("document.activeElement.id") == 'mini-play'
    if plays:
        page.click('#mini-play')
        wait_until(page, "document.getElementById('audio').paused")
        page.click('#mini-play')
        wait_until(page, "!document.getElementById('audio').paused")
    page.click('#mini-next')
    page.click('#mini-prev')
    page.click('#mini-restore')
    wait_until(page, "!document.getElementById('app').classList.contains('mini')")
    mini['full_player_back'] = page.is_visible('.work')
    mini['focus_moved_back'] = page.evaluate("document.activeElement.id") == 'mini-toggle'
    browser.close()
    blocked = [text for text in console_errors if 'Content Security Policy' in text or 'Content-Security-Policy' in text]
    mini_ok = all(mini.values())
    ok = title == 'Bevel' and enabled and mini_ok and not page_errors and not outside and not failed and not blocked
    print(json.dumps({'browser': name, 'ok': ok, 'mini': mini, 'page_errors': page_errors, 'blocked': blocked, 'outside': outside, 'failed': failed}, indent=1), flush=True)
    return ok


def check_stalled_output(driver, song):
    browser = driver.chromium.launch(headless=True, channel=os.environ.get('BROWSER_CHANNEL'))
    page = browser.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    page.add_init_script(STALLED_CONTEXT)
    page.goto(BASE + 'index.html')
    wait_until(page, 'window.retroDJ !== undefined')
    page.set_input_files('#file-input', str(song))
    wait_until(page, "document.querySelectorAll('#tracks .row').length === 1")
    page.click('#play')
    wait_until(page, "document.getElementById('status').textContent.includes('No sound output')", seconds=10)
    browser.close()
    print(json.dumps({'check': 'stalled audio output reports a message', 'ok': True}), flush=True)
    return True


def tone_song(path, frequency):
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(TONE_RATE)
        output.writeframes(b''.join(struct.pack('<h', int(12000 * math.sin(2 * math.pi * frequency * i / TONE_RATE))) for i in range(TONE_RATE * 20)))


def check_echo_closes(driver, folder):
    first, second = pathlib.Path(folder) / 'Tester_-_Echoed.wav', pathlib.Path(folder) / 'Tester_-_Later.wav'
    tone_song(first, 300)
    tone_song(second, TONE_HZ)
    browser = driver.chromium.launch(headless=True, channel=os.environ.get('BROWSER_CHANNEL'), args=['--mute-audio'])
    page = browser.new_context(viewport={'width': 1280, 'height': 900}).new_page()
    page.add_init_script(ANALYSER_HOOK)
    page.goto(BASE + 'index.html')
    wait_until(page, 'window.retroDJ !== undefined')
    page.set_input_files('#file-input', [str(first), str(second)])
    wait_until(page, "document.querySelectorAll('#tracks .row').length === 2")
    page.mouse.click(1, 1)
    page.evaluate('retroDJ.enable(true)')
    wait_until(page, 'window.__analyser !== undefined')
    page.evaluate("retroDJ.load('a', 'Echoed')")
    wait_until(page, "retroDJ.state().a.track === 'Echoed' && !retroDJ.state().a.analysing", seconds=30)
    page.evaluate("retroDJ.crossfade(-1); retroDJ.play('a')")
    page.wait_for_timeout(2000)
    page.evaluate("retroDJ.echo('a'); retroDJ.pause('a')")
    page.wait_for_timeout(8000)
    page.evaluate("retroDJ.load('a', 'Later')")
    wait_until(page, "retroDJ.state().a.track === 'Later' && !retroDJ.state().a.analysing", seconds=30)
    page.evaluate("retroDJ.play('a')")
    page.wait_for_timeout(2500)
    page.evaluate("retroDJ.pause('a')")
    page.wait_for_timeout(1200)
    level = page.evaluate(TONE_LEVEL, TONE_HZ)
    browser.close()
    ok = level < -90
    print(json.dumps({'check': 'echo closes after Echo Out', 'ok': ok, 'level_db': level}), flush=True)
    return ok


def main():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), partial(Handler, directory=str(DOCS)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    with tempfile.TemporaryDirectory() as work, sync_playwright() as driver:
        song = pathlib.Path(work) / 'silence.wav'
        silent_song(song)
        for name in sys.argv[1:] or ['chromium', 'firefox', 'webkit']:
            try:
                results.append(check(driver, name, song))
            except Exception as error:
                print(json.dumps({'browser': name, 'ok': False, 'error': str(error)[:600]}, indent=1), flush=True)
                results.append(False)
        if 'chromium' in (sys.argv[1:] or ['chromium']):
            try:
                results.append(check_echo_closes(driver, work))
            except Exception as error:
                print(json.dumps({'check': 'echo closes after Echo Out', 'ok': False, 'error': str(error)[:600]}), flush=True)
                results.append(False)
            try:
                results.append(check_stalled_output(driver, song))
            except Exception as error:
                print(json.dumps({'check': 'stalled audio output reports a message', 'ok': False, 'error': str(error)[:600]}), flush=True)
                results.append(False)
    server.shutdown()
    sys.exit(0 if all(results) else 1)


main()
