// Params that can either hold a free value or follow the transport. The two
// modes need different control configs (a free range vs an index into a table
// of musical divisions) and different readouts, so each synced param declares
// which table it steps through and how a step should read.

import { formatNumericValue } from '../core/util.js';
import {
  beatsToSeconds,
  formatTempoSeconds,
  formatTempoSyncValue,
  getGrainSyncStep,
} from '../core/tempo.js';

// How a division reads once synced. Free mode uses the control's own unit.
export const SYNC_FORMATTERS = {
  seconds: (v) =>
    formatTempoSyncValue(v, (step) => formatTempoSeconds(beatsToSeconds(step.beats))),
  hz: (v) =>
    formatTempoSyncValue(v, (step) => `${formatNumericValue(1 / beatsToSeconds(step.beats), 2)}Hz`),
  grid: (v) => getGrainSyncStep(Math.round(v)).label,
};

// In sync mode the knob addresses a division by index, so its range is the
// table's length whatever the free range happened to be.
export function syncedControlConfig(key, label, steps) {
  return { key, label, min: 0, max: steps.length - 1, step: 1, unit: '' };
}
