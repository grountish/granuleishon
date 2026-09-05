// Face landmarks → a handful of musical controls. Pure math over MediaPipe
// FaceMesh's 468 keypoints (the ordering ml5's faceMesh returns); no DOM, no
// audio, so it can be reasoned about and tuned on its own.

const IDX = {
  top: 10,
  chin: 152,
  cheekL: 234,
  cheekR: 454,
  nose: 1,
  lipUp: 13,
  lipDown: 14,
  mouthL: 61,
  mouthR: 291,
  eyeLOuter: 33,
  eyeLInner: 133,
  eyeLUp: 159,
  eyeLDown: 145,
  eyeROuter: 263,
  eyeRInner: 362,
  eyeRUp: 386,
  eyeRDown: 374,
  browL: 105,
  browR: 334,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Each control, the raw range that maps to its full travel, and which end a
// relaxed face sits at — calibrate() shifts the range so that end lands on
// the face in front of the camera. Ranges are empirical for a face filling
// about a third of the frame; every value is a ratio of face size, so the
// distance to the camera cancels out.
export const FEATURE_DEFS = [
  { key: 'mouthOpen', label: 'open', lo: 0.02, hi: 0.2, neutral: 'lo' },
  { key: 'mouthWide', label: 'wide', lo: 0.36, hi: 0.5, neutral: 'lo' },
  { key: 'brows', label: 'brows', lo: 0.105, hi: 0.15, neutral: 'lo' },
  { key: 'yaw', label: 'turn', lo: -0.2, hi: 0.2, neutral: 'center', bipolar: true },
  { key: 'tilt', label: 'tilt', lo: 0.3, hi: 0.5, neutral: 'center', bipolar: true },
  { key: 'roll', label: 'roll', lo: -22, hi: 22, neutral: 'center', bipolar: true },
  { key: 'eyes', label: 'eyes', lo: 0.1, hi: 0.3, neutral: 'hi' },
];

// Raw geometry from one face's keypoints. Yaw and roll are negated so they
// read in mirror space, matching the preview the player looks at: turning
// your head to your right gives positive yaw.
export function readRawFeatures(kp) {
  const p = (i) => kp[i];
  const faceH = dist(p(IDX.top), p(IDX.chin)) || 1;
  const faceW = dist(p(IDX.cheekL), p(IDX.cheekR)) || 1;
  const eyeL = mid(p(IDX.eyeLOuter), p(IDX.eyeLInner));
  const eyeR = mid(p(IDX.eyeROuter), p(IDX.eyeRInner));
  const eyeMid = mid(eyeL, eyeR);
  const cheekMid = mid(p(IDX.cheekL), p(IDX.cheekR));
  const nose = p(IDX.nose);
  const eyeOpen = (up, down, outer, inner) => dist(p(up), p(down)) / (dist(p(outer), p(inner)) || 1);
  return {
    mouthOpen: dist(p(IDX.lipUp), p(IDX.lipDown)) / faceH,
    mouthWide: dist(p(IDX.mouthL), p(IDX.mouthR)) / faceW,
    brows: (dist(p(IDX.browL), p(IDX.eyeLUp)) + dist(p(IDX.browR), p(IDX.eyeRUp))) / 2 / faceH,
    yaw: -(nose.x - cheekMid.x) / faceW,
    tilt: (nose.y - eyeMid.y) / (p(IDX.chin).y - eyeMid.y || 1),
    roll: (-Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x) * 180) / Math.PI,
    eyes:
      (eyeOpen(IDX.eyeLUp, IDX.eyeLDown, IDX.eyeLOuter, IDX.eyeLInner) +
        eyeOpen(IDX.eyeRUp, IDX.eyeRDown, IDX.eyeROuter, IDX.eyeRInner)) /
      2,
  };
}

// A relaxed face → per-feature range shifts. The span of each range stays as
// declared; only where it sits moves, so calibration never collapses a range.
export function calibrate(raw) {
  const shift = {};
  FEATURE_DEFS.forEach((d) => {
    const v = raw?.[d.key];
    if (!Number.isFinite(v)) return;
    const rest = d.neutral === 'lo' ? d.lo : d.neutral === 'hi' ? d.hi : (d.lo + d.hi) / 2;
    shift[d.key] = v - rest;
  });
  return shift;
}

// Raw → 0..1 (bipolar: -1..1), clamped, with the calibration shift applied.
export function normalizeFeatures(raw, shift = {}) {
  const out = {};
  FEATURE_DEFS.forEach((d) => {
    const v = raw?.[d.key];
    if (!Number.isFinite(v)) {
      out[d.key] = 0;
      return;
    }
    const s = shift[d.key] || 0;
    const lo = d.lo + s;
    const hi = d.hi + s;
    const t = clamp((v - lo) / (hi - lo || 1), 0, 1);
    out[d.key] = d.bipolar ? t * 2 - 1 : t;
  });
  return out;
}
