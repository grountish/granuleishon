// Filter — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { formatNumericValue } from '../../core/util.js';

export default {
  id: 'filter',
  label: 'Filter',
  idleBypass: true,
  // One row of exclusive mode buttons, bound to state.mode.
  modeRows: [
    {
      key: 'mode',
      options: [
        ['lowpass', 'LP'],
        ['highpass', 'HP'],
        ['bandpass', 'BP'],
      ],
    },
  ],
  params: [
    { key: 'cutoff', label: 'Cutoff', min: 0, max: 14000, step: 10, unit: 'Hz' },
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

  apply(nodes, key, val, { ac }) {
    if (key === 'cutoff') nodes.biquad.frequency.setTargetAtTime(val, ac.currentTime, 0.02);
    if (key === 'q') nodes.biquad.Q.setTargetAtTime(val, ac.currentTime, 0.02);
  },
  applyAll(nodes, { state }) {
    nodes.biquad.type = state.mode;
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  build(ac, st, { input, wet }) {
    const biquad = ac.createBiquadFilter();

    input.connect(biquad);
    biquad.connect(wet);
    return { biquad };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    return `${st.mode.toUpperCase()} • ${formatNumericValue(st.cutoff, 0)}Hz`;
  },
};
