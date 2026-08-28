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
