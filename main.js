// granuleishon — main thread: mic capture, worklet setup, UI wiring.

let audioCtx = null;
let node = null;
let micStream = null;
let started = false;

// ─── Visualizer (per-generator) ────────────────────────────────────────────

const genVizCanvases = [null, null];
const genVizCtxs    = [null, null];
const genVizW       = [0, 0];
const genVizH       = [0, 0];

const GEN_VIZ = [
  { line: '#3cb870', spray: 'rgba(60,184,112,0.12)' },
  { line: '#8b6ed4', spray: 'rgba(139,110,212,0.12)' },
];

function drawGenVizEmpty(gi) {
  const c = genVizCtxs[gi], W = genVizW[gi], H = genVizH[gi];
  if (!c || !W || !H) return;
  c.fillStyle = '#141414';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#252525';
  c.fillRect(0, H / 2 - 0.5, W, 1);
}

function drawGenViz(gi, { waveform, posX, sprayNorm, frozen }) {
  const c = genVizCtxs[gi], W = genVizW[gi], H = genVizH[gi];
  if (!c || !W || !H) return;
  const col = GEN_VIZ[gi];
  const mid = H / 2;
  const N   = waveform.length;
  const maxH = H * 0.48; // max waveform half-height

  // Background
  c.fillStyle = frozen ? '#131824' : '#141414';
  c.fillRect(0, 0, W, H);

  // Spray band (behind waveform)
  const cx = posX * W;
  const sw = sprayNorm * W;
  if (sw > 0) {
    const g = c.createLinearGradient(cx - sw, 0, cx, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, col.spray);
    c.fillStyle = g;
    c.fillRect(cx - sw, 0, sw, H);
  }

  // Compute per-column heights (one pass over data)
  const pH = new Float32Array(W); // peak band
  const tH = new Float32Array(W); // teal band
  const yH = new Float32Array(W); // yellow/bass band

  for (let x = 0; x < W; x++) {
    const i0 = Math.floor(x * N / W);
    const i1 = Math.min(N - 1, Math.floor((x + 1) * N / W) + 1);
    const n  = Math.max(1, i1 - i0 + 1);
    let peak = 0, sumAbs = 0;
    for (let i = i0; i <= i1; i++) {
      const v = Math.abs(waveform[i]);
      if (v > peak) peak = v;
      sumAbs += v;
    }
    if (peak < 0.001) continue;
    const rms = sumAbs / n;
    // Gamma 0.65: boosts quiet content, compresses peaks (like Traktor log scale)
    const p = Math.pow(peak, 0.65) * maxH;
    pH[x] = p;
    tH[x] = p * 0.68;
    yH[x] = Math.min(Math.pow(rms, 0.65) * maxH * 1.4, p * 0.48);
  }

  // Blue — outer/peak layer (draw first, widest)
  c.fillStyle = frozen ? '#3a52a0' : '#3490d8';
  c.beginPath();
  for (let x = 0; x < W; x++) { if (pH[x] > 0.5) c.rect(x, mid - pH[x], 1, pH[x] * 2); }
  c.fill();

  // Teal — mid layer
  c.fillStyle = frozen ? '#285e72' : '#16b8a8';
  c.beginPath();
  for (let x = 0; x < W; x++) { if (tH[x] > 0.5) c.rect(x, mid - tH[x], 1, tH[x] * 2); }
  c.fill();

  // Yellow — inner/bass layer (RMS-based, represents sustained low-freq content)
  c.fillStyle = frozen ? '#6e5818' : '#c4a018';
  c.beginPath();
  for (let x = 0; x < W; x++) { if (yH[x] > 0.5) c.rect(x, mid - yH[x], 1, yH[x] * 2); }
  c.fill();

  // Bright peak caps (1px line at top and bottom of each column)
  c.fillStyle = frozen ? 'rgba(140,165,220,0.65)' : 'rgba(200,238,255,0.9)';
  c.beginPath();
  for (let x = 0; x < W; x++) {
    if (pH[x] > 2) {
      c.rect(x, mid - pH[x],     1, 1);
      c.rect(x, mid + pH[x] - 1, 1, 1);
    }
  }
  c.fill();

  // Center line
  c.fillStyle = '#252525';
  c.fillRect(0, mid - 0.5, W, 1);

  // Position marker
  c.strokeStyle = col.line;
  c.lineWidth = 1.5;
  c.setLineDash(frozen ? [4, 3] : []);
  c.beginPath();
  c.moveTo(Math.round(cx) + 0.5, 0);
  c.lineTo(Math.round(cx) + 0.5, H);
  c.stroke();
  c.setLineDash([]);

  // Write-head (hidden when frozen)
  if (!frozen) {
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(W - 0.5, 0); c.lineTo(W - 0.5, H); c.stroke();
  }

  // FROZEN label
  if (frozen) {
    c.fillStyle = 'rgba(120,150,230,0.75)';
    c.font = 'bold 8px ui-monospace, monospace';
    c.fillText('FROZEN', W - 47, 11);
  }
}

