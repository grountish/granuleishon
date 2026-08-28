// Pitch + Auto Pan — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

const SHAPES = ['sine', 'tri', 'square', 'saw'];

export default {
  id: 'pitchtrem',
  label: 'Pitch + Auto Pan',
  idleBypass: true,
  params: [
    { key: 'pitch', label: 'Pitch center', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
    { key: 'pitchDepth', label: 'Pitch sweep', min: 0, max: 24, step: 1, value: 0, unit: 'st' },
    { key: 'fine', label: 'Fine', min: -100, max: 100, step: 1, value: 0, unit: 'ct' },
    { key: 'rate', label: 'Pan rate', min: 0.05, max: 20, step: 0.05, value: 4, unit: 'Hz' },
    { key: 'depth', label: 'Pan depth', min: 0, max: 1, step: 0.01, value: 0.5, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    pitch: 0,
    pitchDepth: 0,
    fine: 0,
    rate: 4,
    sync: false,
    syncIndex: 4,
    depth: 0.5,
    shape: 'sine',
    mix: 0,
  }),
  presets: [
    {
      name: 'Off',
      values: {
        pitch: 0,
        pitchDepth: 0,
        fine: 0,
        rate: 4,
        sync: false,
        syncIndex: 4,
        depth: 0.5,
        shape: 'sine',
        mix: 0,
      },
    },
    {
      name: 'Gentle Motion',
      values: {
        pitch: 0,
        pitchDepth: 1,
        fine: 0,
        rate: 0.2,
        sync: false,
        syncIndex: 4,
        depth: 0.55,
        shape: 'sine',
        mix: 0.35,
      },
    },
    {
      name: 'Fifth Orbit',
      values: {
        pitch: 0,
        pitchDepth: 7,
        fine: 0,
        rate: 2,
        sync: true,
        syncIndex: 4,
        depth: 0.85,
        shape: 'tri',
        mix: 0.55,
      },
    },
    {
      name: 'Octave Sweep',
      values: {
        pitch: 0,
        pitchDepth: 12,
        fine: 0,
        rate: 0.5,
        sync: true,
        syncIndex: 6,
        depth: 1,
        shape: 'sine',
        mix: 0.65,
      },
    },
    {
      name: 'Wide Vibrato',
      values: {
        pitch: 0,
        pitchDepth: 2,
        fine: 0,
        rate: 5,
        sync: false,
        syncIndex: 4,
        depth: 1,
        shape: 'sine',
        mix: 0.5,
      },
    },
  ],

  apply(nodes, key, val, { ac }) {
    const set = (name, value) =>
      nodes.node.parameters.get(name)?.setTargetAtTime(value, ac.currentTime, 0.02);
    if (key === 'pitch') set('pitch', clamp(val, -24, 24));
    if (key === 'pitchDepth') set('pitchDepth', clamp(val, 0, 24));
    if (key === 'fine') set('fine', clamp(val, -100, 100));
    if (key === 'rate') set('rate', clamp(val, 0.02, 20));
    if (key === 'depth') set('depth', clamp(val, 0, 1));
  },
  applyAll(nodes, { ac, state }) {
    const shape = Math.max(0, SHAPES.indexOf(state.shape));
    nodes.node.parameters.get('shape')?.setValueAtTime(shape, ac.currentTime);
  },
};
