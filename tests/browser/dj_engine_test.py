import json, os, sys
from playwright.sync_api import sync_playwright

R = []
def check(name, ok, detail=''):
    R.append(bool(ok)); print('ok  ' if ok else 'FAIL', name, '' if ok else json.dumps(detail, default=str)[:300])

HOOK = """
const make = AudioContext.prototype.createAnalyser;
AudioContext.prototype.createAnalyser = function () { const n = make.call(this); window.__an = n; return n; };
window.__level = async () => { let m = 0; for (let i = 0; i < 12; i++) { const d = new Float32Array(2048); window.__an.getFloatTimeDomainData(d); for (const v of d) m = Math.max(m, Math.abs(v)); await new Promise(r => setTimeout(r, 40)); } return m; };
"""

with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--mute-audio'])
    c = b.new_context(viewport={'width': 1280, 'height': 950}); c.add_init_script(HOOK)
    page = c.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text and 'ServiceWorker' not in m.text else None)
    page.goto('http://127.0.0.1:8766/index.html'); page.wait_for_timeout(700)
    page.set_input_files('#folder-input', os.path.expanduser('~/Music'))
    page.wait_for_function("document.querySelectorAll('.pl-tab').length === 6 && !document.getElementById('status').textContent.includes('saving')", polling=200, timeout=120000)
    page.wait_for_timeout(1000)
    page.click('#play'); page.wait_for_timeout(300); page.click('#stop')
    w = page.wait_for_timeout
    ev = page.evaluate
    ev("() => retroDJ.enable(true)")
    check('library lists songs', ev("retroDJ.library().length") == 385)
    a = ev("retroDJ.load('a', 'Uptown Funk', 'CD01')")
    check('deck A loads and finds tempo', a['track'] == 'Uptown Funk' and abs(a['bpm'] - 115) < 2, a)
    bb = ev("retroDJ.load('b', 'Faint', 'CD02')")
    check('swapped file names are found', bb['bpm'] and abs(bb['bpm'] - 135) < 2, bb)
    b2 = ev("retroDJ.load('b', 'Billie Jean', 'CD04')")
    check('deck B loads', abs(b2['bpm'] - 117) < 2, b2)
    ev("retroDJ.seek('a', 60); retroDJ.seek('b', 60); retroDJ.crossfade(-1); retroDJ.play('a'); retroDJ.play('b')")
    w(800); s = ev("retroDJ.state()")
    check('both decks play', s['a']['playing'] and s['b']['playing'], s)
    check('position moves', s['a']['position'] > 60.3, s['a']['position'])
    check('A is audible', ev("__level()") > 0.02)
    ev("retroDJ.sync('b', true)"); w(200); s = ev("retroDJ.state()")
    check('sync matches the tempo', abs(s['b']['bpm'] * s['b']['rate'] - s['a']['bpm']) < 0.3, s['b'])
    pa = ev("(() => { const st = retroDJ.state(); return (st.a.beat % 1) - (st.b.beat % 1); })()")
    pa = (pa + 0.5) % 1 - 0.5
    check('sync lines up the beats', abs(pa) < 0.15, pa)
    ev("retroDJ.pause('a'); retroDJ.pause('b')"); w(100)
    s = ev("retroDJ.state()"); before = s['a']['position']; w(400)
    check('pause holds position', ev("retroDJ.state().a.position") == before)
    ev("retroDJ.play('a')"); w(200)
    loud = ev("__level()")
    ev("retroDJ.kill('a','low',true); retroDJ.kill('a','mid',true); retroDJ.kill('a','high',true)"); w(300)
    check('all three kills silence the deck', ev("__level()") < loud * 0.15, loud)
    ev("retroDJ.kill('a','low',false); retroDJ.kill('a','mid',false); retroDJ.kill('a','high',false)"); w(300)
    ev("retroDJ.crossfade(1)"); w(250)
    check('crossfader cuts deck A', ev("__level()") < loud * 0.1, loud)
    ev("retroDJ.crossfade(-1); retroDJ.level('a', 0)"); w(250)
    check('level cuts deck A', ev("__level()") < loud * 0.1)
    ev("retroDJ.level('a', 1)"); w(100)
    ev("retroDJ.loop('a', 1)"); w(100); lp = ev("retroDJ.state().a.loop")
    w(3500); pos = ev("retroDJ.state().a.position")
    check('loop stays inside its range', lp['start'] - 0.05 <= pos <= lp['end'] + 0.05, [lp, pos])
    ev("retroDJ.loop('a', null)"); w(600)
    check('loop release carries on', ev("retroDJ.state().a.loop") is None)
    ev("retroDJ.filter('a', -1)"); w(150); ev("retroDJ.filter('a', 0)")
    ev("retroDJ.setCue('a', 0)"); cue = ev("retroDJ.state().a.cues[0]"); w(1500); ev("retroDJ.jumpCue('a', 0)"); w(100)
    check('hot cue jumps back', abs(ev("retroDJ.state().a.position") - cue) < 0.5, cue)
    ev("retroDJ.tape('a')"); w(2300)
    check('tape stop ends the deck', not ev("retroDJ.state().a.playing"))
    ev("retroDJ.seek('a', 80); retroDJ.play('a')"); w(200); ev("retroDJ.echo('a')"); w(1400)
    check('echo stops the deck', not ev("retroDJ.state().a.playing"))
    check('echo tail is audible after the deck stops', ev("__level()") > 0.002)
    w(300)

    for style, wait_s in [('blend', 95), ('echo', 45), ('roll', 45), ('tape', 45)]:
        ev(f"() => {{ retroDJ.auto({{ playlist: 'CD03', style: '{style}', bars: 12 }}); }}")
        changes = []
        peak = 0
        for _ in range(wait_s * 2):
            w(500)
            st = ev("(() => { const s = retroDJ.state(); return { a: s.a.track, b: s.b.track, ap: s.a.playing, bp: s.b.playing, x: s.crossfader, st: s.auto.status, r: s.auto.running, ar: s.a.rate, br: s.b.rate }; })()")
            k = (st['a'] if st['ap'] else None, st['b'] if st['bp'] else None)
            if not changes or changes[-1] != k:
                changes.append(k)
            if len(changes) >= 4:
                break
        level = ev("__level()")
        ev("retroDJ.stopAuto(); retroDJ.pause('a'); retroDJ.pause('b')")
        moved = len({v for pair in changes for v in pair if v})
        check(f'Auto DJ {style}: moves to a new song with sound', moved >= 2 and level > 0.01, [changes, level, st])
        print('    ', style, changes[:5])
    ev("() => { retroDJ.auto({ playlist: 'CD03', style: 'mixed', bars: 8 }); }"); w(1500)
    ev("retroDJ.stopAuto()"); w(200)
    check('stopping Auto DJ leaves no timer running', not ev("retroDJ.state().auto.running"))
    ev("retroDJ.enable(false)"); w(100)
    check('turning DJ mode off stops the decks', not ev("retroDJ.state().a.playing") and not ev("retroDJ.state().b.playing"))
    check('no page errors', not errs, errs[:5])
    b.close()
print(sum(R), 'of', len(R)); sys.exit(0 if all(R) else 1)
