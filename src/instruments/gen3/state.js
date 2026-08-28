// Gen 3 oscillator state: the sound, the held chord, and the live voices.
// lockedMidis is bound by reference from the edited loop, so the keys grid
// mutates the loop directly.

export const GEN3 = {
  type: 'sine',
  gain: 0.5,
  pitch: 0,
  detune: 0,
  attack: 0.3,
  decay: 0.18,
  sustain: 0.7,
  release: 0.5,
  sustainMode: true,
  arpEnabled: false,
  arpRateBeats: 0.25,
  arpDirection: 'up',
  arpOctaves: 1,
  arpGate: 0.75,
  lockedMidis: new Set(),
  activeNotes: new Map(),
  releasingVoices: new Set(),
  nodes: null,
};

// activeNotes: Map<midi, { freq, source, envelope }>
// Gen3 knob defs — shared by the gen3 panel and the drum sequencer's OSC
// param locks (per-step overrides stored in the osc channel's locks array).
export const GEN3_PARAM_DEFS = [
  { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, unit: 'st' },
  { key: 'detune', label: 'Detune', min: -100, max: 100, step: 1, unit: 'ct' },
  { key: 'attack', label: 'Attack', min: 0, max: 10, step: 0.01, unit: 's' },
  { key: 'decay', label: 'Decay', min: 0, max: 2, step: 0.01, unit: 's' },
  { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'release', label: 'Release', min: 0, max: 10, step: 0.01, unit: 's' },
];

export const gen3ControlBindings = new Map();
