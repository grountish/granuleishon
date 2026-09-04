// Vocoder — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.
//
// The bus this unit sits on is the modulator — meant for the granular buses,
// which is where a mic or a clip comes in. The carrier defaults to ALL: every
// other bus summed, each tapped before its own FX and mixer strip, so the
// rest of the instruments drive the vocoder even when they are turned down
// in the mix. A single bus can be picked instead, or one of three internal
// sources: white noise, a saw at the Note knob, or a saw that follows the
// voice's own pitch (Note then transposes from C4). Which taps feed the
// carrier is a graph connection, re-applied with the rest of the unit state
// so it survives engine rebuilds and only lands once every bus exists.

import { clamp } from '../../core/util.js';

import { formatBackValue, formatNumericValue } from '../../core/util.js';
import { formatMidiNote } from '../../core/theory.js';
import { getFxParamDef } from '../registry.js';

// Index order is the worklet's `source` param.
const SOURCES = ['bus', 'noise', 'osc', 'track'];

// Short labels for the carrier row — the ids are FX_BUS_IDS (fx/state.js),
// listed here rather than imported so the row is plain data. 'all' is every
// bus but the one the unit sits on.
const CARRIER_BUSES = [
  ['all', 'ALL'],
  ['gen0', 'G1'],
  ['gen1', 'G2'],
  ['gen3', 'SYN'],
  ['gen4', 'DRM'],
  ['smp', 'SMP'],
];

const SOURCE_TITLES = {
  BUS: 'Carrier: another bus, picked on the row below (tapped before its FX)',
  NOISE: 'Carrier: white noise — a whisper',
  OSC: 'Carrier: a saw at the Note knob',
  TRACK: "Carrier: a saw following the voice's pitch — Note transposes from C4",
};

