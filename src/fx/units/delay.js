// Delay — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

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
};
