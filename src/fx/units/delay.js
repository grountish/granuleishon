// Delay — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

export const MAX_DELAY_SECONDS = 16;

export default {
  id: 'delay',
  label: 'Delay',
  idleBypass: false,
  params: [
    { key: 'time', label: 'Time', min: 0, max: 1, step: 0.01, value: 0.3, unit: 's' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, value: 0.35, unit: '' },
    { key: 'hp', label: 'HP Cut', min: 20, max: 2000, step: 10, value: 20, unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    time: 0.3,
    feedback: 0.35,
    mix: 0,
    sync: false,
    syncIndex: 4,
    hp: 20,
    mode: 'stereo',
  }),
  presets: [
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

  apply(nodes, key, val, { ac }) {
    if (key === 'time')
      [nodes.tap, nodes.pingL, nodes.pingR].forEach((tap) =>
        tap.delayTime.setTargetAtTime(clamp(val, 0, MAX_DELAY_SECONDS), ac.currentTime, 0.02),
      );
    if (key === 'feedback')
      [nodes.fb, nodes.pingLFb, nodes.pingRFb].forEach((gain) =>
        gain.gain.setTargetAtTime(Math.min(0.98, val), ac.currentTime, 0.02),
      );
    if (key === 'hp')
      [nodes.hpf, nodes.pingLHpf, nodes.pingRHpf].forEach((f) =>
        f.frequency.setTargetAtTime(clamp(val, 20, 2000), ac.currentTime, 0.02),
      );
  },
  // Stereo and ping-pong share one graph; the mode gates which path is live.
  applyAll(nodes, { ac, state }) {
    const ping = state.mode === 'pingpong' ? 1 : 0;
    const normal = 1 - ping;
    [nodes.normalSend, nodes.normalFeedbackMode, nodes.normalWetMode].forEach((g) =>
      g.gain.setValueAtTime(normal, ac.currentTime),
    );
    [nodes.pingInputMode, nodes.pingLFeedbackMode, nodes.pingRFeedbackMode, nodes.pingWetMode].forEach(
      (g) => g.gain.setValueAtTime(ping, ac.currentTime),
    );
  },
};
