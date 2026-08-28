// Mixer panel state (strips, meters, animation frame).

export const MIXER = {
  built: false,
  strips: new Map(),
  master: null,
  meterBuffers: new WeakMap(),
  raf: null,
};
