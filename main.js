// grnsh — main thread: mic capture, worklet setup, UI wiring.

let audioCtx = null;
let node = null;
let micStream = null;
let granularInputSource = null;
let started = false;
let granularModulePromise = null;
let bitReducerModulePromise = null;
const LIVE_SOURCE_SECONDS = 10;
const MAX_DELAY_SECONDS = 16;
const BPM_BOUNDS = { min: 40, max: 240, step: 1 };
const TRANSPORT = { bpm: 120 };
const TEMPO_SYNC_STEPS = [
  { label: '1/16', beats: 0.25 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/8', beats: 0.5 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/4', beats: 1 },
  { label: '1/2', beats: 2 },
  { label: '1B', beats: 4 },
  { label: '2B', beats: 8 },
];
const REC = {
  isRecording: false,
  left: [],
  right: [],
  sampleCount: 0,
  processor: null,
  sink: null,
};
const PRESET_STORAGE_KEY = 'grnsh-presets-v1';
const PRESET_SLOT_COUNT = 4;
let presetSaveArmed = false;
let presetStore = Array.from({ length: PRESET_SLOT_COUNT }, () => null);

function getStatusEl() {
  return document.getElementById('status');
}

function getRecordBtn() {
  return document.getElementById('recordBtn');
}

function getPresetSaveBtn() {
  return document.getElementById('presetSaveBtn');
}

function getPresetSlotsEl() {
  return document.getElementById('presetSlots');
}

function getBpmInput() {
  return document.getElementById('bpmInput');
}

function setStatus(text) {
  const status = getStatusEl();
  if (status) status.textContent = text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function quantize(value, step, decimals) {
  return parseFloat((Math.round(value / step) * step).toFixed(decimals));
}

function formatNumericValue(value, decimals) {
  return parseFloat(value.toFixed(decimals));
}

function formatControlValue(spec, value) {
  const decimals = (spec.step.toString().split('.')[1] || '').length;
  return `${formatNumericValue(value, decimals)}${spec.unit ? ' ' + spec.unit : ''}`;
}

function getTempoStep(syncIndex) {
  const index = clamp(Math.round(syncIndex), 0, TEMPO_SYNC_STEPS.length - 1);
  return TEMPO_SYNC_STEPS[index];
}

function beatsToSeconds(beats) {
  return (60 / TRANSPORT.bpm) * beats;
}

function formatTempoSeconds(seconds) {
  const decimals = seconds >= 10 ? 1 : 2;
  return `${formatNumericValue(seconds, decimals)}s`;
}

function formatTempoSyncValue(syncIndex, suffix) {
  const step = getTempoStep(syncIndex);
  return `${step.label} ${suffix(step)}`;
}

function getDelayTimeSeconds() {
  return clamp(
    FX.delay.sync ? beatsToSeconds(getTempoStep(FX.delay.syncIndex).beats) : FX.delay.time,
    0,
    MAX_DELAY_SECONDS,
  );
}

function getLfoRateHz(lfo) {
  return lfo.sync ? 1 / beatsToSeconds(getTempoStep(lfo.syncIndex).beats) : lfo.rate;
}

function refreshRecordButton() {
  const btn = getRecordBtn();
  if (!btn) return;
  btn.classList.toggle('active', REC.isRecording);
  btn.textContent = REC.isRecording ? 'Stop Rec' : 'Rec';
}

function mergeFloat32(chunks, sampleCount) {
  const merged = new Float32Array(sampleCount);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
}

function encodeWav(left, right, sampleRate) {
  const frameCount = Math.min(left.length, right.length);
  const bytesPerSample = 2;
  const blockAlign = 2 * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(offset + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    offset += 4;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function downloadRecording(blob) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `grnsh-${stamp}.wav`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadPresetStore() {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      presetStore = Array.from({ length: PRESET_SLOT_COUNT }, (_, i) => parsed[i] || null);
    }
  } catch (e) {}
}

function savePresetStore() {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presetStore));
  } catch (e) {}
}

function getStartBtn() {
  return document.getElementById('startBtn');
}

function getIdleStartButtonLabel() {
  return anyMicSourceSelected() ? '▶ Start mic' : '▶ Start';
}

function createGranularSourceState() {
  return {
    mode: 'mic',
    durationSec: LIVE_SOURCE_SECONDS,
    fileName: '',
    bufferData: null,
  };
}

async function ensureAudioEngine() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    await ensureFxModules();
    buildFxNodes();
    buildGen3Nodes();
    fx.output.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!gen3ScopeFrame) startGen3Scope();
  if (!lfoAnimFrame) startLFOLoop();
  if (!started) setStatus('gen3 ready');
}

async function ensureFxModules() {
  if (!audioCtx) return;
  if (!bitReducerModulePromise) {
    bitReducerModulePromise = audioCtx.audioWorklet.addModule('bit-reducer-processor.js');
  }
  await bitReducerModulePromise;
}

async function ensureGranularModule() {
  if (!audioCtx) await ensureAudioEngine();
  if (!granularModulePromise) {
    granularModulePromise = audioCtx.audioWorklet.addModule('granular-processor.js');
  }
  await granularModulePromise;
}

async function startRecording() {
  if (REC.isRecording) return;
  await ensureAudioEngine();
  if (!fx?.output || !audioCtx) return;

  REC.left = [];
  REC.right = [];
  REC.sampleCount = 0;

  const processor = audioCtx.createScriptProcessor(4096, 2, 2);
  const sink = audioCtx.createGain();
  sink.gain.value = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer;
    const output = e.outputBuffer;
    const inL = input.getChannelData(0);
    const inR = input.numberOfChannels > 1 ? input.getChannelData(1) : inL;
    output.getChannelData(0).set(inL);
    output.getChannelData(1).set(inR);
    REC.left.push(new Float32Array(inL));
    REC.right.push(new Float32Array(inR));
    REC.sampleCount += inL.length;
  };

  fx.output.connect(processor);
  processor.connect(sink);
  sink.connect(audioCtx.destination);

  REC.processor = processor;
  REC.sink = sink;
  REC.isRecording = true;
  refreshRecordButton();
  setStatus('recording');
}

function stopRecording() {
  if (!REC.isRecording) return;

  if (REC.processor && fx?.output) {
    try {
      fx.output.disconnect(REC.processor);
    } catch (e) {}
  }
  if (REC.processor) {
    try {
      REC.processor.disconnect();
    } catch (e) {}
    REC.processor.onaudioprocess = null;
  }
  if (REC.sink) {
    try {
      REC.sink.disconnect();
    } catch (e) {}
  }

  const left = mergeFloat32(REC.left, REC.sampleCount);
  const right = mergeFloat32(REC.right, REC.sampleCount);
  if (REC.sampleCount > 0 && audioCtx) {
    downloadRecording(encodeWav(left, right, audioCtx.sampleRate));
  }

  REC.left = [];
  REC.right = [];
  REC.sampleCount = 0;
  REC.processor = null;
  REC.sink = null;
  REC.isRecording = false;
  refreshRecordButton();
  setStatus(started ? getGranularStatusText() : audioCtx ? 'gen3 ready' : 'idle');
}

// ─── Visualizer (per-generator) ────────────────────────────────────────────

const genVizCanvases = [null, null, null];
const genVizCtxs = [null, null, null];
const genVizW = [0, 0, 0];
const genVizH = [0, 0, 0];
const genVizStates = [0, 1].map(() => ({
  seeded: false,
  frozen: false,
  currentPosX: 1,
  targetPosX: 1,
  currentSprayNorm: 0,
  targetSprayNorm: 0,
  currentPeak: null,
  targetPeak: null,
  currentTeal: null,
  targetTeal: null,
  currentBass: null,
  targetBass: null,
  scratchPeak: null,
  scratchTeal: null,
  scratchBass: null,
}));
let genVizFrame = null;

const GEN_VIZ = [
  { line: '#3cb870', spray: 'rgba(60,184,112,0.12)' },
  { line: '#8b6ed4', spray: 'rgba(139,110,212,0.12)' },
];
const GEN_VIZ_SMOOTH = { attack: 0.38, release: 0.16, motion: 0.24 };
const GEN_VIZ_VIEW = { zoomOut: 3.2, peakMix: 0.6, rmsMix: 0.4 };

