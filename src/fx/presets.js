// Factory presets per rack effect. Each entry is a complete set of values
// for that unit, so applying one never leaves a stale field behind.

export const FX_PRESETS = {
  autotune: [
    { name: 'Off', values: { speed: 40, amount: 1, mix: 0 } },
    { name: 'Natural', values: { speed: 120, amount: 0.8, mix: 1 } },
    { name: 'Hard Snap', values: { speed: 0, amount: 1, mix: 1 } },
  ],
  beatrepeat: [
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
  grainarp: [
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
  pitchtrem: [
    {
      name: 'Off',
      values: {
        pitch: 0,
        pitchDepth: 0,
        fine: 0,
        rate: 4,
        sync: false,
        syncIndex: 4,
        depth: 0.5,
        shape: 'sine',
        mix: 0,
      },
    },
    {
      name: 'Gentle Motion',
      values: {
        pitch: 0,
        pitchDepth: 1,
        fine: 0,
        rate: 0.2,
        sync: false,
        syncIndex: 4,
        depth: 0.55,
        shape: 'sine',
        mix: 0.35,
      },
    },
    {
      name: 'Fifth Orbit',
      values: {
        pitch: 0,
        pitchDepth: 7,
        fine: 0,
        rate: 2,
        sync: true,
        syncIndex: 4,
        depth: 0.85,
        shape: 'tri',
        mix: 0.55,
      },
    },
    {
      name: 'Octave Sweep',
      values: {
        pitch: 0,
        pitchDepth: 12,
        fine: 0,
        rate: 0.5,
        sync: true,
        syncIndex: 6,
        depth: 1,
        shape: 'sine',
        mix: 0.65,
      },
    },
    {
      name: 'Wide Vibrato',
      values: {
        pitch: 0,
        pitchDepth: 2,
        fine: 0,
        rate: 5,
        sync: false,
        syncIndex: 4,
        depth: 1,
        shape: 'sine',
        mix: 0.5,
      },
    },
  ],
  delay: [
    {
      name: 'Off',
      values: { time: 0.3, feedback: 0.35, hp: 20, mix: 0, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Slapback',
      values: { time: 0.12, feedback: 0.18, hp: 120, mix: 0.28, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Dub Echo',
      values: { time: 0.375, feedback: 0.72, hp: 350, mix: 0.45, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Ping Pong',
      values: { time: 0.5, feedback: 0.65, hp: 180, mix: 0.42, sync: true, syncIndex: 4, mode: 'pingpong' },
    },
  ],
  filter: [
    { name: 'Off', values: { mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 } },
    { name: 'Warm Low-pass', values: { mode: 'lowpass', cutoff: 1600, q: 0.9, mix: 1 } },
    { name: 'Telephone', values: { mode: 'bandpass', cutoff: 1400, q: 1.4, mix: 0.9 } },
    { name: 'Resonant High-pass', values: { mode: 'highpass', cutoff: 480, q: 7, mix: 0.8 } },
  ],
  resonator: [
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
  bitreduce: [
    { name: 'Off', values: { bits: 8, rate: 1, mix: 0 } },
    { name: '12-bit', values: { bits: 12, rate: 0.72, mix: 0.35 } },
    { name: 'Crunchy', values: { bits: 8, rate: 0.35, mix: 0.6 } },
    { name: 'Destroyed', values: { bits: 4, rate: 0.08, mix: 0.85 } },
  ],
  sat: [
    { name: 'Off', values: { drive: 0.3, mix: 0 } },
    { name: 'Warm', values: { drive: 0.18, mix: 0.35 } },
    { name: 'Driven', values: { drive: 0.5, mix: 0.65 } },
    { name: 'Hard Clip', values: { drive: 0.88, mix: 0.9 } },
  ],
  reverb: [
    { name: 'Off', values: { size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 } },
    { name: 'Room', values: { size: 0.7, decay: 1.3, predelay: 0.008, damping: 0.65, mix: 0.25 } },
    { name: 'Hall', values: { size: 2.8, decay: 4.8, predelay: 0.025, damping: 0.45, mix: 0.38 } },
    { name: 'Cavern', values: { size: 5, decay: 7, predelay: 0.06, damping: 0.3, mix: 0.5 } },
  ],
  limiter: [
    {
      name: 'Balanced',
      values: { threshold: -8, attack: 0.003, release: 0.12, ratio: 20, knee: 0, output: 0.96 },
    },
    {
      name: 'Gentle',
      values: { threshold: -4, attack: 0.01, release: 0.2, ratio: 6, knee: 8, output: 0.96 },
    },
    {
      name: 'Loud',
      values: { threshold: -12, attack: 0.002, release: 0.12, ratio: 20, knee: 2, output: 0.98 },
    },
    {
      name: 'Maximizer',
      values: { threshold: -10, attack: 0.001, release: 0.08, ratio: 40, knee: 1, output: 1.2 },
    },
    {
      name: 'Brickwall',
      values: { threshold: -18, attack: 0.001, release: 0.06, ratio: 40, knee: 0, output: 0.95 },
    },
  ],
};
