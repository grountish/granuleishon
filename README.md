# granuleishon

A live granular synthesizer for the web. It takes your **microphone** as the
source, continuously records the last ~10 seconds into a circular buffer, and
sprays short windowed *grains* read from that recent past — with control over
grain size, density, position, pitch, stereo spread, and a **freeze** button.

## Run it

The mic (`getUserMedia`) and `AudioWorklet` both require a secure context, so
you must serve over `http://localhost` — opening `index.html` from disk won't
work.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

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

| Control       | What it does                                            |
| ------------- | ------------------------------------------------------- |
| Grain size    | Length of each grain (ms)                               |
| Density       | Grains spawned per second                               |
| Position      | How far behind "now" grains read from (s)               |
| Spray         | Random scatter added to position (s)                    |
| Pitch         | Per-grain transposition (semitones)                     |
| Pitch jitter  | Random pitch spread per grain (semitones)               |
| Stereo spread | How wide grains pan across the field                    |
| Output gain   | Master level                                            |
| Freeze        | Stop recording — granulate a frozen moment              |

## Ideas to extend later

- File / drag-and-drop sample source sharing the same engine
- Grain envelope shape selection (Hann / Tukey / triangular)
- Waveform + grain-position visualization on a canvas
- Preset save/load