function drawViz({ gens }) {
  gens.forEach((genData, gi) => drawGenViz(gi, genData));
}

const PARAMS = [
  { key: 'grainSizeMs', label: 'Grain size', min: 5,   max: 500, step: 1,    unit: 'ms'     },
  { key: 'density',     label: 'Density',    min: 1,   max: 100, step: 1,    unit: '/s'     },
  { key: 'positionSec', label: 'Position',   min: 0,   max: 9,   step: 0.01, unit: 's back' },
  { key: 'spraySec',    label: 'Spray',      min: 0,   max: 2,   step: 0.01, unit: 's'      },
  { key: 'pitch',       label: 'Pitch',      min: -24, max: 24,  step: 1,    unit: 'st'     },
  { key: 'pitchJitter', label: 'Pitch jitter', min: 0, max: 12,  step: 0.5,  unit: 'st'     },
  { key: 'spread',      label: 'Stereo spread', min: 0, max: 1,  step: 0.01, unit: ''       },
  { key: 'gain',        label: 'Output gain', min: 0,  max: 2,   step: 0.01, unit: ''       },
];

// Slightly different defaults for gen 1 so independence is immediately audible.
const GEN_DEFAULTS = [
  { grainSizeMs: 120, density: 20, positionSec: 0.5, spraySec: 0.05, pitch:  0, pitchJitter: 0, spread: 0.5, gain: 0.8, freeze: false },
  { grainSizeMs:  80, density: 15, positionSec: 1.2, spraySec: 0.10, pitch:  7, pitchJitter: 2, spread: 0.7, gain: 0.6, freeze: false },
];

const state = [
  { ...GEN_DEFAULTS[0] },
  { ...GEN_DEFAULTS[1] },
];

function sendParams(genIdx) {
  if (!node) return;
  const effective = { ...state[genIdx] };
  if (lfoMappings.size > 0) {
    const scaled = currentLFOValue * LFO.depth;
    lfoMappings.forEach(({ genIdx: gi, key, paramDef }) => {
      if (gi !== genIdx) return;
      const half = (paramDef.max - paramDef.min) * 0.5;
      effective[key] = Math.max(paramDef.min, Math.min(paramDef.max,
        effective[key] + scaled * half));
    });
  }
  node.port.postMessage({ type: 'params', gen: genIdx, value: effective });
}

function makeControlRow(p, initialValue, onInput, lfoToggle = null) {
  const dec = (p.step.toString().split('.')[1] || '').length;
  const fmt = (v) => `${parseFloat(v.toFixed(dec))}${p.unit ? ' ' + p.unit : ''}`;

  const row = document.createElement('div');
  row.className = 'control';

  const valueEl = document.createElement('span');
  valueEl.className = 'value';
  valueEl.textContent = fmt(initialValue);

  const knob = makeKnob(p, initialValue, (v) => {
    valueEl.textContent = fmt(v);
    onInput(v);
  });

  const label = document.createElement('label');
  label.textContent = p.label;

  if (lfoToggle !== null) {
    const led = document.createElement('button');
    led.className = 'lfo-led';
    led.title = 'Toggle LFO modulation';
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      led.classList.toggle('active', lfoToggle());
    });
    row.append(knob, led, label, valueEl);
  } else {
    row.append(knob, label, valueEl);
  }
  return row;
}

// ─── Knob ──────────────────────────────────────────────────────────────────

