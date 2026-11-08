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
    try:
        wait_until(page, "document.getElementById('audio').currentTime > 0.5")
    except TimeoutError as error:
        audio = page.evaluate(AUDIO_STATE)
        raise TimeoutError(f'{error}; audio element: {json.dumps(audio)}; page errors: {page_errors}') from error
    page.evaluate('retroDJ.enable(true)')
    page.wait_for_timeout(500)
    enabled = page.evaluate('retroDJ.state().enabled')
    page.evaluate('retroDJ.enable(false)')
    page.evaluate("Object.defineProperty(window, 'documentPictureInPicture', { value: undefined })")
    page.click('#mini-toggle')
    wait_until(page, "document.getElementById('app').classList.contains('mini')")
    mini = {'strip_shown': page.is_visible('#mini'), 'full_player_hidden': not page.is_visible('.work')}
    mini['label'] = page.inner_text('#mini-marquee')
    page.click('#mini-play')
    wait_until(page, "document.getElementById('audio').paused")
    page.click('#mini-play')
    wait_until(page, "!document.getElementById('audio').paused")
    page.click('#mini-next')
    page.click('#mini-prev')
    page.click('#mini-restore')
    wait_until(page, "!document.getElementById('app').classList.contains('mini')")
    mini['full_player_back'] = page.is_visible('.work')
    browser.close()
    blocked = [text for text in console_errors if 'Content Security Policy' in text or 'Content-Security-Policy' in text]
    mini_ok = mini['strip_shown'] and mini['full_player_hidden'] and mini['full_player_back'] and bool(mini['label'])
    ok = title == 'Bevel' and enabled and mini_ok and not page_errors and not outside and not failed and not blocked
    print(json.dumps({'browser': name, 'ok': ok, 'mini': mini, 'page_errors': page_errors, 'blocked': blocked, 'outside': outside, 'failed': failed}, indent=1), flush=True)
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
    server.shutdown()
    sys.exit(0 if all(results) else 1)


main()
