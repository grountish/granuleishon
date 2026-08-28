// Visualizer state shared by the 2D fallback and the WebGL engine.

export const VIZ = {
  canvas: null,
  ctx: null,
  animId: null,
  freqBuf: null,
  timeBuf: null,
  particles: [],
  warp: [],
  beatEnergyAvg: 0,
  beatCooldown: 0,
  beatFlash: 0,
  flowTime: 0,
  masterHue: 200,
  idleT: 0,
  // State machine
  stateIdx: 0,
  stateTimer: 0,
  stateDur: 30,
  // Current interpolated params (lerp toward active state's targets)
  p: {
    trailAlpha: 0.040,
    warpMult:   1.00,
    orbitStr:   0.55,
    turbStr:    0.70,
    hueVel:     0.07,
    maxP:       1600,
    sat:        85,
    lum:        55,
  },
};