function makeKnob(p, initialValue, onInput) {
  const NS = 'http://www.w3.org/2000/svg';
  const VB = 40, cx = 20, cy = 20, r = 15, sw = 3;
  const S = -135, E = 135; // 7 o'clock → 5 o'clock (270° sweep)

  const decimals = (p.step.toString().split('.')[1] || '').length;
  const toNorm  = (v) => (v - p.min) / (p.max - p.min);
  const toValue = (n) => parseFloat(
    (Math.round((p.min + Math.max(0, Math.min(1, n)) * (p.max - p.min)) / p.step) * p.step)
      .toFixed(decimals)
  );

  function polar(deg) {
    const rad = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }
  function arc(a, b) {
    if (b - a < 0.5) return '';
    const [sx, sy] = polar(a), [ex, ey] = polar(b);
    return `M${sx.toFixed(2)},${sy.toFixed(2)}A${r},${r},0,${b - a > 180 ? 1 : 0},1,${ex.toFixed(2)},${ey.toFixed(2)}`;
  }

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
  svg.classList.add('knob');

  const track = document.createElementNS(NS, 'path');
  track.setAttribute('d', arc(S, E));
  track.setAttribute('stroke-width', sw);
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-linecap', 'round');
  track.classList.add('knob-track');

  const valArc = document.createElementNS(NS, 'path');
  valArc.setAttribute('stroke-width', sw);
  valArc.setAttribute('fill', 'none');
  valArc.setAttribute('stroke-linecap', 'round');
  valArc.classList.add('knob-value');

  const body = document.createElementNS(NS, 'circle');
  body.setAttribute('cx', cx); body.setAttribute('cy', cy); body.setAttribute('r', r - 5);
  body.classList.add('knob-body');

  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', '2');
  dot.classList.add('knob-dot');

  svg.append(track, valArc, body, dot);

  let norm = toNorm(initialValue);

  function render(n) {
    norm = Math.max(0, Math.min(1, n));
    const deg = S + norm * (E - S);
    valArc.setAttribute('d', norm < 0.005 ? '' : arc(S, deg));
    const dr = r - sw / 2 - 1.5, rad = (deg - 90) * Math.PI / 180;
    dot.setAttribute('cx', (cx + dr * Math.cos(rad)).toFixed(2));
    dot.setAttribute('cy', (cy + dr * Math.sin(rad)).toFixed(2));
  }

  render(norm);

  // Drag (up = increase, Shift = fine)
  let y0 = 0, n0 = 0;
  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    y0 = e.clientY; n0 = norm;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('knob--drag');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!svg.hasPointerCapture(e.pointerId)) return;
    const n = Math.max(0, Math.min(1, n0 + (y0 - e.clientY) * (e.shiftKey ? 0.001 : 0.004)));
    render(n); onInput(toValue(n));
  });
  svg.addEventListener('pointerup', () => svg.classList.remove('knob--drag'));

  // Scroll wheel — one step per tick
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const n = Math.max(0, Math.min(1, norm - Math.sign(e.deltaY) * p.step / (p.max - p.min)));
    render(n); onInput(toValue(n));
  }, { passive: false });

  // Double-click to reset to initial value
  svg.addEventListener('dblclick', () => { render(toNorm(initialValue)); onInput(initialValue); });

  return svg;
}