function normParam(value, min, max) {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function drawGenParamFeedback(c, gi, W, H, cx, sw) {
  const params = getEffectiveGeneratorParams(gi);
  if (!params) return;
  const densityNorm = normParam(params.density, 1, 100);
  const grainNorm = normParam(params.grainSizeMs, 5, 500);
  const spreadNorm = normParam(params.spread, 0, 1);
  const gainNorm = normParam(params.gain, 0, 2);
  const jitterNorm = normParam(params.pitchJitter, 0, 12);
  const pitchNorm = params.pitch / 24;
  const bodyHalf = 4 + grainNorm * 26;
  const stereoHalf = bodyHalf + 6 + spreadNorm * 26;
  const pitchLift = pitchNorm * (H * 0.18);
  const markerX = Math.round(cx) + 0.5;
  const centerY = H * 0.5 - pitchLift;
  const densityBars = 2 + Math.round(densityNorm * 6);
  const wingAlpha = 0.08 + gainNorm * 0.14;

  c.save();

  if (spreadNorm > 0.01) {
    const wing = c.createLinearGradient(cx - stereoHalf, 0, cx + stereoHalf, 0);
    wing.addColorStop(0, 'rgba(0,0,0,0)');
    wing.addColorStop(0.5, `rgba(255,255,255,${wingAlpha})`);
    wing.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = wing;
    c.fillRect(cx - stereoHalf, centerY - 2.5, stereoHalf * 2, 5);
  }

  if (grainNorm > 0.01) {
    c.strokeStyle = `rgba(255,255,255,${0.08 + grainNorm * 0.14})`;
    c.lineWidth = 1;
    c.strokeRect(cx - bodyHalf, centerY - H * 0.28, bodyHalf * 2, H * 0.56);
  }

  if (sw > 0.5) {
    c.strokeStyle = `rgba(255,255,255,${0.06 + normParam(params.spraySec, 0, 2) * 0.16})`;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(cx - sw, centerY);
    c.lineTo(cx, centerY);
    c.stroke();
  }

  if (jitterNorm > 0.01) {
    c.strokeStyle = `rgba(255,255,255,${0.08 + jitterNorm * 0.16})`;
    c.lineWidth = 1;
    c.setLineDash([1.5, 2.5]);
    c.beginPath();
    c.moveTo(cx - bodyHalf - jitterNorm * 14, centerY - H * 0.18);
    c.lineTo(cx + bodyHalf + jitterNorm * 14, centerY - H * 0.18);
    c.moveTo(cx - bodyHalf - jitterNorm * 14, centerY + H * 0.18);
    c.lineTo(cx + bodyHalf + jitterNorm * 14, centerY + H * 0.18);
    c.stroke();
    c.setLineDash([]);
  }

  c.strokeStyle = `rgba(255,255,255,${0.16 + gainNorm * 0.18})`;
  c.lineWidth = 1;
  for (let i = 0; i < densityBars; i++) {
    const t = densityBars === 1 ? 0.5 : i / (densityBars - 1);
    const x = cx - bodyHalf + t * bodyHalf * 2;
    c.beginPath();
    c.moveTo(x, centerY - 4 - densityNorm * 6);
    c.lineTo(x, centerY + 4 + densityNorm * 6);
    c.stroke();
  }

  if (Math.abs(pitchNorm) > 0.01) {
    c.fillStyle = `rgba(255,255,255,${0.16 + Math.abs(pitchNorm) * 0.22})`;
    c.beginPath();
    if (pitchNorm > 0) {
      c.moveTo(cx, centerY - H * 0.24 - 5);
      c.lineTo(cx - 4, centerY - H * 0.24 + 1);
      c.lineTo(cx + 4, centerY - H * 0.24 + 1);
    } else {
      c.moveTo(cx, centerY + H * 0.24 + 5);
      c.lineTo(cx - 4, centerY + H * 0.24 - 1);
      c.lineTo(cx + 4, centerY + H * 0.24 - 1);
    }
    c.closePath();
    c.fill();
  }

  c.strokeStyle = GEN_VIZ[gi].line;
  c.lineWidth = 1.5 + gainNorm * 1.5;
  c.beginPath();
  c.moveTo(markerX, centerY - H * 0.34);
  c.lineTo(markerX, centerY + H * 0.34);
  c.stroke();

  c.restore();
}

function drawGenVizEmpty(gi) {
  const c = genVizCtxs[gi],
    W = genVizW[gi],
    H = genVizH[gi];
  if (!c || !W || !H) return;
  c.fillStyle = '#141414';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#252525';
  c.fillRect(0, H / 2 - 0.5, W, 1);
}

function ensureGenVizState(gi) {
  const state = genVizStates[gi];
  const W = genVizW[gi];
  if (!W) return null;
  if (state.targetPeak && state.targetPeak.length === W) return state;
  state.currentPeak = new Float32Array(W);
  state.targetPeak = new Float32Array(W);
  state.currentTeal = new Float32Array(W);
  state.targetTeal = new Float32Array(W);
  state.currentBass = new Float32Array(W);
  state.targetBass = new Float32Array(W);
  state.scratchPeak = new Float32Array(W);
  state.scratchTeal = new Float32Array(W);
  state.scratchBass = new Float32Array(W);
  state.seeded = false;
  return state;
}

function resetGenVizState(gi) {
  const state = genVizStates[gi];
  state.seeded = false;
  state.frozen = false;
  state.currentPosX = 1;
  state.targetPosX = 1;
  state.currentSprayNorm = 0;
  state.targetSprayNorm = 0;
  state.currentPeak = null;
  state.targetPeak = null;
  state.currentTeal = null;
  state.targetTeal = null;
  state.currentBass = null;
  state.targetBass = null;
  state.scratchPeak = null;
  state.scratchTeal = null;
  state.scratchBass = null;
}

function updateGenVizState(gi, { waveform, posX, sprayNorm, frozen }) {
  const state = ensureGenVizState(gi);
  const W = genVizW[gi],
    H = genVizH[gi];
  if (!state || !W || !H) return;
  const N = waveform.length;
  const maxH = H * 0.48;

  state.frozen = frozen;
  state.targetPosX = posX;
  state.targetSprayNorm = sprayNorm;
  state.targetPeak.fill(0);
  state.targetTeal.fill(0);
  state.targetBass.fill(0);
  const binWidth = N / W;
  const halfExtra = Math.max(1, Math.floor(binWidth * (GEN_VIZ_VIEW.zoomOut - 1) * 0.5));

  for (let x = 0; x < W; x++) {
    const i0 = Math.max(0, Math.floor((x * N) / W) - halfExtra);
    const i1 = Math.min(N - 1, Math.floor(((x + 1) * N) / W) + 1 + halfExtra);
    const n = Math.max(1, i1 - i0 + 1);
    let peak = 0,
      sumAbs = 0;
    for (let i = i0; i <= i1; i++) {
      const v = Math.abs(waveform[i]);
      if (v > peak) peak = v;
      sumAbs += v;
    }
    if (peak < 0.001) continue;
    const rms = sumAbs / n;
    const body = peak * GEN_VIZ_VIEW.peakMix + rms * GEN_VIZ_VIEW.rmsMix;
    const p = Math.pow(body, 0.68) * maxH;
    state.targetPeak[x] = p;
    state.targetTeal[x] = p * 0.68;
    state.targetBass[x] = Math.min(Math.pow(rms, 0.65) * maxH * 1.4, p * 0.48);
  }

  for (let x = 0; x < W; x++) {
    const left = x > 0 ? x - 1 : x;
    const right = x < W - 1 ? x + 1 : x;
    state.scratchPeak[x] =
      state.targetPeak[left] * 0.22 + state.targetPeak[x] * 0.56 + state.targetPeak[right] * 0.22;
    state.scratchTeal[x] =
      state.targetTeal[left] * 0.22 + state.targetTeal[x] * 0.56 + state.targetTeal[right] * 0.22;
    state.scratchBass[x] =
      state.targetBass[left] * 0.22 + state.targetBass[x] * 0.56 + state.targetBass[right] * 0.22;
  }
  state.targetPeak.set(state.scratchPeak);
  state.targetTeal.set(state.scratchTeal);
  state.targetBass.set(state.scratchBass);

  if (!state.seeded) {
    state.currentPeak.set(state.targetPeak);
    state.currentTeal.set(state.targetTeal);
    state.currentBass.set(state.targetBass);
    state.currentPosX = state.targetPosX;
    state.currentSprayNorm = state.targetSprayNorm;
    state.seeded = true;
  }
}

function stepGenVizState(gi) {
  const state = genVizStates[gi];
  if (!state.seeded || !state.currentPeak) return;
  const { attack, release, motion } = GEN_VIZ_SMOOTH;

  for (let x = 0; x < state.currentPeak.length; x++) {
    const peakTarget = state.targetPeak[x];
    const tealTarget = state.targetTeal[x];
    const bassTarget = state.targetBass[x];

    state.currentPeak[x] +=
      (peakTarget - state.currentPeak[x]) * (peakTarget > state.currentPeak[x] ? attack : release);
    state.currentTeal[x] +=
      (tealTarget - state.currentTeal[x]) * (tealTarget > state.currentTeal[x] ? attack : release);
    state.currentBass[x] +=
      (bassTarget - state.currentBass[x]) * (bassTarget > state.currentBass[x] ? attack : release);
  }

  state.currentPosX += (state.targetPosX - state.currentPosX) * motion;
  state.currentSprayNorm += (state.targetSprayNorm - state.currentSprayNorm) * motion;
}

function renderGenViz(gi) {
  const c = genVizCtxs[gi],
    W = genVizW[gi],
    H = genVizH[gi];
  if (!c || !W || !H) return;
  const state = genVizStates[gi];
  if (!state.seeded || !state.currentPeak) {
    drawGenVizEmpty(gi);
    return;
  }
  const col = GEN_VIZ[gi];
  const mid = H / 2;

  // Background
  c.fillStyle = state.frozen ? '#131824' : '#141414';
  c.fillRect(0, 0, W, H);

  // Spray band (behind waveform)
  const cx = state.currentPosX * W;
  const sw = state.currentSprayNorm * W;
  if (sw > 0) {
    const g = c.createLinearGradient(cx - sw, 0, cx, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, col.spray);
    c.fillStyle = g;
    c.fillRect(cx - sw, 0, sw, H);
  }

  // Outer layer
  c.shadowBlur = 10;
  c.shadowColor = state.frozen ? 'rgba(122, 144, 178, 0.28)' : 'rgba(122, 150, 176, 0.22)';
  c.fillStyle = state.frozen ? '#5c7091' : '#738ea8';
  c.beginPath();
  for (let x = 0; x < W; x++) {
    if (state.currentPeak[x] > 0.5)
      c.rect(x, mid - state.currentPeak[x], 1, state.currentPeak[x] * 2);
  }
  c.fill();

  // Mid layer
  c.shadowBlur = 8;
  c.shadowColor = state.frozen ? 'rgba(92, 148, 143, 0.22)' : 'rgba(88, 172, 160, 0.2)';
  c.fillStyle = state.frozen ? '#3f6f6c' : '#329487';
  c.beginPath();
  for (let x = 0; x < W; x++) {
    if (state.currentTeal[x] > 0.5)
      c.rect(x, mid - state.currentTeal[x], 1, state.currentTeal[x] * 2);
  }
  c.fill();

  // Inner layer (RMS-based, represents sustained low-freq content)
  c.shadowBlur = 6;
  c.shadowColor = state.frozen ? 'rgba(155, 130, 82, 0.18)' : 'rgba(198, 160, 88, 0.16)';
  c.fillStyle = state.frozen ? '#8b7041' : '#b28b47';
  c.beginPath();
  for (let x = 0; x < W; x++) {
    if (state.currentBass[x] > 0.5)
      c.rect(x, mid - state.currentBass[x], 1, state.currentBass[x] * 2);
  }
  c.fill();

  // Peak caps (1px line at top and bottom of each column)
  c.shadowBlur = 14;
  c.shadowColor = state.frozen ? 'rgba(196, 210, 228, 0.3)' : 'rgba(222, 232, 240, 0.24)';
  c.fillStyle = state.frozen ? 'rgba(190, 204, 224, 0.54)' : 'rgba(211, 226, 237, 0.72)';
  c.beginPath();
  for (let x = 0; x < W; x++) {
    if (state.currentPeak[x] > 2) {
      c.rect(x, mid - state.currentPeak[x], 1, 1);
      c.rect(x, mid + state.currentPeak[x] - 1, 1, 1);
    }
  }
  c.fill();
  c.shadowBlur = 0;

  // Center line
  c.fillStyle = '#252525';
  c.fillRect(0, mid - 0.5, W, 1);

  drawGenParamFeedback(c, gi, W, H, cx, sw);

  // Position marker
  c.strokeStyle = col.line;
  c.lineWidth = 1.5;
  c.setLineDash(state.frozen ? [4, 3] : []);
  c.beginPath();
  c.moveTo(Math.round(cx) + 0.5, 0);
  c.lineTo(Math.round(cx) + 0.5, H);
  c.stroke();
  c.setLineDash([]);

  // Write-head (hidden when frozen)
  if (!state.frozen) {
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(W - 0.5, 0);
    c.lineTo(W - 0.5, H);
    c.stroke();
  }

  // FROZEN label
  if (state.frozen) {
    c.fillStyle = 'rgba(120,150,230,0.75)';
    c.font = 'bold 8px ui-monospace, monospace';
    c.fillText('FROZEN', W - 47, 11);
  }
}

function genVizLoop() {
  for (let gi = 0; gi < 2; gi++) {
    stepGenVizState(gi);
    renderGenViz(gi);
  }
  genVizFrame = requestAnimationFrame(genVizLoop);
}

function startGenVizLoop() {
  if (!genVizFrame) genVizFrame = requestAnimationFrame(genVizLoop);
}

function stopGenVizLoop() {
  if (genVizFrame) {
    cancelAnimationFrame(genVizFrame);
    genVizFrame = null;
  }
}

function drawViz({ gens }) {
  gens.forEach((genData, gi) => updateGenVizState(gi, genData));
}

const PARAMS = [
  { key: 'grainSizeMs', label: 'Grain size', min: 5, max: 500, step: 1, unit: 'ms' },
  { key: 'density', label: 'Density', min: 1, max: 100, step: 1, unit: '/s' },
  { key: 'positionSec', label: 'Position', min: 0, max: 9, step: 0.01, unit: 's back' },
  { key: 'spraySec', label: 'Spray', min: 0, max: 2, step: 0.01, unit: 's' },
  { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, unit: 'st' },
  { key: 'pitchJitter', label: 'Pitch jitter', min: 0, max: 12, step: 0.5, unit: 'st' },
  { key: 'spread', label: 'Stereo spread', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'gain', label: 'Output gain', min: 0, max: 2, step: 0.01, unit: '' },
];

// Slightly different defaults for gen 1 so independence is immediately audible.
const GEN_DEFAULTS = [
  {
    grainSizeMs: 120,
    density: 20,
    positionSec: 0.5,
    spraySec: 0.05,
    pitch: 0,
    pitchJitter: 0,
    spread: 0.5,
    gain: 0.8,
    reverse: false,
    envType: 'hann',
    freeze: false,
  },
  {
    grainSizeMs: 80,
    density: 15,
    positionSec: 1.2,
    spraySec: 0.1,
    pitch: 7,
    pitchJitter: 2,
    spread: 0.7,
    gain: 0.6,
    reverse: false,
    envType: 'hann',
    freeze: false,
  },
];

const state = [{ ...GEN_DEFAULTS[0] }, { ...GEN_DEFAULTS[1] }];
const genControlBindings = [new Map(), new Map()];
const genMapBindings = [new Map(), new Map()];
const genFreezeButtons = [null, null];
const genReverseButtons = [null, null];
const genEnvButtons = [new Map(), new Map()];
const gen3ControlBindings = new Map();
const fxControlBindings = new Map();
const lfoControlBindings = [new Map(), new Map()];
const lfoShapeButtons = [new Map(), new Map()];
const lfoSyncModeControls = [null, null];
const gen3ShapeButtons = new Map();
const filterModeButtons = new Map();
let delaySyncModeControl = null;
const genSourceModeButtons = [new Map(), new Map()];
const POSITION_PARAM = PARAMS.find((p) => p.key === 'positionSec');
const GRANULAR_SOURCES = [createGranularSourceState(), createGranularSourceState()];
const GRAIN_ENV_TYPES = [
  ['hann', 'HAN'],
  ['triangle', 'TRI'],
  ['sharp', 'SHP'],
  ['soft', 'SFT'],
];

function getSourceState(genIdx) {
  return GRANULAR_SOURCES[genIdx];
}

function getGeneratorPositionMax(genIdx) {
  return Math.max(0.05, getSourceState(genIdx)?.durationSec || LIVE_SOURCE_SECONDS);
}

function getParamBounds(genIdx, key) {
  const base = PARAMS.find((p) => p.key === key);
  if (!base) return null;
  if (key !== 'positionSec') return base;
  return { ...base, max: getGeneratorPositionMax(genIdx) };
}

function setSourceDurationSec(genIdx, durationSec) {
  const source = getSourceState(genIdx);
  if (!source) return;
  source.durationSec = Math.max(0.05, durationSec || LIVE_SOURCE_SECONDS);
  const bounds = getParamBounds(genIdx, 'positionSec');
  const clamped = Math.max(bounds.min, Math.min(bounds.max, state[genIdx].positionSec));
  state[genIdx].positionSec = clamped;
  genControlBindings[genIdx].get('positionSec')?.setConfig({ min: bounds.min, max: bounds.max });
  genControlBindings[genIdx].get('positionSec')?.setValue(clamped);
  const posX = Math.max(0, Math.min(1, 1 - clamped / Math.max(0.001, source.durationSec)));
  const vizState = genVizStates[genIdx];
  vizState.targetPosX = posX;
  if (!vizState.seeded) vizState.currentPosX = posX;
}

function clearFreezeStates({ send = true } = {}) {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    state[genIdx].freeze = false;
    genFreezeButtons[genIdx]?.classList.remove('active');
    if (send) sendParams(genIdx);
  }
}

