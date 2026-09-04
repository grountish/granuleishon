// Offline tuning harness for worklets/vocoder-processor.js. No dependencies.
//
//   node tools/vocoder-sweep.mjs
//
// Renders the worklet outside the browser (AudioWorkletProcessor stubbed)
// over synthetic modulators — a vowel, a vowel with grain noise, a fricative
// — against a gated saw carrier, for every combination of bank stages and
// tilt below, and prints how far each octave bin of the output sits from
// the modulator's. A vocoder that tracks its modulator prints small numbers
// in the speech bands (250 Hz – 4 kHz); the highs are expected to come out
// darker. Variants are written to a temp dir and removed afterwards.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGE_OPTIONS = [2, 3, 4];
const TILT_OPTIONS = [0.3, 0.15, 0];

const SR = 48000;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (n, c) => (globalThis.__Proc = c);

const ROOT = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(ROOT, 'worklets', 'vocoder-processor.js'), 'utf8');
const { spectrum, vowel, noise, saw, mix, LEN } = await import('./vocoder-siglib.mjs');

const carrier = saw(277, 0.5, { period: 0.125, frac: 0.75 });
const mods = { vowel: vowel(), 'vowel+noise': mix(vowel(), noise(0.03)), fric: noise(0.15, 3500) };
const modSpec = Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, spectrum(v).db]));
const PARAMS = { bands: 16, lo: 100, hi: 8000, width: 1, attack: 5, release: 60, formant: 0, noise: 0.15, note: 60, source: 0 };

const dir = mkdtempSync(path.join(tmpdir(), 'vocoder-sweep-'));
try {
  console.log('dev = output − modulator, dB per octave bin: 0-250 / 250-500 / 500-1k / 1-2k / 2-4k / 4-8k / 8-16k');
  for (const stages of STAGE_OPTIONS) {
    for (const tilt of TILT_OPTIONS) {
      const variant = src
        .replace(/const STAGES = \d+;/, `const STAGES = ${stages};`)
        .replace(/const TILT_EXP = [\d.]+;/, `const TILT_EXP = ${tilt};`);
      const file = path.join(dir, `v_${stages}_${tilt}.mjs`);
      writeFileSync(file, variant);
      await import(pathToFileURL(file).href);
      const Proc = globalThis.__Proc;
      const lines = [];
      let cost = 0;
      for (const [name, mod] of Object.entries(mods)) {
        const p = new Proc();
        const P = Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, [v]]));
        const out = new Float32Array(LEN);
        const t0 = performance.now();
        for (let i = 0; i + 128 <= LEN; i += 128) {
          const m = mod.subarray(i, i + 128);
          const c = carrier.subarray(i, i + 128);
          const o = [new Float32Array(128), new Float32Array(128)];
          p.process([[m, m], [c, c]], [o], P);
          out.set(o[0], i);
        }
        cost += performance.now() - t0;
        const dev = spectrum(out).db.map((d, i) => d - modSpec[name][i]);
        lines.push(`${name}: ${dev.map((d) => (d >= 0 ? '+' : '') + d.toFixed(0)).join('/')}`);
      }
      const perSecond = cost / ((3 * LEN) / SR);
      console.log(`stages ${stages} tilt ${tilt}  (${perSecond.toFixed(1)} ms per s of audio)\n   ${lines.join('\n   ')}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
