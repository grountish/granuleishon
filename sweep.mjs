import { readFileSync, writeFileSync } from 'node:fs';
const SR = 48000;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (n, c) => (globalThis.__Proc = c);
const src = readFileSync('/Users/mcmilton/Documents/code/granuleishon/worklets/vocoder-processor.js', 'utf8');
const { fft, spectrum, vowel, noise, saw, mix, LEN } = await import('./siglib.mjs');
const carrier = saw(277, 0.5, { period: 0.125, frac: 0.75 });
const mods = { vowel: vowel(), 'vowel+noise': mix(vowel(), noise(0.03)), fric: noise(0.15, 3500) };
const modSpec = Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, spectrum(v).db]));
for (const stages of [2, 3, 4]) for (const tilt of [0.3, 0.15, 0]) {
  const variant = src.replace(/const STAGES = \d+;/, `const STAGES = ${stages};`).replace(/const TILT_EXP = [\d.]+;/, `const TILT_EXP = ${tilt};`);
  const path = `./v_${stages}_${tilt}.mjs`;
  writeFileSync(path, variant);
  await import(path);
  const Proc = globalThis.__Proc;
  const line = [];
  let cost = 0;
  for (const [name, mod] of Object.entries(mods)) {
    const p = new Proc();
    const P = Object.fromEntries(Object.entries({ bands: 16, lo: 100, hi: 8000, width: 1, attack: 5, release: 60, formant: 0, noise: 0.15, note: 60, source: 0 }).map(([k, v]) => [k, [v]]));
    const out = new Float32Array(LEN);
    const t0 = performance.now();
    for (let i = 0; i + 128 <= LEN; i += 128) {
      const o = [new Float32Array(128), new Float32Array(128)];
      p.process([[mod.subarray(i, i + 128), mod.subarray(i, i + 128)], [carrier.subarray(i, i + 128), carrier.subarray(i, i + 128)]], [o], P);
      out.set(o[0], i);
    }
    cost += performance.now() - t0;
    const os = spectrum(out).db;
    const dev = os.map((d, i) => d - modSpec[name][i]);
    line.push(`${name}: ${dev.map((d) => (d >= 0 ? '+' : '') + d.toFixed(0)).join('/')}`);
  }
  console.log(`stages ${stages} tilt ${tilt}  (${(cost / (3 * LEN / SR) * 1000 / 1000).toFixed(1)} ms per s audio)  dev out-mod dB per octave bin 0-250/250-500/500-1k/1-2k/2-4k/4-8k/8-16k\n   ${line.join('\n   ')}`);
}
