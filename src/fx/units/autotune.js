// Autotune — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';
import { computeAutotuneMask } from '../../core/theory.js';

import { AUTOTUNE_SCALE_OPTIONS, NOTE_NAMES } from '../../core/theory.js';
import { formatBackValue, formatNumericValue } from '../../core/util.js';
import { getFxParamDef } from '../registry.js';

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

  apply(nodes, key, val, { ac }) {
    const set = (name, value) =>
      nodes.node.parameters.get(name)?.setTargetAtTime(value, ac.currentTime, 0.02);
    if (key === 'speed') set('speed', clamp(val, 0, 500));
    if (key === 'amount') set('amount', clamp(val, 0, 1));
  },
  // Root and scale reach the worklet as one 12-bit pitch-class mask.
  applyAll(nodes, { ac, state }) {
    nodes.node.parameters.get('mask')?.setValueAtTime(computeAutotuneMask(state), ac.currentTime);
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  build(ac, st, { input, wet }) {
    const node = new AudioWorkletNode(ac, 'autotune-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        speed: st.speed,
        amount: st.amount,
        mask: computeAutotuneMask(st),
      },
    });

    input.connect(node);
    node.connect(wet);
    return { node };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    const scaleLabel =
    AUTOTUNE_SCALE_OPTIONS.find(([id]) => id === st.scale)?.[1] || st.scale;
    return `${NOTE_NAMES[st.root] || 'C'} ${scaleLabel} • ${formatNumericValue(st.speed, 0)}ms • ${formatBackValue(getFxParamDef('autotune', 'mix'), st.mix)} wet`;
  },
};
