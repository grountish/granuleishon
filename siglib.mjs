const SR = 48000;
export const LEN = SR * 3;
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = (-2 * Math.PI) / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const c = Math.cos(ang * k), s = Math.sin(ang * k); const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s; const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
}
export function spectrum(sig) {
  const N = 4096, bins = [[0, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000], [8000, 16000]];
  const acc = bins.map(() => 0); let total = 0;
  for (let start = SR; start + N <= sig.length; start += N) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = sig[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) { const f = (k * SR) / N; const p = re[k] ** 2 + im[k] ** 2; const b = bins.findIndex(([lo, hi]) => f >= lo && f < hi); if (b >= 0) acc[b] += p; total += p; }
  }
  return { db: acc.map((p) => 10 * Math.log10(p / total + 1e-12)), hiFrac: (acc[5] + acc[6]) / total };
}
export function rms(sig) { let s = 0; for (const v of sig) s += v * v; return Math.sqrt(s / sig.length); }
export function vowel(f0 = 150, formants = [[700, 110], [1200, 120], [2600, 160], [3300, 200]]) {
  const out = new Float32Array(LEN);
  for (let n = 1; n * f0 < SR / 2; n++) { const f = n * f0; let a = 0; formants.forEach(([F, BW], idx) => (a += (idx === 0 ? 1 : 0.5) / (1 + Math.pow((f - F) / BW, 2)))); a += 0.02 / n; const ph = Math.random() * 6.28; for (let i = 0; i < LEN; i++) out[i] += a * Math.sin((2 * Math.PI * f * i) / SR + ph); }
  const g = 0.3 / rms(out); for (let i = 0; i < LEN; i++) out[i] *= g; return out;
}
export function noise(amp, hpHz = 0) {
  const out = new Float32Array(LEN); const a = hpHz ? 1 / (1 + (2 * Math.PI * hpHz) / SR) : 0; let px = 0, py = 0;
  for (let i = 0; i < LEN; i++) { const x = Math.random() * 2 - 1; const y = hpHz ? a * (py + x - px) : x; px = x; py = y; out[i] = y * amp; }
  return out;
}
export function saw(f, amp, gate = null) {
  const out = new Float32Array(LEN);
  for (let n = 1; n * f < SR / 2; n++) for (let i = 0; i < LEN; i++) out[i] += ((amp * (2 / Math.PI)) / n) * Math.sin((2 * Math.PI * n * f * i) / SR);
  if (gate) { const period = Math.round(SR * gate.period), on = Math.round(period * gate.frac); for (let i = 0; i < LEN; i++) if (i % period >= on) out[i] = 0; }
  return out;
}
export function mix(...sigs) { const out = new Float32Array(LEN); sigs.forEach((s) => { for (let i = 0; i < LEN; i++) out[i] += s[i]; }); return out; }