export default {
  id: 'vocoder',
  label: 'Vocoder',
  idleBypass: true,
  modeRows: [
    {
      key: 'source',
      options: [
        ['bus', 'BUS'],
        ['noise', 'NOISE'],
        ['osc', 'OSC'],
        ['track', 'TRACK'],
      ],
      title: (label) => SOURCE_TITLES[label],
    },
    {
      key: 'carrier',
      options: CARRIER_BUSES,
      title: (label) =>
        label === 'ALL'
          ? 'Carrier: every other bus summed — the rest of the instruments (BUS mode only)'
          : `Carrier bus: ${label} (BUS mode only)`,
    },
  ],
  params: [
    { key: 'bands', label: 'Bands', min: 4, max: 32, step: 1, value: 16, unit: '' },
    { key: 'lo', label: 'Low', min: 40, max: 1000, step: 5, value: 100, unit: 'Hz' },
    { key: 'hi', label: 'High', min: 1000, max: 16000, step: 50, value: 8000, unit: 'Hz' },
    { key: 'width', label: 'Width', min: 0.3, max: 3, step: 0.05, value: 1, unit: '' },
    { key: 'attack', label: 'Attack', min: 0.5, max: 200, step: 0.5, value: 5, unit: 'ms' },
    { key: 'release', label: 'Release', min: 5, max: 1000, step: 5, value: 60, unit: 'ms' },
    { key: 'formant', label: 'Formant', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
    { key: 'noise', label: 'Hiss', min: 0, max: 1, step: 0.01, value: 0.15, unit: '' },
    { key: 'note', label: 'Note', min: 24, max: 96, step: 1, value: 60, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    source: 'bus',
    carrier: 'all',
    bands: 16,
    lo: 100,
    hi: 8000,
    width: 1,
    attack: 5,
    release: 60,
    formant: 0,
    noise: 0.15,
    note: 60,
    mix: 0,
  }),
  // Presets leave `carrier` alone: which bus drives the vocoder is routing,
  // not a sound, and the user's choice should survive a preset change.
  presets: [
    {
      name: 'Off',
      values: { source: 'bus', bands: 16, lo: 100, hi: 8000, width: 1, attack: 5, release: 60, formant: 0, noise: 0.15, note: 60, mix: 0 },
    },
    {
      name: 'Robot',
      values: { source: 'bus', bands: 16, lo: 100, hi: 8000, width: 1, attack: 5, release: 60, formant: 0, noise: 0.15, note: 60, mix: 1 },
    },
    {
      name: 'Vintage 8',
      values: { source: 'bus', bands: 8, lo: 120, hi: 6000, width: 1.2, attack: 10, release: 120, formant: 0, noise: 0.1, note: 60, mix: 1 },
    },
    {
      name: 'Whisper',
      values: { source: 'noise', bands: 24, lo: 150, hi: 10000, width: 1, attack: 3, release: 40, formant: 0, noise: 0, note: 60, mix: 1 },
    },
    {
      name: 'Sing Along',
      values: { source: 'track', bands: 20, lo: 100, hi: 8000, width: 1, attack: 5, release: 80, formant: 0, noise: 0.2, note: 60, mix: 1 },
    },
    {
      name: 'Sub Robot',
      values: { source: 'track', bands: 20, lo: 80, hi: 8000, width: 1, attack: 5, release: 80, formant: -3, noise: 0.2, note: 48, mix: 1 },
    },
    {
      name: 'Talk Box',
      values: { source: 'osc', bands: 16, lo: 100, hi: 8000, width: 0.8, attack: 3, release: 50, formant: 0, noise: 0.25, note: 45, mix: 1 },
    },
    {
      name: 'Chipmunk',
      values: { source: 'bus', bands: 24, lo: 100, hi: 12000, width: 1, attack: 3, release: 40, formant: 7, noise: 0.2, note: 60, mix: 1 },
    },
  ],

  apply(nodes, key, val, { ac }) {
    const set = (name, value) =>
      nodes.node.parameters.get(name)?.setTargetAtTime(value, ac.currentTime, 0.02);
    if (key === 'bands') nodes.node.parameters.get('bands')?.setValueAtTime(clamp(Math.round(val), 4, 32), ac.currentTime);
    if (key === 'lo') set('lo', clamp(val, 40, 1000));
    if (key === 'hi') set('hi', clamp(val, 1000, 16000));
    if (key === 'width') set('width', clamp(val, 0.3, 3));
    if (key === 'attack') set('attack', clamp(val, 0.5, 200));
    if (key === 'release') set('release', clamp(val, 5, 1000));
    if (key === 'formant') set('formant', clamp(val, -24, 24));
    if (key === 'noise') set('noise', clamp(val, 0, 1));
    if (key === 'note') set('note', clamp(val, 24, 96));
  },
  // Carrier source, plus the cross-bus taps: `buses` is the rack's live bus
  // table, so a bus that is not built yet (or an engine that is torn down)
  // simply stays unplugged until the next pass. Taps are diffed against what
  // is already connected, so a repeat pass is a no-op.
  applyAll(nodes, { ac, state, buses, busId }) {
    nodes.node.parameters
      .get('source')
      ?.setValueAtTime(Math.max(0, SOURCES.indexOf(state.source)), ac.currentTime);
    const ids =
      state.carrier === 'all'
        ? Object.keys(buses || {}).filter((id) => id !== busId)
        : [state.carrier];
    const wanted = new Set(ids.map((id) => buses?.[id]?.tap).filter(Boolean));
    nodes.carrierFrom.forEach((tap) => {
      if (wanted.has(tap)) return;
      try {
        tap.disconnect(nodes.node, 0, 1);
      } catch (_) {}
    });
    wanted.forEach((tap) => {
      if (!nodes.carrierFrom.has(tap)) tap.connect(nodes.node, 0, 1);
    });
    nodes.carrierFrom = wanted;
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path. The
  // bus signal is the modulator on input 0; the carrier arrives on input 1.
  build(ac, st, { input, wet }) {
    const node = new AudioWorkletNode(ac, 'vocoder-processor', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        bands: st.bands,
        lo: st.lo,
        hi: st.hi,
        width: st.width,
        attack: st.attack,
        release: st.release,
        formant: st.formant,
        noise: st.noise,
        note: st.note,
        source: Math.max(0, SOURCES.indexOf(st.source)),
      },
    });

    input.connect(node, 0, 0);
    node.connect(wet);
    return { node, carrierFrom: new Set() };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    let carrier;
    if (st.source === 'noise') carrier = 'NOISE';
    else if (st.source === 'osc') carrier = `OSC ${formatMidiNote(st.note)}`;
    else if (st.source === 'track') {
      const st12 = st.note - 60;
      carrier = `TRACK ${st12 >= 0 ? '+' : ''}${formatNumericValue(st12, 0)}st`;
    } else {
      const label = CARRIER_BUSES.find(([id]) => id === st.carrier)?.[1] || st.carrier;
      carrier = label === 'ALL' ? 'ALL others' : `${label} carrier`;
    }
    return `${carrier} • ${formatNumericValue(st.bands, 0)} bands • ${formatBackValue(getFxParamDef('vocoder', 'mix'), st.mix)} wet`;
  },
};