function buildGeneratorPanel(genIdx) {
  const defaults = GEN_DEFAULTS[genIdx];
  const panel = document.createElement('div');
  panel.className = `generator gen-${genIdx}`;

  // Column header
  const header = document.createElement('div');
  header.className = 'col-header';

  const title = document.createElement('span');
  title.className = 'col-title';
  title.innerHTML = `<span class="col-dot"></span>Gen ${genIdx + 1}`;

  const freezeBtn = document.createElement('button');
  freezeBtn.className = 'gen-freeze';
  freezeBtn.textContent = 'Freeze';
  freezeBtn.disabled = true;
  freezeBtn.addEventListener('click', () => {
    state[genIdx].freeze = !state[genIdx].freeze;
    freezeBtn.classList.toggle('active', state[genIdx].freeze);
    sendParams(genIdx);
  });

  header.append(title, freezeBtn);
  panel.appendChild(header);

  // Per-generator waveform canvas
  const vizCanvas = document.createElement('canvas');
  vizCanvas.className = 'gen-viz';
  genVizCanvases[genIdx] = vizCanvas;
  genVizCtxs[genIdx] = vizCanvas.getContext('2d');
  new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    genVizW[genIdx] = vizCanvas.clientWidth;
    genVizH[genIdx] = vizCanvas.clientHeight;
    vizCanvas.width  = genVizW[genIdx] * dpr;
    vizCanvas.height = genVizH[genIdx] * dpr;
    genVizCtxs[genIdx].setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGenVizEmpty(genIdx);
  }).observe(vizCanvas);
  panel.appendChild(vizCanvas);

  // Control rows
  const rows = document.createElement('div');
  rows.className = 'gen-controls';
  PARAMS.forEach((p) => {
    rows.appendChild(makeControlRow(p, defaults[p.key], (v) => {
      state[genIdx][p.key] = v;
      sendParams(genIdx);
    }, () => toggleLFOMap(genIdx, p.key)));
  });

  panel.appendChild(rows);
  return panel;
}

function buildUI() {
  const container = document.getElementById('generators');
  container.appendChild(buildGeneratorPanel(0));
  container.appendChild(buildGeneratorPanel(1));
}

// ─── FX Chain ──────────────────────────────────────────────────────────────

const FX_DEFS = [
  {
    id: 'delay', label: 'Delay',
    params: [
      { key: 'time',     label: 'Time',     min: 0,   max: 1,    step: 0.01, value: 0.30, unit: 's' },
      { key: 'feedback', label: 'Feedback', min: 0,   max: 0.95, step: 0.01, value: 0.35, unit: ''  },
      { key: 'mix',      label: 'Mix',      min: 0,   max: 1,    step: 0.01, value: 0,    unit: ''  },
    ],
  },
  {
    id: 'sat', label: 'Saturation',
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'mix',   label: 'Mix',   min: 0, max: 1, step: 0.01, value: 0,   unit: '' },
    ],
  },
  {
    id: 'reverb', label: 'Reverb',
    params: [
      { key: 'size',  label: 'Size',  min: 0.1, max: 5, step: 0.1,  value: 2,   unit: 's' },
      { key: 'decay', label: 'Decay', min: 0.5, max: 8, step: 0.1,  value: 3,   unit: ''  },
      { key: 'mix',   label: 'Mix',   min: 0,   max: 1, step: 0.01, value: 0,   unit: ''  },
    ],
  },
];

// Source of truth for FX state — applied to audio nodes when they exist.
const FX = {
  delay:  { time: 0.30, feedback: 0.35, mix: 0 },
  sat:    { drive: 0.3,  mix: 0 },
  reverb: { size: 2,    decay: 3,       mix: 0 },
};

let fx = null; // audio nodes, created in start(), nulled in stop()

// ─── LFO ───────────────────────────────────────────────────────────────────

const LFO = { rate: 1.0, shape: 'sine', depth: 0.3 };
// lfoMappings: 'genIdx:paramKey' → { genIdx, key, paramDef }
const lfoMappings = new Map();
let lfoPhase = 0, lfoLastTs = 0, lfoAnimFrame = null, currentLFOValue = 0;

function lfoStep(ts) {
  const dt = lfoLastTs ? Math.min((ts - lfoLastTs) / 1000, 0.1) : 0;
  lfoLastTs = ts;
  lfoPhase += LFO.rate * dt;
  while (lfoPhase >= 1) lfoPhase -= 1;
  switch (LFO.shape) {
    case 'sine':   currentLFOValue = Math.sin(2 * Math.PI * lfoPhase); break;
    case 'tri':    currentLFOValue = 1 - 4 * Math.abs(lfoPhase - 0.5); break;
    case 'square': currentLFOValue = lfoPhase < 0.5 ? 1 : -1; break;
    case 'saw':    currentLFOValue = 2 * lfoPhase - 1; break;
  }
  if (lfoMappings.size > 0) {
    const gens = new Set([...lfoMappings.values()].map(m => m.genIdx));
    gens.forEach(gi => sendParams(gi));
  }
  lfoAnimFrame = requestAnimationFrame(lfoStep);
}

