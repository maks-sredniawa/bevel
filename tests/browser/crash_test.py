import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
PROFILE = HERE / 'crash-profile'
shutil.rmtree(PROFILE, ignore_errors=True)
LOAD = re.search(r'LOAD = """(.*?)"""', (HERE / 'ui_test.py').read_text(), re.S).group(1)
URL = 'http://127.0.0.1:8766/index.html'


def launch(p):
    return p.chromium.launch_persistent_context(str(PROFILE), channel='chrome', headless=True, viewport={'width': 1280, 'height': 900})


with sync_playwright() as p:
    context = launch(p)
    page = context.new_page()
    page.goto(URL)
    page.wait_for_timeout(500)
    page.evaluate(LOAD)
    page.wait_for_function("document.getElementById('status').textContent.includes('1:02') && !document.getElementById('status').textContent.includes('saving')")
    page.locator('#tracks .row:nth-child(1) .grip').drag_to(page.locator('#tracks .row:nth-child(3)'), target_position={'x': 200, 'y': 35})
    page.click('#play')
    page.wait_for_timeout(6500)
    before = page.evaluate("({ t: document.getElementById('audio').currentTime, rows: [...document.querySelectorAll('#tracks .row .t')].map(e => e.textContent) })")
    subprocess.run(['pkill', '-9', '-f', str(PROFILE)])
    time.sleep(1)
    try:
        context.close()
    except Exception:
        pass

with sync_playwright() as p:
    context = launch(p)
    page = context.new_page()
    page.goto(URL)
    page.wait_for_function("document.querySelectorAll('#tracks .row').length > 0", timeout=10000)
    page.wait_for_timeout(800)
    after = page.evaluate("({ t: document.getElementById('audio').currentTime, rows: [...document.querySelectorAll('#tracks .row .t')].map(e => e.textContent), current: document.querySelector('#tracks .current .t')?.textContent, stored: document.getElementById('status').textContent })")
    page.click('#play')
    page.wait_for_timeout(800)
    plays = page.evaluate("!document.getElementById('audio').paused && document.getElementById('audio').currentTime > 0")
    context.close()

shutil.rmtree(PROFILE, ignore_errors=True)
print('before crash', before)
print('after crash ', after)
print('plays after crash', plays)
ok = before['rows'] == after['rows'] and plays and before['t'] - after['t'] < 6.5
print('PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
