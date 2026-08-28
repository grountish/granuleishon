// Gen 4 drum lanes: what each lane is called, its accent colour and the
// synthesis params it exposes, plus the factory kit for each lane.
// Pure data — no state, no DOM, no audio nodes.

export const GEN4_DEFS = [
  {
    id: 'kick',
    label: 'KICK',
    color: '#e05858',
    paramDefs: [
      { key: 'tune', label: 'Tune', min: 30, max: 120, step: 1, value: 70, unit: 'Hz' },
      { key: 'decay', label: 'Decay', min: 0.05, max: 1.0, step: 0.01, value: 0.85, unit: 's' },
      { key: 'punch', label: 'Punch', min: 0, max: 1, step: 0.01, value: 0.36, unit: '' },
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
    ],
  },
  {
    id: 'snare',
    label: 'SNR',
    color: '#d4892a',
    paramDefs: [
      { key: 'tune', label: 'Tone', min: 100, max: 500, step: 5, value: 360, unit: 'Hz' },
      { key: 'decay', label: 'Decay', min: 0.05, max: 0.8, step: 0.01, value: 0.09, unit: 's' },
      { key: 'snap', label: 'Snap', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.96, unit: '' },
    ],
  },
  {
    id: 'hat',
    label: 'HAT',
    color: '#7ad860',
    paramDefs: [
      { key: 'decay', label: 'Decay', min: 0.005, max: 0.5, step: 0.005, value: 0.06, unit: 's' },
      { key: 'tone', label: 'Tone', min: 3000, max: 16000, step: 200, value: 11200, unit: 'Hz' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.6, unit: '' },
    ],
  },
  {
    id: 'perc',
    label: 'PERC',
    color: '#9f7de8',
    paramDefs: [
      { key: 'tune', label: 'Tune', min: 80, max: 800, step: 5, value: 165, unit: 'Hz' },
      { key: 'ratio', label: 'Ratio', min: 0.5, max: 8, step: 0.1, value: 1.6, unit: '' },
      { key: 'index', label: 'Index', min: 0, max: 10, step: 0.1, value: 1.6, unit: '' },
      { key: 'decay', label: 'Decay', min: 0.03, max: 0.6, step: 0.01, value: 0.06, unit: 's' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.7, unit: '' },
    ],
  },
  {
    id: 'osc',
    label: 'OSC',
    color: '#40b8d0',
    paramDefs: [],
  },
  {
    id: 'fm',
    label: 'FM',
    color: '#e06ab5',
    paramDefs: [
      { key: 'tune', label: 'Tune', min: 30, max: 1200, step: 1, value: 220, unit: 'Hz' },
      { key: 'ratio', label: 'Ratio', min: 0.25, max: 8, step: 0.05, value: 2, unit: '' },
      { key: 'index', label: 'Index', min: 0, max: 20, step: 0.1, value: 3, unit: '' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'attack', label: 'Attack', min: 0.001, max: 1, step: 0.001, value: 0.005, unit: 's' },
      { key: 'decay', label: 'Decay', min: 0.03, max: 2, step: 0.01, value: 0.35, unit: 's' },
      {
        key: 'modDecay',
        label: 'Mod Decay',
        min: 0.01,
        max: 2,
        step: 0.01,
        value: 0.3,
        unit: 's',
      },
      { key: 'tone', label: 'Tone', min: 200, max: 16000, step: 100, value: 12000, unit: 'Hz' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.65, unit: '' },
    ],
  },
  {
    // Sampler lane — plays a slice of a granular input's audio (a loaded file
    // or a frozen mic take). Start/length are fractions of that buffer.
    id: 'smp',
    label: 'SMP',
    color: '#d8c94a',
    paramDefs: [
      { key: 'source', label: 'Source', min: 0, max: 1, step: 1, value: 0, unit: '' },
      { key: 'start', label: 'Start', min: 0, max: 1, step: 0.001, value: 0, unit: '' },
      { key: 'length', label: 'Length', min: 0.01, max: 1, step: 0.001, value: 0.25, unit: '' },
      { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
      { key: 'decay', label: 'Decay', min: 0.02, max: 2, step: 0.01, value: 0.8, unit: 's' },
      { key: 'tone', label: 'Tone', min: 200, max: 16000, step: 100, value: 16000, unit: 'Hz' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.8, unit: '' },
    ],
  },
];

export const GEN4_PRESETS = {
  kick: [
    { name: 'Default', values: { tune: 70, decay: 0.85, punch: 0.36, drive: 0, gain: 1 } },
    { name: 'Deep', values: { tune: 48, decay: 0.72, punch: 0.62, drive: 0.08, gain: 0.95 } },
    { name: 'Tight', values: { tune: 82, decay: 0.18, punch: 0.78, drive: 0.05, gain: 0.9 } },
    { name: 'Driven', values: { tune: 58, decay: 0.5, punch: 0.72, drive: 0.8, gain: 0.82 } },
  ],
  snare: [
    { name: 'Default', values: { tune: 360, decay: 0.09, snap: 1, gain: 0.96 } },
    { name: 'Tight', values: { tune: 310, decay: 0.11, snap: 0.9, gain: 0.9 } },
    { name: 'Fat', values: { tune: 210, decay: 0.32, snap: 0.62, gain: 0.92 } },
    { name: 'Bright', values: { tune: 440, decay: 0.18, snap: 1, gain: 0.78 } },
  ],
  hat: [
    { name: 'Default', values: { decay: 0.06, tone: 11200, gain: 0.6 } },
    { name: 'Closed', values: { decay: 0.025, tone: 13500, gain: 0.52 } },
    { name: 'Open', values: { decay: 0.32, tone: 9800, gain: 0.55 } },
    { name: 'Dark', values: { decay: 0.12, tone: 5200, gain: 0.7 } },
  ],
  perc: [
    { name: 'Default', values: { tune: 165, ratio: 1.6, index: 1.6, decay: 0.06, gain: 0.7 } },
    { name: 'Wood', values: { tune: 145, ratio: 1.4, index: 0.9, decay: 0.12, gain: 0.75 } },
    { name: 'Bell', values: { tune: 330, ratio: 3.5, index: 4.8, decay: 0.45, gain: 0.6 } },
    { name: 'Metal', values: { tune: 520, ratio: 6.2, index: 8.2, decay: 0.2, gain: 0.55 } },
  ],
  fm: [
    {
      name: 'Default',
      values: { tune: 220, ratio: 2, index: 3, feedback: 0, attack: 0.005, decay: 0.35, modDecay: 0.3, tone: 12000, gain: 0.65 },
    },
    {
      name: 'Sub Bass',
      values: { tune: 55, ratio: 0.5, index: 1.2, feedback: 0.08, attack: 0.005, decay: 0.55, modDecay: 0.3, tone: 1800, gain: 0.8 },
    },
    {
      name: 'Bell',
      values: { tune: 440, ratio: 3.5, index: 8, feedback: 0.18, attack: 0.002, decay: 1.4, modDecay: 1.7, tone: 11000, gain: 0.55 },
    },
    {
      name: 'Pluck',
      values: { tune: 220, ratio: 2, index: 4, feedback: 0.05, attack: 0.001, decay: 0.16, modDecay: 0.08, tone: 6500, gain: 0.7 },
    },
    {
      name: 'Zap',
      values: { tune: 110, ratio: 5.25, index: 12, feedback: 0.55, attack: 0.001, decay: 0.22, modDecay: 0.06, tone: 14000, gain: 0.55 },
    },
  ],
  smp: [
    {
      name: 'Default',
      values: { source: 0, start: 0, length: 0.25, pitch: 0, decay: 0.8, tone: 16000, gain: 0.8 },
    },
    {
      name: 'Chop',
      values: { source: 0, start: 0, length: 0.08, pitch: 0, decay: 0.25, tone: 16000, gain: 0.85 },
    },
    {
      name: 'Pad',
      values: { source: 0, start: 0.1, length: 1, pitch: 0, decay: 2, tone: 9000, gain: 0.7 },
    },
    {
      name: 'Dark Half',
      values: { source: 0, start: 0.2, length: 0.35, pitch: -12, decay: 1.2, tone: 3200, gain: 0.8 },
    },
  ],
};

// Note range the drum lanes address, the probability cycle, and the
// Elektron-style per-step trig conditions.
export const GEN4_NOTE_MIN = 24;

export const GEN4_NOTE_MAX = 127;

export const GEN4_PROB_CYCLE = [1.0, 0.75, 0.5, 0.25];

// ── Trig conditions ── Elektron-style per-step gates evaluated at schedule
// time: A:B fires on the Ath of every B pattern cycles, FILL only while the
// fill is engaged, PRE/!PRE follow the lane's previous trig decision.
export const GEN4_TRIG_CONDITIONS = [
  { id: 'always', label: '' },
  { id: '1:2', label: '1:2', a: 1, b: 2 },
  { id: '2:2', label: '2:2', a: 2, b: 2 },
  { id: '1:4', label: '1:4', a: 1, b: 4 },
  { id: '4:4', label: '4:4', a: 4, b: 4 },
  { id: 'fill', label: 'FIL', fill: true },
  { id: 'pre', label: 'PRE', pre: true },
  { id: 'npre', label: '!PR', pre: false },
];
