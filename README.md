# grnsh

A live granular synthesizer for the web. It takes your **microphone** as the
source, continuously records the last ~10 seconds into a circular buffer, and
sprays short windowed _grains_ read from that recent past — with control over
grain size, density, position, pitch, stereo spread, and a **freeze** button.

## Run it

The mic (`getUserMedia`) and `AudioWorklet` both require a secure context, so
you must serve over `http://localhost` — opening `index.html` from disk won't
work.

```bash
python3 serve.py
# then open http://localhost:8000
```

(`serve.py` is a plain `http.server` with caching disabled — a stock
`python3 -m http.server` lets the browser cache `main.js` and the worklet
modules, so edits can silently not load.)

Click **Start mic**, grant permission, and **wear headphones** to avoid
feedback. Make a sound and play with the controls.

## How it works

- `granular-processor.js` — an `AudioWorkletProcessor` running on the audio
  render thread. Holds the circular buffer, writes incoming mic samples into it,
  and schedules/mixes grains. **Freeze** just stops writing to the buffer.
- `main.js` — captures the mic, loads the worklet, and wires the sliders. UI
  changes are sent to the processor via `port.postMessage`.
- `index.html` / `style.css` — controls.

## Parameters

| Control       | What it does                               |
| ------------- | ------------------------------------------ |
| Grain size    | Length of each grain (ms)                  |
| Density       | Grains spawned per second                  |
| Position      | How far behind "now" grains read from (s)  |
| Spray         | Random scatter added to position (s)       |
| Pitch         | Per-grain transposition (semitones)        |
| Pitch jitter  | Random pitch spread per grain (semitones)  |
| Stereo spread | How wide grains pan across the field       |
| Output gain   | Master level                               |
| Freeze        | Stop recording — granulate a frozen moment |

## Loops & Song mode

Granular 1/2 settings, the complete Gen 3 sound and chord, the drum grid, and
the mod-sequencer pattern live in a **Loop**. Right-click an instrument knob to
copy its value to the other loops. FX, LFO settings, and modulation routings
remain global. Seq 1 can optionally share the currently edited sequence across
every loop and Song mode.

Gen 3 offers mutually exclusive **SUS** and **ARP** modes. ARP sequences the
selected keys with per-loop rate, direction, octave range, and gate settings;
right-click any ARP control to copy that value to the other loops.

- The **Loops** bar (under the header) holds your loops: click to edit, `+` to
  add an empty one, `⧉` to duplicate the current one, double-click to rename.
- The **Loop/Song** toggle in the transport picks the play mode. Loop mode
  plays whatever loop you are editing (the previous behavior).
- **Song mode** shows the song lane: append loops as blocks, drag to reorder,
  click a block's `×N` badge (or scroll on it) to set repeats, right-click to
  remove. `⟳` cycles the song at the end; `follow` makes the editor track the
  loop that is sounding. Playback switches patterns sample-accurately at
  pattern boundaries — sound settings stay live throughout.

Projects save all loops plus the arrangement; old single-loop projects load as
loop "A". The workspace also autosaves (localStorage) and restores on reload.

Source audio is persisted too: loaded .wav buffers and **frozen** mic takes are
stored in IndexedDB per project (and for the autosave session), and reload back
into the granulators — a frozen take stays frozen across reloads. The live
unfrozen mic buffer is transient by nature and is not saved.

## Mixer

The Mixer view provides a post-FX channel strip for each granular source, the
synth, and the drums. Each strip has stereo metering, gain, pan, mute/solo, and
a bypassable five-band EQ at 100 Hz, 300 Hz, 1 kHz, 3.5 kHz, and 10 kHz. A
master strip shows the combined output and limiter reduction. Each channel pan
can be mapped to LFO 1/2, Seq 1, Kick SC, or Trig SC from its map dot or the
Back patch panel. Mixer settings and mappings are included in autosave, named
projects, project files, and undo/redo history.

## Ideas to extend later

- File / drag-and-drop sample source sharing the same engine
- Grain envelope shape selection (Hann / Tukey / triangular)
- Per-loop scene recall of sound parameters (kit / FX snapshots)
- Song-position export markers in recordings
