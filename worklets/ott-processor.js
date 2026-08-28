// ott-processor.js — 3-band up/down compressor in the spirit of the famous
// OTT preset: each band is compressed hard downward above its target level
// AND pushed upward when it falls below it, then the wet signal is blended
// with dry by Depth. Depth 0 is bit-transparent (module neutral).
// Params via port:
//   { depth (0..1), time (0.33..3, scales ballistics), inGain dB, outGain dB,
//     bandGains: [low, mid, high] dB }

function lpCoefs(sr, f0, q) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const b1 = 1 - cosw;
  const b0 = b1 / 2;
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function hpCoefs(sr, f0, q) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const b1 = -(1 + cosw);
  const b0 = -b1 / 2;
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function newBiqState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function runBiquad(st, c, x) {
  const y = c[0] * x + c[1] * st.x1 + c[2] * st.x2 - c[3] * st.y1 - c[4] * st.y2;
  st.x2 = st.x1;
  st.x1 = x;
  st.y2 = st.y1;
  st.y1 = y;
  return y;
}

const XOVER_LOW = 120;
const XOVER_HIGH = 2500;
const BAND_TARGETS = [-33, -30, -27]; // dBFS per band
const DOWN_SLOPE = 0.85; // near-limiting above target
const UP_SLOPE = 0.6; // upward push below target
const UP_MAX_DB = 24;
const GATE_DB = -60; // never pull silence up
const GAIN_SMOOTH = 0.3;
const dbToLin = (db) => Math.pow(10, db / 20);

class OttProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.depth = 0;
    this.time = 1;
    this.inGain = 1;
    this.outGain = 1;
    this.bandGains = [1, 1, 1];
    const q = 0.7071;
    this.lp1 = lpCoefs(sampleRate, XOVER_LOW, q);
    this.hp1 = hpCoefs(sampleRate, XOVER_LOW, q);
    this.lp2 = lpCoefs(sampleRate, XOVER_HIGH, q);
    this.hp2 = hpCoefs(sampleRate, XOVER_HIGH, q);
    // Per channel: 4 crossover filter states.
    this.split = [0, 1].map(() => ({
      lp1: newBiqState(),
      hp1: newBiqState(),
      lp2: newBiqState(),
      hp2: newBiqState(),
    }));
    this.bandBuf = [0, 1, 2].map(() => [new Float32Array(128), new Float32Array(128)]);
    this.env = [0, 0, 0];
    this.gDb = [0, 0, 0];
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.depth === 'number') this.depth = Math.min(1, Math.max(0, d.depth));
      if (typeof d.time === 'number') this.time = Math.min(3, Math.max(0.33, d.time));
      if (typeof d.inGain === 'number') this.inGain = dbToLin(d.inGain);
      if (typeof d.outGain === 'number') this.outGain = dbToLin(d.outGain);
      if (Array.isArray(d.bandGains)) this.bandGains = d.bandGains.map(dbToLin);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output) return true;
    const chs = Math.min(input.length, output.length, 2);
    const N = input[0].length;

    if (this.depth <= 0.001) {
      for (let c = 0; c < chs; c++) output[c].set(input[c]);
      return true;
    }

    // Split into bands, tracking the block peak per band.
    const peaks = [0, 0, 0];
    for (let c = 0; c < chs; c++) {
      const data = input[c];
      const st = this.split[c];
      const bufs = [this.bandBuf[0][c], this.bandBuf[1][c], this.bandBuf[2][c]];
      for (let i = 0; i < N; i++) {
        const x = data[i] * this.inGain;
        const lowS = runBiquad(st.lp1, this.lp1, x);
        const rest = runBiquad(st.hp1, this.hp1, x);
        const midS = runBiquad(st.lp2, this.lp2, rest);
        const highS = runBiquad(st.hp2, this.hp2, rest);
        bufs[0][i] = lowS;
        bufs[1][i] = midS;
        bufs[2][i] = highS;
        const al = Math.abs(lowS);
        const am = Math.abs(midS);
        const ah = Math.abs(highS);
        if (al > peaks[0]) peaks[0] = al;
        if (am > peaks[1]) peaks[1] = am;
        if (ah > peaks[2]) peaks[2] = ah;
      }
    }

    // Per band: envelope → up/down gain, smoothed.
    const attAlpha = Math.min(1, 0.55 / this.time);
    const relAlpha = Math.min(1, 0.1 / this.time);
    const bandLin = [0, 0, 0];
    for (let b = 0; b < 3; b++) {
      const peak = peaks[b];
      this.env[b] += (peak - this.env[b]) * (peak > this.env[b] ? attAlpha : relAlpha);
      const envDb = this.env[b] > 1e-6 ? 20 * Math.log10(this.env[b]) : -120;
      const target = BAND_TARGETS[b];
      let g = 0;
      if (envDb > target) {
        g = -(envDb - target) * DOWN_SLOPE;
      } else if (envDb > GATE_DB) {
        g = Math.min(UP_MAX_DB, (target - envDb) * UP_SLOPE);
        // Fade the upward push out as the band approaches the gate floor.
        if (envDb < GATE_DB + 10) g *= (envDb - GATE_DB) / 10;
      }
      this.gDb[b] += (g - this.gDb[b]) * GAIN_SMOOTH;
      bandLin[b] = dbToLin(this.gDb[b]) * this.bandGains[b];
    }

    const depth = this.depth;
    const dryAmt = 1 - depth;
    for (let c = 0; c < chs; c++) {
      const dry = input[c];
      const out = output[c];
      const b0 = this.bandBuf[0][c];
      const b1 = this.bandBuf[1][c];
      const b2 = this.bandBuf[2][c];
      for (let i = 0; i < N; i++) {
        const wet = b0[i] * bandLin[0] + b1[i] * bandLin[1] + b2[i] * bandLin[2];
        out[i] = (dry[i] * dryAmt + wet * depth) * this.outGain;
      }
    }
    return true;
  }
}

registerProcessor('ott-processor', OttProcessor);
