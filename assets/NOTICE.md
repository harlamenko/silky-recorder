# Media assets

These are the default sounds used by the recorder. You can replace any of them
by pointing a scenario's `meta.music` / `meta.sfx` to your own files.

| File | What | Source / license |
|--|--|--|
| `music.mp3` | Background music bed (loops to any video length) | Royalty-free / "No Copyright" background track. Free for use. |
| `click.wav` | Mouse/trackpad click (a MacBook trackpad Force-Touch "tock") | Short functional UI sample. |
| `key.wav` | Keystroke ("thocky" mechanical switch) | Short functional UI sample. |

## About the SFX

`click.wav` and `key.wav` are very short (<0.2 s) functional interface sounds.
They ship as sensible defaults so the tool works out of the box.

If you are unsure about the provenance of any bundled sample or plan wide public
distribution, replace them with your own recordings or CC0/licensed UI sounds
(e.g. from freesound.org CC0, or the built-in synth — see below), and update
`meta.sfx` in your scenario.

## Synth fallback (no bundled samples)

The in-browser engine (`src/silky.js`) can also **synthesize** click / key /
music via the Web Audio API — no files, no licensing. This is not wired into
the default ffmpeg audio path, but the code is there if you prefer a fully
self-generated, guaranteed-clean soundtrack.
