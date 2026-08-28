// Gen 4 drum machine state: scheduler position plus one channel per lane,
// each holding the 32-step pattern arrays the editor mutates in place.

import { GEN4_DEFS } from './defs.js';

export const GEN4 = {
  playing: false,
  schedulerStep: -1,
  displayStep: -1,
  nextStepTime: 0,
  schedulerTimer: null,
  scheduleAheadTime: 0.15,
  scheduleInterval: 25,
  stepCount: 16,
  nodes: null,
  cycleCount: 0, // pattern passes since play started — drives A:B trig conditions
  condFired: GEN4_DEFS.map(() => false), // last per-lane trig decision, for PRE
  channels: GEN4_DEFS.map((def) => {
    return {
      id: def.id,
      muted: false,
      fxSend: def.id !== 'kick',
      steps: new Array(32).fill(false),
      notes: new Array(32).fill(null),
      velocity: new Array(32).fill(1.0),
      timing: new Array(32).fill(0),
      locks: Array.from({ length: 32 }, () => ({})),
      stutter: new Array(32).fill(1),
      probability: new Array(32).fill(1.0),
      condition: new Array(32).fill(0),
      params: Object.fromEntries(def.paramDefs.map((p) => [p.key, p.value])),
    };
  }),
};
