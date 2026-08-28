// dynamic-eq-processor.js — 5-band dynamic EQ for the mastering chain.
// Each band is an RBJ peaking filter whose effective gain is pulled down when
// the band's envelope (from a matching bandpass detector) exceeds its
// threshold — downward dynamic EQ. A band with range = 0 behaves as a plain
// static peaking filter. A band with type 'cut' is a static 12 dB/oct
// high-pass instead (gain and dynamics ignored). Bands arrive via the port:
//   { bands: [{ type?, freq, gain, q, thresh, range }, ...] }
// While any band is dynamic, effective gains are posted back (~20ms cadence):
//   { liveGains: [dB, ...] }

function peakingCoefs(sr, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
  const cosw = Math.cos(w0);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha / A;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function highpassCoefs(sr, f0, q) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
  const cosw = Math.cos(w0);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function bandpassCoefs(sr, f0, q) {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
  const cosw = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
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

const DYN_SLOPE = 0.6; // dB of reduction per dB over threshold (≈2.5:1)
const ENV_ATTACK = 0.45; // per-block smoothing (128 frames ≈ 2.9ms)
const ENV_RELEASE = 0.06;
const GAIN_SMOOTH = 0.35;
const POST_EVERY_BLOCKS = 8;

class DynamicEqProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bands = [];
    this.state = [];
    this.blockCount = 0;
    this.port.onmessage = (e) => {
      if (Array.isArray(e.data?.bands)) this.setBands(e.data.bands);
    };
  }

  setBands(bands) {
    this.bands = bands;
    bands.forEach((band, bi) => {
      let st = this.state[bi];
      if (!st) {
        st = this.state[bi] = {
          det: [newBiqState(), newBiqState()],
          flt: [newBiqState(), newBiqState()],
          env: 0,
          effGain: band.gain,
          applied: null,
          coefs: null,
          detCoefs: null,
        };
      }
      // Detector follows the band with a broad-ish Q so the trigger region
      // matches what the filter touches.
      st.detCoefs = bandpassCoefs(sampleRate, band.freq, Math.max(0.5, band.q));
      st.applied = null; // force coefficient recompute with the new settings
    });
    this.state.length = bands.length;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output) return true;
    const chs = Math.min(input.length, output.length);
    for (let c = 0; c < chs; c++) output[c].set(input[c]);

    let anyDynamic = false;
    for (let bi = 0; bi < this.bands.length; bi++) {
      const band = this.bands[bi];
      const st = this.state[bi];
      if (!band || !st) continue;

      // Low-cut band: static high-pass, no envelope, always in the path.
      if (band.type === 'cut') {
        if (st.applied !== 'cut') {
          st.coefs = highpassCoefs(sampleRate, band.freq, band.q);
          st.applied = 'cut';
          st.effGain = 0;
        }
        for (let c = 0; c < chs; c++) {
          const data = output[c];
          const fs = st.flt[c];
          for (let i = 0; i < data.length; i++) data[i] = runBiquad(fs, st.coefs, data[i]);
        }
        continue;
      }
      if (st.applied === 'cut') st.applied = null; // back to bell — recompute

      let target = band.gain;
      if (band.range > 0) {
        anyDynamic = true;
        let peak = 0;
        for (let c = 0; c < chs; c++) {
          const data = output[c];
          const ds = st.det[c];
          for (let i = 0; i < data.length; i++) {
            const y = runBiquad(ds, st.detCoefs, data[i]);
            const a = Math.abs(y);
            if (a > peak) peak = a;
          }
        }
        st.env += (peak - st.env) * (peak > st.env ? ENV_ATTACK : ENV_RELEASE);
        const envDb = st.env > 1e-6 ? 20 * Math.log10(st.env) : -120;
        const over = envDb - band.thresh;
        if (over > 0) target = band.gain - Math.min(band.range, over * DYN_SLOPE);
      }

      st.effGain += (target - st.effGain) * GAIN_SMOOTH;
      // Identity when the band is effectively flat and static — skip the math.
      if (band.range <= 0 && Math.abs(st.effGain) < 0.03) continue;
      if (st.applied === null || Math.abs(st.effGain - st.applied) > 0.05) {
        st.coefs = peakingCoefs(sampleRate, band.freq, st.effGain, band.q);
        st.applied = st.effGain;
      }
      for (let c = 0; c < chs; c++) {
        const data = output[c];
        const fs = st.flt[c];
        for (let i = 0; i < data.length; i++) data[i] = runBiquad(fs, st.coefs, data[i]);
      }
    }

    if (++this.blockCount % POST_EVERY_BLOCKS === 0 && anyDynamic) {
      this.port.postMessage({ liveGains: this.state.map((st) => st.effGain) });
    }
    return true;
  }
}

registerProcessor('dynamic-eq-processor', DynamicEqProcessor);
