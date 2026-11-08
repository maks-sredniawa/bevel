# Bevel

A free music player in your browser, in the style of the early 2000s. Open it at
[maksforge.com/bevel](https://maksforge.com/bevel/) and add your own music files.

Your songs are stored in your own browser. They are never uploaded, and the app has no server and no account.

## What it does

- Playlists from your files or folders, which survive closing the browser
- A shuffle that plays every song once before reshuffling
- A 10-band equaliser with presets, and three skins
- An optional two-deck DJ mode with beat matching, loops, effects and Auto DJ
- Works offline once it has been opened

## Run it locally

```bash
python3 -m http.server 8766 --bind 127.0.0.1 --directory docs
```

Then open <http://127.0.0.1:8766/index.html>.

## Tests

```bash
npm test
python3 tests/browser/smoke_test.py
```

The smoke test needs `playwright`. CI runs both on Linux, macOS and Windows, in Chromium and Firefox, plus WebKit on Linux and macOS.

## Contributing

Bevel is source-available, not open source: read it, verify it, file issues. Pull requests are not accepted — see
[LICENSE](LICENSE).
