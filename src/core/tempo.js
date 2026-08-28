// Transport tempo and the musical-division tables every synced param reads.
// TRANSPORT.bpm is shared mutable state; setting it lives in the transport UI.

import { clamp, formatNumericValue } from './util.js';

export const BPM_BOUNDS = { min: 40, max: 240, step: 1 };
export const TRANSPORT = { bpm: 120 };

// Divisions offered to tempo-synced FX (delay time, beat repeat interval…).
export const TEMPO_SYNC_STEPS = [
  { label: '1/16', beats: 0.25 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/8', beats: 0.5 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/4', beats: 1 },
  { label: '1/2', beats: 2 },
  { label: '1B', beats: 4 },
  { label: '2B', beats: 8 },
];

// Finer divisions, for grain-rate params that need to go below a 16th.
export const GRAIN_SYNC_STEPS = [
  { label: '1/64', beats: 0.0625 },
  { label: '1/32', beats: 0.125 },
  { label: '1/16', beats: 0.25 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/8', beats: 0.5 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/4', beats: 1 },
];

export const GRAIN_SYNC_CONTROL = { min: 0, max: GRAIN_SYNC_STEPS.length - 1, step: 1, unit: '' };

export function getTempoStep(syncIndex) {
  const index = clamp(Math.round(syncIndex), 0, TEMPO_SYNC_STEPS.length - 1);
  return TEMPO_SYNC_STEPS[index];
}

export function getGrainSyncStep(syncIndex) {
  return GRAIN_SYNC_STEPS[clamp(Math.round(syncIndex), 0, GRAIN_SYNC_STEPS.length - 1)];
}

export function beatsToSeconds(beats) {
  return (60 / TRANSPORT.bpm) * beats;
}

export function formatTempoSeconds(seconds) {
  const decimals = seconds >= 10 ? 1 : 2;
  return `${formatNumericValue(seconds, decimals)}s`;
}

export function formatTempoSyncValue(syncIndex, suffix) {
  const step = getTempoStep(syncIndex);
  return `${step.label} ${suffix(step)}`;
}