function anyMicSourceSelected() {
  return GRANULAR_SOURCES.some((source) => source.mode === 'mic');
}

function canFreezeGenerator(genIdx) {
  return started && getSourceState(genIdx)?.mode === 'mic';
}

function getGranularStatusText() {
  const micCount = granularInputSource
    ? GRANULAR_SOURCES.filter((source) => source.mode === 'mic').length
    : 0;
  const fileSources = GRANULAR_SOURCES.filter(
    (source) => source.mode === 'file' && source.bufferData,
  );
  if (fileSources.length === 2) return '2 file sources';
  if (fileSources.length === 1 && micCount === 0) return `file: ${fileSources[0].fileName}`;
  if (fileSources.length > 0 && micCount > 0) return 'mic + file';
  if (micCount > 0) return 'running';
  return 'running';
}

function refreshSourceModeUI(genIdx) {
  const mode = getSourceState(genIdx).mode;
  genSourceModeButtons[genIdx].forEach((btn, key) => {
    btn.classList.toggle('active', mode === key);
    btn.classList.toggle('loaded', key === 'file' && !!getSourceState(genIdx).bufferData);
  });
  if (!started) getStartBtn().textContent = getIdleStartButtonLabel();
}

function setGranularRunning() {
  started = true;
  getStartBtn().textContent = '■ Stop';
  refreshGeneratorUI(0);
  refreshGeneratorUI(1);
  startLFOLoop();
  startGenVizLoop();
  setStatus(getGranularStatusText());
}

function setGeneratorParam(genIdx, key, value, { send = true } = {}) {
  const param = getParamBounds(genIdx, key);
  if (!param) return;
  const next = Math.max(param.min, Math.min(param.max, value));
  state[genIdx][key] = next;
  genControlBindings[genIdx].get(key)?.setValue(next);
  if (key === 'positionSec') {
    const posX = Math.max(
      0,
      Math.min(1, 1 - next / Math.max(0.001, getGeneratorPositionMax(genIdx))),
    );
    const vizState = genVizStates[genIdx];
    vizState.targetPosX = posX;
    if (!vizState.seeded) vizState.currentPosX = posX;
  }
  if (send) sendParams(genIdx);
}

function getEffectiveGeneratorParams(genIdx) {
  const effective = { ...state[genIdx] };
  if (lfoMappings.size > 0) {
    lfoMappings.forEach(({ genIdx: gi, key, lfoIdx }) => {
      if (gi !== genIdx) return;
      const lfo = LFOS[lfoIdx];
      const paramDef = getParamBounds(genIdx, key);
      if (!lfo) return;
      const scaled = lfo.currentValue * lfo.depth;
      const half = (paramDef.max - paramDef.min) * 0.5;
      effective[key] = Math.max(
        paramDef.min,
        Math.min(paramDef.max, effective[key] + scaled * half),
      );
    });
  }
  return effective;
}

function sendParams(genIdx) {
  if (!node) return;
  const effective = getEffectiveGeneratorParams(genIdx);
  node.port.postMessage({ type: 'params', gen: genIdx, value: effective });
}

function refreshGeneratorUI(genIdx) {
  PARAMS.forEach(({ key }) => {
    genControlBindings[genIdx].get(key)?.setValue(state[genIdx][key]);
  });
  genFreezeButtons[genIdx]?.classList.toggle('active', !!state[genIdx].freeze);
  if (genFreezeButtons[genIdx]) {
    genFreezeButtons[genIdx].disabled = !canFreezeGenerator(genIdx);
  }
  genReverseButtons[genIdx]?.classList.toggle('active', !!state[genIdx].reverse);
  genEnvButtons[genIdx].forEach((btn, envType) => {
    btn.classList.toggle('active', state[genIdx].envType === envType);
  });
}

function refreshLFOMappingUI() {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    PARAMS.forEach(({ key }) => {
      const mapping = lfoMappings.get(`${genIdx}:${key}`);
      genMapBindings[genIdx].get(key)?.setMapLFO(mapping ? mapping.lfoIdx : null);
    });
  }
}

function setLFOLedState(led, lfoIdx) {
  led.classList.remove('active', 'lfo-1', 'lfo-2');
  led.dataset.lfo = '';
  led.textContent = '';
  led.title = 'Map: unset';
  if (lfoIdx === null) return;
  led.classList.add('active', `lfo-${lfoIdx + 1}`);
  led.dataset.lfo = `${lfoIdx + 1}`;
  led.textContent = `${lfoIdx + 1}`;
  led.title = `Map: LFO ${lfoIdx + 1}`;
}

function makeControlRow(p, initialValue, onInput, lfoCycle = null) {
  let spec = { ...p };
  let formatter = null;
  let currentValue = initialValue;
  const row = document.createElement('div');
  row.className = 'control';

  const valueEl = document.createElement('span');
  valueEl.className = 'value';

  const renderValue = (value) => {
    currentValue = value;
    valueEl.textContent = (formatter || ((v) => formatControlValue(spec, v)))(value);
  };

  renderValue(initialValue);

  const knob = makeKnob(p, initialValue, (v) => {
    renderValue(v);
    onInput(v);
  });

  const label = document.createElement('label');
  label.textContent = p.label;
  let led = null;

  if (lfoCycle !== null) {
    led = document.createElement('button');
    led.className = 'lfo-led';
    led.type = 'button';
    setLFOLedState(led, null);
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      setLFOLedState(led, lfoCycle());
    });
    row.append(knob, led, label, valueEl);
  } else {
    row.append(knob, label, valueEl);
  }
  row.setValue = (v) => {
    renderValue(v);
    knob.setValue(v);
  };
  row.setConfig = (patch) => {
    spec = { ...spec, ...patch };
    knob.setConfig?.(patch);
    renderValue(currentValue);
  };
  row.setFormatter = (nextFormatter) => {
    formatter = nextFormatter || null;
    renderValue(currentValue);
  };
  row.setMapLFO = (lfoIdx) => {
    if (led) setLFOLedState(led, lfoIdx);
  };
  return row;
}

