import json
import os
import pathlib
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
    page.mouse.move(box['x'] + 9 + (box['width'] - 18) * ratio, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.mouse.up()
    before = page.evaluate("Number(document.getElementById('seek').value)")
    page.evaluate("document.getElementById('audio').play()")
    wait_until(page, f"Number(document.getElementById('seek').value) > {before + 1}", seconds=10)


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
                results.append(check_stalled_output(driver, song))
            except Exception as error:
                print(json.dumps({'check': 'stalled audio output reports a message', 'ok': False, 'error': str(error)[:600]}), flush=True)
                results.append(False)
    server.shutdown()
    sys.exit(0 if all(results) else 1)


main()
