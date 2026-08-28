// Limiter — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

export default {
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
  presets: [
    {
      name: 'Balanced',
      values: { threshold: -8, attack: 0.003, release: 0.12, ratio: 20, knee: 0, output: 0.96 },
    },
    {
      name: 'Gentle',
      values: { threshold: -4, attack: 0.01, release: 0.2, ratio: 6, knee: 8, output: 0.96 },
    },
    {
      name: 'Loud',
      values: { threshold: -12, attack: 0.002, release: 0.12, ratio: 20, knee: 2, output: 0.98 },
    },
    {
      name: 'Maximizer',
      values: { threshold: -10, attack: 0.001, release: 0.08, ratio: 40, knee: 1, output: 1.2 },
    },
    {
      name: 'Brickwall',
      values: { threshold: -18, attack: 0.001, release: 0.06, ratio: 40, knee: 0, output: 0.95 },
    },
  ],
};