function buildSyncModeRow(isSync, onModeChange) {
  const row = document.createElement('div');
  row.className = 'fx-mode-row sync-mode-row';

  const buttons = new Map();
  [
    ['free', 'Free'],
    ['sync', 'Sync'],
  ].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.className = 'fx-mode-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => onModeChange(mode));
    buttons.set(mode, btn);
    row.appendChild(btn);
  });

  row.setMode = (mode) => {
    buttons.forEach((btn, key) => btn.classList.toggle('active', key === mode));
  };
  row.setMode(isSync ? 'sync' : 'free');
  return row;
}

function buildGeneratorReverseControl(genIdx) {
  const row = document.createElement('div');
  row.className = 'control gen-discrete-control gen-reverse-control';

  const btn = document.createElement('button');
  btn.className = 'gen-discrete-btn';
  btn.type = 'button';
  btn.textContent = 'REV';
  btn.addEventListener('click', () => {
    state[genIdx].reverse = !state[genIdx].reverse;
    refreshGeneratorUI(genIdx);
    sendParams(genIdx);
  });
  genReverseButtons[genIdx] = btn;

  const label = document.createElement('label');
  label.textContent = 'Reverse';

  row.append(btn, label);
  return row;
}

function buildGeneratorShapeControl(genIdx) {
  const row = document.createElement('div');
  row.className = 'control gen-discrete-control gen-shape-control';

  const buttons = document.createElement('div');
  buttons.className = 'gen-shape-buttons';
  GRAIN_ENV_TYPES.forEach(([envType, shortLabel]) => {
    const btn = document.createElement('button');
    btn.className = 'gen-discrete-btn gen-shape-btn';
    btn.type = 'button';
    btn.textContent = shortLabel;
    btn.addEventListener('click', () => {
      state[genIdx].envType = envType;
      refreshGeneratorUI(genIdx);
      sendParams(genIdx);
    });
    genEnvButtons[genIdx].set(envType, btn);
    buttons.appendChild(btn);
  });

  const label = document.createElement('label');
  label.textContent = 'Grain shape';

  row.append(buttons, label);
  return row;
}

// ─── Knob ──────────────────────────────────────────────────────────────────

function makeKnob(p, initialValue, onInput) {
  const NS = 'http://www.w3.org/2000/svg';
  const VB = 40,
    cx = 20,
    cy = 20,
    r = 15,
    sw = 3;
  const S = -135,
    E = 135; // 7 o'clock → 5 o'clock (270° sweep)
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  let spec = { resetValue: initialValue, ...p };
  let currentValue = initialValue;
  const getDecimals = () => (spec.step.toString().split('.')[1] || '').length;
  const toNorm = (v) => {
    const rawToNorm =
      spec.toNorm || ((value) => (value - spec.min) / Math.max(0.0001, spec.max - spec.min));
    return clamp01(rawToNorm(v));
  };
  const toValue = (n) => {
    const rawFromNorm =
      spec.fromNorm || ((value) => spec.min + clamp01(value) * (spec.max - spec.min));
    return parseFloat((Math.round(rawFromNorm(n) / spec.step) * spec.step).toFixed(getDecimals()));
  };

  function polar(deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }
  function arc(a, b) {
    if (b - a < 0.5) return '';
    const [sx, sy] = polar(a),
      [ex, ey] = polar(b);
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
  body.setAttribute('cx', cx);
  body.setAttribute('cy', cy);
  body.setAttribute('r', r - 5);
  body.classList.add('knob-body');

  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', '2');
  dot.classList.add('knob-dot');

  svg.append(track, valArc, body, dot);

  let norm = toNorm(initialValue);

  function renderNorm(n) {
    norm = clamp01(n);
    const deg = S + norm * (E - S);
    valArc.setAttribute('d', norm < 0.005 ? '' : arc(S, deg));
    const dr = r - sw / 2 - 1.5,
      rad = ((deg - 90) * Math.PI) / 180;
    dot.setAttribute('cx', (cx + dr * Math.cos(rad)).toFixed(2));
    dot.setAttribute('cy', (cy + dr * Math.sin(rad)).toFixed(2));
  }

  function renderValue(v) {
    currentValue = Math.max(spec.min, Math.min(spec.max, v));
    renderNorm(toNorm(currentValue));
  }

  renderNorm(norm);

  // Drag (up = increase, Shift = fine)
  let y0 = 0,
    n0 = 0;
  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    y0 = e.clientY;
    n0 = norm;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('knob--drag');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!svg.hasPointerCapture(e.pointerId)) return;
    const n = clamp01(n0 + (y0 - e.clientY) * (e.shiftKey ? 0.001 : 0.004));
    renderNorm(n);
    currentValue = toValue(n);
    onInput(currentValue);
  });
  svg.addEventListener('pointerup', () => svg.classList.remove('knob--drag'));

  // Scroll wheel — one step per tick
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const n = clamp01(
        norm - (Math.sign(e.deltaY) * spec.step) / Math.max(0.0001, spec.max - spec.min),
      );
      renderNorm(n);
      currentValue = toValue(n);
      onInput(currentValue);
    },
    { passive: false },
  );

  // Double-click to reset to initial value
  svg.addEventListener('dblclick', () => {
    const resetValue = typeof spec.resetValue === 'number' ? spec.resetValue : initialValue;
    renderValue(resetValue);
    onInput(Math.max(spec.min, Math.min(spec.max, resetValue)));
  });

  svg.setValue = (v) => renderValue(v);
  svg.setConfig = (patch) => {
    spec = { ...spec, ...patch };
    renderValue(currentValue);
  };
  return svg;
}

function buildGeneratorPanel(genIdx) {
  const defaults = GEN_DEFAULTS[genIdx];
  const panel = document.createElement('div');
  panel.className = `generator gen-${genIdx}`;
  panel.classList.add('source-drop-target');

  // Column header
  const header = document.createElement('div');
  header.className = 'col-header';

  const title = document.createElement('span');
  title.className = 'col-title';
  title.innerHTML = `<span class="col-dot"></span>Gen ${genIdx + 1}`;

  const sourceRow = document.createElement('div');
  sourceRow.className = 'source-mode-row';
  [
    ['mic', 'Mic'],
    ['file', 'File'],
  ].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.className = 'source-mode-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      await setGeneratorSourceMode(genIdx, mode);
    });
    genSourceModeButtons[genIdx].set(mode, btn);
    sourceRow.appendChild(btn);
  });

  const freezeBtn = document.createElement('button');
  freezeBtn.className = 'gen-freeze';
  freezeBtn.textContent = 'Freeze ❄︎';
  freezeBtn.disabled = true;
  freezeBtn.addEventListener('click', () => {
    state[genIdx].freeze = !state[genIdx].freeze;
    freezeBtn.classList.toggle('active', state[genIdx].freeze);
    sendParams(genIdx);
  });
  genFreezeButtons[genIdx] = freezeBtn;

  const headerActions = document.createElement('div');
  headerActions.className = 'gen-header-actions';
  headerActions.append(sourceRow, freezeBtn);

  header.append(title, headerActions);
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
    vizCanvas.width = genVizW[genIdx] * dpr;
    vizCanvas.height = genVizH[genIdx] * dpr;
    genVizCtxs[genIdx].setTransform(dpr, 0, 0, dpr, 0, 0);
    resetGenVizState(genIdx);
    drawGenVizEmpty(genIdx);
  }).observe(vizCanvas);
  const updatePositionFromPointer = (clientX) => {
    const rect = vizCanvas.getBoundingClientRect();
    const normX = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const bounds = getParamBounds(genIdx, 'positionSec');
    const next = bounds.min + (1 - normX) * (bounds.max - bounds.min);
    setGeneratorParam(genIdx, 'positionSec', next);
  };
  vizCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    vizCanvas.setPointerCapture(e.pointerId);
    vizCanvas.classList.add('dragging');
    updatePositionFromPointer(e.clientX);
  });
  vizCanvas.addEventListener('pointermove', (e) => {
    if (!vizCanvas.hasPointerCapture(e.pointerId)) return;
    updatePositionFromPointer(e.clientX);
  });
  const endDrag = (e) => {
    if (vizCanvas.hasPointerCapture(e.pointerId)) vizCanvas.releasePointerCapture(e.pointerId);
    vizCanvas.classList.remove('dragging');
  };
  vizCanvas.addEventListener('pointerup', endDrag);
  vizCanvas.addEventListener('pointercancel', endDrag);
  panel.appendChild(vizCanvas);

  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'source-drop-overlay';
  dropOverlay.textContent = 'Drop WAV Source';
  panel.appendChild(dropOverlay);

  let dragDepth = 0;
  const clearDrag = () => {
    dragDepth = 0;
    panel.classList.remove('drag-over');
  };
  const hasFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  ['dragenter', 'dragover'].forEach((eventName) => {
    panel.addEventListener(eventName, (e) => {
      if (!hasFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (eventName === 'dragenter') dragDepth += 1;
      panel.classList.add('drag-over');
    });
  });
  panel.addEventListener('dragleave', (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) panel.classList.remove('drag-over');
  });
  panel.addEventListener('drop', async (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    clearDrag();
    const file = [...(e.dataTransfer?.files || [])].find((f) => isSupportedGranularFile(f));
    if (!file) {
      setStatus('drop a .wav file');
      return;
    }
    await loadGranularFile(genIdx, file);
  });

  // Control rows
  const rows = document.createElement('div');
  rows.className = 'gen-controls';
  PARAMS.forEach((p) => {
    const control = makeControlRow(
      p,
      defaults[p.key],
      (v) => setGeneratorParam(genIdx, p.key, v),
      () => cycleLFOMap(genIdx, p.key),
    );
    genControlBindings[genIdx].set(p.key, control);
    genMapBindings[genIdx].set(p.key, control);
    rows.appendChild(control);
  });
  rows.appendChild(buildGeneratorReverseControl(genIdx));
  rows.appendChild(buildGeneratorShapeControl(genIdx));

  panel.appendChild(rows);
  refreshGeneratorUI(genIdx);
  refreshSourceModeUI(genIdx);
  return panel;
}

function buildUI() {
  const container = document.getElementById('generators');
  container.appendChild(buildGeneratorPanel(0));
  container.appendChild(buildGeneratorPanel(1));
  container.appendChild(buildOscPanel());
}

// ─── Gen 3: Oscillator ─────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// C1–B5 (MIDI 24–83), highest first so piano roll reads top=high
const OSC_NOTES = [];
for (let m = 83; m >= 24; m--) {
  const oct = Math.floor(m / 12) - 1;
  const name = NOTE_NAMES[m % 12];
  OSC_NOTES.push({
    midi: m,
    label: `${name}${oct}`,
    freq: 440 * Math.pow(2, (m - 69) / 12),
    isBlack: [1, 3, 6, 8, 10].includes(m % 12),
    isC: m % 12 === 0,
  });
}
const OSC_NOTE_GRID = Array.from(
  OSC_NOTES.reduce((octaves, note) => {
    const oct = Math.floor(note.midi / 12) - 1;
    if (!octaves.has(oct)) octaves.set(oct, []);
    octaves.get(oct).push(note);
    return octaves;
  }, new Map()),
)
  .sort((a, b) => b[0] - a[0])
  .map(([octave, notes]) => ({ octave, notes: notes.slice().reverse() }));

