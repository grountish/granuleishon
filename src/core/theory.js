// Music theory — note names, pitch conversions, the shared scale, and the
// snapping primitives the harmonizer and autotune both build on. Pure: no
// DOM, no audio nodes, no app state beyond the shared scale selection.

import { clamp } from './util.js';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFreqHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqHzToMidi(freq) {
  return 69 + 12 * Math.log2(Math.max(1, freq) / 440);
}

// MIDI 57 → "A3". Middle C (60) is C4, matching the note editors' labels.
export function formatMidiNote(midi) {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

// One shared musical scale: the drum note roll and the gen3 keys grid read
// the same root/scale, and every scale-select pair on the page stays in sync.
export const GEN4_SCALES = [
  ['off', 'No scale', null],
  ['major', 'Major', [0, 2, 4, 5, 7, 9, 11]],
  ['minor', 'Minor', [0, 2, 3, 5, 7, 8, 10]],
  ['harm-minor', 'Harm minor', [0, 2, 3, 5, 7, 8, 11]],
  ['dorian', 'Dorian', [0, 2, 3, 5, 7, 9, 10]],
  ['phrygian', 'Phrygian', [0, 1, 3, 5, 7, 8, 10]],
  ['lydian', 'Lydian', [0, 2, 4, 6, 7, 9, 11]],
  ['mixolydian', 'Mixolydian', [0, 2, 4, 5, 7, 9, 10]],
  ['pent-major', 'Pent major', [0, 2, 4, 7, 9]],
  ['pent-minor', 'Pent minor', [0, 3, 5, 7, 10]],
  ['blues', 'Blues', [0, 3, 5, 6, 7, 10]],
];

export const GEN4_SCALE = { scale: 'off', root: 0 };

export function getGen4ScaleIntervals() {
  return GEN4_SCALES.find(([id]) => id === GEN4_SCALE.scale)?.[2] || null;
}

export function isMidiInGen4Scale(midi) {
  const intervals = getGen4ScaleIntervals();
  if (!intervals) return true;
  return intervals.includes((((midi - GEN4_SCALE.root) % 12) + 12) % 12);
}

export function snapMidiToGen4Scale(midi) {
  if (isMidiInGen4Scale(midi)) return midi;
  for (let d = 1; d <= 6; d++) {
    if (isMidiInGen4Scale(midi - d)) return midi - d; // ties resolve downward
    if (isMidiInGen4Scale(midi + d)) return midi + d;
  }
  return midi;
}

// ── Snapping primitives ── the harmonizer walks the whole project with these;
// each takes an explicit allowed set so hard/soft modes are the same code.

export function harmonizerSnapMidi(midi, pitchClasses) {
  if (!Number.isFinite(midi)) return midi;
  const m = clamp(Math.round(midi), 0, 127);
  for (let d = 0; d <= 11; d++) {
    if (m - d >= 0 && pitchClasses.has((m - d) % 12)) return m - d; // ties resolve downward
    if (d && m + d <= 127 && pitchClasses.has((m + d) % 12)) return m + d;
  }
  return m;
}

export function harmonizerSnapHz(hz, pitchClasses, min, max) {
  if (!Number.isFinite(hz) || hz <= 0) return hz;
  let best = null;
  let bestDist = Infinity;
  for (let m = 0; m <= 135; m++) {
    if (!pitchClasses.has(m % 12)) continue;
    const f = midiToFreqHz(m);
    if (f < min || f > max) continue;
    const dist = Math.abs(Math.log2(f / hz));
    if (dist < bestDist) {
      bestDist = dist;
      best = f;
    }
  }
  return best ?? hz;
}

// Semitone offsets (grain pitch, resonator intervals…) have no absolute
// pitch, so they snap by interval: offset mod 12 must land on a scale degree.
export function harmonizerSnapOffset(st, intervals, min, max) {
  if (!Number.isFinite(st)) return st;
  const v = clamp(Math.round(st), min, max);
  for (let d = 0; d <= 11; d++) {
    for (const cand of d === 0 ? [v] : [v - d, v + d]) {
      if (cand < min || cand > max) continue;
      if (intervals.has(((cand % 12) + 12) % 12)) return cand;
    }
  }
  return v;
}

// ── Autotune ── the worklet takes its allowed notes as a 12-bit pitch-class
// mask, so root/scale/tonic/chromatic all collapse into one number.

export const AUTOTUNE_SCALE_OPTIONS = [
  ['chromatic', 'Chromatic'],
  ['tonic', 'Tonic'],
  ...GEN4_SCALES.filter(([, , intervals]) => intervals).map(([id, label]) => [id, label]),
];

export function computeAutotuneMask(at) {
  const intervals =
    at.scale === 'tonic'
      ? [0]
      : at.scale === 'chromatic'
        ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        : GEN4_SCALES.find(([id]) => id === at.scale)?.[2] || [0, 2, 4, 5, 7, 9, 11];
  let mask = 0;
  intervals.forEach((i) => {
    mask |= 1 << (((at.root + i) % 12) + 12) % 12;
  });
  return mask;
}
