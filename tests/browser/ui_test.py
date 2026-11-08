import json
from pathlib import Path

from playwright.sync_api import sync_playwright

LOAD = """async () => {
  const wav = (hz, sec) => {
    const sr = 44100, n = sr * sec, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * hz * i / sr) * 6000, true);
    return b;
  };
  const dt = new DataTransfer();
  [['1 - Alfa - One.wav', 300, 20], ['2 - Beta - Two.wav', 600, 20], ['3 - Gamma - Łąka.wav', 900, 20], ['4 - Delta - Four.wav', 1200, 2]]
    .forEach(([n, hz, s]) => dt.items.add(new File([wav(hz, s)], n)));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}"""

STATE = """() => {
  const a = document.getElementById('audio');
  return { paused: a.paused, t: Math.round(a.currentTime * 10) / 10, title: document.getElementById('marquee').textContent,
           elapsed: document.getElementById('elapsed').textContent, flag: document.getElementById('flag-play').textContent,
           flagOn: document.getElementById('flag-play').classList.contains('on') };
}"""

ROWS = """() => [...document.querySelectorAll('#tracks .row')].map(r =>
  r.querySelector('.t').textContent + (r.classList.contains('current') ? '*' : ''))"""

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))


with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 950})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8766/index.html')

    def wf(expression):
        try:
            page.wait_for_function(expression, polling=100, timeout=20000)
        except Exception:
            print('TIMEOUT waiting for', expression[:90])
            print('status:', page.inner_text('#status'))
            print('durations:', page.evaluate("[...document.querySelectorAll('#tracks .row')].map(r => r.querySelector('.dur').textContent)"))
            print('tabs:', page.evaluate("[...document.querySelectorAll('.pl-tab')].map(t => t.textContent)"))
            raise

    page.evaluate(LOAD)
    wf("document.getElementById('status').textContent.includes('1:02')")
    state = lambda: page.evaluate(STATE)
    rows = lambda: page.evaluate(ROWS)
    wait = page.wait_for_timeout

    check('durations and summary', '1:02 total' in page.inner_text('#status'), page.inner_text('#status'))
    check('wav details', '44100 HZ MONO' in page.inner_text('#lcd').upper(), page.inner_text('#rate-line'))

    page.click('#play'); wait(700); s = state()
    check('play', not s['paused'] and s['t'] > 0.2 and s['flagOn'], s)
    check('button becomes pause', page.get_attribute('#play', 'aria-label') == 'Pause')
    page.click('#next'); wait(500); s = state()
    check('next keeps playing', s['title'] == 'BETA - TWO' and not s['paused'], s)
    wait(3100)
    page.click('#prev'); wait(400); s = state()
    check('previous restarts a song past 3 s', s['title'] == 'BETA - TWO' and s['t'] < 2, s)
    page.click('#prev'); wait(400); s = state()
    check('previous at the start goes back a song', s['title'] == 'ALFA - ONE', s)
    page.click('#play'); wait(200); s = state()
    check('pause', s['paused'] and s['flag'] == 'PAUSE', s)
    page.click('#play'); wait(300)
    page.click('#stop'); wait(200); s = state()
    check('stop rewinds', s['paused'] and s['t'] == 0 and not s['flagOn'], s)

    page.click('#play'); wait(300)
    box = page.locator('#seek').bounding_box()
    page.mouse.click(box['x'] + box['width'] * 0.5, box['y'] + box['height'] / 2); wait(400); s = state()
    check('seek to the middle', 9 < s['t'] < 12, s)
    page.click('#stop')

    page.locator('#tracks .row:nth-child(1) .grip').drag_to(page.locator('#tracks .row:nth-child(4)'), target_position={'x': 200, 'y': 35})
    wait(200)
    check('drag to reorder', rows() == ['Two', 'Łąka', 'Four', 'One*'], rows())

    page.locator('#tracks .row:nth-child(2) .t').dblclick(); wait(500); s = state()
    check('double-click plays', s['title'] == 'GAMMA - ŁĄKA' and not s['paused'], s)
    page.click('#stop')

    page.locator('#tracks .row:nth-child(1) .t').click()
    check('click selects a row', 'selected' in page.locator('#tracks .row:nth-child(1)').get_attribute('class'))
    page.keyboard.press('ArrowDown'); wait(80)
    focused = page.evaluate("document.activeElement.querySelector('.t')?.textContent")
    check('arrow moves selection', focused == 'Łąka', focused)
    page.keyboard.press('Alt+ArrowDown'); wait(80)
    check('alt+arrow reorders', rows()[:3] == ['Two', 'Four', 'Łąka*'], rows())
    page.keyboard.press('Delete'); wait(120)
    check('delete removes', 'Łąka' not in ' '.join(rows()), rows())

    page.click('#repeat'); page.click('#shuffle'); wait(100)
    flags = page.evaluate("[...document.querySelectorAll('.flags span.on')].map(s => s.textContent)")
    check('shuffle and repeat flags', 'SHUF' in flags and 'RPT:ALL' in flags, flags)
    page.click('#shuffle'); page.click('#repeat'); page.click('#repeat')

    page.click('[data-skin-choice=nightshift]')
    check('skin', page.evaluate("document.documentElement.dataset.skin") == 'nightshift')
    page.click('[data-skin-choice=oatmeal]')

    page.click('.menu:nth-child(3) > button')
    check('menu opens', page.locator('.menu.open').count() == 1)
    check('menu focus', page.evaluate("document.activeElement.textContent") == 'DJ mode (advanced)')
    page.keyboard.press('ArrowDown')
    check('menu arrows', page.evaluate("document.activeElement.textContent") == 'Compact mode')
    page.keyboard.press('Escape')
    check('menu closes', page.locator('.menu.open').count() == 0)
    page.click('.menu:nth-child(5) > button'); page.click('text=Keyboard and privacy')
    check('help opens', page.evaluate("document.getElementById('help').open"))
    page.click('#help .close button')

    page.click('#compact'); wait(80)
    check('compact hides panels', not page.locator('.viz').is_visible() and page.locator('#play').is_visible())
    page.click('#compact')

    page.evaluate("document.activeElement.blur()")
    page.keyboard.press('m')
    check('m mutes', page.get_attribute('#mute', 'aria-pressed') == 'true')
    page.keyboard.press('m')
    page.keyboard.press('ArrowDown')
    check('arrow lowers volume', page.inner_text('#volume-value') == '67%', page.inner_text('#volume-value'))
    page.keyboard.press('ArrowUp')
    page.keyboard.press('Space'); wait(300)
    check('space plays', not state()['paused'], state())
    page.keyboard.press('s'); wait(100)
    check('s stops', state()['paused'])

    page.select_option('#eq-preset', 'Rock')
    check('preset moves faders', page.locator('#faders .fader output').nth(1).inner_text() == '+5')
    page.locator('#faders .fader input').nth(3).focus(); page.keyboard.press('ArrowUp'); wait(50)
    check('moving a fader means custom', page.input_value('#eq-preset') == 'Custom')
    page.click('#eq-reset')
    check('reset flattens', page.input_value('#eq-preset') == 'Flat' and page.locator('#faders .fader output').nth(1).inner_text() == '0')

    page.fill('#search', 'beta'); wait(100)
    check('filter', page.locator('#tracks .row').count() == 1 and '1 of 3' in page.inner_text('#status'), page.inner_text('#status'))
    page.fill('#search', '')

    before = rows()
    page.click('#stop')
    page.locator('#tracks .row:nth-child(1) .t').dblclick(); wait(400)
    box = page.locator('#seek').bounding_box()
    page.mouse.click(box['x'] + box['width'] * 0.25, box['y'] + box['height'] / 2); wait(300)
    page.click('#play'); wait(900)
    position = state()
    page.reload()
    wf("document.querySelectorAll('#tracks .row').length > 0")
    wait(500)
    after = rows()
    check('playlist and order survive a reload', [r.rstrip('*') for r in after] == [r.rstrip('*') for r in before], [before, after])
    check('current song survives a reload', after[0].endswith('*'), after)
    s = state()
    check('position survives a reload', s['paused'] and abs(s['t'] - position['t']) < 1.5, [position, s])
    page.click('#play'); wait(600); s = state()
    check('a remembered song plays', not s['paused'] and s['t'] > position['t'] - 1, s)
    page.click('#stop')
    page.locator('#tracks .row:nth-child(2) .rm').click(); wait(500)
    remaining = rows()
    page.reload()
    wf("document.querySelectorAll('#tracks .row').length > 0")
    check('a removed song stays removed', len(rows()) == len(remaining), [remaining, rows()])
    page.evaluate(LOAD)
    wait(800)
    check('adding after a restore skips songs already there, with no id clashes', len(rows()) == 4 and len(set(page.evaluate("[...document.querySelectorAll('#tracks .row')].map(r => r.dataset.id)"))) == 4, rows())
    page.click('#clear'); wait(500)
    page.reload(); wait(600)
    check('clear also forgets the songs', 'No tracks' in page.inner_text('#status'), page.inner_text('#status'))
    stored = page.evaluate("new Promise(r => { const q = indexedDB.open('retro-music-player'); q.onsuccess = () => { const c = q.result.transaction('files').objectStore('files').count(); c.onsuccess = () => r(c.result); }; })")
    check('clear frees the stored copies', stored == 0, stored)

    page.evaluate(LOAD)
    wf("document.getElementById('status').textContent.includes('1:02')")
    first_row = page.evaluate("document.querySelector('#tracks .row .t').textContent")
    check('before shuffle the first song is selected', page.evaluate("document.querySelector('#tracks .current .t').textContent") == first_row)
    page.click('#shuffle'); wait(150)
    picked = page.evaluate("document.querySelector('#tracks .current .t').textContent")
    check('shuffle with nothing playing picks a random first song', picked != first_row and state()['paused'], picked)
    shown = [r.rstrip('*') for r in rows()]
    original = sorted(shown)
    check('the rows themselves are shuffled, current song on top', rows()[0] == picked + '*', rows())
    numbers = page.evaluate("[...document.querySelectorAll('#tracks .row .no')].map(n => n.textContent)")
    check('shuffled rows are renumbered', numbers == ['01', '02', '03', '04'], numbers)
    check('LCD counts the shuffled position', 'TRK 01/04' in page.inner_text('#lcd'), page.inner_text('#track-number'))
    played_order = [picked]
    for _ in range(3):
        page.click('#next'); wait(120)
        played_order.append(page.evaluate("document.querySelector('#tracks .current .t').textContent"))
    check('the list shows exactly what plays', played_order == shown, [played_order, shown])
    check('pressing shuffle does not scroll the page', page.evaluate('scrollY') == 0)
    page.click('#shuffle'); wait(100)
    check('turning shuffle off restores the original order', sorted(r.rstrip('*') for r in rows()) == original and [r.rstrip('*') for r in rows()][0] == first_row, rows())
    page.click('#shuffle'); wait(100)
    page.click('#shuffle'); wait(100)
    page.click('#play'); wait(500)
    playing = page.evaluate("document.querySelector('#tracks .current .t').textContent")
    page.click('#shuffle'); wait(200)
    check('shuffle does not interrupt the song that is playing', page.evaluate("document.querySelector('#tracks .current .t').textContent") == playing and not state()['paused'], playing)
    page.click('#stop'); wait(100)
    played = []
    for _ in range(4):
        played.append(page.evaluate("document.getElementById('marquee').textContent"))
        page.click('#next'); wait(120)
    check('shuffle button plays every song once in a round', len(set(played)) == 4, played)
    wait(100)
    check('shuffle carries on into a new round', page.evaluate("document.getElementById('marquee').textContent") != played[-1])

    page.click('#shuffle'); wait(50)
    page.click('#clear'); wait(300)

    library = str(Path(__file__).parent / 'lib' / 'Music')
    tabs = lambda: page.evaluate("[...document.querySelectorAll('.pl-tab')].map(t => t.querySelector('.name').textContent + ':' + t.querySelector('.count').firstChild.textContent + (t.getAttribute('aria-pressed') === 'true' ? '*' : ''))")
    page.set_input_files('#folder-input', library)
    wf("document.querySelectorAll('.pl-tab').length >= 3 && !document.getElementById('status').textContent.includes('saving')")
    wait(600)
    made = tabs()
    check('one playlist per CD folder', [t.rstrip('*') for t in made if t.startswith('CD')] == ['CD01:2', 'CD02_Rock:3', 'CD06_Wife:2'], made)
    check('first CD opens', any(t.startswith('CD01') and t.endswith('*') for t in made), made)
    check('hidden files are not songs', 'CD01:2' in ' '.join(made))
    page.locator('.pl-tab', has_text='CD06_Wife').click(); wait(200)
    check('nested folders keep their order', rows() == ['Six*', 'Polka'], rows())
    page.locator('.pl-tab', has_text='CD02_Rock').click(); wait(200)
    check('switching shows that CD', len(rows()) == 3 and 'CD02_Rock:3*' in tabs(), [rows(), tabs()])
    page.click('#play'); wait(400)
    box = page.locator('#seek').bounding_box()
    page.mouse.click(box['x'] + box['width'] * 0.5, box['y'] + box['height'] / 2); wait(300)
    t_two = state()['t']
    page.locator('.pl-tab', has_text='CD01').click(); wait(500)
    s = state()
    check('switching while playing keeps playing the new CD', not s['paused'] and s['title'].startswith('ALFA'), s)
    page.click('#stop')
    page.locator('.pl-tab', has_text='CD02_Rock').click(); wait(500)
    s = state()
    check('each CD remembers its own place', abs(s['t'] - t_two) < 1.5 and s['title'].startswith('BETA'), [t_two, s])

    page.click('#playlist-new'); wait(100)
    page.fill('#name-input', 'CD01')
    page.click('#name-ok'); wait(100)
    check('duplicate names are refused', page.evaluate("document.getElementById('name-dialog').open"))
    page.fill('#name-input', 'Road Trip')
    page.press('#name-input', 'Enter'); wait(200)
    check('enter creates the playlist', any(t == 'Road Trip:0*' for t in tabs()), tabs())
    check('new playlist is empty', len(rows()) == 0 and page.locator('#empty').is_visible())
    page.click('#playlist-rename'); wait(100)
    page.fill('#name-input', 'Road Trip 2')
    page.click('#name-ok'); wait(200)
    check('rename', any(t.startswith('Road Trip 2') for t in tabs()), tabs())
    page.click('#playlist-delete'); wait(100)
    page.keyboard.press('Enter'); wait(200)
    check('enter does not delete', any(t.startswith('Road Trip 2') for t in tabs()), tabs())
    page.click('#playlist-delete'); wait(100)
    page.click('#delete-ok'); wait(300)
    check('delete removes the playlist', not any(t.startswith('Road Trip') for t in tabs()), tabs())

    page.set_input_files('#folder-input', library)
    wait(1200)
    check('opening the same folder again adds nothing', [t.rstrip('*') for t in tabs() if t.startswith('CD')] == ['CD01:2', 'CD02_Rock:3', 'CD06_Wife:2'], tabs())

    page.locator('.pl-tab', has_text='CD06_Wife').click(); wait(600)
    page.reload()
    wf("document.querySelectorAll('.pl-tab').length >= 3")
    wait(500)
    check('all playlists survive a reload', [t.rstrip('*') for t in tabs() if t.startswith('CD')] == ['CD01:2', 'CD02_Rock:3', 'CD06_Wife:2'], tabs())
    check('the open playlist survives a reload', any(t.startswith('CD06_Wife') and t.endswith('*') for t in tabs()), tabs())
    page.click('#playlist-delete'); wait(100); page.click('#delete-ok'); wait(400)
    stored = page.evaluate("new Promise(r => { const q = indexedDB.open('retro-music-player'); q.onsuccess = () => { const c = q.result.transaction('files').objectStore('files').count(); c.onsuccess = () => r(c.result); }; })")
    check('deleting a playlist frees its songs', stored == 5, stored)
    page.set_viewport_size({'width': 360, 'height': 800}); wait(200)
    wide = page.evaluate("document.documentElement.scrollWidth")
    check('no sideways scroll at phone width', wide <= 360, wide)
    page.set_viewport_size({'width': 1280, 'height': 950})

    for _ in range(page.locator('.pl-tab').count()):
        if page.locator('#playlist-delete').is_disabled():
            break
        page.click('#playlist-delete'); wait(80); page.click('#delete-ok'); wait(200)
    page.evaluate(LOAD)
    wf("document.querySelectorAll('#tracks .row').length === 4")

    page.click('#clear'); wait(100)
    check('clear empties everything', page.locator('#empty').is_visible() and page.inner_text('#status') == 'No tracks' and 'NO MEDIA' in page.inner_text('#marquee'))
    check('no page errors', not errors, errors)
    browser.close()

for name, ok, detail in results:
    print(('ok  ' if ok else 'FAIL'), name, '' if ok else json.dumps(detail, ensure_ascii=False, default=str))
print(sum(ok for _, ok, _ in results), 'of', len(results))
