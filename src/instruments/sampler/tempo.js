// Tempo estimation for the sampler's "auto" BPM. Onset strength from
// multi-band energy flux (bass, full, highs — no FFT needed), autocorrelated
// over the beat-period range, scored with a log-Gaussian prior around the
// transport tempo to settle the octave, then refined to sub-frame precision.
// Pure DSP: no DOM, no audio nodes. Runs inside tempo-worker.js so a long
// track never stalls the main thread, and inline as the fallback.

function biquadLowpass(fc, sr, q = 0.707) {
  const w = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function biquadHighpass(fc, sr, q = 0.707) {
  const w = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyBiquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return y;
}

// Mean-square energy per block of `hop` samples.
function blockEnergies(x, hop, nBlocks) {
  const e = new Float32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    const off = b * hop;
    let s = 0;
    for (let i = 0; i < hop; i++) {
      const v = x[off + i];
      s += v * v;
    }
    e[b] = s / hop;
  }
  return e;
}

// Onset strength at one hop size: half-wave-rectified rise of log energy
// over a `win`-block window, summed across bands, mean-removed. Log
// compression keeps a quiet hi-hat pattern as visible as a loud kick.
function onsetStrength(bandSignals, hop, win) {
  const nBlocks = Math.floor(bandSignals[0].length / hop);
  const onset = new Float32Array(nBlocks);
  const eps = 1e-8;
  bandSignals.forEach((x) => {
    const e = blockEnergies(x, hop, nBlocks);
    let prev = Math.log(e[0] + eps);
    for (let i = 1; i < nBlocks; i++) {
      let w = 0;
      for (let k = 0; k < win; k++) w += e[i - k] || 0;
      const l = Math.log(w / win + eps);
      onset[i] += Math.max(0, l - prev);
      prev = l;
    }
  });
  let mean = 0;
  for (let i = 0; i < nBlocks; i++) mean += onset[i];
  mean /= nBlocks;
  for (let i = 0; i < nBlocks; i++) onset[i] -= mean;
  return onset;
}

function acfAtLag(onset, l) {
  const n = onset.length;
  let s = 0;
  for (let i = 0; i + l < n; i++) s += onset[i] * onset[i + l];
  return s / (n - l);
}

// Parabolic peak through three neighbours; returns the fractional offset.
function peakOffset(y0, y1, y2) {
  const denom = y0 - 2 * y1 + y2;
  return denom < 0 ? (0.5 * (y0 - y2)) / denom : 0;
}

// Linear bass amplitude rise per block, peak-normalised. Unlike the log
// onset, a hi-hat's leakage into the bass band barely registers here while
// a kick is huge — so it says where the kicks are, not just where something
// started.
function bassRise(low, hop, win) {
  const nBlocks = Math.floor(low.length / hop);
  const e = blockEnergies(low, hop, nBlocks);
  const out = new Float32Array(nBlocks);
  let prev = Math.sqrt(e[0]);
  let peak = 0;
  for (let i = 1; i < nBlocks; i++) {
    let w = 0;
    for (let k = 0; k < win; k++) w += e[i - k] || 0;
    const a = Math.sqrt(w / win);
    out[i] = Math.max(0, a - prev);
    prev = a;
    if (out[i] > peak) peak = out[i];
  }
  if (peak > 0) for (let i = 0; i < nBlocks; i++) out[i] /= peak;
  return out;
}

// Beat phase: the offset (in fine frames, 0 ≤ φ < period) whose comb of
// beats collects the most onset energy — the log onset (every band) plus,
// weighted double, the linear bass rise, so an off-beat hi-hat row cannot
// tie with the kick/snare row half a beat away. Downbeat: of the four beat
// phases φ + m·period, the one whose bar comb collects the most bass rise —
// kicks sit on the one far more often than not. Silence contributes
// nothing, so a lead-in does not pull the phase.
function beatPhase(onsetF, lowF, periodF) {
  const n = onsetF.length;
  const span = Math.floor(periodF);
  let onsetPeak = 0;
  for (let i = 0; i < n; i++) if (onsetF[i] > onsetPeak) onsetPeak = onsetF[i];
  const onsetScale = onsetPeak > 0 ? 1 / onsetPeak : 0;
  let bestPhi = 0;
  let bestScore = -Infinity;
  for (let phi = 0; phi < span; phi++) {
    let score = 0;
    for (let t = phi; t < n; t += periodF) {
      const i = Math.round(t);
      score += Math.max(0, onsetF[i]) * onsetScale + 2 * lowF[i];
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhi = phi;
    }
  }
  // Kicks on 1 and 3 make beats 1 and 3 near-equal candidates; a later beat
  // has to win clearly, else the earlier one is the downbeat.
  let bestBar = 0;
  let bestBarScore = -Infinity;
  for (let m = 0; m < 4; m++) {
    let score = 0;
    for (let t = bestPhi + m * periodF; t < n; t += 4 * periodF) score += lowF[Math.round(t)];
    if (score > bestBarScore * 1.1) {
      bestBarScore = score;
      bestBar = m;
    }
  }
  return { beat: bestPhi, bar: bestPhi + bestBar * periodF };
}

