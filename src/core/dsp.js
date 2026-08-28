// Biquad math — RBJ cookbook coefficients and a magnitude response probe.
// Pure: used both by the LUFS meter's filters and by the EQ response plot.

export function rbjHighpass(sr, f0, q) {
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function rbjLowShelf(sr, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const sqA = Math.sqrt(A);
  const b0 = A * (A + 1 - (A - 1) * cosw + 2 * sqA * alpha);
  const b1 = 2 * A * (A - 1 - (A + 1) * cosw);
  const b2 = A * (A + 1 - (A - 1) * cosw - 2 * sqA * alpha);
  const a0 = A + 1 + (A - 1) * cosw + 2 * sqA * alpha;
  const a1 = -2 * (A - 1 + (A + 1) * cosw);
  const a2 = A + 1 + (A - 1) * cosw - 2 * sqA * alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function rbjPeaking(sr, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cosw;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha / A;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function biquadMagnitudeDb([b0, b1, b2, a1, a2], freq, sr) {
  const w = (2 * Math.PI * freq) / sr;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);
  const numRe = b0 + b1 * cw + b2 * c2w;
  const numIm = -(b1 * sw + b2 * s2w);
  const denRe = 1 + a1 * cw + a2 * c2w;
  const denIm = -(a1 * sw + a2 * s2w);
  const num = numRe * numRe + numIm * numIm;
  const den = denRe * denRe + denIm * denIm;
  return 10 * Math.log10((num || 1e-20) / (den || 1e-20));
}