// activeNotes: Map<midi, { freq, source, envelope }>
const GEN3 = {
  type: 'sine',
  gain: 0.5,
  detune: 0,
  attack: 0.3,
  decay: 0.18,
  sustain: 0.7,
  release: 0.5,
  activeNotes: new Map(),
  releasingVoices: new Set(),
  nodes: null,
};
let gen3ScopeFrame = null;
const gen3NoteEls = new Map();

function setGen3NoteActive(midi, active) {
  gen3NoteEls.get(midi)?.classList.toggle('active', active);
}

function buildGen3Nodes() {
  const ac = audioCtx;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(GEN3.gain, ac.currentTime);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  gain.connect(analyser);
  analyser.connect(fx.input);
  GEN3.nodes = { gain, analyser };
}

function clearGen3ReleaseTimer(voice) {
  if (!voice?.releaseTimer) return;
  clearTimeout(voice.releaseTimer);
  voice.releaseTimer = null;
}

function stopGen3Voice(voice) {
  if (!voice) return;
  clearGen3ReleaseTimer(voice);
  if (voice.source) {
    try {
      voice.source.stop();
    } catch (e) {}
    voice.source.disconnect();
    voice.source = null;
  }
  if (voice.envelope) {
    voice.envelope.disconnect();
    voice.envelope = null;
  }
}

function createGen3SourceNode(freq) {
  if (!GEN3.nodes) return null;
  const ac = audioCtx;
  let src;
  if (GEN3.type === 'noise') {
    const len = ac.sampleRate;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
  } else {
    src = ac.createOscillator();
    src.type = GEN3.type;
    src.frequency.setValueAtTime(freq, ac.currentTime);
    src.detune.setValueAtTime(GEN3.detune, ac.currentTime);
  }
  return src;
}

function applyGen3Envelope(envelope) {
  const now = audioCtx.currentTime;
  const attackEnd = now + GEN3.attack;
  const decayEnd = attackEnd + GEN3.decay;

  envelope.gain.cancelScheduledValues(now);
  envelope.gain.setValueAtTime(0, now);

  if (GEN3.attack > 0) envelope.gain.linearRampToValueAtTime(1, attackEnd);
  else envelope.gain.setValueAtTime(1, now);

  if (GEN3.decay > 0) envelope.gain.linearRampToValueAtTime(GEN3.sustain, decayEnd);
  else envelope.gain.setValueAtTime(GEN3.sustain, attackEnd);
}

function createGen3Voice(freq) {
  if (!GEN3.nodes) return { source: null, envelope: null, releaseTimer: null };
  const source = createGen3SourceNode(freq);
  const envelope = audioCtx.createGain();
  envelope.gain.setValueAtTime(0, audioCtx.currentTime);
  source.connect(envelope);
  envelope.connect(GEN3.nodes.gain);
  applyGen3Envelope(envelope);
  source.start();
  return { source, envelope, releaseTimer: null };
}

function releaseGen3Voice(voice) {
  if (!voice?.source || !voice.envelope || !audioCtx) {
    stopGen3Voice(voice);
    return;
  }

  const now = audioCtx.currentTime;
  const stopAfterMs = Math.max(0, GEN3.release * 1000) + 60;

  clearGen3ReleaseTimer(voice);
  if (voice.envelope.gain.cancelAndHoldAtTime) {
    voice.envelope.gain.cancelAndHoldAtTime(now);
  } else {
    voice.envelope.gain.cancelScheduledValues(now);
    voice.envelope.gain.setValueAtTime(Math.max(voice.envelope.gain.value, 0.0001), now);
  }

  if (GEN3.release > 0) voice.envelope.gain.linearRampToValueAtTime(0, now + GEN3.release);
  else voice.envelope.gain.setValueAtTime(0, now);

  GEN3.releasingVoices.add(voice);
  voice.releaseTimer = setTimeout(() => {
    GEN3.releasingVoices.delete(voice);
    stopGen3Voice(voice);
  }, stopAfterMs);
}

function addGen3Note(midi, freq) {
  const entry = { freq, ...createGen3Voice(freq) };
  GEN3.activeNotes.set(midi, entry);
  setGen3NoteActive(midi, true);
}

function removeGen3Note(midi) {
  const entry = GEN3.activeNotes.get(midi);
  GEN3.activeNotes.delete(midi);
  setGen3NoteActive(midi, false);
  if (entry) releaseGen3Voice(entry);
}

function stopAllGen3Notes() {
  GEN3.activeNotes.forEach((entry) => {
    stopGen3Voice(entry);
  });
  GEN3.releasingVoices.forEach((voice) => {
    stopGen3Voice(voice);
  });
  GEN3.releasingVoices.clear();
}

function restartAllGen3Notes() {
  if (!GEN3.nodes) return;
  GEN3.releasingVoices.forEach((voice) => stopGen3Voice(voice));
  GEN3.releasingVoices.clear();
  GEN3.activeNotes.forEach((entry, midi) => {
    stopGen3Voice(entry);
    Object.assign(entry, createGen3Voice(entry.freq));
  });
}

function drawGen3Scope() {
  const c = genVizCtxs[2],
    W = genVizW[2],
    H = genVizH[2];
  if (!c || !W || !H) return;
  const mid = H / 2;
  c.fillStyle = '#141414';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#252525';
  c.fillRect(0, mid - 0.5, W, 1);

  if (!GEN3.nodes?.analyser) return;
  const analyser = GEN3.nodes.analyser;
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatTimeDomainData(data);

  c.strokeStyle = GEN3.activeNotes.size + GEN3.releasingVoices.size > 0 ? '#40b8d0' : '#3a3a3a';
  c.lineWidth = 1.5;
  c.beginPath();
  const N = data.length;
  for (let x = 0; x < W; x++) {
    const v = data[Math.floor((x * N) / W)];
    const y = mid - v * H * 0.44;
    x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
  }
  c.stroke();
}

function gen3ScopeLoop() {
  drawGen3Scope();
  gen3ScopeFrame = requestAnimationFrame(gen3ScopeLoop);
}
function startGen3Scope() {
  if (!gen3ScopeFrame) gen3ScopeFrame = requestAnimationFrame(gen3ScopeLoop);
}
function stopGen3Scope() {
  if (gen3ScopeFrame) {
    cancelAnimationFrame(gen3ScopeFrame);
    gen3ScopeFrame = null;
  }
}

function buildPianoRoll() {
  const wrap = document.createElement('div');
  wrap.className = 'piano-roll';

  gen3NoteEls.clear();

  OSC_NOTE_GRID.forEach(({ octave, notes }) => {
    const row = document.createElement('div');
    row.className = 'piano-row';

    const cells = document.createElement('div');
    cells.className = 'piano-row-cells';

    notes.forEach(({ midi, label, freq, isBlack }) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `piano-cell ${isBlack ? 'black-key' : 'white-key'}`;
      cell.dataset.midi = midi;
      cell.title = label;

      cell.addEventListener('click', async () => {
        if (GEN3.activeNotes.has(midi)) {
          removeGen3Note(midi);
          return;
        }
        await ensureAudioEngine();
        if (GEN3.nodes) addGen3Note(midi, freq);
      });

      if (GEN3.activeNotes.has(midi)) cell.classList.add('active');
      gen3NoteEls.set(midi, cell);
      cells.appendChild(cell);
    });

    row.appendChild(cells);
    wrap.appendChild(row);
  });
  return wrap;
}

function buildOscPanel() {
  const panel = document.createElement('div');
  panel.className = 'generator gen-3';

  // Header
  const header = document.createElement('div');
  header.className = 'col-header';
  const title = document.createElement('span');
  title.className = 'col-title';
  title.innerHTML = '<span class="col-dot"></span>Gen 3 · Osc';

  const shapes = document.createElement('div');
  shapes.className = 'osc-shapes';
  [
    ['sine', 'SIN'],
    ['triangle', 'TRI'],
    ['square', 'SQR'],
    ['sawtooth', 'SAW'],
    ['noise', 'NOI'],
  ].forEach(([type, lbl]) => {
    const btn = document.createElement('button');
    btn.className = 'osc-shape' + (GEN3.type === type ? ' active' : '');
    btn.textContent = lbl;
    btn.addEventListener('click', () => {
      GEN3.type = type;
      shapes.querySelectorAll('.osc-shape').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      restartAllGen3Notes();
    });
    gen3ShapeButtons.set(type, btn);
    shapes.appendChild(btn);
  });
  header.append(title, shapes);
  panel.appendChild(header);

  // Body: scope (4/5) + piano roll (1/5)
  const body = document.createElement('div');
  body.className = 'gen-3-body';

  const scopeCanvas = document.createElement('canvas');
  scopeCanvas.className = 'gen-viz gen-3-scope';
  genVizCanvases[2] = scopeCanvas;
  genVizCtxs[2] = scopeCanvas.getContext('2d');
  new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    genVizW[2] = scopeCanvas.clientWidth;
    genVizH[2] = scopeCanvas.clientHeight;
    scopeCanvas.width = genVizW[2] * dpr;
    scopeCanvas.height = genVizH[2] * dpr;
    genVizCtxs[2].setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGenVizEmpty(2);
  }).observe(scopeCanvas);

  body.appendChild(scopeCanvas);
  body.appendChild(buildPianoRoll());
  panel.appendChild(body);

  // Controls: gain + detune + ADSR
  const rows = document.createElement('div');
  rows.className = 'gen-controls';
  [
    { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, unit: '' },
    { key: 'detune', label: 'Detune', min: -100, max: 100, step: 1, unit: 'ct' },
    { key: 'attack', label: 'Attack', min: 0, max: 10, step: 0.01, unit: 's' },
    { key: 'decay', label: 'Decay', min: 0, max: 2, step: 0.01, unit: 's' },
    { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '' },
    { key: 'release', label: 'Release', min: 0, max: 10, step: 0.01, unit: 's' },
  ].forEach((p) => {
    const control = makeControlRow(p, GEN3[p.key], (v) => {
      GEN3[p.key] = v;
      if (p.key === 'gain' && GEN3.nodes)
        GEN3.nodes.gain.gain.setValueAtTime(v, audioCtx.currentTime);
      if (p.key === 'detune' && GEN3.nodes)
        GEN3.activeNotes.forEach((entry) => {
          if (entry?.source?.detune) entry.source.detune.setValueAtTime(v, audioCtx.currentTime);
        });
    });
    gen3ControlBindings.set(p.key, control);
    rows.appendChild(control);
  });
  panel.appendChild(rows);
  return panel;
}