// mono: Float32Array at sampleRate (a ~12 kHz decimation is plenty).
// fixedBpm skips the tempo search (the user typed the number) and only
// finds the beat phase for it. Returns
// { bpm, confidence, beatOffset, barOffset } — offsets in seconds to the
// first beat and the first downbeat — or null when there is nothing to
// correlate.
export function estimateTempo(
  mono,
  sampleRate,
  { minBpm = 55, maxBpm = 210, refBpm = 120, fixedBpm = null } = {},
) {
  const n = mono.length;
  if (!(sampleRate > 0) || n < sampleRate * 2) return null;
  // ~187.5 analysis frames per second for the search: 5.3 ms per lag step.
  const hop = Math.max(16, Math.round(sampleRate / 187.5));
  const fps = sampleRate / hop;
  const nBlocks = Math.floor(n / hop);
  if (nBlocks < 64) return null;

  const nyquist = sampleRate / 2;
  const bandSignals = [
    applyBiquad(mono, biquadLowpass(Math.min(150, nyquist * 0.5), sampleRate)),
    mono,
    applyBiquad(mono, biquadHighpass(Math.min(2500, nyquist * 0.8), sampleRate)),
  ];
  // Fine grid (4× the frame rate) for the period refinement and the phase.
  const hopF = Math.max(4, Math.round(hop / 4));
  const fpsF = sampleRate / hopF;
  const winF = Math.round((4 * hop) / hopF);
  const onsetF = onsetStrength(bandSignals, hopF, winF);
  const lowF = bassRise(bandSignals[0], hopF, winF);

  let bpm = fixedBpm;
  let confidence = 1;
  if (!(bpm > 0)) {
    const onset = onsetStrength(bandSignals, hop, 4);

    // Autocorrelation out to three beat periods so each candidate can be
    // scored with its harmonics.
    const lagMin = Math.max(1, Math.floor((fps * 60) / maxBpm));
    const lagMax = Math.ceil((fps * 60) / minBpm);
    const lagTop = Math.min(nBlocks - 2, lagMax * 3 + 1);
    if (lagMin >= lagTop) return null;
    const acf = new Float64Array(lagTop + 1);
    for (let l = 0; l <= lagTop; l++) {
      let s = 0;
      for (let i = 0; i + l < nBlocks; i++) s += onset[i] * onset[i + l];
      acf[l] = s / (nBlocks - l);
    }
    const norm = acf[0] || 1;
    for (let l = 0; l <= lagTop; l++) acf[l] /= norm;
    const acfAt = (x) => {
      const i = Math.floor(x);
      if (i + 1 > lagTop) return 0;
      const f = x - i;
      return acf[i] * (1 - f) + acf[i + 1] * f;
    };

    // A candidate period scores by its own correlation plus its multiples;
    // the prior (0.9 octaves wide around refBpm) breaks the double/half
    // ambiguity.
    const sigma = 0.9;
    let best = -Infinity;
    let bestLag = lagMin;
    for (let l = lagMin; l <= Math.min(lagMax, lagTop); l++) {
      const cand = (60 * fps) / l;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(cand / refBpm) / sigma, 2));
      const score = (acf[l] + 0.5 * acfAt(2 * l) + 0.33 * acfAt(3 * l)) * prior;
      if (score > best) {
        best = score;
        bestLag = l;
      }
    }
    // The prior can lean the winner a lag off the true correlation peak —
    // settle on the local maximum, then interpolate through it.
    let lag = bestLag;
    for (let guard = 0; guard < 3; guard++) {
      if (lag > 1 && acf[lag - 1] > acf[lag]) lag -= 1;
      else if (lag < lagTop - 1 && acf[lag + 1] > acf[lag]) lag += 1;
      else break;
    }
    bpm = (60 * fps) / (lag + peakOffset(acf[lag - 1], acf[lag], acf[lag + 1]));
    confidence = Math.max(0, Math.min(1, acf[lag]));

    // Second pass on the fine grid, only around the period found: a 5 ms
    // lag grid is ±0.25 BPM at 170, too coarse to trust an integer snap.
    const center = (60 * fpsF) / bpm;
    const lo = Math.max(1, Math.floor(center * 0.97));
    const hi = Math.min(onsetF.length - 2, Math.ceil(center * 1.03));
    if (hi - lo >= 2) {
      const acfF = new Float64Array(hi - lo + 1);
      for (let l = lo; l <= hi; l++) acfF[l - lo] = acfAtLag(onsetF, l);
      let bestF = lo;
      for (let l = lo + 1; l <= hi; l++) if (acfF[l - lo] > acfF[bestF - lo]) bestF = l;
      if (bestF > lo && bestF < hi) {
        const off = peakOffset(acfF[bestF - lo - 1], acfF[bestF - lo], acfF[bestF - lo + 1]);
        bpm = (60 * fpsF) / (bestF + off);
      }
    }

    // Produced music sits on whole numbers; snap when the estimate is close.
    if (Math.abs(bpm - Math.round(bpm)) < 0.12) bpm = Math.round(bpm);
    bpm = Math.round(bpm * 100) / 100;
  }

  const periodF = (60 * fpsF) / bpm;
  if (!(periodF >= 2) || periodF > onsetF.length / 2) return null;
  const phase = beatPhase(onsetF, lowF, periodF);
  return {
    bpm,
    confidence,
    beatOffset: phase.beat / fpsF,
    barOffset: phase.bar / fpsF,
  };
}
