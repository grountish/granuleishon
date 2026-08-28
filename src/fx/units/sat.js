// Saturation — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

export default {
  id: 'sat',
  label: 'Saturation',
  idleBypass: true,
  params: [
    { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({ enabled: true, drive: 0.3, mix: 0 }),
  presets: [
    { name: 'Off', values: { drive: 0.3, mix: 0 } },
    { name: 'Warm', values: { drive: 0.18, mix: 0.35 } },
    { name: 'Driven', values: { drive: 0.5, mix: 0.65 } },
    { name: 'Hard Clip', values: { drive: 0.88, mix: 0.9 } },
  ],
};
