// Bit Reduce — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { formatBackValue, formatNumericValue } from '../../core/util.js';
import { getFxParamDef } from '../registry.js';

export default {
  id: 'bitreduce',
  label: 'Bit Reduce',
  idleBypass: true,
  params: [
    { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, value: 8, unit: '' },
    { key: 'rate', label: 'Rate', min: 0.02, max: 1, step: 0.01, value: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({ enabled: true, bits: 8, rate: 1, mix: 0 }),
  presets: [
    { name: 'Off', values: { bits: 8, rate: 1, mix: 0 } },
    { name: '12-bit', values: { bits: 12, rate: 0.72, mix: 0.35 } },
    { name: 'Crunchy', values: { bits: 8, rate: 0.35, mix: 0.6 } },
    { name: 'Destroyed', values: { bits: 4, rate: 0.08, mix: 0.85 } },
  ],

  apply(nodes, key, val, { ac }) {
    if (key === 'bits' || key === 'rate')
      nodes.node.parameters.get(key)?.setTargetAtTime(val, ac.currentTime, 0.02);
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  build(ac, st, { input, wet }) {
    const node = new AudioWorkletNode(ac, 'bit-reducer-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        bits: st.bits,
        rate: st.rate,
      },
    });

    input.connect(node);
    node.connect(wet);
    return { node };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    return `${formatNumericValue(st.bits, 0)} bits • ${formatBackValue(getFxParamDef('bitreduce', 'mix'), st.mix)} wet`;
  },
};
