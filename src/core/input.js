// Audio input selection and the noise gate on the mic feed.

export const INPUT_SOURCE = {
  devices: [],
  selectedId: 'default',
};

// Noise gate on the mic feeding the granulators: signal below threshold is
// muted before it reaches the worklet, so it isn't heard or visualized.
export const INPUT_GATE = {
  enabled: false,
  threshold: 0.01, // linear amplitude; -40 dB default
  node: null, // ScriptProcessor inserted between mic source and worklet
  env: 0, // smoothed gain envelope 0..1
  attackMs: 3, // ramp up when signal crosses threshold
  releaseMs: 120, // ramp down when it drops below
};
