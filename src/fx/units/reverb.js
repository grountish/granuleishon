// Reverb — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

export default {
  id: 'reverb',
  label: 'Reverb',
  idleBypass: true,
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
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({ enabled: true, size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 }),
  presets: [
    { name: 'Off', values: { size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 } },
    { name: 'Room', values: { size: 0.7, decay: 1.3, predelay: 0.008, damping: 0.65, mix: 0.25 } },
    { name: 'Hall', values: { size: 2.8, decay: 4.8, predelay: 0.025, damping: 0.45, mix: 0.38 } },
    { name: 'Cavern', values: { size: 5, decay: 7, predelay: 0.06, damping: 0.3, mix: 0.5 } },
  ],
};