// ─── FX Chain ──────────────────────────────────────────────────────────────

const FX_DEFS = [
  {
    id: 'delay',
    label: 'Delay',
    params: [
      { key: 'time', label: 'Time', min: 0, max: 1, step: 0.01, value: 0.3, unit: 's' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, value: 0.35, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'filter',
    label: 'Filter',
    params: [
      { key: 'cutoff', label: 'Cutoff', min: 80, max: 14000, step: 10, unit: 'Hz' },
      { key: 'q', label: 'Resonance', min: 0.1, max: 20, step: 0.1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'bitreduce',
    label: 'Bit Reduce',
    params: [
      { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, value: 8, unit: '' },
      { key: 'rate', label: 'Rate', min: 0.02, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'sat',
    label: 'Saturation',
    params: [
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'reverb',
    label: 'Reverb',
    params: [
      { key: 'size', label: 'Size', min: 0.1, max: 5, step: 0.1, value: 2, unit: 's' },
      { key: 'decay', label: 'Decay', min: 0.5, max: 8, step: 0.1, value: 3, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'limiter',
    label: 'Limiter',
    params: [
      { key: 'threshold', label: 'Threshold', min: -24, max: 0, step: 0.5, value: -8, unit: 'dB' },
      { key: 'release', label: 'Release', min: 0.02, max: 0.5, step: 0.01, value: 0.12, unit: 's' },
      { key: 'output', label: 'Output', min: 0.5, max: 1.2, step: 0.01, value: 0.96, unit: '' },
    ],
  },
];

// Source of truth for FX state — applied to audio nodes when they exist.
const FX = {
  delay: { time: 0.3, feedback: 0.35, mix: 0, sync: false, syncIndex: 4 },
  filter: { mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 },
  bitreduce: { bits: 8, rate: 1, mix: 0 },
  sat: { drive: 0.3, mix: 0 },
  reverb: { size: 2, decay: 3, mix: 0 },
  limiter: { threshold: -8, release: 0.12, output: 0.96 },
};

let fx = null; // audio nodes, created in start(), nulled in stop()

// ─── LFO ───────────────────────────────────────────────────────────────────

const LFOS = [
  {
    label: 'LFO 1',
    rate: 1.0,
    sync: false,
    syncIndex: 5,
    shape: 'sine',
    depth: 0.3,
    phase: 0,
    currentValue: 0,
    holdValue: 0,
  },
  {
    label: 'LFO 2',
    rate: 0.35,
    sync: false,
    syncIndex: 6,
    shape: 'tri',
    depth: 0.25,
    phase: 0,
    currentValue: 0,
    holdValue: 0,
  },
];
const LFO_RATE_CURVE_EXP = 2.4;
const LFO_RATE_CONTROL = {
  key: 'rate',
  label: 'Rate',
  min: 0.05,
  max: 10,
  step: 0.05,
  unit: 'Hz',
  toNorm: (v) => Math.pow((v - 0.05) / (10 - 0.05), 1 / LFO_RATE_CURVE_EXP),
  fromNorm: (n) => 0.05 + Math.pow(Math.max(0, Math.min(1, n)), LFO_RATE_CURVE_EXP) * (10 - 0.05),
};
const LFO_RATE_SYNC_CONTROL = {
  key: 'rate',
  label: 'Rate',
  min: 0,
  max: TEMPO_SYNC_STEPS.length - 1,
  step: 1,
  unit: '',
};
const DELAY_TIME_FREE_CONTROL = FX_DEFS.find((def) => def.id === 'delay').params.find(
  (param) => param.key === 'time',
);
const DELAY_TIME_SYNC_CONTROL = {
  key: 'time',
  label: 'Time',
  min: 0,
  max: TEMPO_SYNC_STEPS.length - 1,
  step: 1,
  unit: '',
};
// lfoMappings: 'genIdx:paramKey' → { genIdx, key, lfoIdx }
const lfoMappings = new Map();
let lfoLastTs = 0,
  lfoAnimFrame = null;

function getLFOValue(lfo) {
  switch (lfo.shape) {
    case 'sine':
      return Math.sin(2 * Math.PI * lfo.phase);
    case 'tri':
      return 1 - 4 * Math.abs(lfo.phase - 0.5);
    case 'square':
      return lfo.phase < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * lfo.phase - 1;
    case 'samplehold':
      return lfo.holdValue;
    default:
      return 0;
  }
}

function lfoStep(ts) {
  const dt = lfoLastTs ? Math.min((ts - lfoLastTs) / 1000, 0.1) : 0;
  lfoLastTs = ts;
  LFOS.forEach((lfo) => {
    const rateHz = getLfoRateHz(lfo);
    const prevPhase = lfo.phase;
    lfo.phase += rateHz * dt;
    let wrapped = false;
    while (lfo.phase >= 1) {
      lfo.phase -= 1;
      wrapped = true;
    }
    if (lfo.shape === 'samplehold' && (wrapped || (dt === 0 && prevPhase === 0))) {
      lfo.holdValue = Math.random() * 2 - 1;
    }
    lfo.currentValue = getLFOValue(lfo);
  });
  if (lfoMappings.size > 0) {
    const gens = new Set([...lfoMappings.values()].map((m) => m.genIdx));
    gens.forEach((gi) => sendParams(gi));
  }
  lfoAnimFrame = requestAnimationFrame(lfoStep);
}

function startLFOLoop() {
  if (lfoAnimFrame) return;
  lfoLastTs = 0;
  lfoAnimFrame = requestAnimationFrame(lfoStep);
}

function stopLFOLoop() {
  if (lfoAnimFrame) {
    cancelAnimationFrame(lfoAnimFrame);
    lfoAnimFrame = null;
  }
  LFOS.forEach((lfo) => {
    lfo.phase = 0;
    lfo.currentValue = 0;
    lfo.holdValue = 0;
  });
}

function cycleLFOMap(genIdx, key) {
  const mapKey = `${genIdx}:${key}`;
  const mapping = lfoMappings.get(mapKey);
  if (!mapping) {
    lfoMappings.set(mapKey, { genIdx, key, lfoIdx: 0 });
    sendParams(genIdx);
    return 0;
  }
  if (mapping.lfoIdx === 0) {
    mapping.lfoIdx = 1;
    sendParams(genIdx);
    return 1;
  }
  lfoMappings.delete(mapKey);
  sendParams(genIdx);
  return null;
}

function refreshDelayTimeUI() {
  const control = fxControlBindings.get('delay:time');
  if (!control) return;
  const isSync = !!FX.delay.sync;
  control.setConfig(
    isSync
      ? { ...DELAY_TIME_SYNC_CONTROL, resetValue: FX.delay.syncIndex }
      : { ...DELAY_TIME_FREE_CONTROL, resetValue: FX.delay.time },
  );
  control.setFormatter(
    isSync ? (v) => formatTempoSyncValue(v, (step) => formatTempoSeconds(beatsToSeconds(step.beats))) : null,
  );
  control.setValue(isSync ? FX.delay.syncIndex : FX.delay.time);
  delaySyncModeControl?.setMode(isSync ? 'sync' : 'free');
}

function refreshLFOControlUI(lfoIdx) {
  const lfo = LFOS[lfoIdx];
  const control = lfoControlBindings[lfoIdx].get('rate');
  if (!control) return;
  const isSync = !!lfo.sync;
  control.setConfig(
    isSync
      ? { ...LFO_RATE_SYNC_CONTROL, resetValue: lfo.syncIndex }
      : { ...LFO_RATE_CONTROL, resetValue: lfo.rate },
  );
  control.setFormatter(
    isSync
      ? (v) => formatTempoSyncValue(v, (step) => `${formatNumericValue(1 / beatsToSeconds(step.beats), 2)}Hz`)
      : null,
  );
  control.setValue(isSync ? lfo.syncIndex : lfo.rate);
  lfoSyncModeControls[lfoIdx]?.setMode(isSync ? 'sync' : 'free');
}

function setTransportBpm(value, { refresh = true } = {}) {
  if (!Number.isFinite(value)) return;
  const decimals = (BPM_BOUNDS.step.toString().split('.')[1] || '').length;
  TRANSPORT.bpm = clamp(
    quantize(value, BPM_BOUNDS.step, decimals),
    BPM_BOUNDS.min,
    BPM_BOUNDS.max,
  );
  const bpmInput = getBpmInput();
  if (bpmInput) bpmInput.value = `${TRANSPORT.bpm}`;
  if (!refresh) return;
  if (FX.delay.sync) applyFx('delay', 'time', FX.delay.time);
  refreshDelayTimeUI();
  refreshLFOUI();
}

function initTempoDrag() {
  const tempoBox = document.querySelector('.tempo-box');
  const bpmInput = getBpmInput();
  if (!tempoBox) return;

  let startY = 0;
  let startBpm = TRANSPORT.bpm;
  let dragging = false;

  tempoBox.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (bpmInput && e.target === bpmInput) return;
    e.preventDefault();
    startY = e.clientY;
    startBpm = TRANSPORT.bpm;
    dragging = true;
    tempoBox.classList.add('dragging');
    tempoBox.setPointerCapture(e.pointerId);
  });

  tempoBox.addEventListener('pointermove', (e) => {
    if (!dragging || !tempoBox.hasPointerCapture(e.pointerId)) return;
    const sensitivity = e.shiftKey ? 0.1 : 0.35;
    const nextBpm = startBpm + (startY - e.clientY) * sensitivity;
    setTransportBpm(nextBpm);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    tempoBox.classList.remove('dragging');
    if (tempoBox.hasPointerCapture(e.pointerId)) tempoBox.releasePointerCapture(e.pointerId);
  };

  tempoBox.addEventListener('pointerup', endDrag);
  tempoBox.addEventListener('pointercancel', endDrag);
}

function createFxSection(label, className = '') {
  const section = document.createElement('div');
  section.className = `fx-section${className ? ' ' + className : ''}`;

  const header = document.createElement('button');
  header.className = 'fx-section-label';
  header.type = 'button';

  const title = document.createElement('span');
  title.className = 'fx-section-label-text';
  title.textContent = label;

  const toggle = document.createElement('span');
  toggle.className = 'fx-section-toggle';
  toggle.textContent = '−';

  const content = document.createElement('div');
  content.className = 'fx-section-content';

  const setCollapsed = (collapsed) => {
    section.classList.toggle('collapsed', collapsed);
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.textContent = collapsed ? '+' : '−';
  };

  header.addEventListener('click', () => {
    setCollapsed(!section.classList.contains('collapsed'));
  });

  header.append(title, toggle);
  section.append(header, content);
  setCollapsed(false);

  return { section, content, setCollapsed };
}

function buildLFOSection(lfoIdx) {
  const lfo = LFOS[lfoIdx];
  const { section, content } = createFxSection(lfo.label, `lfo-section lfo-section-${lfoIdx + 1}`);

  const rateControl = makeControlRow(LFO_RATE_CONTROL, lfo.rate, (v) => {
    if (lfo.sync) {
      lfo.syncIndex = Math.round(v);
    } else {
      lfo.rate = v;
    }
  });
  lfoControlBindings[lfoIdx].set('rate', rateControl);
  content.appendChild(rateControl);

  const syncModeRow = buildSyncModeRow(lfo.sync, (mode) => {
    lfo.sync = mode === 'sync';
    refreshLFOControlUI(lfoIdx);
  });
  lfoSyncModeControls[lfoIdx] = syncModeRow;
  content.appendChild(syncModeRow);

  const depthControl = makeControlRow(
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, unit: '' },
    lfo.depth,
    (v) => {
      lfo.depth = v;
    },
  );
  lfoControlBindings[lfoIdx].set('depth', depthControl);
  content.appendChild(depthControl);

  // Shape selector
  const shapeRow = document.createElement('div');
  shapeRow.className = 'lfo-shapes';
  [
    ['sine', 'SIN'],
    ['tri', 'TRI'],
    ['square', 'SQR'],
    ['saw', 'SAW'],
    ['samplehold', 'S&H'],
  ].forEach(([shape, lbl]) => {
    const btn = document.createElement('button');
    btn.className = 'lfo-shape' + (lfo.shape === shape ? ' active' : '');
    btn.textContent = lbl;
    btn.addEventListener('click', () => {
      lfo.shape = shape;
      if (shape === 'samplehold') lfo.holdValue = Math.random() * 2 - 1;
      shapeRow.querySelectorAll('.lfo-shape').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
    lfoShapeButtons[lfoIdx].set(shape, btn);
    shapeRow.appendChild(btn);
  });
  content.appendChild(shapeRow);

  refreshLFOControlUI(lfoIdx);

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

function applyFilterMode() {
  if (!fx?.filter?.biquad) return;
  fx.filter.biquad.type = FX.filter.mode;
}

function buildFxNodes() {
  const ac = audioCtx;

  // ─ Delay (feedback loop) ─
  const dlyIn = ac.createGain();
  const dlyDry = ac.createGain();
  const dlyWet = ac.createGain();
  const dlyTap = ac.createDelay(MAX_DELAY_SECONDS);
  const dlyFb = ac.createGain();
  const dlyOut = ac.createGain();

  dlyIn.connect(dlyDry);
  dlyIn.connect(dlyTap);
  dlyTap.connect(dlyFb);
  dlyFb.connect(dlyTap); // feedback loop
  dlyTap.connect(dlyWet);
  dlyDry.connect(dlyOut);
  dlyWet.connect(dlyOut);

  // ─ Filter ─
  const fltIn = ac.createGain();
  const fltDry = ac.createGain();
  const fltWet = ac.createGain();
  const fltBiquad = ac.createBiquadFilter();
  const fltOut = ac.createGain();

  fltIn.connect(fltDry);
  fltIn.connect(fltBiquad);
  fltBiquad.connect(fltWet);
  fltDry.connect(fltOut);
  fltWet.connect(fltOut);

  // ─ Bit reducer ─
  const bitIn = ac.createGain();
  const bitDry = ac.createGain();
  const bitWet = ac.createGain();
  const bitNode = new AudioWorkletNode(ac, 'bit-reducer-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: {
      bits: FX.bitreduce.bits,
      rate: FX.bitreduce.rate,
    },
  });
  const bitOut = ac.createGain();

  bitIn.connect(bitDry);
  bitIn.connect(bitNode);
  bitNode.connect(bitWet);
  bitDry.connect(bitOut);
  bitWet.connect(bitOut);

  // ─ Saturation ─
  const satIn = ac.createGain();
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
  const rvbIn = ac.createGain();
  const rvbConv = ac.createConvolver();
  const rvbDry = ac.createGain();
  const rvbWet = ac.createGain();
  const rvbOut = ac.createGain();

  rvbIn.connect(rvbDry);
  rvbIn.connect(rvbConv);
  rvbConv.connect(rvbWet);
  rvbDry.connect(rvbOut);
  rvbWet.connect(rvbOut);

  // ─ Master limiter ─
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(FX.limiter.threshold, ac.currentTime);
  limiter.knee.setValueAtTime(0, ac.currentTime);
  limiter.ratio.setValueAtTime(20, ac.currentTime);
  limiter.attack.setValueAtTime(0.003, ac.currentTime);
  limiter.release.setValueAtTime(FX.limiter.release, ac.currentTime);
  const masterOut = ac.createGain();
  masterOut.gain.setValueAtTime(FX.limiter.output, ac.currentTime);

  // ─ Chain: granulator → delay → filter → bit reduce → saturation → reverb → limiter ─
  dlyOut.connect(fltIn);
  fltOut.connect(bitIn);
  bitOut.connect(satIn);
  satOut.connect(rvbIn);
  rvbOut.connect(limiter);
  limiter.connect(masterOut);

  fx = {
    input: dlyIn,
    output: masterOut,
    delay: { tap: dlyTap, fb: dlyFb, dry: dlyDry, wet: dlyWet },
    filter: { biquad: fltBiquad, dry: fltDry, wet: fltWet },
    bitreduce: { node: bitNode, dry: bitDry, wet: bitWet },
    sat: { shaper: satShaper, dry: satDry, wet: satWet },
    reverb: { conv: rvbConv, dry: rvbDry, wet: rvbWet },
    limiter: { comp: limiter, output: masterOut },
  };

  applyAllFx();
}

function applyFx(id, key, val) {
  if (!fx) return;
  if (id === 'delay') {
    if (key === 'time')
      fx.delay.tap.delayTime.setTargetAtTime(getDelayTimeSeconds(), audioCtx.currentTime, 0.02);
    if (key === 'feedback')
      fx.delay.fb.gain.setTargetAtTime(Math.min(0.98, val), audioCtx.currentTime, 0.02);
    if (key === 'mix') {
      fx.delay.wet.gain.value = val;
      fx.delay.dry.gain.value = 1 - val;
    }
  } else if (id === 'filter') {
    if (key === 'cutoff')
      fx.filter.biquad.frequency.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'q') fx.filter.biquad.Q.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'mix') {
      fx.filter.wet.gain.value = val;
      fx.filter.dry.gain.value = 1 - val;
    }
  } else if (id === 'bitreduce') {
    if (key === 'bits')
      fx.bitreduce.node.parameters.get('bits')?.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'rate')
      fx.bitreduce.node.parameters.get('rate')?.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'mix') {
      fx.bitreduce.wet.gain.value = val;
      fx.bitreduce.dry.gain.value = 1 - val;
    }
  } else if (id === 'sat') {
    if (key === 'drive') fx.sat.shaper.curve = makeSatCurve(val);
    if (key === 'mix') {
      fx.sat.wet.gain.value = val;
      fx.sat.dry.gain.value = 1 - val;
    }
  } else if (id === 'reverb') {
    if (key === 'size' || key === 'decay') fx.reverb.conv.buffer = makeReverbIR();
    if (key === 'mix') {
      fx.reverb.wet.gain.value = val;
      fx.reverb.dry.gain.value = 1 - val;
    }
  } else if (id === 'limiter') {
    if (key === 'threshold')
      fx.limiter.comp.threshold.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'release') fx.limiter.comp.release.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'output') fx.limiter.output.gain.setTargetAtTime(val, audioCtx.currentTime, 0.02);
  }
}

function applyAllFx() {
  FX_DEFS.forEach(({ id, params }) => params.forEach(({ key }) => applyFx(id, key, FX[id][key])));
  applyFilterMode();
}

function refreshGen3UI() {
  ['gain', 'detune', 'attack', 'decay', 'sustain', 'release'].forEach((key) => {
    gen3ControlBindings.get(key)?.setValue(GEN3[key]);
  });
  gen3ShapeButtons.forEach((btn, type) => btn.classList.toggle('active', GEN3.type === type));
}

function refreshLFOUI() {
  LFOS.forEach((lfo, lfoIdx) => {
    refreshLFOControlUI(lfoIdx);
    lfoControlBindings[lfoIdx].get('depth')?.setValue(lfo.depth);
    lfoShapeButtons[lfoIdx].forEach((btn, shape) =>
      btn.classList.toggle('active', lfo.shape === shape),
    );
  });
}

function refreshFilterUI() {
  ['cutoff', 'q', 'mix'].forEach((key) => {
    fxControlBindings.get(`filter:${key}`)?.setValue(FX.filter[key]);
  });
  filterModeButtons.forEach((btn, mode) => btn.classList.toggle('active', FX.filter.mode === mode));
}

function capturePreset() {
  return {
    transport: { bpm: TRANSPORT.bpm },
    gens: state.map((gen) => ({ ...gen })),
    gen3: {
      type: GEN3.type,
      gain: GEN3.gain,
      detune: GEN3.detune,
      attack: GEN3.attack,
      decay: GEN3.decay,
      sustain: GEN3.sustain,
      release: GEN3.release,
    },
    fx: JSON.parse(JSON.stringify(FX)),
    lfos: LFOS.map(({ label, rate, sync, syncIndex, shape, depth }) => ({
      label,
      rate,
      sync,
      syncIndex,
      shape,
      depth,
    })),
    mappings: [...lfoMappings.values()].map(({ genIdx, key, lfoIdx }) => ({ genIdx, key, lfoIdx })),
  };
}

function applyPreset(preset) {
  if (!preset) return;
  if (typeof preset.transport?.bpm === 'number') {
    setTransportBpm(preset.transport.bpm, { refresh: false });
  }
  preset.gens?.forEach((gen, genIdx) => {
    PARAMS.forEach(({ key }) => {
      if (typeof gen[key] === 'number') setGeneratorParam(genIdx, key, gen[key], { send: false });
    });
    if (typeof gen.freeze === 'boolean') state[genIdx].freeze = gen.freeze;
    if (typeof gen.reverse === 'boolean') state[genIdx].reverse = gen.reverse;
    if (typeof gen.envType === 'string') state[genIdx].envType = gen.envType;
    refreshGeneratorUI(genIdx);
  });

  if (preset.gen3) {
    Object.assign(GEN3, preset.gen3);
    refreshGen3UI();
    if (GEN3.nodes) {
      GEN3.nodes.gain.gain.setValueAtTime(GEN3.gain, audioCtx.currentTime);
      GEN3.activeNotes.forEach((entry) => {
        if (entry?.source?.detune)
          entry.source.detune.setValueAtTime(GEN3.detune, audioCtx.currentTime);
      });
      restartAllGen3Notes();
    }
  }

  if (preset.fx) {
    Object.keys(FX).forEach((id) => {
      if (preset.fx[id]) Object.assign(FX[id], preset.fx[id]);
    });
    applyAllFx();
    refreshFilterUI();
    ['delay', 'filter', 'bitreduce', 'sat', 'reverb', 'limiter'].forEach((id) => {
      Object.entries(FX[id]).forEach(([key, value]) => {
        if (key !== 'mode') fxControlBindings.get(`${id}:${key}`)?.setValue(value);
      });
    });
  }

  if (preset.lfos) {
    preset.lfos.forEach((saved, idx) => {
      if (!LFOS[idx]) return;
      LFOS[idx].rate = saved.rate;
      if (typeof saved.sync === 'boolean') LFOS[idx].sync = saved.sync;
      if (typeof saved.syncIndex === 'number') LFOS[idx].syncIndex = saved.syncIndex;
      LFOS[idx].shape = saved.shape;
      LFOS[idx].depth = saved.depth;
    });
    refreshLFOUI();
  }

  lfoMappings.clear();
  preset.mappings?.forEach(({ genIdx, key, lfoIdx }) => {
    if (genIdx < 2 && PARAMS.some((p) => p.key === key) && (lfoIdx === 0 || lfoIdx === 1)) {
      lfoMappings.set(`${genIdx}:${key}`, { genIdx, key, lfoIdx });
    }
  });
  refreshLFOMappingUI();
  refreshDelayTimeUI();
  refreshLFOUI();
  sendParams(0);
  sendParams(1);
}

function refreshPresetUI() {
  const saveBtn = getPresetSaveBtn();
  saveBtn?.classList.toggle('active', presetSaveArmed);
  const slots = getPresetSlotsEl()?.querySelectorAll('.preset-slot') || [];
  slots.forEach((slot, idx) => {
    slot.classList.toggle('filled', !!presetStore[idx]);
  });
}

function buildPresetUI() {
  const slotsEl = getPresetSlotsEl();
  if (!slotsEl) return;
  slotsEl.textContent = '';
  for (let i = 0; i < PRESET_SLOT_COUNT; i++) {
    const btn = document.createElement('button');
    btn.className = 'preset-slot';
    btn.textContent = `P${i + 1}`;
    btn.addEventListener('click', () => {
      if (presetSaveArmed) {
        presetStore[i] = capturePreset();
        presetSaveArmed = false;
        savePresetStore();
        refreshPresetUI();
        setStatus(`saved preset ${i + 1}`);
        return;
      }
      if (!presetStore[i]) {
        setStatus(`preset ${i + 1} empty`);
        return;
      }
      applyPreset(presetStore[i]);
      setStatus(`loaded preset ${i + 1}`);
    });
    slotsEl.appendChild(btn);
  }
  getPresetSaveBtn()?.addEventListener('click', () => {
    presetSaveArmed = !presetSaveArmed;
    refreshPresetUI();
  });
  refreshPresetUI();
}

function buildFxUI() {
  const container = document.getElementById('fx-chain');

  // Column header matching generator style
  const header = document.createElement('div');
  header.className = 'col-header';
  header.innerHTML = '<span class="col-title"><span class="col-dot"></span>FX Chain</span>';
  container.appendChild(header);

  // LFO modulators first
  LFOS.forEach((_, lfoIdx) => container.appendChild(buildLFOSection(lfoIdx)));

  // One section per effect, stacked vertically
  FX_DEFS.forEach((def) => {
    const { section, content } = createFxSection(def.label);

    if (def.id === 'filter') {
      const modeRow = document.createElement('div');
      modeRow.className = 'fx-mode-row';
      [
        ['lowpass', 'LP'],
        ['highpass', 'HP'],
        ['bandpass', 'BP'],
      ].forEach(([mode, label]) => {
        const btn = document.createElement('button');
        btn.className = 'fx-mode-btn' + (FX.filter.mode === mode ? ' active' : '');
        btn.textContent = label;
        btn.addEventListener('click', () => {
          FX.filter.mode = mode;
          applyFilterMode();
          refreshFilterUI();
        });
        filterModeButtons.set(mode, btn);
        modeRow.appendChild(btn);
      });
      content.appendChild(modeRow);
    }

    def.params.forEach((p) => {
      const control = makeControlRow(p, FX[def.id][p.key], (v) => {
        if (def.id === 'delay' && p.key === 'time') {
          if (FX.delay.sync) {
            FX.delay.syncIndex = Math.round(v);
          } else {
            FX.delay.time = v;
          }
          applyFx('delay', 'time', FX.delay.time);
          return;
        }
        FX[def.id][p.key] = v;
        applyFx(def.id, p.key, v);
      });
      fxControlBindings.set(`${def.id}:${p.key}`, control);
      content.appendChild(control);

      if (def.id === 'delay' && p.key === 'time') {
        delaySyncModeControl = buildSyncModeRow(FX.delay.sync, (mode) => {
          FX.delay.sync = mode === 'sync';
          refreshDelayTimeUI();
          applyFx('delay', 'time', FX.delay.time);
        });
        content.appendChild(delaySyncModeControl);
      }
    });

    container.appendChild(section);
  });

  refreshDelayTimeUI();
}

async function start() {
  try {
    await ensureGranularEngine();
    if (anyMicSourceSelected()) {
      setStatus('requesting mic…');
      await ensureMicInput();
    }
    sendParams(0);
    sendParams(1);
    setGranularRunning();
  } catch (err) {
    setStatus('error: ' + err.message);
    console.error(err);
  }
}

async function ensureGranularEngine() {
  await ensureAudioEngine();
  await ensureGranularModule();
  if (!node) {
    node = new AudioWorkletNode(audioCtx, 'granular-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(fx.input);
    node.port.onmessage = (e) => {
      if (e.data && e.data.type === 'viz') drawViz(e.data);
    };
    sendParams(0);
    sendParams(1);
  }
  await syncGranularSourceStates();
  return node;
}

function disconnectGranularInput({ stopTracks = false } = {}) {
  if (granularInputSource) {
    try {
      granularInputSource.disconnect();
    } catch (e) {}
    granularInputSource = null;
  }
  if (stopTracks && micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

async function ensureMicInput() {
  if (!node) await ensureGranularEngine();
  if (granularInputSource && micStream) return;
  disconnectGranularInput({ stopTracks: true });
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  granularInputSource = audioCtx.createMediaStreamSource(micStream);
  granularInputSource.connect(node);
}

async function syncGranularSourceState(genIdx) {
  if (!node) return;
  const source = getSourceState(genIdx);
  if (source.mode === 'file' && source.bufferData) {
    const workletBuffer = source.bufferData.slice();
    node.port.postMessage({ type: 'set-gen-source-buffer', gen: genIdx, buffer: workletBuffer }, [
      workletBuffer.buffer,
    ]);
  } else {
    node.port.postMessage({ type: 'set-gen-source-mode', gen: genIdx, mode: 'live' });
  }
}

async function syncGranularSourceStates() {
  if (!node) return;
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    await syncGranularSourceState(genIdx);
  }
}

async function setGeneratorSourceMode(genIdx, mode) {
  const source = getSourceState(genIdx);
  if (!source) return;
  if (mode === 'file') {
    if (!source.bufferData) {
      setStatus('drop a .wav file');
      return;
    }
    source.mode = 'file';
    setSourceDurationSec(genIdx, source.durationSec);
    refreshSourceModeUI(genIdx);
    await ensureGranularEngine();
    await syncGranularSourceState(genIdx);
  } else {
    source.mode = 'mic';
    setSourceDurationSec(genIdx, LIVE_SOURCE_SECONDS);
    refreshSourceModeUI(genIdx);
    await ensureMicInput();
    await syncGranularSourceState(genIdx);
  }
  state[genIdx].freeze = false;
  genFreezeButtons[genIdx]?.classList.remove('active');
  sendParams(genIdx);
  setGranularRunning();
}

function isSupportedGranularFile(file) {
  return !!file && /\.wav$/i.test(file.name || '');
}

function audioBufferToMono(audioBuffer) {
  const mono = new Float32Array(audioBuffer.length);
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  for (let ch = 0; ch < channelCount; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / channelCount;
  }
  return mono;
}

async function loadGranularFile(genIdx, file) {
  try {
    setStatus(`loading ${file.name}…`);
    await ensureGranularEngine();
    const bytes = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(bytes);
    const mono = audioBufferToMono(decoded);
    const source = getSourceState(genIdx);
    source.mode = 'file';
    source.fileName = file.name;
    source.bufferData = mono;
    setSourceDurationSec(genIdx, decoded.duration);
    refreshSourceModeUI(genIdx);
    await syncGranularSourceState(genIdx);
    state[genIdx].freeze = false;
    genFreezeButtons[genIdx]?.classList.remove('active');
    sendParams(genIdx);
    setGranularRunning();
  } catch (err) {
    setStatus('error: ' + err.message);
    console.error(err);
  }
}

function stop() {
  stopRecording();
  stopLFOLoop();
  stopGenVizLoop();
  stopGen3Scope();
  stopAllGen3Notes();
  GEN3.nodes = null;
  disconnectGranularInput({ stopTracks: true });
  if (audioCtx) audioCtx.close();
  audioCtx = node = fx = null;
  granularModulePromise = null;
  bitReducerModulePromise = null;
  started = false;

  // Reset freeze state for both generators.
  clearFreezeStates({ send: false });
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    setSourceDurationSec(
      genIdx,
      getSourceState(genIdx).mode === 'file'
        ? getSourceState(genIdx).durationSec
        : LIVE_SOURCE_SECONDS,
    );
    refreshGeneratorUI(genIdx);
    refreshSourceModeUI(genIdx);
  }

  document.getElementById('startBtn').textContent = getIdleStartButtonLabel();
  setStatus('idle');
  resetGenVizState(0);
  resetGenVizState(1);
  drawGenVizEmpty(0);
  drawGenVizEmpty(1);
  drawGenVizEmpty(2);
}

document.getElementById('startBtn').addEventListener('click', () => {
  started ? stop() : start();
});

getBpmInput()?.addEventListener('input', (e) => {
  const next = Number.parseFloat(e.target.value);
  if (Number.isFinite(next)) setTransportBpm(next);
});

getBpmInput()?.addEventListener('change', () => {
  setTransportBpm(TRANSPORT.bpm);
});

['dragover', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
  });
});

getRecordBtn()?.addEventListener('click', () => {
  REC.isRecording ? stopRecording() : startRecording();
});

loadPresetStore();
buildUI();
setSourceDurationSec(0, LIVE_SOURCE_SECONDS);
setSourceDurationSec(1, LIVE_SOURCE_SECONDS);
buildFxUI();
buildPresetUI();
initTempoDrag();
refreshRecordButton();
setTransportBpm(TRANSPORT.bpm);
getStartBtn().textContent = getIdleStartButtonLabel();
