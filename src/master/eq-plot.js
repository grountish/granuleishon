import { clamp, formatMeterHz } from '../core/util.js';
import { rbjHighpass, rbjPeaking, biquadMagnitudeDb } from '../core/dsp.js';
import { MASTERING } from './state.js';
import { MASTERING_EQ_BANDS } from './specs.js';

// ── Graphical EQ ── log-frequency response plot with five draggable,
// fully-parametric band handles: horizontal = frequency, vertical = gain.
// The compact control below the graph edits Q for the selected band.

export const EQ_DB_RANGE = 12;
export const EQ_FMIN = 20;
export const EQ_FMAX = 20000;
const EQ_DISPLAY_SR = 48000;



// The low band doubles as a low-cut: same freq/Q handles, gain and dynamics
// dormant while cut. (The biquad coefficient math lives in core/dsp.js.)
export function masteringLowIsCut() {
  return MASTERING.params.lowType === 'cut';
}

function masteringBandDisplayCoefs(band, bi, gainDb) {
  return bi === 0 && masteringLowIsCut()
    ? rbjHighpass(EQ_DISPLAY_SR, MASTERING.params[band.freqKey], MASTERING.params[band.qKey])
    : rbjPeaking(EQ_DISPLAY_SR, MASTERING.params[band.freqKey], gainDb, MASTERING.params[band.qKey]);
}


// Per-band display coefficients — optional gain overrides let the live
// (dynamics-driven) curve reuse the same math as the static one.
function masteringEqCurveCoefs(gains = null) {
  const p = MASTERING.params;
  return MASTERING_EQ_BANDS.map((band, bi) =>
    masteringBandDisplayCoefs(
      band,
      bi,
      gains && typeof gains[bi] === 'number' ? gains[bi] : p[band.gainKey],
    ),
  );
}

function masteringEqCurveDb(coefsList, freq) {
  let sum = 0;
  for (let i = 0; i < coefsList.length; i++) {
    sum += biquadMagnitudeDb(coefsList[i], freq, EQ_DISPLAY_SR);
  }
  return sum;
}

export const eqFreqToX = (f, w) => (Math.log(f / EQ_FMIN) / Math.log(EQ_FMAX / EQ_FMIN)) * w;
export const eqXToFreq = (x, w) => EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, clamp(x / w, 0, 1));
export const eqDbToY = (db, h) => h / 2 - (db / EQ_DB_RANGE) * (h / 2 - 8);
export const eqYToDb = (y, h) => clamp(((h / 2 - y) / (h / 2 - 8)) * EQ_DB_RANGE, -EQ_DB_RANGE, EQ_DB_RANGE);

