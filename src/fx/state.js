// Per-bus FX state: which effects each instrument bus runs, in what order,
// and the audio nodes realising them. BUS tracks which bus the FX column is
// editing, with BUS.fx aliasing that bus's state so the UI can say BUS.fx.*
// without knowing which bus is active.

import { makeDefaultFxState, DEFAULT_FX_ORDER } from './registry.js';

export const FX_BUS_LABELS = { gen0: 'Granular 1', gen1: 'Granular 2', gen3: 'Synth', gen4: 'Drums' };
export const FX_BUS_IDS = ['gen0', 'gen1', 'gen3', 'gen4'];
// Source of truth for per-bus FX state — applied to audio nodes when they exist.
export const fxStates = {
  gen0: makeDefaultFxState(),
  gen1: makeDefaultFxState(),
  gen3: makeDefaultFxState(),
  gen4: makeDefaultFxState(),
};

// Global master limiter state (one limiter at the tail of the summed mix).
export const LIMITER = { threshold: -8, attack: 0.003, release: 0.12, ratio: 20, knee: 0, output: 0.96 };

// Order of the reorderable effects between each bus input and bus output.
// Mutated per-bus by drag-to-reorder; persisted in presets.
export const fxOrders = {
  gen0: [...DEFAULT_FX_ORDER],
  gen1: [...DEFAULT_FX_ORDER],
  gen3: [...DEFAULT_FX_ORDER],
  gen4: [...DEFAULT_FX_ORDER],
};

// Which bus the FX column currently shows/edits, plus the alias below.
export const BUS = { active: 'gen0', fx: null };

// Per-bus audio node graphs, created in ensureAudioEngine(), nulled in stop().
export const fxBuses = { gen0: null, gen1: null, gen3: null, gen4: null };

// BUS.fx aliases the active bus's state, kept in sync by setActiveBus().
BUS.fx = fxStates[BUS.active];
