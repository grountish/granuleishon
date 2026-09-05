// Modulation sources and their routing: two LFOs, the step sequencer, the
// map of routed targets, and the patch board's UI state.

export const LFOS = [
  {
    label: 'LFO 1',
    rate: 1.0,
    sync: false,
    syncIndex: 5,
    shape: 'sine',
    depth: 0.3,
    phase: 0,
    currentValue: 0,
    holdValue: 0,
  },
  {
    label: 'LFO 2',
    rate: 0.35,
    sync: false,
    syncIndex: 6,
    shape: 'tri',
    depth: 0.25,
    phase: 0,
    currentValue: 0,
    holdValue: 0,
  },
];

export const lfoMappings = new Map();

export const STEP_SEQ = {
  label: 'Seq 1',
  steps: Array.from({ length: 16 }, () => 0),
  subdivision: 16,
  stepBeats: 0.25,
  sharedAcrossLoops: false,
  currentStep: 0,
  currentValue: 0,
  originTime: 0,
  elapsed: 0,
};

export const BACK_PANEL = {
  sourceJacks: new Map(),
  sourceMeters: new Map(),
  sourceMeta: new Map(),
  audioModules: new Map(),
  targetJacks: new Map(),
  targetRows: new Map(),
  targetValues: new Map(),
  routeLayer: null,
  patchfieldEl: null,
  built: false,
  selectedSourceIdx: null,
  pointerX: null,
  pointerY: null,
  connFrame: null,
};
