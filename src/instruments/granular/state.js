// Granular generator params and the live per-generator state.
// Two independent generators; gen 1 starts from different defaults so their
// independence is audible right away.

export const PARAMS = [
  { key: 'grainSizeMs', label: 'Grain size', min: 5, max: 500, step: 1, unit: 'ms' },
  { key: 'density', label: 'Density', min: 1, max: 100, step: 1, unit: '/s' },
  { key: 'positionSec', label: 'Position', min: 0, max: 9, step: 0.01, unit: 's back' },
  { key: 'spraySec', label: 'Spray', min: 0, max: 2, step: 0.01, unit: 's' },
  { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, unit: 'st' },
  { key: 'pitchJitter', label: 'Pitch jitter', min: 0, max: 12, step: 0.5, unit: 'st' },
  { key: 'spread', label: 'Stereo spread', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'gain', label: 'Output gain', min: 0, max: 2, step: 0.01, unit: '' },
];

// Slightly different defaults for gen 1 so independence is immediately audible.
export const GEN_DEFAULTS = [
  {
    grainSizeMs: 308,
    density: 20,
    positionSec: 0.51,
    spraySec: 0.05,
    pitch: 0,
    pitchJitter: 0,
    spread: 0.63,
    gain: 0.8,
    reverse: false,
    envType: 'hann',
    freeze: false,
    grainSizeSync: false,
    grainSizeSyncIndex: 2,
    densitySync: false,
    densitySyncIndex: 2,
  },
  {
    grainSizeMs: 80,
    density: 15,
    positionSec: 3.26,
    spraySec: 0.03,
    pitch: 0,
    pitchJitter: 0,
    spread: 1,
    gain: 0.34,
    reverse: true,
    envType: 'soft',
    freeze: false,
    grainSizeSync: false,
    grainSizeSyncIndex: 2,
    densitySync: false,
    densitySyncIndex: 2,
  },
];

export const state = [{ ...GEN_DEFAULTS[0] }, { ...GEN_DEFAULTS[1] }];
