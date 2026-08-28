// Filter — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

export default {
  id: 'filter',
  label: 'Filter',
  idleBypass: true,
  params: [
    { key: 'cutoff', label: 'Cutoff', min: 80, max: 14000, step: 10, unit: 'Hz' },
    { key: 'q', label: 'Resonance', min: 0.1, max: 20, step: 0.1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({ enabled: true, mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 }),
  presets: [
    { name: 'Off', values: { mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 } },
    { name: 'Warm Low-pass', values: { mode: 'lowpass', cutoff: 1600, q: 0.9, mix: 1 } },
    { name: 'Telephone', values: { mode: 'bandpass', cutoff: 1400, q: 1.4, mix: 0.9 } },
    { name: 'Resonant High-pass', values: { mode: 'highpass', cutoff: 480, q: 7, mix: 0.8 } },
  ],
};
