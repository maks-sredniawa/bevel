# Retro music player — visual directions

Three self-contained mockups, each with a loaded state, an empty state and a drag-over state, three switchable skins, and a fake visualiser. Rendered headlessly with Chrome at 1280 px and 360 px (`direction-*-1280.png`, `direction-*-360.png`); none scrolls horizontally at 360 px.

## Recommendation: Direction A, "Hi-fi stack"

A rack of brushed-metal components: a wide deck with a seven-segment amber LCD, physical transport keys and a rotary volume knob; an equaliser and a visualiser side by side; the playlist in a dark glass drawer underneath. It is the direction that most says "early 2000s player" (bevels, LCD readout, chunky keys, screws in the corners) while taking its cues from hi-fi hardware rather than from any software skin, so nothing in it maps onto a real product's layout. The metal-plus-LCD material gives skins the most room: swapping the metal tone and the LCD colour changes the whole mood without touching layout (Titanium/amber, Graphite/green negative, Champagne/green positive are in the mockup). It also stacks well on a phone: the LCD goes full width, keys become a five-up row, and the knob shrinks beside its readout.

What to watch when building it: the seven-segment digits are SVG built in JS (segment map in the file); the knob needs pointer and keyboard handling as a slider; the brushed texture is a repeating gradient and costs nothing.

### Alternatives

- **B, "Candy handset"**: translucent Y2K plastic. A vertical handset with a dark glossy screen and jelly keys, next to frosted-glass cards for the EQ and playlist. The friendliest and most distinct of the three, and the best-looking at 360 px, but it reads more "turn-of-the-century gadget" than "desktop player", and the soft gloss drifts towards a modern mobile look.
- **C, "Pixel workstation"**: one flat application window with a menubar, group boxes, two-tone bevels, a monochrome positive LCD and a dithered block visualiser on a checker-pattern desktop. The most literal era rendering and the cheapest to build (no textures, no SVG digits), but it looks like a utility rather than something you'd want on screen while listening, and its playlist table carries the least personality.

## Design tokens (Direction A, Titanium skin)

Each skin redefines the same custom properties on `:root[data-skin="…"]`; the layout CSS reads only tokens.

| Token | Value | Use |
| --- | --- | --- |
| `--room` | `#1b1d20` | page background behind the rack |
| `--metal-hi` / `--metal` / `--metal-lo` | `#eceeec` / `#b7babb` / `#7f8486` | brushed-metal gradient for panels, keys, knob |
| `--metal-edge` | `#4b4f52` | 1 px outline on panels and keys |
| `--ink` / `--ink-soft` | `#16191a` / `#3b4042` | text on metal; engraved labels |
| `--engrave-hi` / `--engrave-lo` | `rgba(255,255,255,.8)` / `rgba(0,0,0,.35)` | label text-shadow (engraved look) |
| `--lcd-bg-1` / `--lcd-bg-2` | `#f3bf57` / `#d99a2c` | LCD backlight gradient |
| `--lcd-ink` / `--lcd-dim` / `--lcd-ghost` | `#2a1a05` / `rgba(42,26,5,.62)` / `rgba(42,26,5,.13)` | lit segments and text; secondary text; unlit segments |
| `--glass-bg` / `--glass-ink` / `--glass-dim` | `#101312` / `#e8e3d6` / `#9b968b` | playlist and visualiser wells; row text; metadata |
| `--glass-row` / `--glass-current` / `--glass-current-edge` | `rgba(255,255,255,.04)` / `rgba(243,191,87,.18)` / `#f3bf57` | zebra rows; current track fill and left bar |
| `--viz` / `--viz-peak` | `#f3bf57` / `#fff1c6` | spectrum bars and seek fill; peak caps |
| `--led` / `--led-on` | `#ff3b2a` / `#35e07a` | knob pointer; toggle LEDs |
| `--knob-hi` / `--knob-lo` | `#f4f5f4` / `#8d9193` | knob and screw shading |
| `--focus` | `#1f6dff` | 3 px `:focus-visible` outline (Graphite uses `#ffd34d` on its dark metal) |
| `--radius` | `6px` | panel corners (keys 5 px, LCD 4 px) |
| `--font-ui` | `system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif` | labels, buttons, playlist chrome |
| `--font-mono` | `ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace` | LCD text, readouts, track list |

Other fixed values: hit targets 44–48 px (play key 56–64 px); playlist rows 44 px; fader tracks 118 px tall (96 px on phones); panel gap 14 px; one breakpoint at 760 px where the rack becomes a single column.

Motion: the LCD title scrolls with a CSS marquee and the visualiser animates with `requestAnimationFrame`; both stop under `prefers-reduced-motion: reduce` (static title, single visualiser frame).

## Name suggestions

- **Bevel** — the bevelled edge is the era's signature detail, it is short, and it says nothing about any existing player. A web search for a "Bevel" music player app found none (there is an unrelated Bevel health app).
- **Shelfstack** — the hi-fi stack on a shelf that Direction A is modelled on. No music player of that name was found (the nearest hits were Shelfelf, a remote-control web frontend, and ShelfPlayer, an audiobook client).

Dropped: "Amberdeck" — nothing by that name exists, but it is one letter-group away from Amberol, a GNOME music player.
