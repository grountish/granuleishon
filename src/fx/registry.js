// The rack's unit registry. Each effect describes itself in one file under
// units/; everything the app used to hand-maintain as parallel tables —
// FX_DEFS, FX_PRESETS, the default state, the chain order, the idle-bypass
// set — is derived from that list here, so adding an effect means adding one
// file and one line rather than editing five tables that can drift apart.
//
// Phase 4 of REFACTOR.md continues: build/apply/extraUI move into the unit
// files next, which retires the per-effect branches in app.js.

import beatrepeat from './units/beatrepeat.js';
import grainarp from './units/grainarp.js';
import pitchtrem from './units/pitchtrem.js';
import autotune from './units/autotune.js';
import delay from './units/delay.js';
import filter from './units/filter.js';
import resonator from './units/resonator.js';
import bitreduce from './units/bitreduce.js';
import sat from './units/sat.js';
import reverb from './units/reverb.js';
import limiter from './units/limiter.js';

// Declaration order — matches the old FX_DEFS array, which the preset
// selects and param lookups read.
export const FX_UNITS = [
  beatrepeat,
  grainarp,
  pitchtrem,
  autotune,
  delay,
  filter,
  resonator,
  bitreduce,
  sat,
  reverb,
  limiter,
];

export const FX_UNITS_BY_ID = new Map(FX_UNITS.map((u) => [u.id, u]));

// Signal order through a bus, input → output. The limiter is not here: it is
// global and pinned after the summed mix, not part of any bus chain.
export const DEFAULT_FX_ORDER = [
  'filter',
  'sat',
  'bitreduce',
  'pitchtrem',
  'autotune',
  'delay',
  'beatrepeat',
  'grainarp',
  'resonator',
  'reverb',
];

export const FX_DEFS = FX_UNITS.map(({ id, label, params }) => ({ id, label, params }));

export const FX_PRESETS = Object.fromEntries(
  FX_UNITS.filter((u) => u.presets).map((u) => [u.id, u.presets]),
);

// Units safe to unplug from the chain while inaudible: nothing in them
// accumulates material a player would expect to still be there when the mix
// comes back up. Beat repeat, grain arp and delay are deliberately absent —
// their capture rings and tails must keep filling at mix 0 so a performance
// gesture grabs the audio that just played.
export const FX_IDLE_BYPASS = new Set(
  FX_UNITS.filter((u) => u.idleBypass).map((u) => u.id),
);

// Fresh state per bus — each unit's defaults() is a factory, so no two buses
// ever share a state object. Key order matches the chain order the units are
// declared in, keeping saved presets byte-stable.
export function makeDefaultFxState() {
  const state = {};
  FX_UNITS.forEach((u) => {
    if (u.defaults) state[u.id] = u.defaults();
  });
  return state;
}
