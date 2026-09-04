// Module worker wrapping estimateTempo so a long track's analysis runs off
// the main thread — the drum scheduler only looks 150 ms ahead, and a
// four-minute file takes longer than that to correlate.
import { estimateTempo } from './tempo.js';

self.onmessage = (event) => {
  const { id, mono, sampleRate, refBpm, fixedBpm } = event.data || {};
  try {
    self.postMessage({ id, result: estimateTempo(mono, sampleRate, { refBpm, fixedBpm }) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
