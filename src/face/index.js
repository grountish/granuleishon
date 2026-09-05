// Face view — an island. Nothing here is imported by the rest of the app;
// app.js pulls this module in with a dynamic import the first time the view
// opens and calls mount()/unmount() as the view comes and goes. Everything
// heavy (the ml5 script, the FaceMesh model, the camera, its own
// AudioContext) starts on the Start button and is torn down on unmount, so
// the other views never pay for it.

import { GEN4_SCALES, NOTE_NAMES } from '../core/theory.js';
import { FEATURE_DEFS, readRawFeatures, calibrate, normalizeFeatures } from './features.js';
import { createFaceSynth, OSC_WAVES } from './synth.js';
import { createFaceFxRack, makeFaceFxState, buildFaceFxPanel, paintRange } from './fx.js';
import { createFaceVisual } from './visual.js';

const ML5_URL = 'https://unpkg.com/ml5@1/dist/ml5.min.js';
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Dela+Gothic+One&display=swap';
const FPS_OPTIONS = [10, 15, 20, 30];
const OCTAVE_OPTIONS = [-1, 0, 1];
const BASE_MIDI = 48; // C3: chords sit an octave under middle C
const MAJOR = [0, 2, 4, 5, 7, 9, 11]; // stands in while the harmonizer is off
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const INVERSIONS = 3;
// One ink per gauge, so the row reads as a set of different eyes.
const METER_INKS = {
  mouthOpen: 'var(--yellow)',
  mouthWide: 'var(--vermilion)',
  brows: 'var(--magenta)',
  yaw: 'var(--cyan)',
  tilt: 'var(--cyan)',
  roll: 'var(--cyan)',
  eyes: 'var(--cream)',
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FACE = {
  host: null,
  els: null,
  video: null,
  stream: null,
  model: null,
  ctx: null,
  synth: null,
  timer: null,
  running: false,
  starting: false,
  autostart: false, // once started, re-entering the view starts again
  fps: 20,
  octave: 0,
  seventh: true,
  volume: 0.9,
  patch: { waveA: 'sawtooth', waveB: 'square', octaveB: -1, detune: 10 },
  // Own root and scale, independent of the harmonizer. G# phrygian: dark,
  // and every degree of it has a chord worth landing on.
  scale: { root: 8, id: 'phrygian' },
  fx: makeFaceFxState(),
  rack: null,
  calib: {},
  raw: null,
  smooth: {},
  eyesOpen: true,
  degree: null, // scale degree the head is turned to, null = no chord
  inversion: 0,
  chord: [], // sounding MIDI notes
  // Picture state: the shader, its frame loop, and the slow-moving values it
  // eases toward (present, hue, flash, audio level).
  visual: null,
  drawFrame: null,
  kp: null,
  showMesh: false,
  analyser: null,
  levelBuf: null,
  vis: { face: 0, hue: 0, flash: 0, level: 0, cutoff: 0 },
};

// ── ml5 ── one script tag, loaded on demand, never twice.
let ml5Promise = null;
function loadMl5() {
  if (window.ml5?.faceMesh) return Promise.resolve(window.ml5);
  if (!ml5Promise) {
    ml5Promise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ML5_URL;
      s.async = true;
      s.onload = () =>
        window.ml5?.faceMesh ? resolve(window.ml5) : reject(new Error('ml5 loaded without faceMesh'));
      s.onerror = () => {
        ml5Promise = null;
        s.remove();
        reject(new Error('could not load ml5 — offline?'));
      };
      document.head.appendChild(s);
    });
  }
  return ml5Promise;
}

// ml5's load callback is node-style: (error) on failure, (undefined, model)
// on success. A failed model download must reject here, or detect() throws
// on every frame with nothing to show for it.
function loadModel(ml5) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err?.message || err)));
      else resolve(model);
    };
    let model;
    try {
      model = ml5.faceMesh({ maxFaces: 1, refineLandmarks: false, flipHorizontal: false }, (a, b) =>
        done(a && !(b || a?.keypoints || a?.detect) ? a : null),
      );
    } catch (err) {
      done(err);
      return;
    }
    // Newer builds also expose a ready promise; whichever fires first wins.
    model?.ready?.then?.(() => done(), (err) => done(err));
  });
}