function startLFOLoop() {
  if (lfoAnimFrame) return;
  lfoLastTs = 0;
  lfoAnimFrame = requestAnimationFrame(lfoStep);
}

function stopLFOLoop() {
  if (lfoAnimFrame) { cancelAnimationFrame(lfoAnimFrame); lfoAnimFrame = null; }
  currentLFOValue = 0;
}

function toggleLFOMap(genIdx, key) {
  const mapKey = `${genIdx}:${key}`;
  if (lfoMappings.has(mapKey)) {
    lfoMappings.delete(mapKey);
    sendParams(genIdx); // restore unmodulated value immediately
    return false;
  }
  lfoMappings.set(mapKey, { genIdx, key, paramDef: PARAMS.find(p => p.key === key) });
  return true;
}

function buildLFOSection() {
  const section = document.createElement('div');
  section.className = 'fx-section lfo-section';

  const lbl = document.createElement('div');
  lbl.className = 'fx-section-label';
  lbl.textContent = 'LFO';
  section.appendChild(lbl);

  [{ key: 'rate',  label: 'Rate',  min: 0.05, max: 10, step: 0.05, unit: 'Hz' },
   { key: 'depth', label: 'Depth', min: 0,    max: 1,  step: 0.01, unit: ''   }]
    .forEach((p) => section.appendChild(makeControlRow(p, LFO[p.key], (v) => { LFO[p.key] = v; })));

  // Shape selector
  const shapeRow = document.createElement('div');
  shapeRow.className = 'lfo-shapes';
  [['sine', 'SIN'], ['tri', 'TRI'], ['square', 'SQR'], ['saw', 'SAW']].forEach(([shape, lbl]) => {
    const btn = document.createElement('button');
    btn.className = 'lfo-shape' + (LFO.shape === shape ? ' active' : '');
    btn.textContent = lbl;
    btn.addEventListener('click', () => {
      LFO.shape = shape;
      shapeRow.querySelectorAll('.lfo-shape').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    shapeRow.appendChild(btn);
  });
  section.appendChild(shapeRow);

  return section;
}

function makeSatCurve(drive) {
  const n = 256;
  const curve = new Float32Array(n);
  // tanh soft-clip: k=1 (linear) → k=50 (near hard clip)
  const k = 1 + drive * 49;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    curve[i] = Math.tanh(k * ((i * 2) / n - 1)) / norm;
  }
  return curve;
}

function makeReverbIR() {
  const sr = audioCtx.sampleRate;
  const len = Math.floor(sr * Math.max(0.05, FX.reverb.size));
  const buf = audioCtx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, FX.reverb.decay);
    }
  }
  return buf;
}

function buildFxNodes() {
  const ac = audioCtx;

  // ─ Delay (feedback loop) ─
  const dlyIn  = ac.createGain();
  const dlyDry = ac.createGain();
  const dlyWet = ac.createGain();
  const dlyTap = ac.createDelay(2.0);
  const dlyFb  = ac.createGain();
  const dlyOut = ac.createGain();

  dlyIn.connect(dlyDry);
  dlyIn.connect(dlyTap);
  dlyTap.connect(dlyFb);
  dlyFb.connect(dlyTap);   // feedback loop
  dlyTap.connect(dlyWet);
  dlyDry.connect(dlyOut);
  dlyWet.connect(dlyOut);

  // ─ Saturation ─
  const satIn     = ac.createGain();
  const satShaper = ac.createWaveShaper();
  satShaper.oversample = '4x';
  const satDry = ac.createGain();
  const satWet = ac.createGain();
  const satOut = ac.createGain();

  satIn.connect(satDry);
  satIn.connect(satShaper);
  satShaper.connect(satWet);
  satDry.connect(satOut);
  satWet.connect(satOut);

  // ─ Reverb ─
  const rvbIn   = ac.createGain();
  const rvbConv = ac.createConvolver();
  const rvbDry  = ac.createGain();
  const rvbWet  = ac.createGain();
  const rvbOut  = ac.createGain();

  rvbIn.connect(rvbDry);
  rvbIn.connect(rvbConv);
  rvbConv.connect(rvbWet);
  rvbDry.connect(rvbOut);
  rvbWet.connect(rvbOut);

  // ─ Chain: granulator → delay → saturation → reverb → destination ─
  dlyOut.connect(satIn);
  satOut.connect(rvbIn);

  fx = {
    input:  dlyIn,
    output: rvbOut,
    delay:  { tap: dlyTap, fb: dlyFb, dry: dlyDry, wet: dlyWet },
    sat:    { shaper: satShaper, dry: satDry, wet: satWet },
    reverb: { conv: rvbConv, dry: rvbDry, wet: rvbWet },
  };

  applyAllFx();
}

