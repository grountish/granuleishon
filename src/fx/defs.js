// Parameter definitions for every rack effect: the knobs each unit shows,
// their ranges, steps, defaults and units. Pure data — no state, no DOM.
// Phase 4 of REFACTOR.md folds each entry into its own unit module.

export const FX_DEFS = [
  {
    id: 'beatrepeat',
    label: 'Beat Repeat',
    params: [
      { key: 'interval', label: 'Interval', min: 0.02, max: 2, step: 0.01, value: 0.5, unit: 's' },
      { key: 'grid', label: 'Grid', min: 10, max: 500, step: 1, value: 125, unit: 'ms' },
      { key: 'gate', label: 'Gate', min: 1, max: 32, step: 1, value: 8, unit: 'x' },
      { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
      { key: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'chance', label: 'Chance', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'grainarp',
    label: 'Grain Arp',
    params: [
      { key: 'grid', label: 'Grid', min: 10, max: 500, step: 1, value: 250, unit: 'ms' },
      { key: 'chance', label: 'Activity', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'shape', label: 'Shape', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'reverse', label: 'Reverse', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'feedback', label: 'Repeats', min: 0, max: 0.85, step: 0.01, value: 0.25, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'pitchtrem',
    label: 'Pitch + Auto Pan',
    params: [
      { key: 'pitch', label: 'Pitch center', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
      { key: 'pitchDepth', label: 'Pitch sweep', min: 0, max: 24, step: 1, value: 0, unit: 'st' },
      { key: 'fine', label: 'Fine', min: -100, max: 100, step: 1, value: 0, unit: 'ct' },
      { key: 'rate', label: 'Pan rate', min: 0.05, max: 20, step: 0.05, value: 4, unit: 'Hz' },
      { key: 'depth', label: 'Pan depth', min: 0, max: 1, step: 0.01, value: 0.5, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'autotune',
    label: 'Autotune',
    params: [
      { key: 'speed', label: 'Retune', min: 0, max: 500, step: 5, value: 40, unit: 'ms' },
      { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'delay',
    label: 'Delay',
    params: [
      { key: 'time', label: 'Time', min: 0, max: 1, step: 0.01, value: 0.3, unit: 's' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, value: 0.35, unit: '' },
      { key: 'hp', label: 'HP Cut', min: 20, max: 2000, step: 10, value: 20, unit: 'Hz' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'filter',
    label: 'Filter',
    params: [
      { key: 'cutoff', label: 'Cutoff', min: 80, max: 14000, step: 10, unit: 'Hz' },
      { key: 'q', label: 'Resonance', min: 0.1, max: 20, step: 0.1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'resonator',
    label: 'Resonator',
    params: [
      { key: 'freq', label: 'Freq', min: 40, max: 2000, step: 1, value: 220, unit: 'Hz' },
      { key: 'decay', label: 'Decay', min: 0, max: 0.98, step: 0.01, value: 0.85, unit: '' },
      { key: 'damp', label: 'Damp', min: 200, max: 12000, step: 10, value: 4200, unit: 'Hz' },
      { key: 'int2', label: 'Note 2', min: -24, max: 24, step: 1, value: 12, unit: 'st' },
      { key: 'harm2', label: 'Level 2', min: 0, max: 1, step: 0.01, value: 0.5, unit: '' },
      { key: 'int3', label: 'Note 3', min: -24, max: 24, step: 1, value: 7, unit: 'st' },
      { key: 'harm3', label: 'Level 3', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'bitreduce',
    label: 'Bit Reduce',
    params: [
      { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, value: 8, unit: '' },
      { key: 'rate', label: 'Rate', min: 0.02, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'sat',
    label: 'Saturation',
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'reverb',
    label: 'Reverb',
    params: [
      { key: 'size', label: 'Size', min: 0.1, max: 5, step: 0.1, value: 2, unit: 's' },
      { key: 'decay', label: 'Decay', min: 0.5, max: 8, step: 0.1, value: 3, unit: '' },
      {
        key: 'predelay',
        label: 'Pre-delay',
        min: 0,
        max: 0.25,
        step: 0.001,
        value: 0.018,
        unit: 's',
      },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, value: 0.42, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'limiter',
    label: 'Limiter',
    params: [
      { key: 'threshold', label: 'Threshold', min: -36, max: 0, step: 0.5, value: -8, unit: 'dB' },
      { key: 'attack', label: 'Attack', min: 0, max: 0.1, step: 0.001, value: 0.003, unit: 's' },
      { key: 'release', label: 'Release', min: 0.02, max: 1, step: 0.01, value: 0.12, unit: 's' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 40, step: 0.5, value: 20, unit: ':1' },
      { key: 'knee', label: 'Knee', min: 0, max: 40, step: 0.5, value: 0, unit: 'dB' },
      { key: 'output', label: 'Output', min: 0.5, max: 1.2, step: 0.01, value: 0.96, unit: '' },
    ],
  },
];
