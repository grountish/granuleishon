// The live audio engine. One object so every module reads the same instance
// through a stable binding — these fields are reassigned as the context is
// created, torn down and rebuilt, which an ES module import cannot express.
export const engine = {
  ctx: null, // AudioContext (or the offline one during a render)
  node: null, // the granular worklet node
  master: null, // { sum, limiter, output } — global tail of the mix
  started: false,
  micStream: null,
  granularInputSource: null,
};