function applyFx(id, key, val) {
  if (!fx) return;
  if (id === 'delay') {
    if (key === 'time')     fx.delay.tap.delayTime.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'feedback') fx.delay.fb.gain.setTargetAtTime(Math.min(0.98, val), audioCtx.currentTime, 0.02);
    if (key === 'mix')      { fx.delay.wet.gain.value = val; fx.delay.dry.gain.value = 1 - val; }
  } else if (id === 'sat') {
    if (key === 'drive')    fx.sat.shaper.curve = makeSatCurve(val);
    if (key === 'mix')      { fx.sat.wet.gain.value = val; fx.sat.dry.gain.value = 1 - val; }
  } else if (id === 'reverb') {
    if (key === 'size' || key === 'decay') fx.reverb.conv.buffer = makeReverbIR();
    if (key === 'mix')                     { fx.reverb.wet.gain.value = val; fx.reverb.dry.gain.value = 1 - val; }
  }
}

function applyAllFx() {
  FX_DEFS.forEach(({ id, params }) =>
    params.forEach(({ key }) => applyFx(id, key, FX[id][key]))
  );
}

function buildFxUI() {
  const container = document.getElementById('fx-chain');

  // Column header matching generator style
  const header = document.createElement('div');
  header.className = 'col-header';
  header.innerHTML = '<span class="col-title"><span class="col-dot"></span>FX Chain</span>';
  container.appendChild(header);

  // LFO modulator first
  container.appendChild(buildLFOSection());

  // One section per effect, stacked vertically
  FX_DEFS.forEach((def) => {
    const section = document.createElement('div');
    section.className = 'fx-section';

    const lbl = document.createElement('div');
    lbl.className = 'fx-section-label';
    lbl.textContent = def.label;
    section.appendChild(lbl);

    def.params.forEach((p) => {
      section.appendChild(makeControlRow(p, FX[def.id][p.key], (v) => {
        FX[def.id][p.key] = v;
        applyFx(def.id, p.key, v);
      }));
    });

    container.appendChild(section);
  });
}

async function start() {
  const startBtn = document.getElementById('startBtn');
  const status = document.getElementById('status');

  try {
    status.textContent = 'requesting mic…';
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });

    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule('granular-processor.js');

    const source = audioCtx.createMediaStreamSource(micStream);
    node = new AudioWorkletNode(audioCtx, 'granular-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    buildFxNodes();
    source.connect(node);
    node.connect(fx.input);
    fx.output.connect(audioCtx.destination);

    node.port.onmessage = (e) => {
      if (e.data && e.data.type === 'viz') drawViz(e.data);
    };

    sendParams(0);
    sendParams(1);
    startLFOLoop();

    started = true;
    startBtn.textContent = '■ Stop';
    document.querySelectorAll('.gen-freeze').forEach((btn) => (btn.disabled = false));
    status.textContent = 'running';
  } catch (err) {
    status.textContent = 'error: ' + err.message;
    console.error(err);
  }
}

function stop() {
  stopLFOLoop();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = node = micStream = fx = null;
  started = false;

  // Reset freeze state for both generators.
  state[0].freeze = false;
  state[1].freeze = false;

  document.getElementById('startBtn').textContent = '▶ Start mic';
  document.querySelectorAll('.gen-freeze').forEach((btn) => {
    btn.disabled = true;
    btn.classList.remove('active');
  });
  document.getElementById('status').textContent = 'idle';
  drawGenVizEmpty(0);
  drawGenVizEmpty(1);
}

document.getElementById('startBtn').addEventListener('click', () => {
  started ? stop() : start();
});

buildUI();
buildFxUI();
