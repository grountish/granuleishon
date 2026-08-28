// Reverb — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

export function getReverbDampingCutoff(state) {
  return 900 + Math.pow(1 - clamp(state.damping, 0, 1), 1.45) * 13500;
}

// Synthesised impulse response: early reflections then a filtered, diffused
// noise tail. Seeded so the same settings always render the same room.
export function makeReverbIR(ac, rv) {
  const sr = ac.sampleRate;
  const len = Math.floor(sr * Math.max(0.05, rv.size));
  const buf = ac.createBuffer(2, len, sr);
  const damping = clamp(rv.damping, 0, 1);
  const decay = Math.max(0.5, rv.decay);
  const earlyCount = 6 + Math.round(rv.size * 3);
  const earlySpacing = Math.max(0.003, rv.size * 0.0022);
  const baseBrightness = 0.11 + (1 - damping) * 0.22;
  let peak = 0;
  const seededNoise = (seed) => {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453123;
    return (x - Math.floor(x)) * 2 - 1;
  };

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const stereoBias = c === 0 ? -1 : 1;

    for (let tap = 0; tap < earlyCount; tap++) {
      const jitter = (seededNoise((tap + 1) * (c + 3) * 11.7) + 1) * 0.5;
      const tapTime =
        tap * earlySpacing +
        earlySpacing * 0.5 * Math.sin((tap + 1) * (0.91 + c * 0.13)) +
        jitter * earlySpacing * 0.45;
      const index = Math.min(len - 1, Math.max(0, Math.floor(tapTime * sr)));
      const amp = (0.42 - tap / (earlyCount * 2.2)) * (tap % 2 === 0 ? 1 : 0.82);
      d[index] += amp * (0.9 + stereoBias * 0.08 * Math.sin((tap + 1) * 1.37));
    }

    let filtered = 0;
    let diffuser = 0;
    for (let i = 0; i < len; i++) {
      const t = i / Math.max(1, len - 1);
      const env = Math.pow(1 - t, 0.35 + 3.4 / decay);
      const noise = seededNoise(i + 1 + c * 8192);
      const brightness = baseBrightness * (1 - t * 0.55) + 0.012 + c * 0.006;
      filtered += (noise - filtered) * brightness;
      diffuser += (filtered - diffuser) * (0.055 + (1 - damping) * 0.02 + c * 0.004);
      const shimmer = Math.sin(t * Math.PI * (7.5 + c * 0.7)) * 0.035;
      d[i] += (filtered * 0.78 + diffuser * 0.52 + shimmer) * env;
      peak = Math.max(peak, Math.abs(d[i]));
    }
  }

  if (peak > 0) {
    const norm = 0.92 / peak;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
  }
  return buf;
}

export default {
  id: 'reverb',
  label: 'Reverb',
  idleBypass: true,
  params: [
    { key: 'size', label: 'Size', min: 0.1, max: 5, step: 0.1, value: 2, unit: 's' },
    { key: 'decay', label: 'Decay', min: 0.5, max: 8, step: 0.1, value: 3, unit: '' },
    {
      key: 'predelay',
      label: 'Pre-delay',
      min: 0,
      max: 0.25,
      step: 0.001,
      value: 0.018,
      unit: 's',
    },
    { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, value: 0.42, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({ enabled: true, size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 }),
  presets: [
    { name: 'Off', values: { size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 } },
    { name: 'Room', values: { size: 0.7, decay: 1.3, predelay: 0.008, damping: 0.65, mix: 0.25 } },
    { name: 'Hall', values: { size: 2.8, decay: 4.8, predelay: 0.025, damping: 0.45, mix: 0.38 } },
    { name: 'Cavern', values: { size: 5, decay: 7, predelay: 0.06, damping: 0.3, mix: 0.5 } },
  ],

  apply(nodes, key, val, { ac, state }) {
    // Size, decay and damping all change the room, so the IR is re-rendered.
    if (key === 'size' || key === 'decay' || key === 'damping')
      nodes.conv.buffer = makeReverbIR(ac, state);
    if (key === 'predelay') nodes.pre.delayTime.setTargetAtTime(val, ac.currentTime, 0.02);
    if (key === 'damping')
      nodes.damp.frequency.setTargetAtTime(getReverbDampingCutoff(state), ac.currentTime, 0.03);
  },
};