// One detection, tolerant of both callback shapes ml5 has used. A throwing
// detect() is reported once to the console and kept on the status line.
function detectOnce() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (a, b) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(a) ? a : Array.isArray(b) ? b : []);
    };
    const fail = (err) => {
      if (!FACE.detectError) console.error('[face] detect failed', err);
      FACE.detectError = err?.message || String(err);
      finish([]);
    };
    try {
      const p = FACE.model.detect(FACE.video, finish);
      if (p?.then) p.then((r) => finish(r), fail);
    } catch (err) {
      fail(err);
    }
  });
}

// ── Lifecycle ──

// The display face, fetched once on first open; the stack falls back to a
// heavy system face until it lands.
function ensureFont() {
  if (document.querySelector('link[data-face-font]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_URL;
  link.dataset.faceFont = '1';
  document.head.appendChild(link);
}

export function mount(host) {
  if (FACE.host) return;
  FACE.host = host;
  ensureFont();
  buildPanel(host);
  refreshDegreeStrip();
  setStatus(FACE.autostart ? 'starting…' : 'press Start — camera and model load only then');
  startPicture();
  if (FACE.autostart) start();
}

export function unmount() {
  if (!FACE.host) return;
  stop();
  stopPicture();
  FACE.host.textContent = '';
  FACE.host = null;
  FACE.els = null;
}

// The context must be created and resumed inside the click itself — before
// any await — or Safari (and Chrome without sticky activation) leaves it
// suspended for good.
function ensureAudioContext() {
  if (FACE.ctx) return FACE.ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  FACE.ctx = new Ctor({ latencyHint: 'interactive' });
  FACE.ctx.addEventListener('statechange', () => {
    if (FACE.ctx?.state === 'running' && FACE.running) setStatus('audio on');
  });
  if (FACE.ctx.state === 'suspended') FACE.ctx.resume().catch(() => {});
  return FACE.ctx;
}

// If the context is still not running once everything is up, the next click
// anywhere on the page resumes it.
function armAudioUnlock() {
  if (!FACE.ctx || FACE.ctx.state === 'running') return;
  setStatus('audio blocked — click anywhere');
  const unlock = () => {
    FACE.ctx?.resume().catch(() => {});
    document.removeEventListener('pointerdown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);
}

function ensureSynth() {
  if (!FACE.ctx) ensureAudioContext();
  if (!FACE.synth) {
    FACE.analyser = FACE.ctx.createAnalyser();
    FACE.analyser.fftSize = 512;
    FACE.analyser.smoothingTimeConstant = 0.5;
    FACE.analyser.connect(FACE.ctx.destination);
    FACE.levelBuf = new Float32Array(FACE.analyser.fftSize);
    FACE.rack = createFaceFxRack(FACE.ctx, FACE.analyser, FACE.fx);
    FACE.synth = createFaceSynth(FACE.ctx, FACE.rack.input);
    FACE.synth.setPatch(FACE.patch);
    FACE.synth.setVolume(FACE.volume);
  }
  return FACE.synth;
}

function testTone() {
  const synth = ensureSynth();
  synth.set({ cutoff: 2500, resonance: 1.5, pan: 0 });
  synth.setChord(buildChord(0, 0), { retrigger: true });
  setTimeout(() => {
    if (!FACE.synth) return;
    if (FACE.running && FACE.chord.length) FACE.synth.setChord(FACE.chord);
    else FACE.synth.allOff();
  }, 700);
  armAudioUnlock();
  if (FACE.ctx.state === 'running') setStatus(`test chord · ctx ${FACE.ctx.state}`);
}

async function start() {
  if (FACE.running || FACE.starting) return;
  FACE.starting = true;
  FACE.els.startBtn.disabled = true;
  ensureAudioContext();
  try {
    setStatus('loading ml5…');
    const ml5 = await loadMl5();
    if (!FACE.host) return;
    setStatus('opening camera…');
    FACE.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    if (!FACE.host) return stop();
    const video = FACE.els.video;
    video.srcObject = FACE.stream;
    await new Promise((res) => {
      if (video.readyState >= 1) res();
      else video.addEventListener('loadedmetadata', () => res(), { once: true });
    });
    await video.play();
    FACE.video = video;
    video.width = video.videoWidth || 640;
    video.height = video.videoHeight || 480;
    setStatus('loading face model…');
    FACE.model = await loadModel(ml5);
    if (!FACE.host) return stop();
    ensureSynth();
    FACE.running = true;
    FACE.autostart = true;
    FACE.els.startBtn.textContent = 'Stop';
    FACE.els.emblem.classList.add('live');
    FACE.els.startBtn.disabled = false;
    FACE.els.calibBtn.disabled = false;
    setStatus('looking for a face…');
    armAudioUnlock();
    startDetection();
    loop();
  } catch (err) {
    console.error('[face]', err);
    setStatus(`failed: ${err.message}`);
    stop();
  } finally {
    FACE.starting = false;
    if (FACE.els) FACE.els.startBtn.disabled = false;
  }
}

function stop() {
  FACE.running = false;
  clearTimeout(FACE.timer);
  FACE.timer = null;
  try {
    FACE.model?.detectStop?.();
  } catch (e) {}
  FACE.model = null;
  FACE.continuous = false;
  FACE.latest = null;
  FACE.stream?.getTracks().forEach((t) => t.stop());
  FACE.stream = null;
  if (FACE.video) FACE.video.srcObject = null;
  FACE.video = null;
  FACE.synth?.dispose();
  FACE.synth = null;
  const rack = FACE.rack;
  FACE.rack = null;
  if (rack) setTimeout(() => rack.dispose(), 200);
  FACE.analyser = null;
  FACE.kp = null;
  const ctx = FACE.ctx;
  FACE.ctx = null;
  if (ctx) setTimeout(() => ctx.close().catch(() => {}), 250);
  FACE.degree = null;
  FACE.chord = [];
  FACE.smooth = {};
  FACE.detectError = null;
  if (FACE.els) {
    FACE.els.startBtn.textContent = 'Start camera';
    FACE.els.calibBtn.disabled = true;
    FACE.els.emblem.classList.remove('live');
    showChord();
    if (!FACE.starting) setStatus('stopped — nothing loaded');
  }
}

// ml5's own loop (detectStart) is the path its examples exercise; it runs
// at the video's frame rate and drops results into FACE.latest. Our loop
// then reads the newest one at the fps cap. Builds without detectStart fall
// back to single detect() calls at the cap.
function startDetection() {
  FACE.latest = null;
  FACE.logged = false;
  if (typeof FACE.model.detectStart !== 'function') return;
  FACE.continuous = true;
  FACE.model.detectStart(FACE.video, (a, b) => {
    const faces = Array.isArray(a) ? a : Array.isArray(b) ? b : [];
    if (!FACE.logged) {
      FACE.logged = true;
      console.log('[face] first detectStart result', { a, b, count: faces.length, keys: faces[0] && Object.keys(faces[0]) });
    }
    FACE.latest = faces;
  });
}

async function loop() {
  if (!FACE.running) return;
  const t0 = performance.now();
  const faces = FACE.continuous ? FACE.latest || [] : await detectOnce();
  if (!FACE.running) return;
  handleFaces(faces);
  const wait = Math.max(0, 1000 / FACE.fps - (performance.now() - t0));
  FACE.timer = setTimeout(loop, wait);
}

// ── Per-frame: landmarks → features → synth + meters + preview ──

function handleFaces(faces) {
  const kp = faces[0]?.keypoints;
  FACE.kp = kp && kp.length >= 468 ? kp : null;
  if (!kp || kp.length < 468) {
    if (faces[0] && !FACE.shapeLogged) {
      FACE.shapeLogged = true;
      console.warn('[face] unexpected result shape', Object.keys(faces[0]), kp?.length);
    }
    FACE.raw = null;
    if (FACE.degree !== null) {
      FACE.degree = null;
      FACE.chord = [];
      FACE.synth?.allOff();
      showChord();
    }
    setStatus(
      FACE.detectError
        ? `detect error: ${FACE.detectError}`
        : `no face · ${faces.length} result${faces.length === 1 ? '' : 's'}${kp ? ` · ${kp.length} pts` : ''}`,
    );
    return;
  }
  FACE.raw = readRawFeatures(kp);
  const norm = normalizeFeatures(FACE.raw, FACE.calib);
  // Exponential smoothing; mouth and eyes stay quicker so the cutoff and the
  // blink feel played, the head moves are steadier for the chord pick.
  FEATURE_DEFS.forEach(({ key }) => {
    const a = key === 'mouthOpen' || key === 'eyes' ? 0.55 : 0.25;
    const prev = FACE.smooth[key] ?? norm[key];
    FACE.smooth[key] = prev + (norm[key] - prev) * a;
  });
  const f = FACE.smooth;
  updateMeters(f);
  drive(f);
  setStatus(`live · ${FACE.synth?.voiceCount() ?? 0} voices · ctx ${FACE.ctx?.state}`);
}

function drive(f) {
  const intervals = scaleIntervals();
  const n = intervals.length;
  // Head turn picks the degree, tilt (up = higher) the inversion. Both are
  // bins with hysteresis so a chord holds until the head clearly moves on.
  const degree = binWithHysteresis(((f.yaw + 1) / 2) * n, FACE.degree, n);
  const inversion = binWithHysteresis(((1 - f.tilt) / 2) * INVERSIONS, FACE.inversion, INVERSIONS);
  const changed = degree !== FACE.degree || inversion !== FACE.inversion;
  FACE.degree = degree;
  FACE.inversion = inversion;
  if (changed) {
    FACE.chord = buildChord(degree, inversion);
    FACE.synth.setChord(FACE.chord);
    showChord();
    FACE.vis.flash = Math.max(FACE.vis.flash, 0.45);
  }

  // Mouth → cutoff over six octaves, brows → resonance, width → osc mix.
  FACE.synth.set({
    cutoff: 110 * Math.pow(2, f.mouthOpen * 6.2),
    resonance: 0.7 + f.brows * 9,
    mix: f.mouthWide,
    pan: f.roll * 0.8,
  });

  // A blink moves the root up a fifth: twelve blinks walk the whole circle.
  if (FACE.eyesOpen && f.eyes < 0.3) {
    FACE.eyesOpen = false;
    FACE.vis.flash = 1;
    FACE.scale.root = (FACE.scale.root + 7) % 12;
    if (FACE.els.rootSelect) FACE.els.rootSelect.value = String(FACE.scale.root);
    onScaleChanged({ retrigger: true });
  } else if (!FACE.eyesOpen && f.eyes > 0.55) {
    FACE.eyesOpen = true;
  }
}

// Which bin 0..n-1 a continuous position x (in bin units) lands in, keeping
// the current bin while x is within `margin` of its edges.
function binWithHysteresis(x, current, n, margin = 0.15) {
  if (current !== null && x >= current - margin && x < current + 1 + margin) return current;
  return clamp(Math.floor(x), 0, n - 1);
}

function scaleIntervals() {
  const found = GEN4_SCALES.find(([id]) => id === FACE.scale.id)?.[2];
  return found?.length ? found : MAJOR;
}

// Root or scale changed: relabel the strip and re-voice a sounding chord.
// A key change from a blink re-strikes; a select change lets common tones ring.
function onScaleChanged({ retrigger = false } = {}) {
  refreshDegreeStrip();
  if (FACE.degree !== null && FACE.synth) {
    FACE.degree = Math.min(FACE.degree, scaleIntervals().length - 1);
    FACE.chord = buildChord(FACE.degree, FACE.inversion);
    FACE.synth.setChord(FACE.chord, { retrigger });
    showChord();
  }
}

// Scale note `i` (any integer, wraps octaves) on the current root and octave.
function scaleNote(i, intervals = scaleIntervals()) {
  const n = intervals.length;
  const oct = Math.floor(i / n);
  return BASE_MIDI + FACE.scale.root + FACE.octave * 12 + oct * 12 + intervals[((i % n) + n) % n];
}

// Stacked thirds in scale steps: degree, +2, +4 (+6 with the seventh), then
// the lowest `inversion` notes lifted an octave.
function buildChord(degree, inversion) {
  const steps = FACE.seventh ? [0, 2, 4, 6] : [0, 2, 4];
  const notes = steps.map((k) => scaleNote(degree + k));
  for (let i = 0; i < Math.min(inversion, notes.length - 1); i++) notes[i] += 12;
  return notes.sort((a, b) => a - b);
}

// Roman numeral in the chord's quality: case from the third, ° for a
// diminished fifth, + for an augmented one.
function degreeLabel(degree) {
  const root = scaleNote(degree);
  const third = scaleNote(degree + 2) - root;
  const fifth = scaleNote(degree + 4) - root;
  let label = ROMAN[degree] || String(degree + 1);
  if (third < 4) label = label.toLowerCase();
  if (fifth === 6) label += '°';
  else if (fifth === 8) label += '+';
  return label;
}

function showChord() {
  if (!FACE.els) return;
  const { numeral, names, degreeStrip } = FACE.els;
  if (FACE.degree === null) {
    numeral.textContent = '—';
    numeral.classList.add('off');
    names.textContent = '';
  } else {
    numeral.textContent = degreeLabel(FACE.degree);
    numeral.classList.remove('off');
    names.textContent = FACE.chord.map((m) => NOTE_NAMES[((m % 12) + 12) % 12]).join(' ');
  }
  degreeStrip.querySelectorAll('.face-degree').forEach((el, i) => {
    el.classList.toggle('active', i === FACE.degree);
  });
}

function refreshDegreeStrip() {
  if (!FACE.els) return;
  const strip = FACE.els.degreeStrip;
  strip.textContent = '';
  const n = scaleIntervals().length;
  for (let d = 0; d < n; d++) {
    const el = document.createElement('span');
    el.className = 'face-degree' + (d === FACE.degree ? ' active' : '');
    el.textContent = degreeLabel(d);
    strip.appendChild(el);
  }
}

// ── Panel ──

function buildPanel(host) {
  host.textContent = '';
  const root = document.createElement('div');
  root.className = 'face-root';

  const mast = document.createElement('div');
  mast.className = 'face-mast';
  const emblem = document.createElement('div');
  emblem.className = 'face-emblem';
  const title = document.createElement('span');
  title.className = 'face-title';
  title.textContent = 'Face';
  const band = document.createElement('div');
  band.className = 'face-band';

  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'face-btn face-start';
  startBtn.textContent = 'Start camera';
  startBtn.title = 'Loads ml5 + the FaceMesh model and opens the webcam. Video never leaves this machine.';
  startBtn.addEventListener('click', () => (FACE.running ? stop() : start()));

  const calibBtn = document.createElement('button');
  calibBtn.type = 'button';
  calibBtn.className = 'face-btn';
  calibBtn.textContent = 'Calibrate';
  calibBtn.title = 'Relax your face, look straight at the camera, press: that becomes the neutral pose';
  calibBtn.disabled = true;
  calibBtn.addEventListener('click', () => {
    if (!FACE.raw) return;
    FACE.calib = calibrate(FACE.raw);
    FACE.smooth = {};
    setStatus('calibrated');
  });

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'face-btn';
  testBtn.textContent = 'Test chord';
  testBtn.title = 'Half a second of the voice, no face needed — checks the audio path';
  testBtn.addEventListener('click', testTone);

  const fpsLabel = labelled('fps', selectFrom(FPS_OPTIONS, FACE.fps, (v) => (FACE.fps = Number(v))));
  const octLabel = labelled(
    'oct',
    selectFrom(OCTAVE_OPTIONS, FACE.octave, (v) => (FACE.octave = Number(v)), (v) =>
      v > 0 ? `+${v}` : String(v),
    ),
  );

  const setPatch = (key, value) => {
    FACE.patch[key] = value;
    FACE.synth?.setPatch({ [key]: value });
  };
  const waveALabel = labelled('osc a', selectFrom(OSC_WAVES, FACE.patch.waveA, (v) => setPatch('waveA', v), waveName));
  const waveBLabel = labelled('osc b', selectFrom(OSC_WAVES, FACE.patch.waveB, (v) => setPatch('waveB', v), waveName));
  const octBLabel = labelled(
    'b oct',
    selectFrom([-2, -1, 0, 1], FACE.patch.octaveB, (v) => setPatch('octaveB', Number(v)), (v) =>
      v > 0 ? `+${v}` : String(v),
    ),
  );
  const detune = document.createElement('input');
  detune.type = 'range';
  detune.min = '0';
  detune.max = '40';
  detune.step = '1';
  detune.value = String(FACE.patch.detune);
  detune.title = 'Osc B detune, cents';
  paintRange(detune);
  detune.addEventListener('input', () => {
    paintRange(detune);
    setPatch('detune', Number(detune.value));
  });
  const detuneLabel = labelled('detune', detune);

  const meshBtn = document.createElement('button');
  meshBtn.type = 'button';
  meshBtn.className = 'face-btn' + (FACE.showMesh ? ' active' : '');
  meshBtn.textContent = 'Mesh';
  meshBtn.title = 'Overlay the tracked landmarks, to check the camera sees you';
  meshBtn.addEventListener('click', () => {
    FACE.showMesh = !FACE.showMesh;
    meshBtn.classList.toggle('active', FACE.showMesh);
  });

  const seventhBtn = document.createElement('button');
  seventhBtn.type = 'button';
  seventhBtn.className = 'face-btn' + (FACE.seventh ? ' active' : '');
  seventhBtn.textContent = '7th';
  seventhBtn.title = 'Four-note chords';
  seventhBtn.addEventListener('click', () => {
    FACE.seventh = !FACE.seventh;
    seventhBtn.classList.toggle('active', FACE.seventh);
    if (FACE.degree !== null && FACE.synth) {
      FACE.chord = buildChord(FACE.degree, FACE.inversion);
      FACE.synth.setChord(FACE.chord);
      showChord();
    }
  });
  const rootSelect = selectFrom(NOTE_NAMES.map((_, i) => i), FACE.scale.root, (v) => {
    FACE.scale.root = Number(v);
    onScaleChanged();
  }, (i) => NOTE_NAMES[i]);
  const rootLabel = labelled('root', rootSelect);
  const scaleIds = GEN4_SCALES.filter(([id, , iv]) => id !== 'off' && iv?.length).map(([id]) => id);
  const scaleLabel = labelled(
    'scale',
    selectFrom(scaleIds, FACE.scale.id, (v) => {
      FACE.scale.id = v;
      onScaleChanged();
    }, (id) => GEN4_SCALES.find(([x]) => x === id)?.[1] || id),
  );

  const vol = document.createElement('input');
  vol.type = 'range';
  vol.min = '0';
  vol.max = '1';
  vol.step = '0.01';
  vol.value = String(FACE.volume);
  paintRange(vol);
  vol.addEventListener('input', () => {
    paintRange(vol);
    FACE.volume = Number(vol.value);
    FACE.synth?.setVolume(FACE.volume);
  });
  const volLabel = labelled('vol', vol);

  const status = document.createElement('span');
  status.className = 'face-status';
  mast.append(emblem, title, startBtn, calibBtn, testBtn, status);
  band.append(
    waveALabel, waveBLabel, octBLabel, detuneLabel, octLabel, seventhBtn, rootLabel, scaleLabel,
    fpsLabel, meshBtn, volLabel,
  );

  const body = document.createElement('div');
  body.className = 'face-body';
  const stage = document.createElement('div');
  stage.className = 'face-stage';
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  const canvas = document.createElement('canvas');
  canvas.className = 'face-gl';
  const overlay = document.createElement('canvas');
  overlay.className = 'face-overlay';
  const hint = document.createElement('div');
  hint.className = 'face-hint';
  hint.textContent = 'turn for the chord · tilt for the inversion · open your mouth for the cutoff · brows for resonance · blink to move the root up a fifth';
  stage.append(video, canvas, overlay, hint);

  const side = document.createElement('div');
  side.className = 'face-side';
  const chord = document.createElement('div');
  chord.className = 'face-chord';
  const numeral = document.createElement('div');
  numeral.className = 'face-numeral off';
  numeral.textContent = '—';
  const names = document.createElement('div');
  names.className = 'face-names';
  chord.append(numeral, names);
  const degreeStrip = document.createElement('div');
  degreeStrip.className = 'face-degrees';
  const meters = document.createElement('div');
  meters.className = 'face-meters';
  const meterEls = {};
  FEATURE_DEFS.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'face-meter' + (d.bipolar ? ' bipolar' : '');
    const lab = document.createElement('span');
    lab.textContent = d.label;
    const ring = document.createElement('div');
    ring.className = 'face-meter-ring';
    ring.style.setProperty('--c', METER_INKS[d.key] || 'var(--cyan)');
    const val = document.createElement('span');
    val.className = 'face-meter-val';
    row.append(lab, ring, val);
    meters.appendChild(row);
    meterEls[d.key] = { ring, val };
  });
  const map = document.createElement('div');
  map.className = 'face-map';
  map.innerHTML =
    '<b>turn</b> chord degree of the scale<br>' +
    '<b>tilt</b> inversion (up = higher)<br>' +
    '<b>mouth open</b> filter cutoff<br>' +
    '<b>mouth wide</b> osc a → osc b mix<br>' +
    '<b>brows</b> resonance<br>' +
    '<b>roll</b> pan<br>' +
    '<b>blink</b> root up a fifth';
  side.append(chord, degreeStrip, meters, map);
  body.append(stage, side);
  root.append(mast, band, body);
  buildFaceFxPanel(FACE.fx, root, () => FACE.rack);
  host.appendChild(root);

  FACE.els = {
    startBtn, calibBtn, status, video, canvas, overlay, stage, numeral, names, degreeStrip, meterEls,
    rootSelect, emblem,
  };
}

function waveName(w) {
  return { sawtooth: 'saw', square: 'sqr', triangle: 'tri', sine: 'sin' }[w] || w;
}

function labelled(text, control) {
  const label = document.createElement('label');
  label.className = 'face-field';
  const span = document.createElement('span');
  span.textContent = text;
  label.append(span, control);
  return label;
}

function selectFrom(options, current, onChange, format = String) {
  const sel = document.createElement('select');
  options.forEach((v) => sel.appendChild(new Option(format(v), String(v))));
  sel.value = String(current);
  sel.addEventListener('change', () => onChange(sel.value));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  return sel;
}

function setStatus(text) {
  if (FACE.els) FACE.els.status.textContent = text;
}

// Ring gauges: an arc from the top, clockwise for a value, either way for a
// bipolar one (right for positive, left for negative).
function updateMeters(f) {
  FEATURE_DEFS.forEach((d) => {
    const m = FACE.els.meterEls[d.key];
    const v = f[d.key];
    let a = 0;
    let b = v;
    if (d.bipolar) {
      if (v >= 0) b = v * 0.5;
      else {
        a = 1 + v * 0.5;
        b = 1;
      }
    }
    m.ring.style.setProperty('--a', String(a));
    m.ring.style.setProperty('--b', String(b));
    m.val.textContent = v.toFixed(2);
  });
}

// ── Picture ── runs at display rate for as long as the view is open; the
// detection loop only feeds it. Values ease so a 20 fps face reads smooth.

function startPicture() {
  const { canvas, stage } = FACE.els;
  try {
    FACE.visual = createFaceVisual(canvas);
  } catch (err) {
    console.error('[face] visual', err);
    FACE.visual = null;
  }
  if (!FACE.visual) {
    setStatus('WebGL unavailable — no picture');
    return;
  }
  const fit = () => {
    const w = Math.max(2, Math.min(1280, Math.round(stage.clientWidth)));
    const h = Math.max(2, Math.round((w * stage.clientHeight) / Math.max(1, stage.clientWidth)));
    FACE.visual.resize(w, h);
    FACE.els.overlay.width = w;
    FACE.els.overlay.height = h;
  };
  fit();
  FACE.resizeObs = new ResizeObserver(fit);
  FACE.resizeObs.observe(stage);
  const tick = () => {
    FACE.drawFrame = requestAnimationFrame(tick);
    drawPicture();
  };
  tick();
}

function stopPicture() {
  cancelAnimationFrame(FACE.drawFrame);
  FACE.drawFrame = null;
  FACE.resizeObs?.disconnect();
  FACE.resizeObs = null;
  FACE.visual?.dispose();
  FACE.visual = null;
}

function audioLevel() {
  if (!FACE.analyser || !FACE.levelBuf) return 0;
  FACE.analyser.getFloatTimeDomainData(FACE.levelBuf);
  let sum = 0;
  for (let i = 0; i < FACE.levelBuf.length; i++) sum += FACE.levelBuf[i] * FACE.levelBuf[i];
  return clamp(Math.sqrt(sum / FACE.levelBuf.length) * 4, 0, 1);
}

function drawPicture() {
  if (!FACE.visual) return;
  const v = FACE.vis;
  const f = FACE.smooth;
  const present = FACE.running && FACE.degree !== null;
  v.face += ((present ? 1 : 0) - v.face) * 0.06;
  v.flash *= 0.86;
  v.level += (audioLevel() - v.level) * 0.25;
  const n = scaleIntervals().length;
  const hueTarget = FACE.degree === null ? v.hue : FACE.degree / n + FACE.inversion * 0.04;
  v.hue += (hueTarget - v.hue) * 0.08;
  const cutoffTarget = present ? f.mouthOpen ?? 0 : 0.2;
  v.cutoff += (cutoffTarget - v.cutoff) * 0.2;
  FACE.visual.frame({
    mouth: present ? f.mouthOpen ?? 0 : 0,
    wide: present ? f.mouthWide ?? 0 : 0.3,
    brows: present ? f.brows ?? 0 : 0.1,
    yaw: present ? f.yaw ?? 0 : 0,
    tilt: present ? f.tilt ?? 0 : 0,
    roll: present ? f.roll ?? 0 : 0,
    eyes: present ? f.eyes ?? 1 : 1,
    flash: v.flash,
    level: v.level,
    hue: v.hue,
    face: v.face,
    cutoff: v.cutoff,
  });
  drawMesh();
}

// Optional faint constellation of the tracked points, mirrored like a
// selfie, so you can see the camera has you without seeing the camera.
function drawMesh() {
  const { overlay, video } = FACE.els;
  const c = overlay.getContext('2d');
  c.clearRect(0, 0, overlay.width, overlay.height);
  if (!FACE.showMesh || !FACE.kp || !video?.videoWidth) return;
  const sx = overlay.width / video.videoWidth;
  const sy = overlay.height / video.videoHeight;
  const sc = Math.min(sx, sy);
  const ox = (overlay.width - video.videoWidth * sc) / 2;
  const oy = (overlay.height - video.videoHeight * sc) / 2;
  c.fillStyle = 'rgba(235, 240, 255, 0.55)';
  const kp = FACE.kp;
  for (let i = 0; i < kp.length; i += 2) {
    const x = overlay.width - (ox + kp[i].x * sc);
    const y = oy + kp[i].y * sc;
    c.fillRect(x - 1, y - 1, 2, 2);
  }
}
