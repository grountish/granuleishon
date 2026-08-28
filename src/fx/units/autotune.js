// Autotune — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

export default {
  id: 'autotune',
  label: 'Autotune',
  idleBypass: true,
  params: [
    { key: 'speed', label: 'Retune', min: 0, max: 500, step: 5, value: 40, unit: 'ms' },
    { key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    root: 0,
    scale: 'major',
    speed: 40,
    amount: 1,
    mix: 0,
  }),
  presets: [
    { name: 'Off', values: { speed: 40, amount: 1, mix: 0 } },
    { name: 'Natural', values: { speed: 120, amount: 0.8, mix: 1 } },
    { name: 'Hard Snap', values: { speed: 0, amount: 1, mix: 1 } },
  ],
};