export function drawMasteringEq() {
  const canvas = MASTERING.els.eqCanvas;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 280;
  const h = canvas.clientHeight || 130;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const borderCol = styles.getPropertyValue('--border').trim() || '#3a3a3a';
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#5a5a5a';
  const bandCols = [
    styles.getPropertyValue('--accent-0').trim() || '#3cb870',
    styles.getPropertyValue('--accent-1').trim() || '#8b6ed4',
    styles.getPropertyValue('--accent-fx').trim() || '#d4892a',
    styles.getPropertyValue('--accent-1').trim() || '#8b6ed4',
    styles.getPropertyValue('--accent-0').trim() || '#3cb870',
  ];

  // Grid: octave-ish frequency lines + 0/±6 dB lines.
  g.strokeStyle = borderCol;
  g.lineWidth = 1;
  g.globalAlpha = 0.5;
  [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
    const x = Math.round(eqFreqToX(f, w)) + 0.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  });
  [-6, 0, 6].forEach((db) => {
    const y = Math.round(eqDbToY(db, h)) + 0.5;
    g.globalAlpha = db === 0 ? 0.9 : 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  });
  g.globalAlpha = 1;
  g.fillStyle = mutedCol;
  g.font = '7px ui-monospace, monospace';
  [[100, '100'], [1000, '1k'], [10000, '10k']].forEach(([f, lbl]) => {
    g.fillText(lbl, eqFreqToX(f, w) + 2, h - 3);
  });

  // Live output spectrum behind the curves — analyser data is refreshed by
  // drawMasteringMeters earlier in the same viz frame, so reuse it for free.
  const pv = MASTERING.preview;
  const meter = MASTERING.meter;
  if (pv?.analysers && meter?.freq0 && MASTERING.ctx) {
    const binHz = MASTERING.ctx.sampleRate / 2 / pv.analysers[0].frequencyBinCount;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 2) {
      const f = eqXToFreq(x, w);
      const bin = clamp(Math.round(f / binHz), 0, meter.freq0.length - 1);
      const db = (meter.freq0[bin] + meter.freq1[bin]) / 2;
      const norm = clamp((db + 90) / 80, 0, 1);
      g.lineTo(x, h - norm * (h - 8));
    }
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = mutedCol;
    g.globalAlpha = 0.18;
    g.fill();
    g.globalAlpha = 1;
  }

  // Selected band's own response — tinted fill against the 0 dB line.
  MASTERING.els.eqCutBtn?.classList.toggle('active', masteringLowIsCut());
  const selBand = MASTERING_EQ_BANDS[MASTERING.eqBandIndex];
  if (selBand) {
    const coeffs = masteringBandDisplayCoefs(
      selBand,
      MASTERING.eqBandIndex,
      MASTERING.params[selBand.gainKey],
    );
    const y0 = eqDbToY(0, h);
    const selCol = bandCols[MASTERING.eqBandIndex] || bandCols[0];
    g.beginPath();
    g.moveTo(0, y0);
    for (let i = 0; i <= 120; i++) {
      const f = EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, i / 120);
      const db = clamp(biquadMagnitudeDb(coeffs, f, EQ_DISPLAY_SR), -EQ_DB_RANGE, EQ_DB_RANGE);
      g.lineTo(eqFreqToX(f, w), eqDbToY(db, h));
    }
    g.lineTo(w, y0);
    g.closePath();
    g.fillStyle = selCol;
    g.globalAlpha = 0.12;
    g.fill();
    g.globalAlpha = 0.5;
    g.strokeStyle = selCol;
    g.lineWidth = 1;
    g.stroke();
    g.globalAlpha = 1;
  }

  // Combined response. While previewing with dynamics active, the configured
  // curve stays as a ghost and the whole live curve (per-band effective
  // gains from the worklet) moves with the music — Pro-Q style.
  const steps = 160;
  const drawResponseCurve = (coefsList, width, alpha) => {
    g.strokeStyle = bandCols[0];
    g.lineWidth = width;
    g.globalAlpha = alpha;
    g.beginPath();
    for (let i = 0; i <= steps; i++) {
      const f = EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, i / steps);
      const y = eqDbToY(clamp(masteringEqCurveDb(coefsList, f), -EQ_DB_RANGE, EQ_DB_RANGE), h);
      if (i === 0) g.moveTo(eqFreqToX(f, w), y);
      else g.lineTo(eqFreqToX(f, w), y);
    }
    g.stroke();
    g.globalAlpha = 1;
  };
  const liveGains = MASTERING.preview ? MASTERING.liveEqGains : null;
  const anyDynamic = MASTERING_EQ_BANDS.some(
    (band, bi) =>
      !(bi === 0 && masteringLowIsCut()) && (MASTERING.params[band.rangeKey] || 0) > 0,
  );
  if (liveGains && anyDynamic) {
    drawResponseCurve(masteringEqCurveCoefs(), 1, 0.3); // ghost: configured curve
    const gains = MASTERING_EQ_BANDS.map((band, bi) =>
      (MASTERING.params[band.rangeKey] || 0) > 0 && typeof liveGains[bi] === 'number'
        ? liveGains[bi]
        : MASTERING.params[band.gainKey],
    );
    drawResponseCurve(masteringEqCurveCoefs(gains), 1.5, 1); // live curve
  } else {
    drawResponseCurve(masteringEqCurveCoefs(), 1.5, 1);
  }

  // Band handles.
  MASTERING_EQ_BANDS.forEach((band, bi) => {
    const cut = bi === 0 && masteringLowIsCut();
    const x = eqFreqToX(MASTERING.params[band.freqKey], w);
    // A cut has no gain — its handle rides the 0 dB line.
    const y = eqDbToY(cut ? 0 : MASTERING.params[band.gainKey], h);
    const range = cut ? 0 : MASTERING.params[band.rangeKey] || 0;
    if (range > 0) {
      // Dynamic range indicator: how far the band can be pulled down.
      const yLow = eqDbToY(
        clamp(MASTERING.params[band.gainKey] - range, -EQ_DB_RANGE, EQ_DB_RANGE),
        h,
      );
      g.strokeStyle = bandCols[bi];
      g.globalAlpha = 0.45;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, yLow);
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 1;
    }
    if (bi === MASTERING.eqBandIndex) {
      g.strokeStyle = bandCols[bi];
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, 7.5, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = bandCols[bi];
    g.beginPath();
    g.arc(x, y, 4.5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = borderCol;
    g.lineWidth = 1;
    g.stroke();
  });

  // Cursor readout — freq/gain at the pointer while hovering.
  const hov = MASTERING.eqHover;
  if (hov) {
    const f = eqXToFreq(hov.x, w);
    const db = eqYToDb(hov.y, h);
    g.strokeStyle = mutedCol;
    g.globalAlpha = 0.5;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(Math.round(hov.x) + 0.5, 0);
    g.lineTo(Math.round(hov.x) + 0.5, h);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.font = '8px ui-monospace, monospace';
    const lbl = `${formatMeterHz(f)} · ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
    const tw = g.measureText(lbl).width;
    const tx = hov.x + 6 + tw > w - 2 ? hov.x - tw - 6 : hov.x + 6;
    g.fillStyle = styles.getPropertyValue('--text').trim() || '#ddd';
    g.fillText(lbl, tx, clamp(hov.y - 6, 10, h - 14));
  }
}

export function setMasteringEqReadout(band) {
  const el = MASTERING.els.eqReadout;
  if (!el) return;
  if (!band) {
    el.textContent = '';
    return;
  }
  const f = MASTERING.params[band.freqKey];
  const dB = MASTERING.params[band.gainKey];
  const q = MASTERING.params[band.qKey];
  const fLabel = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
  const cut = band === MASTERING_EQ_BANDS[0] && masteringLowIsCut();
  el.textContent = cut
    ? `${band.label} ${fLabel} Hz CUT · Q ${q.toFixed(2)}`
    : `${band.label} ${fLabel} Hz ${dB >= 0 ? '+' : ''}${dB.toFixed(1)} dB · Q ${q.toFixed(2)}`;
}
