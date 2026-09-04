// Gen 5 sampler: one loaded sample (global, persisted with the project's
// audio clips) fired by the transport rather than by a step grid. Playback
// params live per loop, like the gen 3 sound, so each loop can play its own
// slice; the retrigger mode is global.
//
// Pure data + state — no DOM, no audio nodes. Node building, triggering and
// the scheduler hook live in app.js next to the gen 4 scheduler they ride on.

export const SMP_PARAM_DEFS = [
  // start/end are seconds into the sample. end 0 means "to the sample end";
  // the knob max is patched to the sample's duration once one is loaded.
  { key: 'start', label: 'Start', min: 0, max: 10, step: 0.01, value: 0, unit: 's' },
  { key: 'end', label: 'End', min: 0, max: 10, step: 0.01, value: 0, unit: 's' },
  { key: 'gain', label: 'Gain', min: 0, max: 1.5, step: 0.01, value: 0.8, unit: '' },
  { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
  { key: 'attack', label: 'Attack', min: 0, max: 2, step: 0.01, value: 0, unit: 's' },
  { key: 'release', label: 'Release', min: 0, max: 4, step: 0.01, value: 0.05, unit: 's' },
];

// Per-loop switches next to the knobs: whether this loop fires the sampler at
// all, whether the slice loops until the next trigger, and playback direction.
export const SMP_FLAG_DEFS = [
  { key: 'on', label: 'Active', short: 'ON', value: true },
  { key: 'loop', label: 'Loop slice', short: 'LOOP', value: false },
  { key: 'reverse', label: 'Reverse', short: 'REV', value: false },
];

export const SMP_MODES = [
  ['loop', 'Loop', 'Retrigger at the start of every pattern cycle'],
  ['song', 'Song', 'Trigger once per song pass — on play, and again when the song cycles'],
];

// Warp: how the sample meets the transport tempo. Off plays it as recorded;
// Re-pitch scales playback rate by transport/sample BPM (pitch follows, like
// a turntable); Beats slices it on 16ths and re-times the slices to the
// transport grid so pitch stays put — Ableton's "Beats" mode.
export const SMP_WARP_MODES = [
  ['off', 'Off', "Play at the sample's own tempo"],
  ['repitch', 'Pitch', 'Re-pitch: speed the sample to the transport tempo — pitch follows'],
  ['beats', 'Beats', 'Slice on 16ths and re-time them to the transport — pitch stays'],
];

// genIdx namespace for the knob context menu (copy to other loops). 0–2 are
// the granulators and gen 3, 3–5 are FX, drums and mixer pan targets.
export const SMP_GEN_IDX = 6;

export function makeSamplerLoopParams() {
  const params = Object.fromEntries(SMP_PARAM_DEFS.map((p) => [p.key, p.value]));
  SMP_FLAG_DEFS.forEach((f) => (params[f.key] = f.value));
  return params;
}

export const SMP = {
  mode: 'loop', // 'loop' | 'song'
  // { channels: Float32Array[], sampleRate, duration, fileName } — raw
  // decoded audio, kept off the AudioContext so it survives engine rebuilds.
  sample: null,
  // AudioBuffers built from `sample` for the live context, forward + reversed.
  cache: { sample: null, ctx: null, buf: null, rev: null },
  nodes: null, // { out } — the gain feeding the sampler bus
  voice: null, // { src, choke, release } — the one instance sounding now
  // Warp mode plus the sample's tempo; bpm 0 means "use detectedBpm".
  // snap: Start/End snap to the detected beat grid; off, Start is the downbeat.
  warp: { mode: 'off', bpm: 0, snap: true },
  detectedBpm: null, // found by tempo analysis when the sample loads
  // Beat grid of the sample from the same analysis: seconds to its first
  // beat and first downbeat, and the bpm they were found for.
  detectedGrid: null, // { bpm, beatOffset, barOffset }
  analysing: false, // a tempo analysis is in flight
  // Set by songLandOn when the arrangement wraps to its first entry; the
  // scheduler consumes it to retrigger in song mode.
  songWrapped: false,
};

// The sample's beat grid for snapping: { origin, beat } in seconds, with
// origin the first downbeat found for the current tempo (0 when the grid
// was found for another tempo or not at all), or null without a tempo.
export function getSamplerGrid() {
  const bpm = getSamplerBpm();
  if (!(bpm > 0)) return null;
  const g = SMP.detectedGrid;
  const origin = g && Math.abs(g.bpm - bpm) < 0.005 ? g.barOffset : 0;
  return { origin, beat: 60 / bpm };
}

// Nearest beat of `grid` to time t (never before 0); t itself without one.
export function snapToGrid(t, grid) {
  if (!grid || !(grid.beat > 0)) return t;
  let k = Math.round((t - grid.origin) / grid.beat);
  let v = grid.origin + k * grid.beat;
  if (v < 0) v = grid.origin + Math.ceil(-grid.origin / grid.beat) * grid.beat;
  return v;
}

// Resolve a loop's start/end into a playable region of `duration` seconds,
// snapped to `grid` when one is given. end <= start (or end 0) means "to
// the end"; the region never collapses below 5 ms so a trigger always makes
// a sound.
export function samplerRegion(params, duration, grid = null) {
  const start = Math.max(0, Math.min(snapToGrid(params.start, grid), Math.max(0, duration - 0.005)));
  let end = params.end > 0 ? Math.min(snapToGrid(params.end, grid), duration) : duration;
  if (end <= start) end = duration;
  if (end - start < 0.005) end = Math.min(duration, start + 0.005);
  return { start, end };
}

// The sample's BPM: the user's number, else the guess from its length.
export function getSamplerBpm() {
  if (SMP.warp.bpm > 0) return SMP.warp.bpm;
  return SMP.detectedBpm > 0 ? SMP.detectedBpm : null;
}

// Guess a loop's tempo from its length alone: assume it is a power-of-two
// number of 4/4 bars (¼ … 1024) and pick the bar count whose tempo lands
// nearest the reference (the transport) in log space. Candidates sit an
// octave apart, so one always falls within ×√2 of the reference — there is
// always a guess; it is only right for clean loops, and the user can always
// type the real number. Returns { bpm, bars }.
export function detectSampleTempo(duration, refBpm) {
  if (!(duration > 0)) return null;
  const ref = refBpm > 0 ? refBpm : 120;
  let best = null;
  for (let k = -2; k <= 10; k++) {
    const bars = Math.pow(2, k);
    const bpm = (bars * 4 * 60) / duration;
    const score = Math.abs(Math.log(bpm / ref));
    if (!best || score < best.score) best = { bpm, bars, score };
  }
  return { bpm: Math.round(best.bpm * 100) / 100, bars: best.bars };
}
