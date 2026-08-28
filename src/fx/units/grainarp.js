// Grain Arp — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

// Arp patterns, in the order their mode buttons appear.
export const GRAINARP_PATTERNS = [
  ['oct', 'OCT'],
  ['up', 'UP'],
  ['down', 'DOWN'],
  ['rand', 'RND'],
];

import { formatBackValue } from '../../core/util.js';
import { getFxParamDef } from '../registry.js';

export default {
  id: 'grainarp',
  label: 'Grain Arp',
  idleBypass: false,
  params: [
    { key: 'grid', label: 'Grid', min: 10, max: 500, step: 1, value: 250, unit: 'ms' },
    { key: 'chance', label: 'Activity', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
    { key: 'shape', label: 'Shape', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
    { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    { key: 'reverse', label: 'Reverse', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    { key: 'feedback', label: 'Repeats', min: 0, max: 0.85, step: 0.01, value: 0.25, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    grid: 250, // free value in ms, like beatrepeat's grid
    gridSync: true,
    gridSyncIndex: 4, // 1/8
    pattern: 'oct',
    chance: 1,
    shape: 0.3,
    scatter: 0,
    reverse: 0,
    feedback: 0.25,
    hold: false, // performance latch — freezes the capture ring
    mix: 0,
  }),
  presets: [
    {
      name: 'Off',
      values: {
        grid: 250,
        gridSync: true,
        gridSyncIndex: 4,
        pattern: 'oct',
        chance: 1,
        shape: 0.3,
        scatter: 0,
        reverse: 0,
        feedback: 0.25,
        mix: 0,
      },
    },
    {
      name: 'Octave Bloom',
      values: {
        grid: 250,
        gridSync: true,
        gridSyncIndex: 4, // 1/8
        pattern: 'oct',
        chance: 0.85,
        shape: 0.25,
        scatter: 0,
        reverse: 0.15,
        feedback: 0.45,
        mix: 0.5,
      },
    },
    {
      name: 'Rising Sparkle',
      values: {
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2, // 1/16
        pattern: 'up',
        chance: 0.7,
        shape: 0.15,
        scatter: 0,
        reverse: 0,
        feedback: 0.3,
        mix: 0.45,
      },
    },
    {
      name: 'Falling Ghost',
      values: {
        grid: 250,
        gridSync: true,
        gridSyncIndex: 5, // 1/4T
        pattern: 'down',
        chance: 0.6,
        shape: 0.6,
        scatter: 0.3,
        reverse: 0.35,
        feedback: 0.55,
        mix: 0.5,
      },
    },
    {
      name: 'Scatter',
      values: {
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2, // 1/16
        pattern: 'rand',
        chance: 0.5,
        shape: 0.4,
        scatter: 0.7,
        reverse: 0.25,
        feedback: 0.35,
        mix: 0.45,
      },
    },
  ],

  apply(nodes, key, val, { ac }) {
    const set = (name, value) => nodes.node.parameters.get(name)?.setValueAtTime(value, ac.currentTime);
    if (key === 'grid') set('grid', clamp(val, 0.005, 1));
    if (key === 'chance') set('chance', clamp(val, 0, 1));
    if (key === 'shape') set('shape', clamp(val, 0, 1));
    if (key === 'scatter') set('scatter', clamp(val, 0, 1));
    if (key === 'reverse') set('reverse', clamp(val, 0, 1));
    if (key === 'feedback') set('feedback', clamp(val, 0, 0.85));
  },
  // Pattern choice and the HOLD latch are state, not knob params.
  applyAll(nodes, { ac, state }) {
    const idx = GRAINARP_PATTERNS.findIndex(([id]) => id === state.pattern);
    nodes.node.parameters.get('pattern')?.setValueAtTime(Math.max(0, idx), ac.currentTime);
    nodes.node.parameters.get('hold')?.setValueAtTime(state.hold ? 1 : 0, ac.currentTime);
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  build(ac, st, { input, wet, base }) {
    const node = new AudioWorkletNode(ac, 'grain-arp-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        grid: base('grid'),
        pattern: Math.max(
          0,
          GRAINARP_PATTERNS.findIndex(([id]) => id === st.pattern),
        ),
        chance: st.chance,
        shape: st.shape,
        scatter: st.scatter,
        reverse: st.reverse,
        feedback: st.feedback,
        hold: st.hold ? 1 : 0,
      },
    });

    input.connect(node);
    node.connect(wet);
    return { node };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    return `${st.hold ? 'HOLD • ' : ''}${st.pattern.toUpperCase()} • ${formatBackValue(getFxParamDef('grainarp', 'mix'), st.mix)} wet`;
  },
};
