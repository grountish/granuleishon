// Resonator — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

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
};
