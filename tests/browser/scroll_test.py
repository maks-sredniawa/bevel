from playwright.sync_api import sync_playwright

LOAD = """async () => {
  const sr = 8000, n = sr * 2, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  const dt = new DataTransfer();
  for (let i = 1; i <= 60; i++) dt.items.add(new File([b], `${String(i).padStart(2, '0')} - Artist ${i} - Song ${i}.wav`));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}"""

READ = """() => {
  const s = document.getElementById('tracks-scroll');
  const rows = [...document.querySelectorAll('#tracks .row')];
  return { top: Math.round(s.scrollTop), page: Math.round(scrollY), first: rows[0].querySelector('.t').textContent,
           current: rows.findIndex(r => r.classList.contains('current')) + 1 };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 950})
    page.goto('http://127.0.0.1:8766/index.html')
    page.evaluate(LOAD)
    page.wait_for_function("document.querySelectorAll('#tracks .row').length === 60", polling=100)
    page.wait_for_timeout(800)
    read = lambda: page.evaluate(READ)
    bad = 0
    for i in range(1, 7):
        page.click('#shuffle')
        page.wait_for_timeout(150)
        state = read()
        on = page.get_attribute('#shuffle', 'aria-pressed')
        print(f'press {i}: shuffle={on} {state}')
        if state['top'] != 0 or state['page'] != 0 or state['current'] != 1:
            bad += 1
    page.click('#shuffle')
    page.wait_for_timeout(150)
    page.click('#play')
    page.wait_for_timeout(200)
    seen = []
    for _ in range(16):
        page.click('#next')
        page.wait_for_timeout(100)
        state = read()
        seen.append((state['current'], state['top']))
    print('next, next, ... (row, scrollTop):', seen)
    visible = page.evaluate("""() => {
      const s = document.getElementById('tracks-scroll').getBoundingClientRect();
      const r = document.querySelector('#tracks .current').getBoundingClientRect();
      return r.top >= s.top && r.bottom <= s.bottom;
    }""")
    print('current row visible while advancing:', visible)
    browser.close()
print('presses that left the list not at the top with row 1 selected:', bad)
