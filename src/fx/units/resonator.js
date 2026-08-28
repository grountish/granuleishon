// Resonator — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

import { formatBackValue, formatNumericValue } from '../../core/util.js';
import { formatMidiNote } from '../../core/theory.js';
import { getFxParamDef } from '../registry.js';

export default {
  id: 'resonator',
  label: 'Resonator',
  idleBypass: true,
  params: [
    { key: 'freq', label: 'Freq', min: 40, max: 2000, step: 1, value: 220, unit: 'Hz' },
    { key: 'decay', label: 'Decay', min: 0, max: 0.98, step: 0.01, value: 0.85, unit: '' },
    { key: 'damp', label: 'Damp', min: 200, max: 12000, step: 10, value: 4200, unit: 'Hz' },
    { key: 'int2', label: 'Note 2', min: -24, max: 24, step: 1, value: 12, unit: 'st' },
    { key: 'harm2', label: 'Level 2', min: 0, max: 1, step: 0.01, value: 0.5, unit: '' },
    { key: 'int3', label: 'Note 3', min: -24, max: 24, step: 1, value: 7, unit: 'st' },
    { key: 'harm3', label: 'Level 3', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    freq: 220,
    noteMode: false,
    note: 57, // MIDI A3 = 220Hz
    decay: 0.85,
    damp: 4200,
    int2: 12, // chord voice 2, semitones from root (octave)
    int3: 7, // chord voice 3, semitones from root (fifth)
    harm2: 0.5,
    harm3: 0.3,
    mix: 0,
  }),
  presets: [
    {
      name: 'Off',
      values: {
        freq: 220,
        noteMode: false,
        note: 57,
        decay: 0.85,
        damp: 4200,
        int2: 12,
        int3: 7,
        harm2: 0.5,
        harm3: 0.3,
        mix: 0,
      },
    },
    {
      name: 'Sub Drone',
      values: {
        freq: 55,
        noteMode: true,
        note: 33, // A1 = 55Hz
        decay: 0.94,
        damp: 2200,
        int2: 12, // octave
        int3: 19, // octave + fifth
        harm2: 0.6,
        harm3: 0.25,
        mix: 0.5,
      },
    },
    {
      name: 'Major Triad',
      values: {
        freq: 220,
        noteMode: true,
        note: 57, // A3
        decay: 0.9,
        damp: 5200,
        int2: 4, // major third
        int3: 7, // fifth
        harm2: 0.7,
        harm3: 0.7,
        mix: 0.45,
      },
    },
    {
      name: 'Minor Triad',
      values: {
        freq: 220,
        noteMode: true,
        note: 57, // A3
        decay: 0.9,
        damp: 5200,
        int2: 3, // minor third
        int3: 7, // fifth
        harm2: 0.7,
        harm3: 0.7,
        mix: 0.45,
      },
    },
    {
      name: 'Metallic',
      values: {
        freq: 440,
        noteMode: true,
        note: 69, // A4 = 440Hz
        decay: 0.9,
        damp: 9000,
        int2: 12,
        int3: 19,
        harm2: 0.8,
        harm3: 0.7,
        mix: 0.55,
      },
    },
    {
      name: 'Glass Bell',
      values: {
        freq: 880,
        noteMode: true,
        note: 81, // A5 = 880Hz
        decay: 0.82,
        damp: 6500,
        int2: 19, // octave + fifth
        int3: 24, // two octaves
        harm2: 0.45,
        harm3: 0.6,
        mix: 0.4,
      },
    },
  ],

  apply(nodes, key, val, { ac }) {
    const set = (name, value) =>
      nodes.node.parameters.get(name)?.setTargetAtTime(value, ac.currentTime, 0.02);
    if (key === 'freq') set('freq', clamp(val, 40, 2000));
    if (key === 'decay') set('decay', clamp(val, 0, 0.98));
    if (key === 'damp') set('damp', clamp(val, 200, 12000));
    if (key === 'int2') set('int2', clamp(val, -24, 24));
    if (key === 'int3') set('int3', clamp(val, -24, 24));
    if (key === 'harm2') set('harm2', clamp(val, 0, 1));
    if (key === 'harm3') set('harm3', clamp(val, 0, 1));
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  build(ac, st, { input, wet, base }) {
    const node = new AudioWorkletNode(ac, 'resonator-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        freq: base('freq'),
        decay: st.decay,
        damp: st.damp,
        int2: st.int2,
        int3: st.int3,
        harm2: st.harm2,
        harm3: st.harm3,
      },
    });

    input.connect(node);
    node.connect(wet);
    return { node };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    return `${st.noteMode ? formatMidiNote(st.note) : `${formatNumericValue(st.freq, 0)}Hz`} • ${formatBackValue(getFxParamDef('resonator', 'mix'), st.mix)} wet`;
  },
};
