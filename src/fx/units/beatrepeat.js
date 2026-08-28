// Beat Repeat — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

export default {
  id: 'beatrepeat',
  label: 'Beat Repeat',
  idleBypass: false,
  params: [
    { key: 'interval', label: 'Interval', min: 0.02, max: 2, step: 0.01, value: 0.5, unit: 's' },
    { key: 'grid', label: 'Grid', min: 10, max: 500, step: 1, value: 125, unit: 'ms' },
    { key: 'gate', label: 'Gate', min: 1, max: 32, step: 1, value: 8, unit: 'x' },
    { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
    { key: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
    { key: 'chance', label: 'Chance', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    interval: 0.5,
    sync: true,
    syncIndex: 4,
    grid: 125,
    gridSync: true,
    gridSyncIndex: 2,
    gate: 8,
    pitch: 0,
    decay: 1,
    chance: 1,
    mix: 0,
  }),
  presets: [
    {
      name: 'Off',
      values: {
        interval: 0.5,
        sync: true,
        syncIndex: 4,
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2,
        gate: 8,
        pitch: 0,
        decay: 1,
        chance: 1,
        mix: 0,
      },
    },
    {
      name: 'Tight Stutter',
      values: {
        interval: 0.25,
        sync: true,
        syncIndex: 2,
        grid: 63,
        gridSync: true,
        gridSyncIndex: 1,
        gate: 4,
        pitch: 0,
        decay: 0.82,
        chance: 1,
        mix: 0.62,
      },
    },
    {
      name: 'Pitch Scatter',
      values: {
        interval: 0.5,
        sync: true,
        syncIndex: 4,
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2,
        gate: 6,
        pitch: 12,
        decay: 0.7,
        chance: 0.62,
        mix: 0.7,
      },
    },
    {
      name: 'Tape Stop',
      values: {
        interval: 1,
        sync: true,
        syncIndex: 6,
        grid: 250,
        gridSync: true,
        gridSyncIndex: 3,
        gate: 8,
        pitch: -12,
        decay: 0.58,
        chance: 1,
        mix: 0.78,
      },
    },
  ],

  apply(nodes, key, val, { ac }) {
    const set = (name, value) => nodes.node.parameters.get(name)?.setValueAtTime(value, ac.currentTime);
    if (key === 'interval') set('interval', clamp(val, 0.02, 30));
    if (key === 'grid') set('grid', clamp(val, 0.005, 1));
    if (key === 'gate') set('gate', clamp(Math.round(val), 1, 64));
    if (key === 'pitch') set('pitch', clamp(val, -24, 24));
    if (key === 'decay') set('decay', clamp(val, 0, 1));
    if (key === 'chance') set('chance', clamp(val, 0, 1));
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  build(ac, st, { input, wet, base }) {
    const node = new AudioWorkletNode(ac, 'beat-repeat-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        interval: base('interval'),
        grid: base('grid'),
        gate: st.gate,
        pitch: st.pitch,
        decay: st.decay,
        chance: st.chance,
      },
    });

    input.connect(node);
    node.connect(wet);
    return { node };
  },
};
