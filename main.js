// grnsh — main thread: mic capture, worklet setup, UI wiring.

let audioCtx = null;
let node = null;
let micStream = null;
let granularInputSource = null;
let started = false;
let granularModulePromise = null;
let bitReducerModulePromise = null;
let beatRepeatModulePromise = null;
const LIVE_SOURCE_SECONDS = 10;
const MAX_DELAY_SECONDS = 16;
const INPUT_SOURCE = {
  devices: [],
  selectedId: 'default',
};
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
const GRAIN_SYNC_STEPS = [
  { label: '1/64', beats: 0.0625 },
  { label: '1/32', beats: 0.125 },
  { label: '1/16', beats: 0.25 },
  { label: '1/8T', beats: 1 / 3 },
  { label: '1/8', beats: 0.5 },
  { label: '1/4T', beats: 2 / 3 },
  { label: '1/4', beats: 1 },
];
const GRAIN_SYNC_CONTROL = { min: 0, max: GRAIN_SYNC_STEPS.length - 1, step: 1, unit: '' };
const REC = {
  isRecording: false,
  left: [],
  right: [],
  sampleCount: 0,
  processor: null,
  sink: null,
};

// Noise gate on the mic feeding the granulators: signal below threshold is
// muted before it reaches the worklet, so it isn't heard or visualized.
const INPUT_GATE = {
  enabled: false,
  threshold: 0.01, // linear amplitude; -40 dB default
  node: null, // ScriptProcessor inserted between mic source and worklet
  env: 0, // smoothed gain envelope 0..1
  attackMs: 3, // ramp up when signal crosses threshold
  releaseMs: 120, // ramp down when it drops below
};

// dB <-> linear amplitude helper for the gate.
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}
const PROJECT_STORAGE_KEY = 'grnsh-projects-v1';
const LEGACY_PRESET_STORAGE_KEY = 'grnsh-presets-v1';
const AUTOSAVE_STORAGE_KEY = 'grnsh-autosave-v1';
const AUTOSAVE_INTERVAL_MS = 5000;
let projectStore = []; // [{ name, data, savedAt }]
let currentProjectName = null;
let projectMenuOpen = false;
let defaultProjectSnapshot = null; // pristine state captured at startup, for "new project"
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
const UI_VIEW = { mode: 'front' };
const BACK_PANEL = {
  sourceJacks: new Map(),
  sourceMeters: new Map(),
  sourceMeta: new Map(),
  audioModules: new Map(),
  targetJacks: new Map(),
  targetRows: new Map(),
  targetValues: new Map(),
  routeLayer: null,
  patchfieldEl: null,
  built: false,
  selectedSourceIdx: null,
  pointerX: null,
  pointerY: null,
};

function getStatusEl() {
  return document.getElementById('status');
}

function getRecordBtn() {
  return document.getElementById('recordBtn');
}

function getGateEnable() {
  return document.getElementById('gateEnable');
}

function getGateSlider() {
  return document.getElementById('gateThreshold');
}

function getGateVal() {
  return document.getElementById('gateThresholdVal');
}

function getProjectMenuBtn() {
  return document.getElementById('projectMenuBtn');
}

function getProjectMenu() {
  return document.getElementById('projectMenu');
}

function getProjectMenuLabel() {
  return document.getElementById('projectMenuLabel');
}

function getProjectList() {
  return document.getElementById('projectList');
}

function getProjectNameInput() {
  return document.getElementById('projectNameInput');
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

function getDelayTimeSeconds(busId = activeBus) {
  const d = fxStates[busId].delay;
  return clamp(d.sync ? beatsToSeconds(getTempoStep(d.syncIndex).beats) : d.time, 0, MAX_DELAY_SECONDS);
}

function getBeatRepeatIntervalSeconds(busId = activeBus) {
  const b = fxStates[busId].beatrepeat;
  return b.sync ? beatsToSeconds(getTempoStep(b.syncIndex).beats) : b.interval;
}

function getBeatRepeatGridSeconds(busId = activeBus) {
  const b = fxStates[busId].beatrepeat;
  return b.gridSync ? beatsToSeconds(getGrainSyncStep(b.gridSyncIndex).beats) : b.grid / 1000;
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

function loadProjectStore() {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        projectStore = parsed.filter((p) => p && typeof p.name === 'string' && p.data);
        return;
      }
    }
    migrateLegacyPresets();
  } catch (e) {}
}

// One-time import of the old 4-slot preset store into named projects.
function migrateLegacyPresets() {
  try {
    const raw = localStorage.getItem(LEGACY_PRESET_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    parsed.forEach((data, i) => {
      if (data) projectStore.push({ name: `preset ${i + 1}`, data, savedAt: 0 });
    });
    if (projectStore.length) saveProjectStore();
  } catch (e) {}
}

function saveProjectStore() {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projectStore));
  } catch (e) {}
}

// ── Autosave ── the live workspace (including loops + song) survives reloads
// without pressing Save; named projects stay manual snapshots.

function writeAutosave() {
  try {
    localStorage.setItem(
      AUTOSAVE_STORAGE_KEY,
      JSON.stringify({ name: currentProjectName, data: capturePreset(), savedAt: Date.now() }),
    );
  } catch (e) {}
}

function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved?.data) return false;
    applyPreset(saved.data);
    currentProjectName = typeof saved.name === 'string' ? saved.name : null;
    const input = getProjectNameInput();
    if (input && currentProjectName) input.value = currentProjectName;
    refreshProjectUI();
    restoreAudioForScope('autosave');
    setStatus('session restored');
    return true;
  } catch (e) {
    return false;
  }
}

// ── Audio clip persistence ── granular source audio (loaded .wav buffers and
// frozen mic takes) is too big for localStorage, so it lives in IndexedDB,
// keyed `<scope>:gen<i>` where scope is `project:<name>` or `autosave`.

const AUDIO_DB_NAME = 'grnsh-audio-v1';
const AUDIO_DB_STORE = 'clips';
let audioDbPromise = null;

function openAudioDb() {
  if (audioDbPromise) return audioDbPromise;
  audioDbPromise = new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    const req = indexedDB.open(AUDIO_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(AUDIO_DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return audioDbPromise;
}

async function audioClipTx(mode, fn) {
  const db = await openAudioDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(AUDIO_DB_STORE, mode);
      const req = fn(tx.objectStore(AUDIO_DB_STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

function audioClipPut(key, value) {
  return audioClipTx('readwrite', (store) => store.put(value, key));
}

function audioClipGet(key) {
  return audioClipTx('readonly', (store) => store.get(key));
}

function audioClipDelete(key) {
  return audioClipTx('readwrite', (store) => store.delete(key));
}

// Persist both generators' source audio under a scope (or clear stale clips).
async function persistAudioForScope(scope) {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const source = getSourceState(genIdx);
    const key = `${scope}:gen${genIdx}`;
    if (source.mode === 'file' && source.bufferData) {
      await audioClipPut(key, {
        mode: 'file',
        samples: source.bufferData,
        sampleRate: audioCtx?.sampleRate || 48000,
        durationSec: source.durationSec,
        fileName: source.fileName,
      });
    } else if (source.mode === 'mic' && source.frozenData && state[genIdx].freeze) {
      await audioClipPut(key, {
        mode: 'frozen',
        samples: source.frozenData.samples,
        frozenAt: source.frozenData.frozenAt,
        sampleRate: source.frozenData.sampleRate,
      });
    } else {
      await audioClipDelete(key);
    }
  }
}

async function deleteAudioForScope(scope) {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    await audioClipDelete(`${scope}:gen${genIdx}`);
  }
}

async function applyRestoredClip(genIdx, clip) {
  const source = getSourceState(genIdx);
  if (clip.mode === 'file' && clip.samples?.length) {
    source.mode = 'file';
    source.fileName = clip.fileName || 'restored.wav';
    source.bufferData = clip.samples;
    source.frozenData = null;
    setSourceDurationSec(
      genIdx,
      clip.durationSec || clip.samples.length / (clip.sampleRate || 48000),
    );
    refreshSourceModeUI(genIdx);
    if (!genVizFrame) drawGenVizIdle(genIdx);
    if (node) await syncGranularSourceState(genIdx);
  } else if (clip.mode === 'frozen' && clip.samples?.length) {
    source.mode = 'mic';
    source.fileName = '';
    source.bufferData = null;
    source.frozenData = {
      samples: clip.samples,
      frozenAt: clip.frozenAt || 0,
      sampleRate: clip.sampleRate,
    };
    state[genIdx].freeze = true;
    genFreezeButtons[genIdx]?.classList.add('active');
    setSourceDurationSec(genIdx, LIVE_SOURCE_SECONDS);
    refreshSourceModeUI(genIdx);
    if (!genVizFrame) drawGenVizIdle(genIdx);
    if (node) {
      await syncGranularSourceState(genIdx);
      sendParams(genIdx);
    }
  }
}

async function restoreAudioForScope(scope) {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const clip = await audioClipGet(`${scope}:gen${genIdx}`);
    if (clip) await applyRestoredClip(genIdx, clip);
  }
  // Mirror what is now loaded into the autosave scope (also clears stale clips).
  queueAutosaveAudio();
}

// Blank both generators' sources; applyPreset starts from this and the
// scope's stored clips (if any) are layered back on asynchronously.
function resetGranularSources() {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const source = getSourceState(genIdx);
    source.mode = 'mic';
    source.fileName = '';
    source.bufferData = null;
    source.frozenData = null;
    setSourceDurationSec(genIdx, LIVE_SOURCE_SECONDS);
    refreshSourceModeUI(genIdx);
    if (!genVizFrame) drawGenVizIdle(genIdx);
    if (node) syncGranularSourceState(genIdx);
  }
}

// Autosave of source audio — runs after freeze/unfreeze/file events. Tiny
// debounce only to coalesce bursts (e.g. both gens clearing at once); a
// pending write is flushed on unload so a quick refresh can't lose the clip.
let autosaveAudioTimer = null;

function queueAutosaveAudio() {
  clearTimeout(autosaveAudioTimer);
  autosaveAudioTimer = setTimeout(() => {
    autosaveAudioTimer = null;
    persistAudioForScope('autosave');
  }, 150);
}

function flushAutosaveAudio() {
  if (!autosaveAudioTimer) return;
  clearTimeout(autosaveAudioTimer);
  autosaveAudioTimer = null;
  persistAudioForScope('autosave');
}

function setGenFrozenData(genIdx, frozenData) {
  const source = getSourceState(genIdx);
  if (!source) return;
  source.frozenData = frozenData;
  queueAutosaveAudio();
}

function getStartBtn() {
  return document.getElementById('startBtn');
}

function getInputSelect() {
  return document.getElementById('inputDeviceSelect');
}

function getFrontWorkspace() {
  return document.getElementById('frontWorkspace');
}

function getBackPanel() {
  return document.getElementById('backPanel');
}

function getViewToggle() {
  return document.getElementById('viewToggle');
}

function getIdleStartButtonLabel() {
  return anyMicSourceSelected() ? '▶ Start input' : '▶ Start';
}

function getAudioWorkletErrorMessage() {
  if (location.protocol === 'file:') {
    return 'audio worklets unavailable. open the app through localhost instead of file://';
  }
  if (!window.isSecureContext) {
    return 'audio worklets unavailable. use localhost or https';
  }
  return 'audio worklets unavailable in this browser. use a browser with AudioWorklet support';
}

function createAudioContext() {
  if (!AudioContextCtor) {
    throw new Error('web audio is not supported in this browser');
  }
  const ctx = new AudioContextCtor();
  if (!ctx.audioWorklet?.addModule) {
    try {
      ctx.close?.();
    } catch (e) {}
    throw new Error(getAudioWorkletErrorMessage());
  }
  return ctx;
}

function formatInputDeviceLabel(device, idx) {
  if (!device) return `Input ${idx + 1}`;
  if (device.deviceId === 'default') return device.label || 'System Default';
  return device.label || `Input ${idx + 1}`;
}

function renderInputDevices() {
  const select = getInputSelect();
  if (!select) return;
  select.textContent = '';
  if (INPUT_SOURCE.devices.length === 0) {
    const option = document.createElement('option');
    option.value = 'default';
    option.textContent = 'No input devices';
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  INPUT_SOURCE.devices.forEach((device, idx) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = formatInputDeviceLabel(device, idx);
    select.appendChild(option);
  });
  if (!INPUT_SOURCE.devices.some((device) => device.deviceId === INPUT_SOURCE.selectedId)) {
    INPUT_SOURCE.selectedId = INPUT_SOURCE.devices[0]?.deviceId || 'default';
  }
  select.value = INPUT_SOURCE.selectedId;
  select.disabled = false;
}

async function refreshInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === 'audioinput');
    INPUT_SOURCE.devices = audioInputs.length
      ? audioInputs
      : [{ deviceId: 'default', label: 'System Default', kind: 'audioinput' }];
    renderInputDevices();
    refreshBackPanelState();
  } catch (e) {}
}

function createGranularSourceState() {
  return {
    mode: 'mic',
    durationSec: LIVE_SOURCE_SECONDS,
    fileName: '',
    bufferData: null,
    frozenData: null, // { samples, frozenAt, sampleRate } — persisted frozen take
  };
}

async function ensureAudioEngine() {
  if (!audioCtx) {
    audioCtx = createAudioContext();
    await ensureFxModules();
    buildFxNodes();
    buildGen3Nodes();
    buildGen4Nodes();
    master.output.connect(audioCtx.destination);
    ensureVizAnalyser();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!gen3ScopeFrame) startGen3Scope();
  if (!lfoAnimFrame) startLFOLoop();
  if (!started) setStatus('gen3 ready');
}

// Worklet modules are fetched via addModule AFTER page load (on the start
// gesture), so a hard reload never busts their HTTP cache entry. A unique
// query string per session guarantees the current file is what runs.
function workletUrl(file) {
  return `${file}?v=${Date.now()}`;
}

async function ensureFxModules() {
  if (!audioCtx) return;
  if (!audioCtx.audioWorklet?.addModule) {
    throw new Error(getAudioWorkletErrorMessage());
  }
  if (!bitReducerModulePromise) {
    bitReducerModulePromise = audioCtx.audioWorklet.addModule(workletUrl('bit-reducer-processor.js'));
  }
  if (!beatRepeatModulePromise) {
    beatRepeatModulePromise = audioCtx.audioWorklet.addModule(workletUrl('beat-repeat-processor.js'));
  }
  await Promise.all([bitReducerModulePromise, beatRepeatModulePromise]);
}

async function ensureGranularModule() {
  if (!audioCtx) await ensureAudioEngine();
  if (!audioCtx.audioWorklet?.addModule) {
    throw new Error(getAudioWorkletErrorMessage());
  }
  if (!granularModulePromise) {
    granularModulePromise = audioCtx.audioWorklet.addModule(workletUrl('granular-processor.js'));
  }
  await granularModulePromise;
}

async function startRecording() {
  if (REC.isRecording) return;
  await ensureAudioEngine();
  if (!master?.output || !audioCtx) return;

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

  master.output.connect(processor);
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

  if (REC.processor && master?.output) {
    try {
      master.output.disconnect(REC.processor);
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

  // Only the two granular generators take a mic/WAV source; Gen 3 is a synth scope.
  if (gi > 1) return;

  // Empty-state hint: spell out the two ways to feed this generator.
  c.save();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = '600 11px ui-monospace, monospace';
  c.fillStyle = GEN_VIZ[gi]?.line || '#3cb870';
  c.globalAlpha = 0.85;
  c.fillText('MIC — use system input', W / 2, H / 2 - 11);
  c.fillStyle = '#9aa3a3';
  c.font = '500 10px ui-monospace, monospace';
  c.fillText('or drop a .wav file here', W / 2, H / 2 + 9);
  c.restore();
}

// Static waveform of a loaded file buffer, drawn straight from the main-thread
// copy — visible while the engine is idle (e.g. right after a session restore,
// before the worklet exists to stream live viz frames).
function drawGenVizStatic(gi) {
  const c = genVizCtxs[gi],
    W = genVizW[gi],
    H = genVizH[gi];
  if (!c || !W || !H || gi > 1) return false;
  const source = getSourceState(gi);
  let data = null;
  let label = '';
  let bg = '#141414';
  if (source.mode === 'file' && source.bufferData?.length) {
    data = source.bufferData;
    label = source.fileName || 'file';
  } else if (source.mode === 'mic' && state[gi].freeze && source.frozenData?.samples?.length) {
    data = source.frozenData.samples;
    label = 'frozen take';
    bg = '#131824';
  }
  if (!data) return false;
  const mid = H / 2;
  const line = GEN_VIZ[gi]?.line || '#3cb870';

  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);

  const step = data.length / W;
  c.fillStyle = line;
  c.globalAlpha = 0.5;
  c.beginPath();
  for (let x = 0; x < W; x++) {
    let peak = 0;
    const i0 = Math.floor(x * step);
    const i1 = Math.min(data.length, Math.max(i0 + 1, Math.ceil((x + 1) * step)));
    for (let i = i0; i < i1; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    const h = Math.max(0.5, peak * H * 0.46);
    c.rect(x, mid - h, 1, h * 2);
  }
  c.fill();
  c.globalAlpha = 1;
  c.fillStyle = '#252525';
  c.fillRect(0, mid - 0.5, W, 1);

  // Read-position marker, same mapping as the live view (posX relative to end).
  const dur = Math.max(
    0.01,
    source.mode === 'file'
      ? source.durationSec
      : data.length / (source.frozenData?.sampleRate || audioCtx?.sampleRate || 48000),
  );
  const posX = Math.max(0, Math.min(1, 1 - state[gi].positionSec / dur)) * W;
  c.strokeStyle = line;
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(Math.round(posX) + 0.5, H * 0.08);
  c.lineTo(Math.round(posX) + 0.5, H * 0.92);
  c.stroke();

  c.save();
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.font = '500 9px ui-monospace, monospace';
  c.fillStyle = '#9aa3a3';
  c.globalAlpha = 0.9;
  c.fillText(label, 8, 6);
  c.restore();
  return true;
}

// Idle drawing: file sources show their waveform, everything else the hint.
function drawGenVizIdle(gi) {
  if (!drawGenVizStatic(gi)) drawGenVizEmpty(gi);
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
    drawGenVizIdle(gi);
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
  // The granular viz canvases live on the front view; skip the work (but keep
  // the loop alive so it resumes instantly) when another view is showing.
  if (UI_VIEW.mode === 'front') {
    for (let gi = 0; gi < 2; gi++) {
      stepGenVizState(gi);
      renderGenViz(gi);
    }
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
    grainSizeSync: false,
    grainSizeSyncIndex: 2,
    densitySync: false,
    densitySyncIndex: 2,
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
    grainSizeSync: false,
    grainSizeSyncIndex: 2,
    densitySync: false,
    densitySyncIndex: 2,
  },
];

const state = [{ ...GEN_DEFAULTS[0] }, { ...GEN_DEFAULTS[1] }];
const genControlBindings = [new Map(), new Map()];
const genMapBindings = [new Map(), new Map()];
const genFreezeButtons = [null, null];
const genReverseButtons = [null, null];
const genEnvButtons = [new Map(), new Map()];
const genGrainSyncModeControls = [null, null];
const genDensitySyncModeControls = [null, null];
const gen3ControlBindings = new Map();
const gen3MapBindings = new Map();
const fxControlBindings = new Map();
const lfoControlBindings = [new Map(), new Map()];
const lfoShapeButtons = [new Map(), new Map()];
const lfoSyncModeControls = [null, null];
const gen3ShapeButtons = new Map();
let gen3SusBtnEl = null;
const filterModeButtons = new Map();
let delaySyncModeControl = null;
let beatRepeatSyncModeControl = null;
let beatRepeatGridSyncModeControl = null;
const fxSectionEls = new Map(); // effect id → its draggable section element
let fxLimiterSection = null; // the pinned (non-draggable) limiter section
const delayModeButtons = new Map();
const genSourceModeButtons = [new Map(), new Map()];
const POSITION_PARAM = PARAMS.find((p) => p.key === 'positionSec');
const GRANULAR_SOURCES = [createGranularSourceState(), createGranularSourceState()];
const GRAIN_ENV_TYPES = [
  ['hann', 'HAN'],
  ['triangle', 'TRI'],
  ['sharp', 'SHP'],
  ['soft', 'SFT'],
];
const GEN3_LFO_PARAMS = [
  { key: 'gain', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'pitch', min: -24, max: 24, step: 1, unit: 'st' },
];
const FX_LFO_PARAMS = [
  { id: 'delay', key: 'time', min: 0, max: MAX_DELAY_SECONDS },
  { id: 'delay', key: 'feedback', min: 0, max: 0.95 },
  { id: 'delay', key: 'mix', min: 0, max: 1 },
  { id: 'filter', key: 'cutoff', min: 80, max: 14000 },
  { id: 'filter', key: 'q', min: 0.1, max: 20 },
  { id: 'filter', key: 'mix', min: 0, max: 1 },
  { id: 'bitreduce', key: 'rate', min: 0.02, max: 1 },
  { id: 'bitreduce', key: 'mix', min: 0, max: 1 },
  { id: 'reverb', key: 'predelay', min: 0, max: 0.25 },
  { id: 'reverb', key: 'mix', min: 0, max: 1 },
];
const BACK_AUDIO_CHAIN = [
  { id: 'input-1', title: 'Input A' },
  { id: 'gen-1', title: 'Gen 1' },
  { id: 'input-2', title: 'Input B' },
  { id: 'gen-2', title: 'Gen 2' },
  { id: 'gen-3', title: 'Gen 3' },
  { id: 'mix', title: 'Mix Bus' },
  { id: 'delay', title: 'Delay' },
  { id: 'filter', title: 'Filter' },
  { id: 'bitreduce', title: 'Bit Reduce' },
  { id: 'sat', title: 'Saturation' },
  { id: 'reverb', title: 'Reverb' },
  { id: 'limiter', title: 'Limiter' },
  { id: 'output', title: 'Output' },
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
  refreshBackPanelState();
}

function clearFreezeStates({ send = true } = {}) {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    state[genIdx].freeze = false;
    setGenFrozenData(genIdx, null);
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
  refreshBackPanelState();
}

function setGranularRunning() {
  started = true;
  getStartBtn().textContent = '■ Stop';
  refreshGeneratorUI(0);
  refreshGeneratorUI(1);
  startLFOLoop();
  startGenVizLoop();
  setStatus(getGranularStatusText());
  refreshBackPanelState();
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
  refreshModulationVisuals();
  refreshBackPanelState();
}

function getGrainSyncStep(syncIndex) {
  return GRAIN_SYNC_STEPS[clamp(Math.round(syncIndex), 0, GRAIN_SYNC_STEPS.length - 1)];
}
function getGrainSizeSyncMs(genIdx) {
  return beatsToSeconds(getGrainSyncStep(state[genIdx].grainSizeSyncIndex).beats) * 1000;
}
function getDensitySyncValue(genIdx) {
  return 1 / beatsToSeconds(getGrainSyncStep(state[genIdx].densitySyncIndex).beats);
}

function getEffectiveGeneratorParams(genIdx) {
  const effective = { ...state[genIdx] };
  if (effective.grainSizeSync) effective.grainSizeMs = getGrainSizeSyncMs(genIdx);
  if (effective.densitySync) effective.density = getDensitySyncValue(genIdx);
  if (lfoMappings.size > 0) {
    lfoMappings.forEach(({ genIdx: gi, key, sourceIdx }) => {
      if (gi !== genIdx) return;
      const paramDef = getParamBounds(genIdx, key);
      const scaled = getModSourceScaledValue(sourceIdx);
      if (!paramDef || scaled === null) return;
      const half = (paramDef.max - paramDef.min) * 0.5;
      effective[key] = Math.max(
        paramDef.min,
        Math.min(paramDef.max, effective[key] + scaled * half),
      );
    });
  }
  return effective;
}

function getGen3ParamBounds(key) {
  return GEN3_LFO_PARAMS.find((param) => param.key === key) || null;
}

function getFxParamBounds(id, key) {
  return FX_LFO_PARAMS.find((param) => param.id === id && param.key === key) || null;
}

function getEffectiveGen3Params() {
  const effective = {
    gain: GEN3.gain,
    pitch: GEN3.pitch,
    detune: GEN3.detune,
  };
  if (lfoMappings.size > 0) {
    lfoMappings.forEach(({ genIdx, key, sourceIdx }) => {
      if (genIdx !== 2) return;
      const paramDef = getGen3ParamBounds(key);
      const scaled = getModSourceScaledValue(sourceIdx);
      if (!paramDef || scaled === null) return;
      const half = (paramDef.max - paramDef.min) * 0.5;
      effective[key] = Math.max(
        paramDef.min,
        Math.min(paramDef.max, effective[key] + scaled * half),
      );
    });
  }
  return effective;
}

function getModSourceScaledValue(sourceIdx) {
  if (sourceIdx === 0 || sourceIdx === 1) {
    const lfo = LFOS[sourceIdx];
    return lfo ? lfo.currentValue * lfo.depth : null;
  }
  if (sourceIdx === 2) {
    return STEP_SEQ.currentValue;
  }
  if (sourceIdx === 3) {
    return -KICK_SC.envelope * 2 * KICK_SC.amount;
  }
  return null;
}

function getBaseFxValue(id, key, busId = activeBus) {
  if (id === 'delay' && key === 'time') return getDelayTimeSeconds(busId);
  if (id === 'beatrepeat' && key === 'interval') return getBeatRepeatIntervalSeconds(busId);
  if (id === 'beatrepeat' && key === 'grid') return getBeatRepeatGridSeconds(busId);
  return fxStates[busId][id]?.[key];
}

function getEffectiveFxValue(id, key, busId = activeBus) {
  const base = getBaseFxValue(id, key, busId);
  // FX modulation routing is global across buses (one mapping wobbles every
  // bus's copy of the param, each added to that bus's own base value).
  const mapping = lfoMappings.get(`3:${id}:${key}`);
  const paramDef = getFxParamBounds(id, key);
  if (!mapping || !paramDef) return base;
  const scaled = getModSourceScaledValue(mapping.sourceIdx);
  if (scaled === null) return base;
  const half = (paramDef.max - paramDef.min) * 0.5;
  return Math.max(paramDef.min, Math.min(paramDef.max, base + scaled * half));
}

let modVisualsActive = false; // were modulation visuals showing last frame?

function applyMappedModulationTargets() {
  const hasMappings = lfoMappings.size > 0;
  if (hasMappings) {
    const gens = new Set([...lfoMappings.values()].map((m) => m.genIdx));
    gens.forEach((gi) => {
      if (gi === 2) applyGen3Modulation();
      else if (gi === 3) applyFxModulation();
      else if (gi === 4) applyGen4Modulation();
      else sendParams(gi);
    });
  }
  // Visual refreshes only matter for the panel currently on screen. Skip the
  // front-control mod visuals once there's nothing to show (one extra frame to
  // clear), and only run the back panel's live meter while the back view is up.
  if (UI_VIEW.mode === 'front' && (hasMappings || modVisualsActive)) refreshModulationVisuals();
  if (UI_VIEW.mode === 'back') refreshBackPanelState();
  modVisualsActive = hasMappings;
}

function sendParams(genIdx) {
  if (!node) return;
  const effective = getEffectiveGeneratorParams(genIdx);
  node.port.postMessage({ type: 'params', gen: genIdx, value: effective });
}

function applyGen3Modulation() {
  if (!GEN3.nodes || !audioCtx) return;
  const effective = getEffectiveGen3Params();
  GEN3.nodes.gain.gain.setTargetAtTime(effective.gain, audioCtx.currentTime, 0.02);
  GEN3.activeNotes.forEach((entry) => {
    applyGen3VoicePitch(entry, effective);
  });
}

function applyFxModulation() {
  // Each bus owns its own copy of every effect; apply base or modulated value
  // per bus so a wobble set on one instrument stays on that instrument.
  FX_BUS_IDS.forEach((busId) => {
    FX_LFO_PARAMS.forEach(({ id, key }) => {
      applyFx(id, key, getEffectiveFxValue(id, key, busId), busId);
    });
  });
}

function applyGen4Modulation() {
  // drum params are one-shots; effective values read at trigger time in gen4FireChannel
}

function refreshModulationVisuals() {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const effective = getEffectiveGeneratorParams(genIdx);
    PARAMS.forEach(({ key }) => {
      const control = genControlBindings[genIdx].get(key);
      const mapped = lfoMappings.has(`${genIdx}:${key}`);
      control?.setModValue(mapped ? effective[key] : null);
    });
  }

  const gen3Effective = getEffectiveGen3Params();
  GEN3_LFO_PARAMS.forEach(({ key }) => {
    const control = gen3ControlBindings.get(key);
    const mapped = lfoMappings.has(`2:${key}`);
    control?.setModValue(mapped ? gen3Effective[key] : null);
  });

  FX_LFO_PARAMS.forEach(({ id, key }) => {
    const control = fxControlBindings.get(`${id}:${key}`);
    const mapped = lfoMappings.has(`3:${id}:${key}`);
    if (!mapped) {
      control?.setModValue(null);
      return;
    }
    if (id === 'delay' && key === 'time' && FX.delay.sync) {
      control?.setModValue(null);
      return;
    }
    control?.setModValue(getEffectiveFxValue(id, key));
  });

  gen4ControlBindings.forEach((ctrlMap, ci) => {
    const def = GEN4_DEFS[ci];
    const effective = getEffectiveGen4Params(ci);
    def.paramDefs.forEach((pd) => {
      const ctrl = ctrlMap.get(pd.key);
      const mapped = lfoMappings.has(`4:${def.id}:${pd.key}`);
      ctrl?.setModValue(mapped ? effective[pd.key] : null);
    });
  });
}

function refreshGenGrainSizeSyncUI(genIdx) {
  const isSync = state[genIdx].grainSizeSync;
  const ctrl = genControlBindings[genIdx].get('grainSizeMs');
  if (ctrl) {
    if (isSync) {
      const idx = state[genIdx].grainSizeSyncIndex;
      ctrl.setConfig({ ...GRAIN_SYNC_CONTROL, label: 'Grain size', resetValue: idx });
      ctrl.setValue(idx);
      ctrl.setFormatter((v) => getGrainSyncStep(Math.round(v)).label);
    } else {
      const p = PARAMS.find((q) => q.key === 'grainSizeMs');
      ctrl.setConfig({ ...p, resetValue: state[genIdx].grainSizeMs });
      ctrl.setValue(state[genIdx].grainSizeMs);
      ctrl.setFormatter(null);
    }
  }
  genGrainSyncModeControls[genIdx]?.setMode(isSync ? 'sync' : 'free');
}

function refreshGenDensitySyncUI(genIdx) {
  const isSync = state[genIdx].densitySync;
  const ctrl = genControlBindings[genIdx].get('density');
  if (ctrl) {
    if (isSync) {
      const idx = state[genIdx].densitySyncIndex;
      ctrl.setConfig({ ...GRAIN_SYNC_CONTROL, label: 'Density', resetValue: idx });
      ctrl.setValue(idx);
      ctrl.setFormatter((v) => getGrainSyncStep(Math.round(v)).label);
    } else {
      const p = PARAMS.find((q) => q.key === 'density');
      ctrl.setConfig({ ...p, resetValue: state[genIdx].density });
      ctrl.setValue(state[genIdx].density);
      ctrl.setFormatter(null);
    }
  }
  genDensitySyncModeControls[genIdx]?.setMode(isSync ? 'sync' : 'free');
}

function refreshGeneratorUI(genIdx) {
  PARAMS.forEach(({ key }) => {
    if (key === 'grainSizeMs' || key === 'density') return; // handled by sync refresh
    genControlBindings[genIdx].get(key)?.setValue(state[genIdx][key]);
  });
  refreshGenGrainSizeSyncUI(genIdx);
  refreshGenDensitySyncUI(genIdx);
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
      genMapBindings[genIdx].get(key)?.setMapLFO(mapping ? mapping.sourceIdx : null);
    });
  }
  GEN3_LFO_PARAMS.forEach(({ key }) => {
    const mapping = lfoMappings.get(`2:${key}`);
    gen3MapBindings.get(key)?.setMapLFO(mapping ? mapping.sourceIdx : null);
  });
  FX_LFO_PARAMS.forEach(({ id, key }) => {
    const mapping = lfoMappings.get(`3:${id}:${key}`);
    fxControlBindings.get(`${id}:${key}`)?.setMapLFO(mapping ? mapping.sourceIdx : null);
  });
  gen4ControlBindings.forEach((ctrlMap, ci) => {
    const def = GEN4_DEFS[ci];
    def.paramDefs.forEach((pd) => {
      const mapping = lfoMappings.get(`4:${def.id}:${pd.key}`);
      ctrlMap.get(pd.key)?.setMapLFO(mapping ? mapping.sourceIdx : null);
    });
  });
  refreshModulationVisuals();
  refreshBackPanelState();
}

function setLFOLedState(led, sourceIdx) {
  led.classList.remove('active', 'lfo-1', 'lfo-2', 'lfo-seq');
  led.dataset.lfo = '';
  led.textContent = '';
  led.title = 'Map: unset';
  if (sourceIdx === null) return;
  if (sourceIdx === 2) {
    led.classList.add('active', 'lfo-seq');
    led.dataset.lfo = 'S';
    led.textContent = 'S';
    led.title = 'Map: Seq';
    return;
  }
  if (sourceIdx === 3) {
    led.classList.add('active', 'lfo-sc');
    led.dataset.lfo = 'K';
    led.textContent = 'K';
    led.title = 'Map: Kick SC';
    return;
  }
  led.classList.add('active', `lfo-${sourceIdx + 1}`);
  led.dataset.lfo = `${sourceIdx + 1}`;
  led.textContent = `${sourceIdx + 1}`;
  led.title = `Map: LFO ${sourceIdx + 1}`;
}

function makeControlRow(p, initialValue, onInput, lfoTarget = null) {
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

  if (lfoTarget !== null) {
    led = document.createElement('button');
    led.className = 'lfo-led';
    led.type = 'button';
    setLFOLedState(led, null);
    led.addEventListener('click', (e) => {
      e.stopPropagation();
      setLFOLedState(led, cycleLFOMap(lfoTarget.genIdx, lfoTarget.key));
    });
    led.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openModSourceMenu(lfoTarget, led, e.clientX, e.clientY);
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
  row.setModValue = (v) => {
    knob.setModValue?.(v);
  };
  row.setModNorm = (n) => {
    knob.setModNorm?.(n);
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

function buildGenSyncToggle(onToggle) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gen-sync-toggle';
  btn.textContent = 'FREE';
  btn.addEventListener('click', () => onToggle());
  btn.setMode = (mode) => {
    const sync = mode === 'sync';
    btn.classList.toggle('active', sync);
    btn.textContent = sync ? 'SYNC' : 'FREE';
  };
  return btn;
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
    modR = 17.5,
    sw = 3;
  const S = -135,
    E = 135; // 7 o'clock → 5 o'clock (270° sweep)
  const clamp01 = (n) => Math.max(0, Math.min(1, n));

  let spec = { resetValue: initialValue, ...p };
  let currentValue = initialValue;
  let currentModNorm = null;
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

  function polar(deg, radius = r) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  }
  function arc(a, b, radius = r) {
    if (b - a < 0.5) return '';
    const [sx, sy] = polar(a, radius),
      [ex, ey] = polar(b, radius);
    return `M${sx.toFixed(2)},${sy.toFixed(2)}A${radius},${radius},0,${b - a > 180 ? 1 : 0},1,${ex.toFixed(2)},${ey.toFixed(2)}`;
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

  const modArc = document.createElementNS(NS, 'path');
  modArc.setAttribute('stroke-width', '2');
  modArc.setAttribute('fill', 'none');
  modArc.setAttribute('stroke-linecap', 'round');
  modArc.classList.add('knob-mod-value');

  const body = document.createElementNS(NS, 'circle');
  body.setAttribute('cx', cx);
  body.setAttribute('cy', cy);
  body.setAttribute('r', r - 5);
  body.classList.add('knob-body');

  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', '2');
  dot.classList.add('knob-dot');

  const modDot = document.createElementNS(NS, 'circle');
  modDot.setAttribute('r', '1.7');
  modDot.classList.add('knob-mod-dot');

  svg.append(track, modArc, valArc, body, modDot, dot);

  let norm = toNorm(initialValue);

  function renderModNorm(n) {
    currentModNorm = n === null ? null : clamp01(n);
    if (currentModNorm === null || Math.abs(currentModNorm - norm) < 0.002) {
      modArc.setAttribute('d', '');
      modDot.setAttribute('opacity', '0');
      return;
    }
    const start = S + Math.min(norm, currentModNorm) * (E - S);
    const end = S + Math.max(norm, currentModNorm) * (E - S);
    modArc.setAttribute('d', arc(start, end, modR));
    const modDeg = S + currentModNorm * (E - S);
    const modRad = ((modDeg - 90) * Math.PI) / 180;
    modDot.setAttribute('cx', (cx + modR * Math.cos(modRad)).toFixed(2));
    modDot.setAttribute('cy', (cy + modR * Math.sin(modRad)).toFixed(2));
    modDot.setAttribute('opacity', '1');
  }

  function renderNorm(n) {
    norm = clamp01(n);
    const deg = S + norm * (E - S);
    valArc.setAttribute('d', norm < 0.005 ? '' : arc(S, deg));
    const dr = r - sw / 2 - 1.5,
      rad = ((deg - 90) * Math.PI) / 180;
    dot.setAttribute('cx', (cx + dr * Math.cos(rad)).toFixed(2));
    dot.setAttribute('cy', (cy + dr * Math.sin(rad)).toFixed(2));
    renderModNorm(currentModNorm);
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
  svg.setModValue = (v) => {
    if (v === null || v === undefined) {
      renderModNorm(null);
      return;
    }
    renderModNorm(toNorm(v));
  };
  svg.setModNorm = (n) => {
    if (n === null || n === undefined) {
      renderModNorm(null);
      return;
    }
    renderModNorm(n);
  };
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
    // On freeze the worklet answers with a 'frozen-dump' that gets persisted;
    // on unfreeze the stored take is dropped.
    if (!state[genIdx].freeze) setGenFrozenData(genIdx, null);
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
    drawGenVizIdle(genIdx);
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
    const onChange =
      p.key === 'grainSizeMs'
        ? (v) => {
            if (state[genIdx].grainSizeSync) state[genIdx].grainSizeSyncIndex = Math.round(v);
            else setGeneratorParam(genIdx, p.key, v);
            sendParams(genIdx);
          }
        : p.key === 'density'
          ? (v) => {
              if (state[genIdx].densitySync) state[genIdx].densitySyncIndex = Math.round(v);
              else setGeneratorParam(genIdx, p.key, v);
              sendParams(genIdx);
            }
          : (v) => setGeneratorParam(genIdx, p.key, v);
    const control = makeControlRow(p, defaults[p.key], onChange, { genIdx, key: p.key });
    genControlBindings[genIdx].set(p.key, control);
    genMapBindings[genIdx].set(p.key, control);
    rows.appendChild(control);
    if (p.key === 'grainSizeMs') {
      const btn = buildGenSyncToggle(() => {
        state[genIdx].grainSizeSync = !state[genIdx].grainSizeSync;
        refreshGenGrainSizeSyncUI(genIdx);
        sendParams(genIdx);
      });
      genGrainSyncModeControls[genIdx] = btn;
      rows.appendChild(btn);
    }
    if (p.key === 'density') {
      const btn = buildGenSyncToggle(() => {
        state[genIdx].densitySync = !state[genIdx].densitySync;
        refreshGenDensitySyncUI(genIdx);
        sendParams(genIdx);
      });
      genDensitySyncModeControls[genIdx] = btn;
      rows.appendChild(btn);
    }
  });
  rows.appendChild(buildGeneratorReverseControl(genIdx));
  rows.appendChild(buildGeneratorShapeControl(genIdx));

  panel.appendChild(rows);
  refreshGeneratorUI(genIdx);
  refreshSourceModeUI(genIdx);
  return panel;
}

// ─── Visualizer ──────────────────────────────────────────────────────────────

let vizAnalyser = null;

// Five moods with distinct visual character. dur = [min, max] in idleT units.
// idleT += 0.01/frame → 1 unit ≈ 1.67 seconds → 36 units ≈ 1 minute.
const VIZ_STATES = [
  { label: 'nebula',  dur: [25, 45], trailAlpha: 0.030, warpMult: 0.45, orbitStr: 0.38, turbStr: 0.50, hueVel: 0.035, hueTarget:  30, maxP: 1600, sat: 75, lum: 48 },
  { label: 'warp',    dur: [18, 32], trailAlpha: 0.062, warpMult: 2.80, orbitStr: 0.16, turbStr: 0.25, hueVel: 0.180, hueTarget: 185, maxP:  700, sat: 95, lum: 68 },
  { label: 'chaos',   dur: [14, 26], trailAlpha: 0.078, warpMult: 1.60, orbitStr: 0.78, turbStr: 1.90, hueVel: 0.320, hueTarget: null,maxP: 1400, sat:100, lum: 62 },
  { label: 'void',    dur: [28, 50], trailAlpha: 0.020, warpMult: 0.85, orbitStr: 0.28, turbStr: 0.20, hueVel: 0.012, hueTarget: 270, maxP:  450, sat: 52, lum: 36 },
  { label: 'storm',   dur: [14, 24], trailAlpha: 0.092, warpMult: 2.20, orbitStr: 1.02, turbStr: 1.40, hueVel: 0.220, hueTarget: 320, maxP: 1800, sat: 90, lum: 58 },
];

const VIZ = {
  canvas: null,
  ctx: null,
  animId: null,
  freqBuf: null,
  timeBuf: null,
  particles: [],
  warp: [],
  beatEnergyAvg: 0,
  beatCooldown: 0,
  beatFlash: 0,
  flowTime: 0,
  masterHue: 200,
  idleT: 0,
  // State machine
  stateIdx: 0,
  stateTimer: 0,
  stateDur: 30,
  // Current interpolated params (lerp toward active state's targets)
  p: {
    trailAlpha: 0.040,
    warpMult:   1.00,
    orbitStr:   0.55,
    turbStr:    0.70,
    hueVel:     0.07,
    maxP:       1600,
    sat:        85,
    lum:        55,
  },
};

function ensureVizAnalyser() {
  if (vizAnalyser || !audioCtx || !master?.output) return;
  vizAnalyser = audioCtx.createAnalyser();
  vizAnalyser.fftSize = 2048;
  vizAnalyser.smoothingTimeConstant = 0.84;
  master.output.connect(vizAnalyser);
  VIZ.freqBuf = new Uint8Array(vizAnalyser.frequencyBinCount);
  VIZ.timeBuf = new Uint8Array(vizAnalyser.fftSize);
}

function buildVisualPanel() {
  const panel = document.getElementById('visualPanel');
  if (!panel) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'viz-canvas';
  panel.appendChild(canvas);
  VIZ.canvas = canvas;
  VIZ.ctx = canvas.getContext('2d');
  const ro = new ResizeObserver(() => {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  });
  ro.observe(canvas);
}

function startViz() {
  if (VIZ.animId) return;
  ensureVizAnalyser();
  (function frame() {
    VIZ.animId = requestAnimationFrame(frame);
    renderViz();
  })();
}

function stopViz() {
  if (VIZ.animId) cancelAnimationFrame(VIZ.animId);
  VIZ.animId = null;
}

function vizFlowField(x, y, cx, cy, t, bass, mid, orbitStr, turbStr) {
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const orb = (orbitStr + bass * 1.3) / dist;
  const ox = -dy * orb;
  const oy =  dx * orb;
  const s = 0.0035;
  const a = Math.sin(x * s + t * 0.38) * Math.cos(y * s * 0.9 - t * 0.27) * (turbStr + mid * 1.2);
  return { vx: ox + Math.cos(a * 6.28), vy: oy + Math.sin(a * 6.28) };
}

function renderViz() {
  const { canvas, ctx } = VIZ;
  if (!canvas || !ctx || canvas.width === 0) return;

  ensureVizAnalyser();

  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const minDim = Math.min(W, H);
  VIZ.idleT += 0.01;

  // ── State machine ─────────────────────────────────────────────
  VIZ.stateTimer += 0.01;
  if (VIZ.stateTimer >= VIZ.stateDur) {
    VIZ.stateIdx = (VIZ.stateIdx + 1) % VIZ_STATES.length;
    VIZ.stateTimer = 0;
    const nd = VIZ_STATES[VIZ.stateIdx].dur;
    VIZ.stateDur = nd[0] + Math.random() * (nd[1] - nd[0]);
  }
  const st = VIZ_STATES[VIZ.stateIdx];
  const vp = VIZ.p;
  const lp = 0.008;
  vp.trailAlpha += (st.trailAlpha - vp.trailAlpha) * lp;
  vp.warpMult   += (st.warpMult   - vp.warpMult)   * lp;
  vp.orbitStr   += (st.orbitStr   - vp.orbitStr)   * lp;
  vp.turbStr    += (st.turbStr    - vp.turbStr)    * lp;
  vp.hueVel     += (st.hueVel     - vp.hueVel)     * lp;
  vp.maxP       += (st.maxP       - vp.maxP)       * lp;
  vp.sat        += (st.sat        - vp.sat)        * lp;
  vp.lum        += (st.lum        - vp.lum)        * lp;

  // ── Audio data ────────────────────────────────────────────────
  if (vizAnalyser && VIZ.freqBuf) vizAnalyser.getByteFrequencyData(VIZ.freqBuf);
  const freq = VIZ.freqBuf;
  const fLen = freq ? freq.length : 1024;

  function bandE(s, e) {
    if (!freq) return 0;
    let sum = 0;
    for (let i = s; i < e && i < fLen; i++) sum += freq[i];
    return sum / ((e - s) * 255);
  }
  const bassE = bandE(0, 5);
  const midE  = bandE(5, 40);
  const highE = bandE(40, 120);
  const allE  = bandE(0, 100);

  // ── Beat detection ────────────────────────────────────────────
  VIZ.beatEnergyAvg = VIZ.beatEnergyAvg * 0.93 + bassE * 0.07;
  const isBeat = VIZ.beatCooldown <= 0 && bassE > VIZ.beatEnergyAvg * 1.6 && bassE > 0.1;
  if (isBeat) {
    VIZ.beatCooldown = 14;
    VIZ.beatFlash = 1.0;
    const n = 55 + Math.floor(bassE * 90);
    for (let i = 0; i < n && VIZ.particles.length < Math.floor(vp.maxP * 1.1); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      const bx = cx + (Math.random() - 0.5) * minDim * 0.08;
      const by = cy + (Math.random() - 0.5) * minDim * 0.08;
      VIZ.particles.push({
        x: bx, y: by, px: bx, py: by,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 0.007 + Math.random() * 0.01,
        hue: (VIZ.masterHue + Math.random() * 80 - 40 + 360) % 360,
        size: 1.5 + Math.random() * 3,
      });
    }
  }
  if (VIZ.beatCooldown > 0) VIZ.beatCooldown--;
  VIZ.beatFlash *= 0.85;

  // Ambient trickle — keep field alive even without beats
  const trickle = 2 + Math.floor(allE * 10);
  for (let i = 0; i < trickle && VIZ.particles.length < Math.floor(vp.maxP); i++) {
    const px = Math.random() * W, py = Math.random() * H;
    VIZ.particles.push({
      x: px, y: py, px, py,
      vx: 0, vy: 0,
      life: 0.5 + Math.random() * 0.5,
      decay: 0.002 + Math.random() * 0.003,
      hue: (VIZ.masterHue + Math.random() * 200 - 100 + 360) % 360,
      size: 0.6 + Math.random() * 1.6,
    });
  }

  // Warp tunnel — particles born near centre, fly radially outward
  const warpRate = Math.floor((2 + allE * 10) * vp.warpMult);
  const warpCap  = Math.floor(300 * Math.max(0.3, vp.warpMult));
  for (let i = 0; i < warpRate && VIZ.warp.length < warpCap; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * minDim * 0.04;
    const wx = cx + Math.cos(angle) * r;
    const wy = cy + Math.sin(angle) * r;
    VIZ.warp.push({
      x: wx, y: wy, px: wx, py: wy,
      angle,
      speed: (0.4 + Math.random() * 1.2) * Math.max(0.4, vp.warpMult),
      life: 1,
      decay: 0.008 + Math.random() * 0.007,
      hue: 170 + Math.random() * 70,  // teal → cyan
      width: 0.4 + Math.random() * 0.9,
    });
  }

  VIZ.flowTime += 0.007 + allE * 0.05;
  // Advance hue at state-driven velocity, then nudge toward hueTarget (shortest arc)
  VIZ.masterHue = (VIZ.masterHue + vp.hueVel + highE * 0.5 + 360) % 360;
  if (st.hueTarget != null) {
    const diff = ((st.hueTarget - VIZ.masterHue) + 540) % 360 - 180;
    VIZ.masterHue = (VIZ.masterHue + diff * 0.003 + 360) % 360;
  }

  // ── 1. Background fade — alpha from state drives trail length ──
  ctx.fillStyle = `rgba(4, 3, 6, ${vp.trailAlpha + allE * 0.03})`;
  ctx.fillRect(0, 0, W, H);

  // ── 2. Warp tunnel — radial streaks from centre ───────────────
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = VIZ.warp.length - 1; i >= 0; i--) {
    const p = VIZ.warp[i];
    p.px = p.x; p.py = p.y;
    p.speed *= 1.028 + allE * 0.04;  // accelerate; audio boosts it
    p.x += Math.cos(p.angle) * p.speed;
    p.y += Math.sin(p.angle) * p.speed;
    p.life -= p.decay;
    if (p.life <= 0 || p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) {
      VIZ.warp.splice(i, 1); continue;
    }
    const alpha = p.life * (0.35 + allE * 0.5);
    ctx.strokeStyle = `hsla(${p.hue}, 90%, ${70 + allE * 20}%, ${alpha})`;
    ctx.lineWidth = p.width * (1 + allE * 1.5);
    ctx.beginPath();
    ctx.moveTo(p.px, p.py);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  ctx.restore();

  // ── 3. Orbital flow particles — drawn as streaks ──────────────
  const ft = VIZ.flowTime;
  const velMult = 1 + allE * 3.5 + bassE * 2;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = VIZ.particles.length - 1; i >= 0; i--) {
    const p = VIZ.particles[i];
    // Save trail origin before moving
    p.px = p.x; p.py = p.y;
    const field = vizFlowField(p.x, p.y, cx, cy, ft, bassE, midE, vp.orbitStr, vp.turbStr);
    p.vx = p.vx * 0.82 + field.vx * velMult * 0.18;
    p.vy = p.vy * 0.82 + field.vy * velMult * 0.18;
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    if (p.life <= 0 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) {
      VIZ.particles.splice(i, 1); continue;
    }
    const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const alpha = p.life * Math.min(0.9, 0.25 + spd * 0.1 + allE * 0.35);
    const h = (p.hue + spd * 9) % 360;
    const lw = Math.max(0.4, p.size * (0.5 + allE * 1.2) * p.life);
    ctx.strokeStyle = `hsla(${h}, ${Math.round(vp.sat)}%, ${Math.round(vp.lum + Math.min(spd * 4, 22))}%, ${alpha})`;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(p.px, p.py);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  ctx.restore();

  // ── 5. Beat flash ─────────────────────────────────────────────
  if (VIZ.beatFlash > 0.02) {
    const fg = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.65);
    fg.addColorStop(0,    `rgba(255, 245, 255, ${VIZ.beatFlash * 0.22})`);
    fg.addColorStop(0.45, `rgba(190, 160, 255, ${VIZ.beatFlash * 0.08})`);
    fg.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = fg;
    ctx.fillRect(0, 0, W, H);
  }

  // ── 6. Vignette ───────────────────────────────────────────────
  // Static for a given canvas size — rebuild only when the canvas resizes.
  if (!VIZ.vignette || VIZ.vignetteW !== W || VIZ.vignetteH !== H) {
    const vig = ctx.createRadialGradient(cx, cy, minDim * 0.2, cx, cy, minDim * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.72)');
    VIZ.vignette = vig;
    VIZ.vignetteW = W;
    VIZ.vignetteH = H;
  }
  ctx.fillStyle = VIZ.vignette;
  ctx.fillRect(0, 0, W, H);
}

// ─── Build UI ────────────────────────────────────────────────────────────────

function buildUI() {
  const container = document.getElementById('generators');
  // Each instrument panel is tagged with its FX bus and selects that bus when
  // clicked anywhere inside — the FX column then shows that instrument's chain.
  const panels = [
    [buildGeneratorPanel(0), 'gen0'],
    [buildGeneratorPanel(1), 'gen1'],
    [buildOscPanel(), 'gen3'],
    [buildDrumPanel(), 'gen4'],
  ];
  panels.forEach(([panel, busId]) => {
    panel.dataset.bus = busId;
    panel.classList.toggle('active-instrument', busId === activeBus);
    panel.addEventListener('click', () => setActiveBus(busId));
    container.appendChild(panel);
  });
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
  pitch: 0,
  detune: 0,
  attack: 0.3,
  decay: 0.18,
  sustain: 0.7,
  release: 0.5,
  sustainMode: true,
  lockedMidis: new Set(),
  activeNotes: new Map(),
  releasingVoices: new Set(),
  nodes: null,
};
let gen3ScopeFrame = null;
let gen3ScopeBuf = null; // reused time-domain buffer for the gen3 scope
const gen3NoteEls = new Map();

function setGen3NoteActive(midi, active) {
  const el = gen3NoteEls.get(midi);
  if (!el) return;
  el.classList.toggle('active', active);
  el.classList.toggle('locked', GEN3.lockedMidis.has(midi));
}

function refreshGen3KeyStates() {
  gen3NoteEls.forEach((el, midi) => {
    el.classList.toggle('active', GEN3.activeNotes.has(midi));
    el.classList.toggle('locked', GEN3.lockedMidis.has(midi));
  });
}

function buildGen3Nodes() {
  const ac = audioCtx;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(getEffectiveGen3Params().gain, ac.currentTime);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  gain.connect(analyser);
  if (fxBuses.gen3) analyser.connect(fxBuses.gen3.input);
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
  const effective = getEffectiveGen3Params();
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
    src.frequency.setValueAtTime(freq * Math.pow(2, effective.pitch / 12), ac.currentTime);
    src.detune.setValueAtTime(effective.detune, ac.currentTime);
  }
  return src;
}

function applyGen3VoicePitch(voice, effective = getEffectiveGen3Params()) {
  if (!voice?.source || !audioCtx) return;
  if ('frequency' in voice.source && voice.source.frequency) {
    voice.source.frequency.setValueAtTime(
      voice.freq * Math.pow(2, effective.pitch / 12),
      audioCtx.currentTime,
    );
  }
  if ('detune' in voice.source && voice.source.detune) {
    voice.source.detune.setValueAtTime(effective.detune, audioCtx.currentTime);
  }
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
    refreshBackPanelState();
  }, stopAfterMs);
}

function addGen3Note(midi, freq) {
  const entry = { freq, autoReleaseTimer: null, ...createGen3Voice(freq) };
  GEN3.activeNotes.set(midi, entry);
  setGen3NoteActive(midi, true);
  if (!GEN3.sustainMode) {
    const ms = Math.max(0, GEN3.attack + GEN3.decay) * 1000;
    entry.autoReleaseTimer = setTimeout(() => removeGen3Note(midi), ms);
  }
  refreshTransportStopBtn();
  refreshBackPanelState();
}

function removeGen3Note(midi) {
  const entry = GEN3.activeNotes.get(midi);
  GEN3.activeNotes.delete(midi);
  setGen3NoteActive(midi, false);
  if (entry) {
    if (entry.autoReleaseTimer) {
      clearTimeout(entry.autoReleaseTimer);
      entry.autoReleaseTimer = null;
    }
    releaseGen3Voice(entry);
  }
  refreshTransportStopBtn();
  refreshBackPanelState();
}

function stopAllGen3Notes() {
  GEN3.activeNotes.forEach((entry) => {
    stopGen3Voice(entry);
  });
  GEN3.activeNotes.clear();
  GEN3.releasingVoices.forEach((voice) => {
    stopGen3Voice(voice);
  });
  GEN3.releasingVoices.clear();
  gen3NoteEls.forEach((_, midi) => setGen3NoteActive(midi, false));
  refreshBackPanelState();
}

function restartAllGen3Notes() {
  if (!GEN3.nodes) return;
  GEN3.releasingVoices.forEach((voice) => stopGen3Voice(voice));
  GEN3.releasingVoices.clear();
  GEN3.activeNotes.forEach((entry, midi) => {
    stopGen3Voice(entry);
    Object.assign(entry, createGen3Voice(entry.freq));
  });
  refreshBackPanelState();
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
  if (!gen3ScopeBuf || gen3ScopeBuf.length !== analyser.frequencyBinCount)
    gen3ScopeBuf = new Float32Array(analyser.frequencyBinCount);
  const data = gen3ScopeBuf;
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
  if (UI_VIEW.mode === 'front') drawGen3Scope();
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
        if (GEN3.sustainMode) {
          // Sustain mode: toggle note on/off and track in lockedMidis
          if (GEN3.activeNotes.has(midi)) {
            GEN3.lockedMidis.delete(midi);
            removeGen3Note(midi);
          } else {
            GEN3.lockedMidis.add(midi);
            await ensureAudioEngine();
            if (GEN3.nodes) addGen3Note(midi, freq);
          }
        } else {
          // Sequencer mode: toggle locked state only — sequencer drives playback
          if (GEN3.lockedMidis.has(midi)) {
            GEN3.lockedMidis.delete(midi);
            cell.classList.remove('locked');
          } else {
            GEN3.lockedMidis.add(midi);
            cell.classList.add('locked');
          }
        }
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
  const susBtn = document.createElement('button');
  susBtn.className = 'osc-sus-btn' + (GEN3.sustainMode ? ' active' : '');
  susBtn.textContent = 'SUS';
  susBtn.title = 'Sustain mode — when off, notes auto-release after attack + decay';
  gen3SusBtnEl = susBtn;
  susBtn.addEventListener('click', async () => {
    GEN3.sustainMode = !GEN3.sustainMode;
    susBtn.classList.toggle('active', GEN3.sustainMode);
    if (GEN3.sustainMode) {
      // Switched to sustain: play all locked notes
      await ensureAudioEngine();
      GEN3.lockedMidis.forEach((m) => {
        if (!GEN3.activeNotes.has(m) && GEN3.nodes) {
          addGen3Note(m, 440 * Math.pow(2, (m - 69) / 12));
        }
      });
    } else {
      // Switched to sequencer: stop all playing, keep locked visual
      stopAllGen3Notes();
      refreshGen3KeyStates();
    }
  });

  header.append(title, shapes, susBtn);
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
    { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, unit: 'st' },
    { key: 'detune', label: 'Detune', min: -100, max: 100, step: 1, unit: 'ct' },
    { key: 'attack', label: 'Attack', min: 0, max: 10, step: 0.01, unit: 's' },
    { key: 'decay', label: 'Decay', min: 0, max: 2, step: 0.01, unit: 's' },
    { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '' },
    { key: 'release', label: 'Release', min: 0, max: 10, step: 0.01, unit: 's' },
  ].forEach((p) => {
    const isMappable = p.key === 'gain' || p.key === 'pitch';
    const control = makeControlRow(
      p,
      GEN3[p.key],
      (v) => {
        GEN3[p.key] = v;
        if (GEN3.nodes && (p.key === 'gain' || p.key === 'pitch' || p.key === 'detune')) {
          applyGen3Modulation();
        }
        refreshModulationVisuals();
        refreshBackPanelState();
      },
      isMappable ? { genIdx: 2, key: p.key } : null,
    );
    gen3ControlBindings.set(p.key, control);
    if (isMappable) gen3MapBindings.set(p.key, control);
    rows.appendChild(control);
  });
  panel.appendChild(rows);
  return panel;
}

// ─── Gen 4: Glitch Drums ──────────────────────────────────────────────────

const GEN4_DEFS = [
  {
    id: 'kick',
    label: 'KICK',
    color: '#e05858',
    paramDefs: [
      { key: 'tune', label: 'Tune', min: 30, max: 120, step: 1, value: 70, unit: 'Hz' },
      { key: 'decay', label: 'Decay', min: 0.05, max: 1.0, step: 0.01, value: 0.85, unit: 's' },
      { key: 'punch', label: 'Punch', min: 0, max: 1, step: 0.01, value: 0.36, unit: '' },
      { key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
    ],
  },
  {
    id: 'snare',
    label: 'SNR',
    color: '#d4892a',
    paramDefs: [
      { key: 'tune', label: 'Tone', min: 100, max: 500, step: 5, value: 360, unit: 'Hz' },
      { key: 'decay', label: 'Decay', min: 0.05, max: 0.8, step: 0.01, value: 0.09, unit: 's' },
      { key: 'snap', label: 'Snap', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.96, unit: '' },
    ],
  },
  {
    id: 'hat',
    label: 'HAT',
    color: '#7ad860',
    paramDefs: [
      { key: 'decay', label: 'Decay', min: 0.005, max: 0.5, step: 0.005, value: 0.06, unit: 's' },
      { key: 'tone', label: 'Tone', min: 3000, max: 16000, step: 200, value: 11200, unit: 'Hz' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.6, unit: '' },
    ],
  },
  {
    id: 'perc',
    label: 'PERC',
    color: '#9f7de8',
    paramDefs: [
      { key: 'tune', label: 'Tune', min: 80, max: 800, step: 5, value: 165, unit: 'Hz' },
      { key: 'ratio', label: 'Ratio', min: 0.5, max: 8, step: 0.1, value: 1.6, unit: '' },
      { key: 'index', label: 'Index', min: 0, max: 10, step: 0.1, value: 1.6, unit: '' },
      { key: 'decay', label: 'Decay', min: 0.03, max: 0.6, step: 0.01, value: 0.06, unit: 's' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.7, unit: '' },
    ],
  },
  {
    id: 'osc',
    label: 'OSC',
    color: '#40b8d0',
    paramDefs: [],
  },
];

let gen4StepCountBtns = [];

const GEN4 = {
  playing: false,
  schedulerStep: -1,
  displayStep: -1,
  nextStepTime: 0,
  schedulerTimer: null,
  scheduleAheadTime: 0.1,
  scheduleInterval: 25,
  stepCount: 16,
  nodes: null,
  channels: GEN4_DEFS.map((def) => {
    return {
      id: def.id,
      muted: false,
      fxSend: def.id !== 'kick',
      steps: new Array(32).fill(false),
      velocity: new Array(32).fill(1.0),
      stutter: new Array(32).fill(1),
      probability: new Array(32).fill(1.0),
      params: Object.fromEntries(def.paramDefs.map((p) => [p.key, p.value])),
    };
  }),
};

const KICK_SC = {
  envelope: 0,
  release: 0.2,
  amount: 1.0,
};

const gen4Schedule = [];
const gen4StepEls = GEN4_DEFS.map(() => new Array(32).fill(null));
const gen4ControlBindings = GEN4_DEFS.map(() => new Map());
let gen4PlayBtnEl = null;
let gen4DisplayFrame = null;
const gen4DragState = { active: false, ci: 0, si: 0, startY: 0, startVel: 1 };

addEventListener('mousemove', (e) => {
  if (!gen4DragState.active) return;
  const { ci, si, startY, startVel } = gen4DragState;
  const next = clamp(startVel + (startY - e.clientY) / 80, 0.05, 1.0);
  GEN4.channels[ci].velocity[si] = next;
  gen4StepEls[ci][si]?.style.setProperty('--step-velocity', next);
});

window.addEventListener('mouseup', () => {
  gen4DragState.active = false;
});

function buildGen4Nodes() {
  if (!audioCtx || GEN4.nodes) return;
  const ac = audioCtx;

  const noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < ac.sampleRate; i++) noiseData[i] = Math.random() * 2 - 1;

  const channelOuts = GEN4.channels.map((ch) => {
    const g = ac.createGain();
    g.gain.value = 1.0;
    // Drum channels share the drums bus; bypass routes straight to the mix sum.
    g.connect(ch.fxSend ? fxBuses.gen4.input : master.sum);
    return g;
  });

  GEN4.nodes = { channelOuts, noiseBuf };
}

const gen4FxSendBtns = [];

function gen4SetChannelFxSend(ci, send) {
  const ch = GEN4.channels[ci];
  ch.fxSend = send;
  if (GEN4.nodes?.channelOuts?.[ci] && fxBuses.gen4 && master) {
    const out = GEN4.nodes.channelOuts[ci];
    try {
      out.disconnect();
    } catch (e) {}
    out.connect(send ? fxBuses.gen4.input : master.sum);
  }
  const btn = gen4FxSendBtns[ci];
  if (btn) btn.classList.toggle('active', send);
}

function gen4DistortionCurve(amount) {
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function gen4TriggerKick(time, velocity, p, dest) {
  KICK_SC.envelope = 1.0;
  const ac = audioCtx;
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(p.tune * (1 + p.punch * 4), time);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(p.tune * 0.08, 18),
    time + p.punch * 0.15 + 0.005,
  );

  const shaper = ac.createWaveShaper();
  shaper.curve = gen4DistortionCurve(p.drive * 300 + 1);
  shaper.oversample = '2x';

  const env = ac.createGain();
  env.gain.setValueAtTime(0.001, time);
  env.gain.linearRampToValueAtTime(velocity * p.gain, time + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, time + p.decay);

  osc.connect(shaper);
  shaper.connect(env);
  env.connect(dest);
  osc.start(time);
  osc.stop(time + p.decay + 0.05);
}

function gen4TriggerSnare(time, velocity, p, dest) {
  const ac = audioCtx;

  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(p.tune, time);
  osc.frequency.exponentialRampToValueAtTime(Math.max(p.tune * 0.5, 20), time + p.decay * 0.3);
  const oscEnv = ac.createGain();
  oscEnv.gain.setValueAtTime(0.001, time);
  oscEnv.gain.linearRampToValueAtTime(velocity * p.gain * p.snap, time + 0.002);
  oscEnv.gain.exponentialRampToValueAtTime(0.001, time + p.decay * 0.6);
  osc.connect(oscEnv);
  oscEnv.connect(dest);

  const noise = ac.createBufferSource();
  noise.buffer = GEN4.nodes.noiseBuf;
  const bpf = ac.createBiquadFilter();
  bpf.type = 'bandpass';
  bpf.frequency.value = p.tune * 1.5;
  bpf.Q.value = 0.7;
  const noiseEnv = ac.createGain();
  noiseEnv.gain.setValueAtTime(0.001, time);
  noiseEnv.gain.linearRampToValueAtTime(velocity * p.gain * (1 - p.snap * 0.3), time + 0.001);
  noiseEnv.gain.exponentialRampToValueAtTime(0.001, time + p.decay);
  noise.connect(bpf);
  bpf.connect(noiseEnv);
  noiseEnv.connect(dest);

  osc.start(time);
  osc.stop(time + p.decay + 0.05);
  noise.start(time);
  noise.stop(time + p.decay + 0.05);
}

function gen4TriggerHat(time, velocity, p, dest) {
  const ac = audioCtx;
  const noise = ac.createBufferSource();
  noise.buffer = GEN4.nodes.noiseBuf;

  const hpf = ac.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = p.tone;
  hpf.Q.value = 0.5;

  const bpf = ac.createBiquadFilter();
  bpf.type = 'bandpass';
  bpf.frequency.value = p.tone * 1.4;
  bpf.Q.value = 1.0;

  const env = ac.createGain();
  env.gain.setValueAtTime(0.001, time);
  env.gain.linearRampToValueAtTime(velocity * p.gain, time + 0.001);
  env.gain.exponentialRampToValueAtTime(0.001, time + p.decay);

  noise.connect(hpf);
  hpf.connect(bpf);
  bpf.connect(env);
  env.connect(dest);
  noise.start(time);
  noise.stop(time + p.decay + 0.02);
}

function gen4TriggerPerc(time, velocity, p, dest) {
  const ac = audioCtx;
  const modFreq = p.tune * p.ratio;

  const mod = ac.createOscillator();
  mod.type = 'sine';
  mod.frequency.setValueAtTime(modFreq, time);

  const modGain = ac.createGain();
  const modDepth = modFreq * p.index;
  modGain.gain.setValueAtTime(modDepth, time);
  modGain.gain.exponentialRampToValueAtTime(Math.max(modDepth * 0.01, 0.001), time + p.decay * 0.5);
  mod.connect(modGain);

  const car = ac.createOscillator();
  car.type = 'sine';
  car.frequency.setValueAtTime(p.tune, time);
  modGain.connect(car.frequency);

  const env = ac.createGain();
  env.gain.setValueAtTime(0.001, time);
  env.gain.linearRampToValueAtTime(velocity * p.gain, time + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, time + p.decay);

  car.connect(env);
  env.connect(dest);
  mod.start(time);
  mod.stop(time + p.decay + 0.05);
  car.start(time);
  car.stop(time + p.decay + 0.05);
}

const GEN4_OSC_MIDI = 200; // reserved virtual MIDI slot for sequencer-triggered Gen3 notes

function gen4TriggerOsc(time, midis = GEN3.lockedMidis) {
  if (!audioCtx || GEN3.sustainMode || midis.size === 0) return;
  // Snapshot the chord now — in song mode the bound loop may change before the
  // scheduled timeout fires.
  const notes = [...midis];
  const delayMs = Math.max(0, time - audioCtx.currentTime) * 1000;
  setTimeout(() => {
    if (!audioCtx) return;
    notes.forEach((midi) => {
      if (GEN3.activeNotes.has(midi)) removeGen3Note(midi);
      addGen3Note(midi, 440 * Math.pow(2, (midi - 69) / 12));
    });
  }, delayMs);
}

function getEffectiveGen4Params(ci) {
  const ch = GEN4.channels[ci];
  const def = GEN4_DEFS[ci];
  const effective = { ...ch.params };
  def.paramDefs.forEach((pd) => {
    const mapping = lfoMappings.get(`4:${def.id}:${pd.key}`);
    if (!mapping) return;
    const scaled = getModSourceScaledValue(mapping.sourceIdx);
    if (scaled === null) return;
    const half = (pd.max - pd.min) * 0.5;
    effective[pd.key] = Math.max(pd.min, Math.min(pd.max, effective[pd.key] + scaled * half));
  });
  return effective;
}

function gen4FireChannel(ci, time, velocity, loop = null) {
  const ch = GEN4.channels[ci];
  if (ch.muted) return;
  const p = getEffectiveGen4Params(ci);
  const dest = GEN4.nodes.channelOuts[ci];
  switch (ch.id) {
    case 'kick':
      gen4TriggerKick(time, velocity, p, dest);
      break;
    case 'snare':
      gen4TriggerSnare(time, velocity, p, dest);
      break;
    case 'hat':
      gen4TriggerHat(time, velocity, p, dest);
      break;
    case 'perc':
      gen4TriggerPerc(time, velocity, p, dest);
      break;
    case 'osc':
      gen4TriggerOsc(time, loop ? loop.gen3.lockedMidis : GEN3.lockedMidis);
      break;
  }
}

function gen4ScheduleTick() {
  if (!audioCtx || !GEN4.nodes || !GEN4.playing) return;
  const secPerStep = 60.0 / TRANSPORT.bpm / 4;
  while (GEN4.nextStepTime < audioCtx.currentTime + GEN4.scheduleAheadTime) {
    // The pattern to schedule from: the edited loop in loop mode, the loop at
    // the song cursor in song mode. Resolved per step so a pattern boundary
    // can hand off to the next arrangement entry mid-lookahead.
    let loop = getSchedulerLoop();
    if (!loop) {
      stopGen4Sequencer();
      return;
    }
    let step = GEN4.schedulerStep + 1;
    if (step >= loop.gen4.stepCount) {
      if (PLAY.mode === 'song') {
        if (!advanceSongCursor()) {
          stopGen4Sequencer();
          return;
        }
        loop = getSchedulerLoop();
        if (!loop) {
          stopGen4Sequencer();
          return;
        }
      }
      step = 0;
    }
    GEN4.schedulerStep = step;
    gen4Schedule.push({
      step,
      time: GEN4.nextStepTime,
      loopId: loop.id,
      entryIdx: PLAY.mode === 'song' ? SONG.cursor.entryIdx : -1,
      repeat: PLAY.mode === 'song' ? SONG.cursor.repeat : 0,
    });
    if (gen4Schedule.length > 48) gen4Schedule.shift();
    loop.gen4.channels.forEach((pat, ci) => {
      if (!pat.steps[step]) return;
      if (Math.random() > pat.probability[step]) return;
      const count = pat.stutter[step];
      for (let r = 0; r < count; r++) {
        gen4FireChannel(ci, GEN4.nextStepTime + r * (secPerStep / count), pat.velocity[step], loop);
      }
    });
    GEN4.nextStepTime += secPerStep;
  }
}

function gen4RefreshStepDisplay() {
  GEN4_DEFS.forEach((_, ci) => {
    for (let si = 0; si < 32; si++) {
      const el = gen4StepEls[ci][si];
      if (!el) continue;
      const inactive = si >= GEN4.stepCount;
      el.classList.toggle('current', !inactive && si === GEN4.displayStep);
      el.classList.toggle('step-inactive', inactive);
    }
  });
}

function gen4IsStepDefault(ch, stepIdx) {
  return (
    !ch.steps[stepIdx] &&
    ch.velocity[stepIdx] === 1.0 &&
    ch.stutter[stepIdx] === 1 &&
    ch.probability[stepIdx] === 1.0
  );
}

function gen4CanDuplicateStepRange(fromStepCount, toStepCount) {
  if (toStepCount !== fromStepCount * 2 || toStepCount > 32) return false;
  for (const ch of GEN4.channels) {
    for (let si = fromStepCount; si < toStepCount; si++) {
      if (!gen4IsStepDefault(ch, si)) return false;
    }
  }
  return true;
}

function gen4DuplicateStepRange(fromStepCount, toStepCount) {
  const copyLength = Math.min(fromStepCount, toStepCount - fromStepCount);
  GEN4.channels.forEach((ch, ci) => {
    for (let offset = 0; offset < copyLength; offset++) {
      const src = offset;
      const dest = fromStepCount + offset;
      ch.steps[dest] = ch.steps[src];
      ch.velocity[dest] = ch.velocity[src];
      ch.stutter[dest] = ch.stutter[src];
      ch.probability[dest] = ch.probability[src];
      gen4ApplyStepBtn(ci, dest);
    }
  });
}

function gen4SetStepCount(n, { duplicateOnExpand = true } = {}) {
  const prevStepCount = GEN4.stepCount;
  if (
    duplicateOnExpand &&
    prevStepCount === 16 &&
    n === 32 &&
    gen4CanDuplicateStepRange(prevStepCount, n)
  ) {
    gen4DuplicateStepRange(prevStepCount, n);
  }
  GEN4.stepCount = n;
  const editLoop = getEditLoop();
  if (editLoop) editLoop.gen4.stepCount = n;
  if (GEN4.schedulerStep >= n) GEN4.schedulerStep = -1;
  document.querySelectorAll('.drum-steps').forEach((el) => el.style.setProperty('--step-count', n));
  gen4RefreshStepDisplay();
  gen4StepCountBtns.forEach((btn) =>
    btn.classList.toggle('active', Number(btn.dataset.steps) === n),
  );
}

function gen4DisplayTick() {
  gen4DisplayFrame = requestAnimationFrame(gen4DisplayTick);
  if (!audioCtx || !GEN4.playing) return;
  const now = audioCtx.currentTime;
  let audible = null;
  for (let i = gen4Schedule.length - 1; i >= 0; i--) {
    if (gen4Schedule[i].time <= now) {
      audible = gen4Schedule[i];
      break;
    }
  }
  if (!audible) return;
  if (PLAY.mode === 'song') updateSongPlayhead(audible);
  // The grid playhead only makes sense when the audible loop is the one shown.
  const editLoop = getEditLoop();
  const shown = editLoop && audible.loopId === editLoop.id ? audible.step : -1;
  if (shown !== GEN4.displayStep) {
    GEN4.displayStep = shown;
    gen4RefreshStepDisplay();
  }
}

function refreshTransportStopBtn() {
  const btn = document.getElementById('transportStopBtn');
  if (!btn) return;
  const anyPlaying = GEN4.playing || (GEN3.activeNotes && GEN3.activeNotes.size > 0);
  btn.disabled = !anyPlaying;
  btn.classList.toggle('active', anyPlaying);
}

function startGen4Sequencer() {
  if (GEN4.playing) return;
  if (PLAY.mode === 'song' && SONG.entries.length === 0) {
    setStatus('song is empty — add loops to the song lane');
    return;
  }
  GEN4.playing = true;
  GEN4.schedulerStep = -1;
  GEN4.displayStep = -1;
  gen4Schedule.length = 0;
  if (PLAY.mode === 'song') resetSongPlayback();
  GEN4.nextStepTime = audioCtx.currentTime;
  GEN4.schedulerTimer = setInterval(gen4ScheduleTick, GEN4.scheduleInterval);
  if (!gen4DisplayFrame) gen4DisplayFrame = requestAnimationFrame(gen4DisplayTick);
  if (gen4PlayBtnEl) {
    gen4PlayBtnEl.textContent = '◼ Stop';
    gen4PlayBtnEl.classList.add('active');
  }
  refreshSongTransportUI();
  refreshTransportStopBtn();
}

function stopGen4Sequencer() {
  GEN4.playing = false;
  clearInterval(GEN4.schedulerTimer);
  GEN4.schedulerTimer = null;
  if (gen4DisplayFrame) {
    cancelAnimationFrame(gen4DisplayFrame);
    gen4DisplayFrame = null;
  }
  GEN4.displayStep = -1;
  SONG.audibleEntryIdx = -1;
  renderSongPlayhead();
  gen4RefreshStepDisplay();
  if (gen4PlayBtnEl) {
    gen4PlayBtnEl.textContent = '▶ Play';
    gen4PlayBtnEl.classList.remove('active');
  }
  refreshSongTransportUI();
  refreshTransportStopBtn();
}

const GEN4_PROB_CYCLE = [1.0, 0.75, 0.5, 0.25];

function gen4ApplyStepBtn(ci, si) {
  const btn = gen4StepEls[ci][si];
  if (!btn) return;
  const ch = GEN4.channels[ci];
  const on = ch.steps[si];
  btn.classList.toggle('on', on);
  btn.style.setProperty('--step-velocity', ch.velocity[si]);

  const stutterEl = btn.querySelector('.drum-step-stutter');
  if (stutterEl) {
    const s = ch.stutter[si];
    stutterEl.textContent = s > 1 ? `${s}×` : '';
    stutterEl.hidden = s <= 1;
  }

  const probEl = btn.querySelector('.drum-step-prob');
  if (probEl) {
    const p = ch.probability[si];
    probEl.style.width = `${p * 100}%`;
    probEl.hidden = !on || p >= 1.0;
  }
}

function gen4CycleStutter(ci, si) {
  const ch = GEN4.channels[ci];
  ch.stutter[si] = (ch.stutter[si] % 4) + 1;
  gen4ApplyStepBtn(ci, si);
}

function gen4CycleProbability(ci, si) {
  const ch = GEN4.channels[ci];
  const idx = GEN4_PROB_CYCLE.indexOf(ch.probability[si]);
  ch.probability[si] = GEN4_PROB_CYCLE[(idx + 1) % GEN4_PROB_CYCLE.length];
  gen4ApplyStepBtn(ci, si);
}

function buildDrumPanel() {
  const panel = document.createElement('div');
  panel.className = 'generator gen-4';

  // Header
  const header = document.createElement('div');
  header.className = 'col-header';
  const title = document.createElement('span');
  title.className = 'col-title';
  title.innerHTML = '<span class="col-dot"></span>Gen 4 · Drums';
  const actions = document.createElement('div');
  actions.className = 'gen-header-actions';

  const stepCounts = [12, 15, 16, 32];
  const stepsGroup = document.createElement('div');
  stepsGroup.className = 'drum-step-count-group';
  gen4StepCountBtns = stepCounts.map((n) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drum-step-count-btn';
    btn.dataset.steps = String(n);
    btn.textContent = String(n);
    btn.title = `${n} steps`;
    btn.classList.toggle('active', n === GEN4.stepCount);
    btn.addEventListener('click', () => gen4SetStepCount(n));
    stepsGroup.appendChild(btn);
    return btn;
  });
  actions.appendChild(stepsGroup);

  const playBtn = document.createElement('button');
  playBtn.className = 'drum-play-btn';
  playBtn.textContent = '▶ Play';
  gen4PlayBtnEl = playBtn;
  playBtn.addEventListener('click', async () => {
    await ensureAudioEngine();
    if (!GEN4.nodes) buildGen4Nodes();
    GEN4.playing ? stopGen4Sequencer() : startGen4Sequencer();
  });
  actions.appendChild(playBtn);
  header.append(title, actions);
  panel.appendChild(header);

  const hints = document.createElement('div');
  hints.className = 'drum-hints';
  hints.innerHTML =
    '<span class="drum-hint"><span class="drum-hint-key">drag</span> active step → velocity</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">shift + click</span> active step → cycle probability</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">right-click</span> active step → cycle stutter</span>';
  panel.appendChild(hints);

  // Step grid
  const grid = document.createElement('div');
  grid.className = 'drum-grid';

  GEN4_DEFS.forEach((def, ci) => {
    const ch = GEN4.channels[ci];
    const row = document.createElement('div');
    row.className = 'drum-row';
    row.style.setProperty('--ch-color', def.color);

    const lbl = document.createElement('div');
    lbl.className = 'drum-row-label';
    lbl.textContent = def.label;

    const stepsEl = document.createElement('div');
    stepsEl.className = 'drum-steps';
    stepsEl.style.setProperty('--step-count', GEN4.stepCount);

    for (let si = 0; si < 32; si++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drum-step';
      gen4StepEls[ci][si] = btn;

      const stutterEl = document.createElement('span');
      stutterEl.className = 'drum-step-stutter';
      stutterEl.hidden = true;
      btn.appendChild(stutterEl);

      const probEl = document.createElement('span');
      probEl.className = 'drum-step-prob';
      probEl.hidden = true;
      btn.appendChild(probEl);

      if (si >= GEN4.stepCount) btn.classList.add('step-inactive');
      gen4ApplyStepBtn(ci, si);

      btn.addEventListener('click', (e) => {
        if (e.shiftKey && ch.steps[si]) {
          gen4CycleProbability(ci, si);
          return;
        }
        ch.steps[si] = !ch.steps[si];
        // reset glitch state when turning off
        if (!ch.steps[si]) {
          ch.stutter[si] = 1;
          ch.probability[si] = 1.0;
        }
        gen4ApplyStepBtn(ci, si);
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (ch.steps[si]) gen4CycleStutter(ci, si);
      });

      btn.addEventListener('mousedown', (e) => {
        if (!ch.steps[si] || e.shiftKey || e.button !== 0) return;
        gen4DragState.active = true;
        gen4DragState.ci = ci;
        gen4DragState.si = si;
        gen4DragState.startY = e.clientY;
        gen4DragState.startVel = ch.velocity[si];
        e.preventDefault();
      });

      stepsEl.appendChild(btn);
    }

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'drum-mute-btn';
    muteBtn.textContent = 'M';
    muteBtn.title = 'Mute channel';
    muteBtn.addEventListener('click', () => {
      ch.muted = !ch.muted;
      muteBtn.classList.toggle('muted', ch.muted);
    });

    const actions = document.createElement('div');
    actions.className = 'drum-row-actions';
    if (def.id !== 'osc') {
      const fxBtn = document.createElement('button');
      fxBtn.type = 'button';
      fxBtn.className = 'drum-fx-btn';
      fxBtn.classList.toggle('active', ch.fxSend);
      fxBtn.textContent = 'FX';
      fxBtn.title = 'Send to FX chain — click to bypass to limiter only';
      gen4FxSendBtns[ci] = fxBtn;
      fxBtn.addEventListener('click', () => gen4SetChannelFxSend(ci, !ch.fxSend));
      actions.appendChild(fxBtn);
    }
    actions.appendChild(muteBtn);

    row.append(lbl, stepsEl, actions);
    grid.appendChild(row);
  });

  panel.appendChild(grid);

  // Param sections (one per channel, collapsed by default)
  const paramsWrap = document.createElement('div');
  paramsWrap.className = 'drum-params';

  GEN4_DEFS.forEach((def, ci) => {
    const ch = GEN4.channels[ci];
    const { section, content, setCollapsed } = createFxSection(def.label, 'drum-param-section');
    section.querySelector('.fx-section-label').style.color = def.color;
    setCollapsed(true);

    const controls = document.createElement('div');
    controls.className = 'gen-controls';
    controls.style.setProperty('--gen-accent', def.color);

    def.paramDefs.forEach((p) => {
      const ctrl = makeControlRow(
        p,
        ch.params[p.key],
        (v) => {
          ch.params[p.key] = v;
        },
        { genIdx: 4, key: `${def.id}:${p.key}` },
      );
      gen4ControlBindings[ci].set(p.key, ctrl);
      controls.appendChild(ctrl);
    });

    content.appendChild(controls);
    paramsWrap.appendChild(section);
  });

  panel.appendChild(paramsWrap);
  gen4RefreshStepDisplay();
  return panel;
}

// ─── FX Chain ──────────────────────────────────────────────────────────────

const FX_DEFS = [
  {
    id: 'beatrepeat',
    label: 'Beat Repeat',
    params: [
      { key: 'interval', label: 'Interval', min: 0.02, max: 2, step: 0.01, value: 0.5, unit: 's' },
      { key: 'grid', label: 'Grid', min: 10, max: 500, step: 1, value: 125, unit: 'ms' },
      { key: 'gate', label: 'Gate', min: 1, max: 32, step: 1, value: 8, unit: 'x' },
      { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
      { key: 'decay', label: 'Decay', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'chance', label: 'Chance', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'delay',
    label: 'Delay',
    params: [
      { key: 'time', label: 'Time', min: 0, max: 1, step: 0.01, value: 0.3, unit: 's' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, value: 0.35, unit: '' },
      { key: 'hp', label: 'HP Cut', min: 20, max: 2000, step: 10, value: 20, unit: 'Hz' },
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
      {
        key: 'predelay',
        label: 'Pre-delay',
        min: 0,
        max: 0.25,
        step: 0.001,
        value: 0.018,
        unit: 's',
      },
      { key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.01, value: 0.42, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
    ],
  },
  {
    id: 'limiter',
    label: 'Limiter',
    params: [
      { key: 'threshold', label: 'Threshold', min: -36, max: 0, step: 0.5, value: -8, unit: 'dB' },
      { key: 'attack', label: 'Attack', min: 0, max: 0.1, step: 0.001, value: 0.003, unit: 's' },
      { key: 'release', label: 'Release', min: 0.02, max: 1, step: 0.01, value: 0.12, unit: 's' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 40, step: 0.5, value: 20, unit: ':1' },
      { key: 'knee', label: 'Knee', min: 0, max: 40, step: 0.5, value: 0, unit: 'dB' },
      { key: 'output', label: 'Output', min: 0.5, max: 1.2, step: 0.01, value: 0.96, unit: '' },
    ],
  },
];

// Per-instrument FX buses. Each instrument (granular 1/2, synth, drums) owns an
// independent effect chain; one instrument is "active" and its chain is shown and
// edited in the FX column. All bus outputs sum into a single global master limiter.
const FX_BUS_IDS = ['gen0', 'gen1', 'gen3', 'gen4'];
const FX_BUS_LABELS = { gen0: 'Granular 1', gen1: 'Granular 2', gen3: 'Synth', gen4: 'Drums' };

// Default per-bus effect state (the limiter is global, not per-bus).
function makeDefaultFxState() {
  return {
    beatrepeat: {
      interval: 0.5,
      sync: true,
      syncIndex: 4,
      grid: 125,
      gridSync: true,
      gridSyncIndex: 2,
      gate: 8,
      pitch: 0,
      decay: 1,
      chance: 1,
      mix: 0,
    },
    delay: { time: 0.3, feedback: 0.35, mix: 0, sync: false, syncIndex: 4, hp: 20, mode: 'stereo' },
    filter: { mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 },
    bitreduce: { bits: 8, rate: 1, mix: 0 },
    sat: { drive: 0.3, mix: 0 },
    reverb: { size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 },
  };
}

// Source of truth for per-bus FX state — applied to audio nodes when they exist.
const fxStates = {
  gen0: makeDefaultFxState(),
  gen1: makeDefaultFxState(),
  gen3: makeDefaultFxState(),
  gen4: makeDefaultFxState(),
};

// Global master limiter state (one limiter at the tail of the summed mix).
const LIMITER = { threshold: -8, attack: 0.003, release: 0.12, ratio: 20, knee: 0, output: 0.96 };

// Order of the reorderable effects between each bus input and bus output.
// Mutated per-bus by drag-to-reorder; persisted in presets.
const DEFAULT_FX_ORDER = ['beatrepeat', 'delay', 'filter', 'bitreduce', 'sat', 'reverb'];
const fxOrders = {
  gen0: [...DEFAULT_FX_ORDER],
  gen1: [...DEFAULT_FX_ORDER],
  gen3: [...DEFAULT_FX_ORDER],
  gen4: [...DEFAULT_FX_ORDER],
};

// Which bus the FX column currently shows/edits.
let activeBus = 'gen0';

// Per-bus audio node graphs, created in ensureAudioEngine(), nulled in stop().
const fxBuses = { gen0: null, gen1: null, gen3: null, gen4: null };
let master = null; // { sum, limiter, output } — global tail of the mix

// Live alias to the active bus state, kept in sync by setActiveBus(). Lets the FX
// UI/refresh code keep referring to FX.* without knowing which bus is active.
let FX = fxStates[activeBus];

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
const BEATREPEAT_INTERVAL_FREE_CONTROL = FX_DEFS.find((def) => def.id === 'beatrepeat').params.find(
  (param) => param.key === 'interval',
);
const BEATREPEAT_INTERVAL_SYNC_CONTROL = {
  key: 'interval',
  label: 'Interval',
  min: 0,
  max: TEMPO_SYNC_STEPS.length - 1,
  step: 1,
  unit: '',
};
const BEATREPEAT_GRID_FREE_CONTROL = FX_DEFS.find((def) => def.id === 'beatrepeat').params.find(
  (param) => param.key === 'grid',
);
const BEATREPEAT_GRID_SYNC_CONTROL = {
  key: 'grid',
  label: 'Grid',
  min: 0,
  max: GRAIN_SYNC_STEPS.length - 1,
  step: 1,
  unit: '',
};
const STEP_SEQ_STEP_BEAT_OPTIONS = [
  { label: '1/4', beats: 0.25 },
  { label: '1/2', beats: 0.5 },
  { label: '1', beats: 1 },
  { label: '2', beats: 2 },
  { label: '4', beats: 4 },
  { label: '8', beats: 8 },
];
const STEP_SEQ = {
  label: 'Seq 1',
  steps: Array.from({ length: 16 }, () => 0),
  subdivision: 16,
  stepBeats: 0.25,
  currentStep: 0,
  currentValue: 0,
  elapsed: 0,
};
let seqBars = [];
const seqSubdivisionButtons = new Map();
const seqStepBeatButtons = new Map();
// lfoMappings: 'genIdx:paramKey' → { genIdx, key, sourceIdx }
const lfoMappings = new Map();
let lfoLastTs = 0,
  lfoAnimFrame = null;

function getSeqActiveStepCountFor(seq) {
  return clamp(Math.round(seq.subdivision), 1, seq.steps.length);
}

function getSeqActiveStepCount() {
  return getSeqActiveStepCountFor(STEP_SEQ);
}

function clampSequencerStepBeats(stepBeats) {
  const min = STEP_SEQ_STEP_BEAT_OPTIONS[0].beats;
  const max = STEP_SEQ_STEP_BEAT_OPTIONS[STEP_SEQ_STEP_BEAT_OPTIONS.length - 1].beats;
  return clamp(stepBeats, min, max);
}

function getLegacySequencerStepBeats(subdivision) {
  return 4 / clamp(Math.round(subdivision), 1, STEP_SEQ.steps.length);
}

function formatSequencerStepBeats(stepBeats) {
  const option = STEP_SEQ_STEP_BEAT_OPTIONS.find(({ beats }) => Math.abs(beats - stepBeats) < 1e-6);
  return option ? option.label : `${formatNumericValue(stepBeats, stepBeats >= 1 ? 0 : 2)}`;
}

function getSeqStepDurationFor(seq) {
  return beatsToSeconds(clampSequencerStepBeats(seq.stepBeats));
}

function getSeqStepDuration() {
  return getSeqStepDurationFor(STEP_SEQ);
}

function refreshSequencerUI() {
  seqBars.forEach((bar, idx) => {
    if (!bar) return;
    const value = STEP_SEQ.steps[idx] || 0;
    bar.style.setProperty('--seq-value', `${Math.abs(value)}`);
    bar.classList.toggle('negative', value < 0);
    bar.classList.toggle('positive', value > 0);
    bar.classList.toggle('active', idx === STEP_SEQ.currentStep);
    bar.classList.toggle('inactive', idx >= getSeqActiveStepCount());
  });
  seqSubdivisionButtons.forEach((btn, subdivision) => {
    btn.classList.toggle('active', STEP_SEQ.subdivision === subdivision);
  });
  seqStepBeatButtons.forEach((btn, stepBeats) => {
    btn.classList.toggle('active', Math.abs(STEP_SEQ.stepBeats - stepBeats) < 1e-6);
  });
}

function setSequencerStep(stepIdx, value) {
  STEP_SEQ.steps[stepIdx] = clamp(value, -1, 1);
  STEP_SEQ.currentValue = STEP_SEQ.steps[STEP_SEQ.currentStep] || 0;
  refreshSequencerUI();
  refreshBackPanelState();
}

function clearSequencerSteps() {
  STEP_SEQ.steps.fill(0);
  STEP_SEQ.currentValue = STEP_SEQ.steps[STEP_SEQ.currentStep] || 0;
  refreshSequencerUI();
  refreshBackPanelState();
  applyMappedModulationTargets();
}

// ─── Loops & Song Arrangement ─────────────────────────────────────────────
//
// The instrument rack (generator/kit/FX/LFO settings, routings) is global and
// always live. What is *sequenced* — the drum grid, the chord the OSC row
// fires, and the mod-sequencer pattern — lives in a Loop. Song mode arranges
// loops on a timeline of entries (loop × repeats).
//
// The edited loop's pattern arrays are bound by reference into GEN4.channels /
// GEN3.lockedMidis / STEP_SEQ, so all existing editing UI mutates the loop
// directly. Playback instead resolves patterns through getSchedulerLoop(),
// which in song mode follows the arrangement cursor.

const PLAY = { mode: 'loop' }; // 'loop' | 'song'

const LOOPS = {
  list: [],
  editIndex: 0,
  counter: 0,
};

const SONG = {
  entries: [], // [{ id, loopId, repeats }]
  loop: true, // cycle the arrangement when it reaches the end
  follow: true, // while a song plays, show the loop that is sounding
  cursor: { entryIdx: 0, repeat: 0 }, // scheduler position (runs ahead of audio)
  audibleEntryIdx: -1, // entry actually sounding right now
  entryCounter: 0,
};

const SONG_REPEAT_CYCLE = [1, 2, 4, 8, 16];
const loopChipEls = new Map(); // loop id → chip element
const songBlockEls = new Map(); // entry id → block element
let songPlayBtnEl = null;
let songAddBtnEl = null;
let songPlayheadRendered = { entryIdx: -2, repeat: -2 };

function createLoopData(name) {
  do {
    LOOPS.counter += 1;
  } while (LOOPS.list.some((l) => l.id === `loop-${LOOPS.counter}`));
  return {
    id: `loop-${LOOPS.counter}`,
    name,
    gen4: {
      stepCount: 16,
      channels: GEN4_DEFS.map(() => ({
        steps: new Array(32).fill(false),
        velocity: new Array(32).fill(1.0),
        stutter: new Array(32).fill(1),
        probability: new Array(32).fill(1.0),
      })),
    },
    gen3: { lockedMidis: new Set() },
    seq: {
      steps: Array.from({ length: 16 }, () => 0),
      subdivision: 16,
      stepBeats: 0.25,
    },
  };
}

function nextLoopName() {
  const used = new Set(LOOPS.list.map((l) => l.name));
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (!used.has(letter)) return letter;
  }
  return `L${LOOPS.counter + 1}`;
}

// Wraps the pre-existing live arrays into loop "A" at startup, so the initial
// state needs no rebinding.
function adoptInitialLoop() {
  LOOPS.counter += 1;
  LOOPS.list = [
    {
      id: `loop-${LOOPS.counter}`,
      name: 'A',
      gen4: {
        stepCount: GEN4.stepCount,
        channels: GEN4.channels.map((ch) => ({
          steps: ch.steps,
          velocity: ch.velocity,
          stutter: ch.stutter,
          probability: ch.probability,
        })),
      },
      gen3: { lockedMidis: GEN3.lockedMidis },
      seq: {
        steps: STEP_SEQ.steps,
        subdivision: STEP_SEQ.subdivision,
        stepBeats: STEP_SEQ.stepBeats,
      },
    },
  ];
  LOOPS.editIndex = 0;
}

function getEditLoop() {
  return LOOPS.list[LOOPS.editIndex] || null;
}

function getLoopById(id) {
  return LOOPS.list.find((l) => l.id === id) || null;
}

function getSchedulerLoop() {
  if (PLAY.mode !== 'song') return getEditLoop();
  const entry = SONG.entries[SONG.cursor.entryIdx];
  return entry ? getLoopById(entry.loopId) : null;
}

function getAudibleLoop() {
  if (PLAY.mode === 'song' && GEN4.playing) {
    const entry = SONG.entries[SONG.audibleEntryIdx];
    const loop = entry ? getLoopById(entry.loopId) : null;
    if (loop) return loop;
  }
  return getEditLoop();
}

function serializeLoop(loop) {
  return {
    id: loop.id,
    name: loop.name,
    gen4: {
      stepCount: loop.gen4.stepCount,
      channels: loop.gen4.channels.map((c) => ({
        steps: [...c.steps],
        velocity: [...c.velocity],
        stutter: [...c.stutter],
        probability: [...c.probability],
      })),
    },
    gen3: { lockedMidis: [...loop.gen3.lockedMidis] },
    seq: {
      steps: [...loop.seq.steps],
      subdivision: loop.seq.subdivision,
      stepBeats: loop.seq.stepBeats,
    },
  };
}

function deserializeLoop(data) {
  const loop = createLoopData(
    typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : nextLoopName(),
  );
  if (typeof data?.id === 'string' && data.id && !getLoopById(data.id)) loop.id = data.id;
  const g4 = data?.gen4;
  if ([12, 15, 16, 32].includes(g4?.stepCount)) loop.gen4.stepCount = g4.stepCount;
  (g4?.channels || []).forEach((saved, ci) => {
    const pat = loop.gen4.channels[ci];
    if (!pat || !saved) return;
    if (Array.isArray(saved.steps))
      saved.steps.slice(0, 32).forEach((v, si) => (pat.steps[si] = !!v));
    if (Array.isArray(saved.velocity))
      saved.velocity.slice(0, 32).forEach((v, si) => (pat.velocity[si] = clamp(v, 0.05, 1.0)));
    if (Array.isArray(saved.stutter))
      saved.stutter.slice(0, 32).forEach((v, si) => (pat.stutter[si] = clamp(Math.round(v), 1, 4)));
    if (Array.isArray(saved.probability))
      saved.probability.slice(0, 32).forEach((v, si) => (pat.probability[si] = clamp(v, 0, 1)));
  });
  if (Array.isArray(data?.gen3?.lockedMidis)) {
    loop.gen3.lockedMidis = new Set(data.gen3.lockedMidis.filter((m) => Number.isFinite(m)));
  }
  const seq = data?.seq;
  if (Array.isArray(seq?.steps)) {
    seq.steps.slice(0, loop.seq.steps.length).forEach((v, i) => {
      if (typeof v === 'number') loop.seq.steps[i] = clamp(v, -1, 1);
    });
  }
  if (typeof seq?.subdivision === 'number') {
    loop.seq.subdivision = clamp(Math.round(seq.subdivision), 1, loop.seq.steps.length);
  }
  if (typeof seq?.stepBeats === 'number') {
    loop.seq.stepBeats = clampSequencerStepBeats(seq.stepBeats);
  } else if (typeof seq?.subdivision === 'number') {
    // Legacy patterns predate the beat/step control.
    loop.seq.stepBeats = clampSequencerStepBeats(getLegacySequencerStepBeats(seq.subdivision));
  }
  return loop;
}

// Shapes a pre-loops preset (patterns stored at the top level) into loop data.
function legacyLoopData(preset) {
  return {
    name: 'A',
    gen4: {
      stepCount: preset?.gen4?.stepCount,
      channels: (preset?.gen4?.channels || []).map((ch) => ({
        steps: ch?.steps,
        velocity: ch?.velocity,
        stutter: ch?.stutter,
        probability: ch?.probability,
      })),
    },
    gen3: { lockedMidis: preset?.gen3?.lockedMidis || [] },
    seq: preset?.seq,
  };
}

function bindEditLoop() {
  const loop = getEditLoop();
  if (!loop) return;
  GEN4.channels.forEach((ch, ci) => {
    const pat = loop.gen4.channels[ci];
    ch.steps = pat.steps;
    ch.velocity = pat.velocity;
    ch.stutter = pat.stutter;
    ch.probability = pat.probability;
  });
  const chordChanged = GEN3.lockedMidis !== loop.gen3.lockedMidis;
  GEN3.lockedMidis = loop.gen3.lockedMidis;
  STEP_SEQ.steps = loop.seq.steps;
  STEP_SEQ.subdivision = loop.seq.subdivision;
  STEP_SEQ.stepBeats = loop.seq.stepBeats;
  STEP_SEQ.currentStep = Math.min(STEP_SEQ.currentStep, getSeqActiveStepCount() - 1);
  STEP_SEQ.currentValue = STEP_SEQ.steps[STEP_SEQ.currentStep] || 0;

  gen4SetStepCount(loop.gen4.stepCount, { duplicateOnExpand: false });
  GEN4.channels.forEach((_, ci) => {
    for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
  });
  gen4RefreshStepDisplay();

  if (chordChanged && GEN3.sustainMode && GEN3.nodes && GEN3.activeNotes.size > 0) {
    // A sustained drone follows the newly bound loop's chord.
    stopAllGen3Notes();
    GEN3.lockedMidis.forEach((m) => addGen3Note(m, 440 * Math.pow(2, (m - 69) / 12)));
  }
  refreshGen3KeyStates();
  refreshSequencerUI();
  refreshBackPanelState();
  applyMappedModulationTargets();
}

function selectEditLoop(index) {
  if (index < 0 || index >= LOOPS.list.length) return;
  if (index !== LOOPS.editIndex) {
    LOOPS.editIndex = index;
    bindEditLoop();
  }
  renderLoopsBar();
}

function addLoop({ duplicate = false } = {}) {
  let loop;
  const src = getEditLoop();
  if (duplicate && src) {
    const data = serializeLoop(src);
    delete data.id;
    data.name = nextLoopName();
    loop = deserializeLoop(data);
  } else {
    loop = createLoopData(nextLoopName());
  }
  LOOPS.list.push(loop);
  selectEditLoop(LOOPS.list.length - 1);
  setStatus(
    duplicate && src ? `duplicated "${src.name}" into "${loop.name}"` : `added loop "${loop.name}"`,
  );
}

function deleteLoop(index) {
  const loop = LOOPS.list[index];
  if (!loop) return;
  if (LOOPS.list.length <= 1) {
    setStatus('cannot delete the last loop');
    return;
  }
  const used = SONG.entries.filter((e) => e.loopId === loop.id).length;
  const msg =
    used > 0
      ? `Delete loop "${loop.name}"? It is used ${used}× in the song.`
      : `Delete loop "${loop.name}"?`;
  if (!window.confirm(msg)) return;
  LOOPS.list.splice(index, 1);
  SONG.entries = SONG.entries.filter((e) => e.loopId !== loop.id);
  if (index < LOOPS.editIndex) LOOPS.editIndex -= 1;
  LOOPS.editIndex = clamp(LOOPS.editIndex, 0, LOOPS.list.length - 1);
  bindEditLoop();
  if (GEN4.playing && PLAY.mode === 'song') {
    if (SONG.entries.length === 0) stopGen4Sequencer();
    else {
      SONG.cursor.entryIdx = clamp(SONG.cursor.entryIdx, 0, SONG.entries.length - 1);
      SONG.cursor.repeat = 0;
    }
  } else {
    SONG.cursor.entryIdx = 0;
    SONG.cursor.repeat = 0;
  }
  renderLoopsBar();
  renderSongLane();
  setStatus(`deleted loop "${loop.name}"`);
}

// ── Song cursor / playback ──

function advanceSongCursor() {
  const entry = SONG.entries[SONG.cursor.entryIdx];
  if (!entry) return false;
  SONG.cursor.repeat += 1;
  if (SONG.cursor.repeat < Math.max(1, entry.repeats)) return true;
  SONG.cursor.repeat = 0;
  SONG.cursor.entryIdx += 1;
  if (SONG.cursor.entryIdx >= SONG.entries.length) {
    if (!SONG.loop) return false;
    SONG.cursor.entryIdx = 0;
  }
  return true;
}

function resetSongPlayback() {
  SONG.cursor.entryIdx = 0;
  SONG.cursor.repeat = 0;
  SONG.audibleEntryIdx = -1;
  STEP_SEQ.currentStep = 0;
  STEP_SEQ.elapsed = 0;
  const seq = getSchedulerLoop()?.seq;
  STEP_SEQ.currentValue = seq ? seq.steps[0] || 0 : 0;
  refreshSequencerUI();
  renderSongPlayhead();
}

// Called every display frame during song playback with the schedule entry
// that is currently audible.
function updateSongPlayhead(audible) {
  const changed = audible.entryIdx !== SONG.audibleEntryIdx;
  SONG.audibleEntryIdx = audible.entryIdx;
  if (changed) {
    // Restart the mod sequencer at each arrangement block so its pattern
    // stays phase-locked to the section.
    STEP_SEQ.currentStep = 0;
    STEP_SEQ.elapsed = 0;
    const seq = getAudibleLoop()?.seq;
    STEP_SEQ.currentValue = seq ? seq.steps[0] || 0 : 0;
    refreshSequencerUI();
    if (SONG.follow) {
      const entry = SONG.entries[audible.entryIdx];
      const idx = entry ? LOOPS.list.findIndex((l) => l.id === entry.loopId) : -1;
      if (idx >= 0 && idx !== LOOPS.editIndex) selectEditLoop(idx);
    }
  }
  renderSongPlayhead(audible.repeat);
}

function renderSongPlayhead(repeat = -1) {
  const entryIdx = SONG.audibleEntryIdx;
  if (songPlayheadRendered.entryIdx === entryIdx && songPlayheadRendered.repeat === repeat) return;
  songPlayheadRendered = { entryIdx, repeat };
  const audibleLoopId = SONG.entries[entryIdx]?.loopId ?? null;
  SONG.entries.forEach((entry, idx) => {
    const el = songBlockEls.get(entry.id);
    if (!el) return;
    const playing = idx === entryIdx;
    el.classList.toggle('playing', playing);
    const badge = el.querySelector('.song-block-repeats');
    if (badge) {
      badge.textContent =
        playing && repeat >= 0 && entry.repeats > 1
          ? `${repeat + 1}/${entry.repeats}`
          : entry.repeats > 1
            ? `×${entry.repeats}`
            : '';
    }
  });
  loopChipEls.forEach((chip, loopId) => {
    chip.classList.toggle('playing', loopId === audibleLoopId);
  });
}

function refreshSongTransportUI() {
  if (!songPlayBtnEl) return;
  songPlayBtnEl.textContent = GEN4.playing ? '◼' : '▶';
  songPlayBtnEl.title = GEN4.playing ? 'Stop the song' : 'Play the song';
  songPlayBtnEl.classList.toggle('active', GEN4.playing);
}

// ── Song entry ops ──

function addSongEntry(loopId = getEditLoop()?.id) {
  const loop = getLoopById(loopId);
  if (!loop) return;
  do {
    SONG.entryCounter += 1;
  } while (SONG.entries.some((e) => e.id === `entry-${SONG.entryCounter}`));
  SONG.entries.push({ id: `entry-${SONG.entryCounter}`, loopId, repeats: 1 });
  renderSongLane();
}

function removeSongEntry(entryId) {
  const idx = SONG.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return;
  SONG.entries.splice(idx, 1);
  if (GEN4.playing && PLAY.mode === 'song') {
    if (SONG.entries.length === 0) stopGen4Sequencer();
    else if (idx < SONG.cursor.entryIdx) SONG.cursor.entryIdx -= 1;
    else SONG.cursor.entryIdx = clamp(SONG.cursor.entryIdx, 0, SONG.entries.length - 1);
  }
  renderSongLane();
}

function setSongEntryRepeats(entryId, repeats) {
  const entry = SONG.entries.find((e) => e.id === entryId);
  if (!entry) return;
  entry.repeats = clamp(Math.round(repeats), 1, 64);
  renderSongLane();
}

// ── Song block context menu (cycles / remove) ──

let songBlockMenuEl = null;

function closeSongBlockMenu() {
  if (!songBlockMenuEl) return;
  songBlockMenuEl.remove();
  songBlockMenuEl = null;
}

function openSongBlockMenu(entryId, x, y) {
  closeSongBlockMenu();
  const entry = SONG.entries.find((e) => e.id === entryId);
  if (!entry) return;
  const loop = getLoopById(entry.loopId);

  const menu = document.createElement('div');
  menu.className = 'song-block-menu';
  songBlockMenuEl = menu;

  const title = document.createElement('div');
  title.className = 'song-block-menu-title';
  title.textContent = `${loop?.name ?? '?'} · cycles`;
  menu.appendChild(title);

  const presets = document.createElement('div');
  presets.className = 'song-block-menu-presets';
  SONG_REPEAT_CYCLE.forEach((n) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'song-block-menu-preset' + (entry.repeats === n ? ' active' : '');
    btn.dataset.n = String(n);
    btn.textContent = `×${n}`;
    btn.addEventListener('click', () => {
      setSongEntryRepeats(entry.id, n);
      closeSongBlockMenu();
    });
    presets.appendChild(btn);
  });
  menu.appendChild(presets);

  const customRow = document.createElement('div');
  customRow.className = 'song-block-menu-custom';
  const customLabel = document.createElement('span');
  customLabel.textContent = 'custom';
  const customInput = document.createElement('input');
  customInput.type = 'number';
  customInput.min = '1';
  customInput.max = '64';
  customInput.step = '1';
  customInput.value = String(entry.repeats);
  customInput.addEventListener('input', () => {
    const n = Number.parseInt(customInput.value, 10);
    if (!Number.isFinite(n)) return;
    setSongEntryRepeats(entry.id, n);
    presets
      .querySelectorAll('.song-block-menu-preset')
      .forEach((b) => b.classList.toggle('active', Number(b.dataset.n) === entry.repeats));
  });
  customInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === 'Escape') closeSongBlockMenu();
  });
  customRow.append(customLabel, customInput);
  menu.appendChild(customRow);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'song-block-menu-remove';
  removeBtn.textContent = 'remove from song';
  removeBtn.addEventListener('click', () => {
    closeSongBlockMenu();
    removeSongEntry(entry.id);
  });
  menu.appendChild(removeBtn);

  document.body.appendChild(menu);
  // Clamp into the viewport once measurable.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

window.addEventListener('pointerdown', (e) => {
  if (songBlockMenuEl && !songBlockMenuEl.contains(e.target)) closeSongBlockMenu();
});

function commitSongOrderFromDom() {
  const wrap = document.querySelector('.song-blocks');
  if (!wrap) return;
  const playingEntryId = SONG.entries[SONG.cursor.entryIdx]?.id ?? null;
  const order = [...wrap.querySelectorAll('.song-block')].map((el) => el.dataset.entryId);
  const byId = new Map(SONG.entries.map((e) => [e.id, e]));
  const next = order.map((id) => byId.get(id)).filter(Boolean);
  SONG.entries.forEach((e) => {
    if (!next.includes(e)) next.push(e);
  });
  SONG.entries = next;
  if (playingEntryId) {
    const idx = SONG.entries.findIndex((e) => e.id === playingEntryId);
    if (idx >= 0) SONG.cursor.entryIdx = idx;
  }
  renderSongLane();
}

// ── Play mode ──

function setPlayMode(mode) {
  if (mode !== 'loop' && mode !== 'song') return;
  if (PLAY.mode === mode) {
    refreshModeToggleUI();
    return;
  }
  const wasPlaying = GEN4.playing;
  if (wasPlaying) stopGen4Sequencer();
  PLAY.mode = mode;
  const lane = document.getElementById('songLane');
  if (lane) lane.hidden = mode !== 'song';
  refreshModeToggleUI();
  if (wasPlaying && (mode === 'loop' || SONG.entries.length > 0)) startGen4Sequencer();
}

function refreshModeToggleUI() {
  document
    .querySelectorAll('#modeToggle .mode-btn')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === PLAY.mode));
}

function initModeToggle() {
  document.querySelectorAll('#modeToggle .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPlayMode(btn.dataset.mode));
  });
}

// ── Loops bar UI ──

function startLoopRename(chip, loop) {
  const nameBtn = chip.querySelector('.loop-chip-name');
  if (!nameBtn) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 12;
  input.value = loop.name;
  input.className = 'loop-rename-input';
  input.spellcheck = false;
  chip.replaceChild(input, nameBtn);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name) loop.name = name;
    renderLoopsBar();
    renderSongLane();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function renderLoopsBar() {
  const bar = document.getElementById('loopsBar');
  if (!bar) return;
  loopChipEls.clear();
  bar.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'loops-bar-label';
  label.textContent = 'Loops';
  bar.appendChild(label);

  LOOPS.list.forEach((loop, idx) => {
    const chip = document.createElement('div');
    chip.className = 'loop-chip' + (idx === LOOPS.editIndex ? ' active' : '');

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'loop-chip-name';
    nameBtn.textContent = loop.name;
    nameBtn.title = 'Click to edit this loop · double-click to rename';
    nameBtn.addEventListener('click', () => selectEditLoop(idx));
    nameBtn.addEventListener('dblclick', () => startLoopRename(chip, loop));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'loop-chip-del';
    delBtn.textContent = '×';
    delBtn.title = 'Delete loop';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLoop(idx);
    });

    chip.append(nameBtn, delBtn);
    loopChipEls.set(loop.id, chip);
    bar.appendChild(chip);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'loop-add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'New empty loop';
  addBtn.addEventListener('click', () => addLoop());

  const dupBtn = document.createElement('button');
  dupBtn.type = 'button';
  dupBtn.className = 'loop-add-btn';
  dupBtn.textContent = '⧉';
  dupBtn.title = 'Duplicate the current loop';
  dupBtn.addEventListener('click', () => addLoop({ duplicate: true }));

  bar.append(addBtn, dupBtn);
  if (songAddBtnEl) songAddBtnEl.textContent = `+ ${getEditLoop()?.name ?? ''}`;
}

// ── Song lane UI ──

function getSongDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('.song-block:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  els.forEach((child) => {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  });
  return closest.element;
}

function renderSongLane() {
  const lane = document.getElementById('songLane');
  if (!lane) return;
  songBlockEls.clear();
  songPlayheadRendered = { entryIdx: -2, repeat: -2 };
  lane.innerHTML = '';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'song-play-btn';
  songPlayBtnEl = playBtn;
  playBtn.addEventListener('click', async () => {
    await ensureAudioEngine();
    if (!GEN4.nodes) buildGen4Nodes();
    GEN4.playing ? stopGen4Sequencer() : startGen4Sequencer();
  });
  lane.appendChild(playBtn);
  refreshSongTransportUI();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'song-add-btn';
  songAddBtnEl = addBtn;
  addBtn.textContent = `+ ${getEditLoop()?.name ?? ''}`;
  addBtn.title = 'Append the current loop to the song';
  addBtn.addEventListener('click', () => addSongEntry());
  lane.appendChild(addBtn);

  const blocksWrap = document.createElement('div');
  blocksWrap.className = 'song-blocks';

  SONG.entries.forEach((entry) => {
    const loop = getLoopById(entry.loopId);
    const block = document.createElement('div');
    block.className = 'song-block';
    block.dataset.entryId = entry.id;
    block.draggable = true;

    const name = document.createElement('span');
    name.className = 'song-block-name';
    name.textContent = loop?.name ?? '?';

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'song-block-repeats';
    badge.textContent = entry.repeats > 1 ? `×${entry.repeats}` : '';
    badge.title = 'Repeats — click to cycle, scroll to fine-tune';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const pos = SONG_REPEAT_CYCLE.indexOf(entry.repeats);
      const nextRepeats =
        pos >= 0
          ? SONG_REPEAT_CYCLE[(pos + 1) % SONG_REPEAT_CYCLE.length]
          : SONG_REPEAT_CYCLE[0];
      setSongEntryRepeats(entry.id, nextRepeats);
    });

    block.title = `${loop?.name ?? '?'} — right-click: cycles / remove · scroll: ±1 cycle`;
    block.addEventListener('click', () => {
      const idx = LOOPS.list.findIndex((l) => l.id === entry.loopId);
      if (idx >= 0) selectEditLoop(idx);
    });
    block.addEventListener('wheel', (e) => {
      e.preventDefault();
      setSongEntryRepeats(entry.id, entry.repeats - Math.sign(e.deltaY));
    });
    block.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSongBlockMenu(entry.id, e.clientX, e.clientY);
    });
    block.addEventListener('dragstart', (e) => {
      block.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', entry.id);
        } catch (_) {}
      }
    });
    block.addEventListener('dragend', () => {
      block.classList.remove('dragging');
      commitSongOrderFromDom();
    });

    block.append(name, badge);
    songBlockEls.set(entry.id, block);
    blocksWrap.appendChild(block);
  });

  blocksWrap.addEventListener('dragover', (e) => {
    const dragging = blocksWrap.querySelector('.song-block.dragging');
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const after = getSongDragAfterElement(blocksWrap, e.clientX);
    if (after == null) blocksWrap.appendChild(dragging);
    else if (after !== dragging) blocksWrap.insertBefore(dragging, after);
  });
  lane.appendChild(blocksWrap);

  const cycleBtn = document.createElement('button');
  cycleBtn.type = 'button';
  cycleBtn.className = 'song-opt-btn' + (SONG.loop ? ' active' : '');
  cycleBtn.textContent = '⟳';
  cycleBtn.title = 'Cycle the song when it reaches the end';
  cycleBtn.addEventListener('click', () => {
    SONG.loop = !SONG.loop;
    cycleBtn.classList.toggle('active', SONG.loop);
  });
  lane.appendChild(cycleBtn);

  const followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.className = 'song-opt-btn' + (SONG.follow ? ' active' : '');
  followBtn.textContent = 'follow';
  followBtn.title = 'While the song plays, show the loop that is sounding';
  followBtn.addEventListener('click', () => {
    SONG.follow = !SONG.follow;
    followBtn.classList.toggle('active', SONG.follow);
  });
  lane.appendChild(followBtn);

  if (SONG.entries.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'song-empty-hint';
    hint.textContent = '← + adds the selected loop';
    blocksWrap.appendChild(hint);
  }

  renderSongPlayhead();
}

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
  {
    // Pattern data comes from the audible loop (edited loop in loop mode, the
    // sounding song entry in song mode); transport position stays on STEP_SEQ.
    const seq = getAudibleLoop()?.seq || STEP_SEQ;
    const stepDuration = getSeqStepDurationFor(seq);
    let advanced = false;
    STEP_SEQ.elapsed += dt;
    while (STEP_SEQ.elapsed >= stepDuration) {
      STEP_SEQ.elapsed -= stepDuration;
      STEP_SEQ.currentStep = (STEP_SEQ.currentStep + 1) % getSeqActiveStepCountFor(seq);
      advanced = true;
    }
    if (STEP_SEQ.currentStep >= getSeqActiveStepCountFor(seq)) STEP_SEQ.currentStep = 0;
    STEP_SEQ.currentValue = seq.steps[STEP_SEQ.currentStep] || 0;
    if (advanced || dt === 0) refreshSequencerUI();
  }
  if (KICK_SC.envelope > 0) {
    KICK_SC.envelope = Math.max(0, KICK_SC.envelope - dt / Math.max(0.005, KICK_SC.release));
  }
  applyMappedModulationTargets();
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
  STEP_SEQ.currentStep = 0;
  STEP_SEQ.currentValue = STEP_SEQ.steps[0] || 0;
  STEP_SEQ.elapsed = 0;
  refreshSequencerUI();
  refreshModulationVisuals();
  refreshBackPanelState();
}

function setSequencerSubdivision(subdivision) {
  STEP_SEQ.subdivision = clamp(Math.round(subdivision), 1, STEP_SEQ.steps.length);
  const editLoop = getEditLoop();
  if (editLoop) editLoop.seq.subdivision = STEP_SEQ.subdivision;
  STEP_SEQ.currentStep = Math.min(STEP_SEQ.currentStep, getSeqActiveStepCount() - 1);
  STEP_SEQ.currentValue = STEP_SEQ.steps[STEP_SEQ.currentStep] || 0;
  STEP_SEQ.elapsed = 0;
  refreshSequencerUI();
  refreshBackPanelState();
  applyMappedModulationTargets();
}

function setSequencerStepBeats(stepBeats) {
  STEP_SEQ.stepBeats = clampSequencerStepBeats(stepBeats);
  const editLoop = getEditLoop();
  if (editLoop) editLoop.seq.stepBeats = STEP_SEQ.stepBeats;
  STEP_SEQ.elapsed = 0;
  refreshSequencerUI();
  refreshBackPanelState();
  applyMappedModulationTargets();
}

function cycleLFOMap(genIdx, key) {
  const mapKey = `${genIdx}:${key}`;
  const mapping = lfoMappings.get(mapKey);
  let nextSourceIdx = null;
  if (!mapping) {
    lfoMappings.set(mapKey, { genIdx, key, sourceIdx: 0 });
    nextSourceIdx = 0;
  } else if (mapping.sourceIdx === 0) {
    mapping.sourceIdx = 1;
    nextSourceIdx = 1;
  } else if (mapping.sourceIdx === 1) {
    mapping.sourceIdx = 2;
    nextSourceIdx = 2;
  } else if (mapping.sourceIdx === 2) {
    mapping.sourceIdx = 3;
    nextSourceIdx = 3;
  } else {
    lfoMappings.delete(mapKey);
    nextSourceIdx = null;
  }
  if (genIdx === 2) applyGen3Modulation();
  else if (genIdx === 3) applyFxModulation();
  else if (genIdx === 4) applyGen4Modulation();
  else sendParams(genIdx);
  rebuildBackWireSVG();
  refreshBackPanelState();
  return nextSourceIdx;
}

function setLFOMapSource(genIdx, key, sourceIdx) {
  const mapKey = `${genIdx}:${key}`;
  if (sourceIdx === null) lfoMappings.delete(mapKey);
  else lfoMappings.set(mapKey, { genIdx, key, sourceIdx });
  if (genIdx === 2) applyGen3Modulation();
  else if (genIdx === 3) applyFxModulation();
  else if (genIdx === 4) applyGen4Modulation();
  else sendParams(genIdx);
  rebuildBackWireSVG();
  refreshBackPanelState();
  refreshModulationVisuals();
  return sourceIdx;
}

// ── Mod source context menu (right-click a knob's map LED) ──

let modSourceMenuEl = null;

function closeModSourceMenu() {
  if (!modSourceMenuEl) return;
  modSourceMenuEl.remove();
  modSourceMenuEl = null;
}

function getModSourceOptions() {
  return [
    { idx: null, label: 'None', ledClass: '' },
    { idx: 0, label: LFOS[0]?.label || 'LFO 1', ledClass: 'lfo-1' },
    { idx: 1, label: LFOS[1]?.label || 'LFO 2', ledClass: 'lfo-2' },
    { idx: 2, label: STEP_SEQ.label || 'Seq', ledClass: 'lfo-seq' },
    { idx: 3, label: 'Kick SC', ledClass: 'lfo-sc' },
  ];
}

function openModSourceMenu(target, led, x, y) {
  closeModSourceMenu();
  const current = lfoMappings.get(`${target.genIdx}:${target.key}`)?.sourceIdx ?? null;

  const menu = document.createElement('div');
  menu.className = 'mod-source-menu';
  modSourceMenuEl = menu;

  const title = document.createElement('div');
  title.className = 'mod-source-menu-title';
  title.textContent = 'Mod source';
  menu.appendChild(title);

  getModSourceOptions().forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mod-source-option' + (opt.idx === current ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'mod-source-dot' + (opt.ledClass ? ` active ${opt.ledClass}` : '');
    dot.textContent = opt.idx === null ? '' : opt.idx === 2 ? 'S' : opt.idx === 3 ? 'K' : `${opt.idx + 1}`;

    const lbl = document.createElement('span');
    lbl.className = 'mod-source-label';
    lbl.textContent = opt.label;

    btn.append(dot, lbl);
    btn.addEventListener('click', () => {
      setLFOMapSource(target.genIdx, target.key, opt.idx);
      setLFOLedState(led, opt.idx);
      closeModSourceMenu();
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

window.addEventListener('pointerdown', (e) => {
  if (modSourceMenuEl && !modSourceMenuEl.contains(e.target)) closeModSourceMenu();
});

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
    isSync
      ? (v) => formatTempoSyncValue(v, (step) => formatTempoSeconds(beatsToSeconds(step.beats)))
      : null,
  );
  control.setValue(isSync ? FX.delay.syncIndex : FX.delay.time);
  delaySyncModeControl?.setMode(isSync ? 'sync' : 'free');
}

function refreshBeatRepeatIntervalUI() {
  const control = fxControlBindings.get('beatrepeat:interval');
  if (!control) return;
  const isSync = !!FX.beatrepeat.sync;
  control.setConfig(
    isSync
      ? { ...BEATREPEAT_INTERVAL_SYNC_CONTROL, resetValue: FX.beatrepeat.syncIndex }
      : { ...BEATREPEAT_INTERVAL_FREE_CONTROL, resetValue: FX.beatrepeat.interval },
  );
  control.setFormatter(
    isSync
      ? (v) => formatTempoSyncValue(v, (step) => formatTempoSeconds(beatsToSeconds(step.beats)))
      : null,
  );
  control.setValue(isSync ? FX.beatrepeat.syncIndex : FX.beatrepeat.interval);
  beatRepeatSyncModeControl?.setMode(isSync ? 'sync' : 'free');
}

function refreshBeatRepeatGridUI() {
  const control = fxControlBindings.get('beatrepeat:grid');
  if (!control) return;
  const isSync = !!FX.beatrepeat.gridSync;
  control.setConfig(
    isSync
      ? { ...BEATREPEAT_GRID_SYNC_CONTROL, resetValue: FX.beatrepeat.gridSyncIndex }
      : { ...BEATREPEAT_GRID_FREE_CONTROL, resetValue: FX.beatrepeat.grid },
  );
  control.setFormatter(isSync ? (v) => getGrainSyncStep(Math.round(v)).label : null);
  control.setValue(isSync ? FX.beatrepeat.gridSyncIndex : FX.beatrepeat.grid);
  beatRepeatGridSyncModeControl?.setMode(isSync ? 'sync' : 'free');
}

function refreshDelayModeUI() {
  delayModeButtons.forEach((btn, mode) => btn.classList.toggle('active', FX.delay.mode === mode));
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
      ? (v) =>
          formatTempoSyncValue(
            v,
            (step) => `${formatNumericValue(1 / beatsToSeconds(step.beats), 2)}Hz`,
          )
      : null,
  );
  control.setValue(isSync ? lfo.syncIndex : lfo.rate);
  lfoSyncModeControls[lfoIdx]?.setMode(isSync ? 'sync' : 'free');
}

function setTransportBpm(value, { refresh = true } = {}) {
  if (!Number.isFinite(value)) return;
  const decimals = (BPM_BOUNDS.step.toString().split('.')[1] || '').length;
  TRANSPORT.bpm = clamp(quantize(value, BPM_BOUNDS.step, decimals), BPM_BOUNDS.min, BPM_BOUNDS.max);
  const bpmInput = getBpmInput();
  if (bpmInput) bpmInput.value = `${TRANSPORT.bpm}`;
  if (!refresh) return;
  // Every bus has its own sync-locked delay/beat-repeat times — retune them all.
  FX_BUS_IDS.forEach((busId) => {
    const st = fxStates[busId];
    if (st.delay.sync) applyFx('delay', 'time', getBaseFxValue('delay', 'time', busId), busId);
    if (st.beatrepeat.sync)
      applyFx('beatrepeat', 'interval', getBaseFxValue('beatrepeat', 'interval', busId), busId);
    if (st.beatrepeat.gridSync)
      applyFx('beatrepeat', 'grid', getBaseFxValue('beatrepeat', 'grid', busId), busId);
  });
  refreshDelayTimeUI();
  refreshBeatRepeatIntervalUI();
  refreshBeatRepeatGridUI();
  refreshLFOUI();
  for (let gi = 0; gi < 2; gi++) {
    if (state[gi].grainSizeSync) refreshGenGrainSizeSyncUI(gi);
    if (state[gi].densitySync) refreshGenDensitySyncUI(gi);
    if (state[gi].grainSizeSync || state[gi].densitySync) sendParams(gi);
  }
  applyMappedModulationTargets();
  refreshBackPanelState();
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

function getFxParamDef(id, key) {
  return FX_DEFS.find((def) => def.id === id)?.params.find((param) => param.key === key) || null;
}

function getGen3ParamLabel(key) {
  if (key === 'gain') return 'Gain';
  if (key === 'pitch') return 'Pitch';
  if (key === 'detune') return 'Detune';
  return key;
}

function formatBackValue(spec, value) {
  if (!spec || typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return formatControlValue(spec, value);
}

function getSelectedInputLabel() {
  const idx = INPUT_SOURCE.devices.findIndex(
    (device) => device.deviceId === INPUT_SOURCE.selectedId,
  );
  return formatInputDeviceLabel(
    INPUT_SOURCE.devices[idx] ||
      INPUT_SOURCE.devices[0] || { deviceId: 'default', label: 'System Default' },
    Math.max(0, idx),
  );
}

function getBackTargetValue(routeKey) {
  const [group, a, b] = routeKey.split(':');
  if (group === '0' || group === '1') {
    return formatBackValue(
      getParamBounds(Number(group), a),
      getEffectiveGeneratorParams(Number(group))[a],
    );
  }
  if (group === '2') {
    const spec = getGen3ParamBounds(a) || { step: 0.01, unit: '' };
    return formatBackValue(spec, getEffectiveGen3Params()[a]);
  }
  if (group === '3') {
    const spec = getFxParamDef(a, b);
    return formatBackValue(spec, getEffectiveFxValue(a, b));
  }
  return 'n/a';
}

function parseBackRouteKey(routeKey) {
  const [group, a, b] = routeKey.split(':');
  const genIdx = Number(group);
  if (!Number.isFinite(genIdx)) return null;
  if (genIdx === 3 || genIdx === 4) {
    if (!a || !b) return null;
    return { genIdx, key: `${a}:${b}` };
  }
  if (!a) return null;
  return { genIdx, key: a };
}

function clearBackPatchSelection() {
  if (
    BACK_PANEL.selectedSourceIdx === null &&
    BACK_PANEL.pointerX === null &&
    BACK_PANEL.pointerY === null
  ) {
    return;
  }
  BACK_PANEL.selectedSourceIdx = null;
  BACK_PANEL.pointerX = null;
  BACK_PANEL.pointerY = null;
  refreshBackPanelState();
}

function setBackPatchSelection(sourceIdx) {
  BACK_PANEL.selectedSourceIdx = BACK_PANEL.selectedSourceIdx === sourceIdx ? null : sourceIdx;
  BACK_PANEL.pointerX = null;
  BACK_PANEL.pointerY = null;
  refreshBackPanelState();
}

function applyModulationTargetUpdate(genIdx) {
  if (genIdx === 2) applyGen3Modulation();
  else if (genIdx === 3) applyFxModulation();
  else if (genIdx === 4) applyGen4Modulation();
  else sendParams(genIdx);
}

function patchBackPanelRoute(routeKey) {
  if (BACK_PANEL.selectedSourceIdx === null) return;
  const parsed = parseBackRouteKey(routeKey);
  if (!parsed) return;
  const existing = lfoMappings.get(routeKey);
  if (existing?.sourceIdx === BACK_PANEL.selectedSourceIdx) {
    lfoMappings.delete(routeKey);
  } else {
    lfoMappings.set(routeKey, {
      genIdx: parsed.genIdx,
      key: parsed.key,
      sourceIdx: BACK_PANEL.selectedSourceIdx,
    });
  }
  applyModulationTargetUpdate(parsed.genIdx);
  rebuildBackWireSVG();
  refreshLFOMappingUI();
}

function buildBackPanel() {
  const root = getBackPanel();
  if (!root) return;
  root.textContent = '';
  BACK_PANEL.sourceJacks.clear();
  BACK_PANEL.sourceMeters.clear();
  BACK_PANEL.sourceMeta.clear();
  BACK_PANEL.audioModules.clear();
  BACK_PANEL.targetJacks.clear();
  BACK_PANEL.targetRows.clear();
  BACK_PANEL.targetValues.clear();

  const board = document.createElement('div');
  board.className = 'back-board';

  const legend = document.createElement('div');
  legend.className = 'back-board-legend';
  legend.innerHTML = '<span>modulation board</span><span>rev a</span>';
  board.appendChild(legend);

  for (let idx = 0; idx < 4; idx++) {
    const hole = document.createElement('div');
    hole.className = `back-mount-hole hole-${idx + 1}`;
    board.appendChild(hole);
  }

  const patchfield = document.createElement('div');
  patchfield.className = 'back-patchfield';
  BACK_PANEL.patchfieldEl = patchfield;

  const wireLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wireLayer.classList.add('back-wire-layer');
  patchfield.appendChild(wireLayer);
  BACK_PANEL.routeLayer = wireLayer;

  const sourceColumn = document.createElement('div');
  sourceColumn.className = 'back-column';
  [
    { idx: 0, title: 'LFO 1' },
    { idx: 1, title: 'LFO 2' },
    { idx: 2, title: 'Seq 1' },
  ].forEach(({ idx, title }) => {
    const module = document.createElement('div');
    module.className = 'back-module back-source-module';
    const titleEl = document.createElement('div');
    titleEl.className = 'back-module-title';
    titleEl.textContent = title;
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'back-module-subtitle';
    subtitleEl.textContent = '...';
    const body = document.createElement('div');
    body.className = 'back-source-body';
    const readout = document.createElement('div');
    readout.className = 'back-source-readout';
    const left = document.createElement('span');
    left.textContent = 'mod out';
    const valueEl = document.createElement('span');
    valueEl.textContent = '0.00';
    readout.append(left, valueEl);
    const meter = document.createElement('div');
    meter.className = 'back-source-meter';
    const fill = document.createElement('div');
    fill.className = `back-source-fill src-${idx}`;
    meter.appendChild(fill);
    const jackRow = document.createElement('div');
    jackRow.className = 'back-source-readout';
    const jackLabel = document.createElement('span');
    jackLabel.textContent = 'patch';
    const jack = document.createElement('button');
    jack.type = 'button';
    jack.className = 'patch-jack source';
    jack.addEventListener('click', (e) => {
      e.stopPropagation();
      setBackPatchSelection(idx);
    });
    jackRow.append(jackLabel, jack);
    body.append(readout, meter, jackRow);
    module.append(titleEl, subtitleEl, body);
    sourceColumn.appendChild(module);
    BACK_PANEL.sourceJacks.set(idx, jack);
    BACK_PANEL.sourceMeters.set(idx, fill);
    BACK_PANEL.sourceMeta.set(idx, { subtitleEl, valueEl, module });
  });

  // Kick SC source module (sourceIdx = 3)
  (() => {
    const module = document.createElement('div');
    module.className = 'back-module back-source-module back-sc-module';
    const titleEl = document.createElement('div');
    titleEl.className = 'back-module-title';
    titleEl.textContent = 'Kick SC';
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'back-module-subtitle';
    subtitleEl.textContent = 'Sidechain';
    const body = document.createElement('div');
    body.className = 'back-source-body';

    const readout = document.createElement('div');
    readout.className = 'back-source-readout';
    const readoutLabel = document.createElement('span');
    readoutLabel.textContent = 'envelope';
    const valueEl = document.createElement('span');
    valueEl.textContent = '0.00';
    readout.append(readoutLabel, valueEl);

    const meter = document.createElement('div');
    meter.className = 'back-source-meter';
    const fill = document.createElement('div');
    fill.className = 'back-source-fill src-3';
    meter.appendChild(fill);

    const buildScCtrl = (label, min, max, step, initial, unit, onChange) => {
      const row = document.createElement('div');
      row.className = 'back-source-readout';
      const lbl = document.createElement('span');
      lbl.textContent = label;
      const valEl = document.createElement('span');
      valEl.textContent = `${formatNumericValue(initial, 2)}${unit}`;
      row.append(lbl, valEl);
      const sliderRow = document.createElement('div');
      sliderRow.className = 'back-sc-slider-row';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'back-sc-slider';
      slider.dataset.scParam = label;
      slider.dataset.scUnit = unit;
      slider.min = `${min}`;
      slider.max = `${max}`;
      slider.step = `${step}`;
      slider.value = `${initial}`;
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        onChange(v);
        valEl.textContent = `${formatNumericValue(v, 2)}${unit}`;
      });
      sliderRow.appendChild(slider);
      return [row, sliderRow];
    };

    const [amtRow, amtSliderRow] = buildScCtrl('amount', 0, 1, 0.01, KICK_SC.amount, '', (v) => {
      KICK_SC.amount = v;
    });
    const [relRow, relSliderRow] = buildScCtrl(
      'release',
      0.01,
      1,
      0.01,
      KICK_SC.release,
      's',
      (v) => {
        KICK_SC.release = v;
      },
    );

    const jackRow = document.createElement('div');
    jackRow.className = 'back-source-readout';
    const jackLabel = document.createElement('span');
    jackLabel.textContent = 'patch';
    const jack = document.createElement('button');
    jack.type = 'button';
    jack.className = 'patch-jack source';
    jack.addEventListener('click', (e) => {
      e.stopPropagation();
      setBackPatchSelection(3);
    });
    jackRow.append(jackLabel, jack);

    body.append(readout, meter, amtRow, amtSliderRow, relRow, relSliderRow, jackRow);
    module.append(titleEl, subtitleEl, body);
    sourceColumn.appendChild(module);
    BACK_PANEL.sourceJacks.set(3, jack);
    BACK_PANEL.sourceMeters.set(3, fill);
    BACK_PANEL.sourceMeta.set(3, { subtitleEl, valueEl, module });
  })();

  const destGrid = document.createElement('div');
  destGrid.className = 'back-dest-grid';
  const destinationGroups = [
    {
      title: 'Gen 1',
      subtitle: 'Granular A',
      params: PARAMS.map((p) => ({ routeKey: `0:${p.key}`, label: p.label })),
    },
    {
      title: 'Gen 2',
      subtitle: 'Granular B',
      params: PARAMS.map((p) => ({ routeKey: `1:${p.key}`, label: p.label })),
    },
    {
      title: 'Gen 3',
      subtitle: 'Oscillator',
      params: GEN3_LFO_PARAMS.map((p) => ({
        routeKey: `2:${p.key}`,
        label: getGen3ParamLabel(p.key),
      })),
    },
    {
      title: 'Delay',
      subtitle: 'FX routing',
      params: ['time', 'feedback', 'mix'].map((key) => ({
        routeKey: `3:delay:${key}`,
        label: getFxParamDef('delay', key)?.label || key,
      })),
    },
    {
      title: 'Filter',
      subtitle: 'Tone shaping',
      params: ['cutoff', 'q', 'mix'].map((key) => ({
        routeKey: `3:filter:${key}`,
        label: getFxParamDef('filter', key)?.label || key,
      })),
    },
    {
      title: 'Bit + Verb',
      subtitle: 'Texture / space',
      params: [
        {
          routeKey: '3:bitreduce:rate',
          label: getFxParamDef('bitreduce', 'rate')?.label || 'Rate',
        },
        { routeKey: '3:bitreduce:mix', label: getFxParamDef('bitreduce', 'mix')?.label || 'Mix' },
        {
          routeKey: '3:reverb:predelay',
          label: getFxParamDef('reverb', 'predelay')?.label || 'Pre-delay',
        },
        { routeKey: '3:reverb:mix', label: getFxParamDef('reverb', 'mix')?.label || 'Mix' },
      ],
    },
    ...GEN4_DEFS.map((def) => ({
      title: `Drm·${def.label}`,
      subtitle:
        def.id === 'kick'
          ? 'Bass drum'
          : def.id === 'snare'
            ? 'Snare'
            : def.id === 'hat'
              ? 'Hi-hat'
              : 'Percussion',
      params: def.paramDefs.map((pd) => ({ routeKey: `4:${def.id}:${pd.key}`, label: pd.label })),
    })),
  ];

  destinationGroups.forEach(({ title, subtitle, params }) => {
    const module = document.createElement('div');
    module.className = 'back-module back-dest-module';
    const titleEl = document.createElement('div');
    titleEl.className = 'back-module-title';
    titleEl.textContent = title;
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'back-module-subtitle';
    subtitleEl.textContent = subtitle;
    const list = document.createElement('div');
    list.className = 'back-param-list';
    params.forEach(({ routeKey, label }) => {
      const row = document.createElement('div');
      row.className = 'back-param-row';
      const jack = document.createElement('button');
      jack.type = 'button';
      jack.className = 'patch-jack target';
      const labelEl = document.createElement('span');
      labelEl.className = 'back-param-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'back-param-value';
      valueEl.textContent = '...';
      row.append(jack, labelEl, valueEl);
      const handlePatch = (event) => {
        event.stopPropagation();
        if (BACK_PANEL.selectedSourceIdx === null) {
          const mapping = lfoMappings.get(routeKey);
          if (mapping) {
            setBackPatchSelection(mapping.sourceIdx);
          }
          return;
        }
        patchBackPanelRoute(routeKey);
      };
      row.addEventListener('click', handlePatch);
      jack.addEventListener('click', handlePatch);
      list.appendChild(row);
      BACK_PANEL.targetJacks.set(routeKey, jack);
      BACK_PANEL.targetRows.set(routeKey, row);
      BACK_PANEL.targetValues.set(routeKey, valueEl);
    });
    module.append(titleEl, subtitleEl, list);
    destGrid.appendChild(module);
  });

  patchfield.addEventListener('pointermove', (event) => {
    if (BACK_PANEL.selectedSourceIdx === null) return;
    const rect = patchfield.getBoundingClientRect();
    BACK_PANEL.pointerX = event.clientX - rect.left;
    BACK_PANEL.pointerY = event.clientY - rect.top;
    if (UI_VIEW.mode === 'back') requestAnimationFrame(renderBackPanelConnections);
  });
  patchfield.addEventListener('pointerleave', () => {
    if (BACK_PANEL.selectedSourceIdx === null) return;
    BACK_PANEL.pointerX = null;
    BACK_PANEL.pointerY = null;
    if (UI_VIEW.mode === 'back') requestAnimationFrame(renderBackPanelConnections);
  });
  patchfield.addEventListener('click', (event) => {
    if (BACK_PANEL.selectedSourceIdx === null) return;
    if (event.target.closest('.patch-jack') || event.target.closest('.back-param-row')) return;
    clearBackPatchSelection();
  });

  // ── Master Limiter Column ──
  const masterColumn = document.createElement('div');
  masterColumn.className = 'back-column';

  const limiterModule = document.createElement('div');
  limiterModule.className = 'back-module back-dest-module';

  const limTitleEl = document.createElement('div');
  limTitleEl.className = 'back-module-title';
  limTitleEl.textContent = 'Limiter';

  const limSubtitleEl = document.createElement('div');
  limSubtitleEl.className = 'back-module-subtitle';
  limSubtitleEl.textContent = 'Master bus';

  const limBody = document.createElement('div');
  limBody.className = 'back-source-body';

  const limReadout = document.createElement('div');
  limReadout.className = 'back-source-readout';
  const limLabel = document.createElement('span');
  limLabel.textContent = 'Gain Reduction';
  const limValueEl = document.createElement('span');
  limValueEl.textContent = '0.0 dB';
  limReadout.append(limLabel, limValueEl);

  const limMeter = document.createElement('div');
  limMeter.className = 'back-source-meter';
  const limFill = document.createElement('div');
  limFill.className = 'back-source-fill src-limiter unipolar';
  limMeter.appendChild(limFill);

  limBody.append(limReadout, limMeter);
  limiterModule.append(limTitleEl, limSubtitleEl, limBody);
  masterColumn.appendChild(limiterModule);

  BACK_PANEL.limiterValueEl = limValueEl;
  BACK_PANEL.limiterFill = limFill;

  patchfield.append(sourceColumn, destGrid, masterColumn);
  board.append(patchfield);
  root.appendChild(board);
  BACK_PANEL.built = true;
  refreshBackPanelState();
}

// Build wire SVG elements once; called when routes change or panel opens.
// Per-frame loop only updates CSS opacity vars — no layout reads.
function rebuildBackWireSVG() {
  if (!BACK_PANEL.built || !BACK_PANEL.routeLayer) return;
  const svg = BACK_PANEL.routeLayer;

  // Remove old static wires, keep preview group
  Array.from(svg.children).forEach((el) => {
    if (!el.classList.contains('preview')) el.remove();
  });

  BACK_PANEL.wireGlowEls = new Map();
  BACK_PANEL.wireEls = new Map();

  const svgRect = svg.getBoundingClientRect();
  const routes = [...lfoMappings.values()].sort((a, b) => {
    if (a.sourceIdx !== b.sourceIdx) return a.sourceIdx - b.sourceIdx;
    if (a.genIdx !== b.genIdx) return a.genIdx - b.genIdx;
    return `${a.key}`.localeCompare(`${b.key}`);
  });

  routes.forEach(({ genIdx, key, sourceIdx }, routeIdx) => {
    const sourceJack = BACK_PANEL.sourceJacks.get(sourceIdx);
    const targetJack = BACK_PANEL.targetJacks.get(`${genIdx}:${key}`);
    if (!sourceJack || !targetJack) return;
    const s = sourceJack.getBoundingClientRect();
    const t = targetJack.getBoundingClientRect();
    const sx = s.left - svgRect.left + s.width / 2;
    const sy = s.top - svgRect.top + s.height / 2;
    const tx = t.left - svgRect.left + t.width / 2;
    const ty = t.top - svgRect.top + t.height / 2;
    const travel = Math.max(120, tx - sx);
    const drop = 34 + (routeIdx % 6) * 16 + sourceIdx * 10;
    const spread = ((routeIdx % 5) - 2) * 18;
    const c1x = sx + Math.min(travel * 0.24, 120);
    const c2x = tx - Math.min(travel * 0.3, 170);
    const c1y = sy + drop + spread * 0.2;
    const c2y = ty + drop - spread * 0.35;
    const d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
    const rk = `${genIdx}:${key}`;

    const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shadow.setAttribute('d', d);
    shadow.setAttribute('class', 'back-wire-shadow');
    svg.appendChild(shadow);

    const glow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('class', `back-wire-glow src-${sourceIdx}`);
    svg.appendChild(glow);
    BACK_PANEL.wireGlowEls.set(rk, glow);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `back-wire src-${sourceIdx}`);
    svg.appendChild(path);
    BACK_PANEL.wireEls.set(rk, path);

    [
      [sx, sy],
      [tx, ty],
    ].forEach(([cx, cy]) => {
      const plug = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      plug.setAttribute('cx', cx.toFixed(1));
      plug.setAttribute('cy', cy.toFixed(1));
      plug.setAttribute('r', '7.2');
      plug.setAttribute('class', `back-wire-plug src-${sourceIdx}`);
      svg.appendChild(plug);
      const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      core.setAttribute('cx', cx.toFixed(1));
      core.setAttribute('cy', cy.toFixed(1));
      core.setAttribute('r', '3');
      core.setAttribute('class', 'back-wire-plug-core');
      svg.appendChild(core);
    });
  });
}

function renderBackPanelConnections() {
  if (!BACK_PANEL.built || !BACK_PANEL.routeLayer || UI_VIEW.mode !== 'back') return;

  // ── Update wire glow opacity (no layout reads — just CSS vars) ──
  lfoMappings.forEach(({ genIdx, key, sourceIdx }) => {
    const activity = Math.abs(getModSourceScaledValue(sourceIdx) || 0);
    const rk = `${genIdx}:${key}`;
    BACK_PANEL.wireGlowEls
      ?.get(rk)
      ?.style.setProperty('--route-opacity', `${(0.34 + activity * 0.34).toFixed(2)}`);
    BACK_PANEL.wireEls
      ?.get(rk)
      ?.style.setProperty('--route-opacity', `${(0.76 + activity * 0.24).toFixed(2)}`);
  });

  // ── Preview wire while patching ──
  const svg = BACK_PANEL.routeLayer;
  svg.querySelectorAll('.preview').forEach((el) => el.remove());
  if (
    BACK_PANEL.selectedSourceIdx !== null &&
    BACK_PANEL.pointerX !== null &&
    BACK_PANEL.pointerY !== null
  ) {
    const sourceJack = BACK_PANEL.sourceJacks.get(BACK_PANEL.selectedSourceIdx);
    if (sourceJack) {
      const svgRect = svg.getBoundingClientRect();
      const s = sourceJack.getBoundingClientRect();
      const sx = s.left - svgRect.left + s.width / 2;
      const sy = s.top - svgRect.top + s.height / 2;
      const tx = BACK_PANEL.pointerX;
      const ty = BACK_PANEL.pointerY;
      const travel = Math.max(90, tx - sx);
      const c1x = sx + Math.min(Math.max(50, travel * 0.28), 110);
      const c2x = tx - 48;
      const d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${(sy + 56).toFixed(1)}, ${c2x.toFixed(1)} ${(ty + 34).toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      const ci = BACK_PANEL.selectedSourceIdx;
      [
        ['back-wire-shadow preview', null, null],
        [`back-wire-glow src-${ci} preview`, '--route-opacity', '0.44'],
        [`back-wire src-${ci} preview`, '--route-opacity', '0.82'],
      ].forEach(([cls, prop, val]) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        el.setAttribute('d', d);
        el.setAttribute('class', cls);
        if (prop) el.style.setProperty(prop, val);
        svg.appendChild(el);
      });
    }
  }

  // ── Limiter gain reduction meter ──
  if (BACK_PANEL.limiterValueEl && BACK_PANEL.limiterFill && master?.limiter?.comp) {
    const reduction = Math.abs(master.limiter.comp.reduction || 0);
    BACK_PANEL.limiterValueEl.textContent = `${formatNumericValue(reduction, 1)} dB`;
    BACK_PANEL.limiterFill.style.setProperty('--source-level', `${Math.min(1, reduction / 12)}`);
  }

  if (UI_VIEW.mode === 'back') requestAnimationFrame(renderBackPanelConnections);
}

function refreshBackPanelState() {
  if (!BACK_PANEL.built) return;

  BACK_PANEL.patchfieldEl?.classList.toggle('patching', BACK_PANEL.selectedSourceIdx !== null);

  [0, 1, 2, 3].forEach((idx) => {
    const meta = BACK_PANEL.sourceMeta.get(idx);
    if (!meta) return;
    const routeCount = [...lfoMappings.values()].filter(
      (mapping) => mapping.sourceIdx === idx,
    ).length;
    meta.module.dataset.routes = `${routeCount}`;
    meta.module.classList.toggle('mapped', routeCount > 0);
    meta.module.classList.toggle('selected', BACK_PANEL.selectedSourceIdx === idx);
  });

  BACK_PANEL.sourceMeta.get(0) &&
    (() => {
      const meta = BACK_PANEL.sourceMeta.get(0);
      const routeCount = [...lfoMappings.values()].filter(
        (mapping) => mapping.sourceIdx === 0,
      ).length;
      meta.subtitleEl.textContent = `${LFOS[0].shape.toUpperCase()} • ${LFOS[0].sync ? getTempoStep(LFOS[0].syncIndex).label : `${formatNumericValue(LFOS[0].rate, 2)}Hz`} • ${routeCount} route${routeCount === 1 ? '' : 's'}`;
      meta.valueEl.textContent = `${LFOS[0].currentValue >= 0 ? '+' : ''}${formatNumericValue(LFOS[0].currentValue, 2)}`;
      meta.module.classList.toggle('active', true);
    })();
  BACK_PANEL.sourceMeta.get(1) &&
    (() => {
      const meta = BACK_PANEL.sourceMeta.get(1);
      const routeCount = [...lfoMappings.values()].filter(
        (mapping) => mapping.sourceIdx === 1,
      ).length;
      meta.subtitleEl.textContent = `${LFOS[1].shape.toUpperCase()} • ${LFOS[1].sync ? getTempoStep(LFOS[1].syncIndex).label : `${formatNumericValue(LFOS[1].rate, 2)}Hz`} • ${routeCount} route${routeCount === 1 ? '' : 's'}`;
      meta.valueEl.textContent = `${LFOS[1].currentValue >= 0 ? '+' : ''}${formatNumericValue(LFOS[1].currentValue, 2)}`;
      meta.module.classList.toggle('active', true);
    })();
  BACK_PANEL.sourceMeta.get(2) &&
    (() => {
      const meta = BACK_PANEL.sourceMeta.get(2);
      const routeCount = [...lfoMappings.values()].filter(
        (mapping) => mapping.sourceIdx === 2,
      ).length;
      meta.subtitleEl.textContent = `${getSeqActiveStepCount()} steps • ${formatSequencerStepBeats(STEP_SEQ.stepBeats)}b/step • step ${STEP_SEQ.currentStep + 1} • ${routeCount} route${routeCount === 1 ? '' : 's'}`;
      meta.valueEl.textContent = `${STEP_SEQ.currentValue >= 0 ? '+' : ''}${formatNumericValue(STEP_SEQ.currentValue, 2)}`;
      meta.module.classList.toggle('active', true);
    })();
  BACK_PANEL.sourceMeta.get(3) &&
    (() => {
      const meta = BACK_PANEL.sourceMeta.get(3);
      const routeCount = [...lfoMappings.values()].filter(
        (mapping) => mapping.sourceIdx === 3,
      ).length;
      meta.subtitleEl.textContent = `${formatNumericValue(KICK_SC.release, 2)}s release • ${routeCount} route${routeCount === 1 ? '' : 's'}`;
      meta.valueEl.textContent = formatNumericValue(KICK_SC.envelope, 2);
      meta.module.classList.toggle('active', KICK_SC.envelope > 0.01);
    })();

  [0, 1, 2].forEach((idx) => {
    const fill = BACK_PANEL.sourceMeters.get(idx);
    const value = idx === 2 ? STEP_SEQ.currentValue : LFOS[idx].currentValue;
    if (!fill) return;
    fill.style.setProperty('--source-level', `${Math.abs(value)}`);
    fill.classList.toggle('negative', value < 0);
  });
  (() => {
    const fill = BACK_PANEL.sourceMeters.get(3);
    if (!fill) return;
    fill.style.setProperty('--source-level', `${KICK_SC.envelope}`);
  })();

  BACK_PANEL.audioModules.get('input-1') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('input-1');
      const source = getSourceState(0);
      module.subtitleEl.textContent =
        source.mode === 'file' ? source.fileName || 'File source' : getSelectedInputLabel();
      module.el.classList.toggle(
        'active',
        source.mode === 'file' ? !!source.bufferData : anyMicSourceSelected(),
      );
    })();
  BACK_PANEL.audioModules.get('gen-1') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('gen-1');
      module.subtitleEl.textContent = `${Math.round(state[0].density)}/s • ${formatNumericValue(state[0].grainSizeMs, 0)}ms`;
      module.el.classList.toggle('active', started);
    })();
  BACK_PANEL.audioModules.get('input-2') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('input-2');
      const source = getSourceState(1);
      module.subtitleEl.textContent =
        source.mode === 'file' ? source.fileName || 'File source' : getSelectedInputLabel();
      module.el.classList.toggle(
        'active',
        source.mode === 'file' ? !!source.bufferData : anyMicSourceSelected(),
      );
    })();
  BACK_PANEL.audioModules.get('gen-2') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('gen-2');
      module.subtitleEl.textContent = `${Math.round(state[1].density)}/s • ${formatNumericValue(state[1].grainSizeMs, 0)}ms`;
      module.el.classList.toggle('active', started);
    })();
  BACK_PANEL.audioModules.get('gen-3') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('gen-3');
      const totalVoices = GEN3.activeNotes.size + GEN3.releasingVoices.size;
      module.subtitleEl.textContent = `${GEN3.type.toUpperCase()} • ${totalVoices} voice${totalVoices === 1 ? '' : 's'}`;
      module.el.classList.toggle('active', GEN3.activeNotes.size + GEN3.releasingVoices.size > 0);
    })();
  BACK_PANEL.audioModules.get('mix') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('mix');
      module.subtitleEl.textContent = `${started ? 'front bus live' : 'standby'} • ${lfoMappings.size} mod route${lfoMappings.size === 1 ? '' : 's'}`;
      module.el.classList.toggle('active', started || GEN3.activeNotes.size > 0);
    })();
  BACK_PANEL.audioModules.get('delay') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('delay');
      module.subtitleEl.textContent = `${FX.delay.mode === 'pingpong' ? 'PINGPONG' : 'STEREO'} • ${formatBackValue(getFxParamDef('delay', 'mix'), FX.delay.mix)} wet`;
      module.el.classList.toggle('active', FX.delay.mix > 0.001);
    })();
  BACK_PANEL.audioModules.get('filter') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('filter');
      module.subtitleEl.textContent = `${FX.filter.mode.toUpperCase()} • ${formatNumericValue(FX.filter.cutoff, 0)}Hz`;
      module.el.classList.toggle('active', FX.filter.mix > 0.001);
    })();
  BACK_PANEL.audioModules.get('bitreduce') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('bitreduce');
      module.subtitleEl.textContent = `${formatNumericValue(FX.bitreduce.bits, 0)} bits • ${formatBackValue(getFxParamDef('bitreduce', 'mix'), FX.bitreduce.mix)} wet`;
      module.el.classList.toggle('active', FX.bitreduce.mix > 0.001);
    })();
  BACK_PANEL.audioModules.get('sat') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('sat');
      module.subtitleEl.textContent = `${formatBackValue(getFxParamDef('sat', 'drive'), FX.sat.drive)} drive`;
      module.el.classList.toggle('active', FX.sat.mix > 0.001 || FX.sat.drive > 0.001);
    })();
  BACK_PANEL.audioModules.get('reverb') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('reverb');
      module.subtitleEl.textContent = `${formatBackValue(getFxParamDef('reverb', 'mix'), FX.reverb.mix)} wet`;
      module.el.classList.toggle('active', FX.reverb.mix > 0.001);
    })();
  BACK_PANEL.audioModules.get('limiter') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('limiter');
      module.subtitleEl.textContent = `${formatNumericValue(LIMITER.ratio, 1)}:1 • ${formatNumericValue(LIMITER.threshold, 1)}dB`;
      module.el.classList.toggle('active', true);
    })();
  BACK_PANEL.audioModules.get('output') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('output');
      module.subtitleEl.textContent =
        started || GEN3.activeNotes.size > 0 ? getGranularStatusText() : 'idle';
      module.el.classList.toggle('active', started || GEN3.activeNotes.size > 0);
    })();

  BACK_PANEL.targetValues.forEach((valueEl, routeKey) => {
    valueEl.textContent = getBackTargetValue(routeKey);
  });

  BACK_PANEL.targetRows.forEach((row) => {
    row.classList.remove('mapped', 'src-0', 'src-1', 'src-2', 'patch-ready');
    row.classList.toggle('patch-ready', BACK_PANEL.selectedSourceIdx !== null);
  });
  lfoMappings.forEach(({ genIdx, key, sourceIdx }) => {
    BACK_PANEL.targetRows.get(`${genIdx}:${key}`)?.classList.add('mapped', `src-${sourceIdx}`);
  });

  if (UI_VIEW.mode === 'back') requestAnimationFrame(renderBackPanelConnections);
}

function setPanelView(mode) {
  UI_VIEW.mode = mode;
  document.getElementById('loopStrip')?.classList.toggle('hidden-panel', mode !== 'front');
  getFrontWorkspace()?.classList.toggle('hidden-panel', mode !== 'front');
  getBackPanel()?.classList.toggle('hidden-panel', mode !== 'back');
  document.getElementById('visualPanel')?.classList.toggle('hidden-panel', mode !== 'visual');
  getViewToggle()
    ?.querySelectorAll('.view-btn')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));
  if (mode === 'back') {
    refreshBackPanelState();
    rebuildBackWireSVG();
    requestAnimationFrame(renderBackPanelConnections);
  }
  // Mod visuals are skipped per-frame while the front view is hidden; refresh
  // once on entry so the FX/gen controls show the current mapping state.
  if (mode === 'front') refreshModulationVisuals();
  if (mode === 'visual') startViz(); else stopViz();
}

function initViewToggle() {
  getViewToggle()
    ?.querySelectorAll('.view-btn')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        setPanelView(btn.dataset.view);
      });
    });
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

function buildSequencerSection() {
  const { section, content } = createFxSection(STEP_SEQ.label, 'seq-section');
  const subdivisionRow = document.createElement('div');
  subdivisionRow.className = 'fx-mode-row seq-setting-row seq-subdivision-row';
  const subdivisionLabel = document.createElement('span');
  subdivisionLabel.className = 'seq-row-label';
  subdivisionLabel.textContent = 'Steps';
  subdivisionRow.appendChild(subdivisionLabel);
  [
    [4, '4'],
    [5, '5'],
    [8, '8'],
    [12, '12'],
    [16, '16'],
  ].forEach(([subdivision, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fx-mode-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      setSequencerSubdivision(subdivision);
    });
    seqSubdivisionButtons.set(subdivision, btn);
    subdivisionRow.appendChild(btn);
  });
  content.appendChild(subdivisionRow);

  const stepBeatRow = document.createElement('div');
  stepBeatRow.className = 'fx-mode-row seq-setting-row seq-step-beat-row';
  const stepBeatLabel = document.createElement('span');
  stepBeatLabel.className = 'seq-row-label';
  stepBeatLabel.textContent = 'Beat/step';
  stepBeatRow.appendChild(stepBeatLabel);
  STEP_SEQ_STEP_BEAT_OPTIONS.forEach(({ label, beats }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fx-mode-btn';
    btn.textContent = label;
    btn.title = `${label} beat${beats === 1 ? '' : 's'} per step`;
    btn.addEventListener('click', () => {
      setSequencerStepBeats(beats);
    });
    seqStepBeatButtons.set(beats, btn);
    stepBeatRow.appendChild(btn);
  });
  content.appendChild(stepBeatRow);

  const actionRow = document.createElement('div');
  actionRow.className = 'fx-mode-row seq-action-row';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'fx-mode-btn seq-action-btn';
  clearBtn.textContent = 'Clean';
  clearBtn.addEventListener('click', () => {
    clearSequencerSteps();
  });
  actionRow.appendChild(clearBtn);
  content.appendChild(actionRow);

  const grid = document.createElement('div');
  grid.className = 'seq-grid';
  seqBars = [];

  const valueFromPointer = (event, element) => {
    const rect = element.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    const distance = clamp((centerY - event.clientY) / (rect.height / 2), -1, 1);
    return distance;
  };

  STEP_SEQ.steps.forEach((stepValue, stepIdx) => {
    const step = document.createElement('button');
    step.type = 'button';
    step.className = 'seq-step';
    step.style.setProperty('--seq-value', `${Math.abs(stepValue)}`);
    step.dataset.step = `${stepIdx + 1}`;

    const updateStep = (event) => {
      setSequencerStep(stepIdx, valueFromPointer(event, step));
      if (STEP_SEQ.currentStep === stepIdx) applyMappedModulationTargets();
    };

    step.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      step.setPointerCapture(event.pointerId);
      step.classList.add('dragging');
      updateStep(event);
    });
    step.addEventListener('pointermove', (event) => {
      if (!step.hasPointerCapture(event.pointerId)) return;
      updateStep(event);
    });
    const endDrag = (event) => {
      if (step.hasPointerCapture(event.pointerId)) step.releasePointerCapture(event.pointerId);
      step.classList.remove('dragging');
    };
    step.addEventListener('pointerup', endDrag);
    step.addEventListener('pointercancel', endDrag);

    seqBars.push(step);
    grid.appendChild(step);
  });

  content.appendChild(grid);
  refreshSequencerUI();
  return section;
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
    refreshBackPanelState();
  });
  lfoControlBindings[lfoIdx].set('rate', rateControl);
  content.appendChild(rateControl);

  const syncModeRow = buildSyncModeRow(lfo.sync, (mode) => {
    lfo.sync = mode === 'sync';
    refreshLFOControlUI(lfoIdx);
    refreshBackPanelState();
  });
  lfoSyncModeControls[lfoIdx] = syncModeRow;
  content.appendChild(syncModeRow);

  const depthControl = makeControlRow(
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, unit: '' },
    lfo.depth,
    (v) => {
      lfo.depth = v;
      refreshBackPanelState();
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
      refreshBackPanelState();
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

function makeReverbIR(busId = activeBus) {
  const rv = fxStates[busId].reverb;
  const sr = audioCtx.sampleRate;
  const len = Math.floor(sr * Math.max(0.05, rv.size));
  const buf = audioCtx.createBuffer(2, len, sr);
  const damping = clamp(rv.damping, 0, 1);
  const decay = Math.max(0.5, rv.decay);
  const earlyCount = 6 + Math.round(rv.size * 3);
  const earlySpacing = Math.max(0.003, rv.size * 0.0022);
  const baseBrightness = 0.11 + (1 - damping) * 0.22;
  let peak = 0;
  const seededNoise = (seed) => {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453123;
    return (x - Math.floor(x)) * 2 - 1;
  };

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const stereoBias = c === 0 ? -1 : 1;

    for (let tap = 0; tap < earlyCount; tap++) {
      const jitter = (seededNoise((tap + 1) * (c + 3) * 11.7) + 1) * 0.5;
      const tapTime =
        tap * earlySpacing +
        earlySpacing * 0.5 * Math.sin((tap + 1) * (0.91 + c * 0.13)) +
        jitter * earlySpacing * 0.45;
      const index = Math.min(len - 1, Math.max(0, Math.floor(tapTime * sr)));
      const amp = (0.42 - tap / (earlyCount * 2.2)) * (tap % 2 === 0 ? 1 : 0.82);
      d[index] += amp * (0.9 + stereoBias * 0.08 * Math.sin((tap + 1) * 1.37));
    }

    let filtered = 0;
    let diffuser = 0;
    for (let i = 0; i < len; i++) {
      const t = i / Math.max(1, len - 1);
      const env = Math.pow(1 - t, 0.35 + 3.4 / decay);
      const noise = seededNoise(i + 1 + c * 8192);
      const brightness = baseBrightness * (1 - t * 0.55) + 0.012 + c * 0.006;
      filtered += (noise - filtered) * brightness;
      diffuser += (filtered - diffuser) * (0.055 + (1 - damping) * 0.02 + c * 0.004);
      const shimmer = Math.sin(t * Math.PI * (7.5 + c * 0.7)) * 0.035;
      d[i] += (filtered * 0.78 + diffuser * 0.52 + shimmer) * env;
      peak = Math.max(peak, Math.abs(d[i]));
    }
  }

  if (peak > 0) {
    const norm = 0.92 / peak;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
  }
  return buf;
}

function getReverbDampingCutoff(busId = activeBus) {
  return 900 + Math.pow(1 - clamp(fxStates[busId].reverb.damping, 0, 1), 1.45) * 13500;
}

function applyDelayMode(busId = activeBus) {
  const bus = fxBuses[busId];
  if (!bus?.delay) return;
  const isPingPong = fxStates[busId].delay.mode === 'pingpong';
  const normalGain = isPingPong ? 0 : 1;
  const pingGain = isPingPong ? 1 : 0;

  bus.delay.normalSend.gain.setValueAtTime(normalGain, audioCtx.currentTime);
  bus.delay.normalFeedbackMode.gain.setValueAtTime(normalGain, audioCtx.currentTime);
  bus.delay.normalWetMode.gain.setValueAtTime(normalGain, audioCtx.currentTime);

  bus.delay.pingInputMode.gain.setValueAtTime(pingGain, audioCtx.currentTime);
  bus.delay.pingLFeedbackMode.gain.setValueAtTime(pingGain, audioCtx.currentTime);
  bus.delay.pingRFeedbackMode.gain.setValueAtTime(pingGain, audioCtx.currentTime);
  bus.delay.pingWetMode.gain.setValueAtTime(pingGain, audioCtx.currentTime);
}

function applyFilterMode(busId = activeBus) {
  const bus = fxBuses[busId];
  if (!bus?.filter?.biquad) return;
  bus.filter.biquad.type = fxStates[busId].filter.mode;
}

// Build the global master tail once: every bus output sums into master.sum,
// which feeds the single limiter and the master output gain → destination.
function buildMaster() {
  const ac = audioCtx;
  const sum = ac.createGain();
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(LIMITER.threshold, ac.currentTime);
  limiter.knee.setValueAtTime(LIMITER.knee, ac.currentTime);
  limiter.ratio.setValueAtTime(LIMITER.ratio, ac.currentTime);
  limiter.attack.setValueAtTime(LIMITER.attack, ac.currentTime);
  limiter.release.setValueAtTime(LIMITER.release, ac.currentTime);
  const masterOut = ac.createGain();
  masterOut.gain.setValueAtTime(LIMITER.output, ac.currentTime);
  sum.connect(limiter);
  limiter.connect(masterOut);
  master = { sum, limiter: { comp: limiter, output: masterOut }, output: masterOut };
  return master;
}

// Build one instrument's independent effect chain. Its output sums into the
// shared master tail. The effect order between input and output is rewired
// live by reconnectFxChain(busId).
function buildBusFx(busId) {
  const ac = audioCtx;
  const st = fxStates[busId];

  // Stable entry/exit gains: the generator connects to `input` once, `output`
  // sums into master; the movable effects between them are wired by reconnect.
  const chainIn = ac.createGain();
  const busOut = ac.createGain();

  // ─ Beat repeat ─
  const brIn = ac.createGain();
  const brDry = ac.createGain();
  const brWet = ac.createGain();
  const brNode = new AudioWorkletNode(ac, 'beat-repeat-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: {
      interval: getBeatRepeatIntervalSeconds(busId),
      grid: getBeatRepeatGridSeconds(busId),
      gate: st.beatrepeat.gate,
      pitch: st.beatrepeat.pitch,
      decay: st.beatrepeat.decay,
      chance: st.beatrepeat.chance,
    },
  });
  const brOut = ac.createGain();

  brIn.connect(brDry);
  brIn.connect(brNode);
  brNode.connect(brWet);
  brDry.connect(brOut);
  brWet.connect(brOut);

  // ─ Delay (feedback loop) ─
  const dlyIn = ac.createGain();
  const dlyDry = ac.createGain();
  const dlyWet = ac.createGain();
  const dlyNormalSend = ac.createGain();
  const dlyNormalFeedbackMode = ac.createGain();
  const dlyNormalWetMode = ac.createGain();
  const dlyTap = ac.createDelay(MAX_DELAY_SECONDS);
  const dlyFb = ac.createGain();
  const dlyHpf = ac.createBiquadFilter();
  dlyHpf.type = 'highpass';
  dlyHpf.frequency.value = st.delay.hp;
  dlyHpf.Q.value = 0.5;
  const dlyPingSplit = ac.createChannelSplitter(2);
  const dlyPingMonoIn = ac.createGain();
  dlyPingMonoIn.channelCount = 1;
  dlyPingMonoIn.channelCountMode = 'explicit';
  const dlyPingInputMode = ac.createGain();
  const dlyPingL = ac.createDelay(MAX_DELAY_SECONDS);
  const dlyPingR = ac.createDelay(MAX_DELAY_SECONDS);
  const dlyPingLFb = ac.createGain();
  const dlyPingRFb = ac.createGain();
  const dlyPingLFeedbackMode = ac.createGain();
  const dlyPingRFeedbackMode = ac.createGain();
  const dlyPingLHpf = ac.createBiquadFilter();
  dlyPingLHpf.type = 'highpass';
  dlyPingLHpf.frequency.value = st.delay.hp;
  dlyPingLHpf.Q.value = 0.5;
  const dlyPingRHpf = ac.createBiquadFilter();
  dlyPingRHpf.type = 'highpass';
  dlyPingRHpf.frequency.value = st.delay.hp;
  dlyPingRHpf.Q.value = 0.5;
  const dlyPingMerge = ac.createChannelMerger(2);
  const dlyPingWetMode = ac.createGain();
  const dlyOut = ac.createGain();

  dlyIn.connect(dlyDry);
  dlyIn.connect(dlyNormalSend);
  dlyNormalSend.connect(dlyTap);
  dlyTap.connect(dlyNormalFeedbackMode);
  dlyNormalFeedbackMode.connect(dlyFb);
  dlyFb.connect(dlyHpf);
  dlyHpf.connect(dlyTap); // filtered feedback loop
  dlyTap.connect(dlyNormalWetMode);
  dlyNormalWetMode.connect(dlyWet);

  dlyIn.connect(dlyPingSplit);
  dlyPingSplit.connect(dlyPingMonoIn, 0);
  dlyPingSplit.connect(dlyPingMonoIn, 1);
  dlyPingMonoIn.connect(dlyPingInputMode);
  dlyPingInputMode.connect(dlyPingL);
  dlyPingL.connect(dlyPingMerge, 0, 0);
  dlyPingL.connect(dlyPingLFeedbackMode);
  dlyPingLFeedbackMode.connect(dlyPingLFb);
  dlyPingLFb.connect(dlyPingLHpf);
  dlyPingLHpf.connect(dlyPingR);
  dlyPingR.connect(dlyPingMerge, 0, 1);
  dlyPingR.connect(dlyPingRFeedbackMode);
  dlyPingRFeedbackMode.connect(dlyPingRFb);
  dlyPingRFb.connect(dlyPingRHpf);
  dlyPingRHpf.connect(dlyPingL);
  dlyPingMerge.connect(dlyPingWetMode);
  dlyPingWetMode.connect(dlyWet);

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
      bits: st.bitreduce.bits,
      rate: st.bitreduce.rate,
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
  const rvbPre = ac.createDelay(0.25);
  const rvbHP = ac.createBiquadFilter();
  rvbHP.type = 'highpass';
  rvbHP.frequency.setValueAtTime(140, ac.currentTime);
  rvbHP.Q.setValueAtTime(0.6, ac.currentTime);
  const rvbDamp = ac.createBiquadFilter();
  rvbDamp.type = 'lowpass';
  const rvbConv = ac.createConvolver();
  const rvbDry = ac.createGain();
  const rvbWet = ac.createGain();
  const rvbOut = ac.createGain();

  rvbIn.connect(rvbDry);
  rvbIn.connect(rvbPre);
  rvbPre.connect(rvbHP);
  rvbHP.connect(rvbDamp);
  rvbDamp.connect(rvbConv);
  rvbConv.connect(rvbWet);
  rvbDry.connect(rvbOut);
  rvbWet.connect(rvbOut);

  fxBuses[busId] = {
    input: chainIn,
    output: busOut,
    beatrepeat: { node: brNode, dry: brDry, wet: brWet, in: brIn, out: brOut },
    delay: {
      tap: dlyTap,
      fb: dlyFb,
      hpf: dlyHpf,
      dry: dlyDry,
      wet: dlyWet,
      normalSend: dlyNormalSend,
      normalFeedbackMode: dlyNormalFeedbackMode,
      normalWetMode: dlyNormalWetMode,
      pingInputMode: dlyPingInputMode,
      pingL: dlyPingL,
      pingR: dlyPingR,
      pingLFb: dlyPingLFb,
      pingRFb: dlyPingRFb,
      pingLFeedbackMode: dlyPingLFeedbackMode,
      pingRFeedbackMode: dlyPingRFeedbackMode,
      pingLHpf: dlyPingLHpf,
      pingRHpf: dlyPingRHpf,
      pingWetMode: dlyPingWetMode,
      in: dlyIn,
      out: dlyOut,
    },
    filter: { biquad: fltBiquad, dry: fltDry, wet: fltWet, in: fltIn, out: fltOut },
    bitreduce: { node: bitNode, dry: bitDry, wet: bitWet, in: bitIn, out: bitOut },
    sat: { shaper: satShaper, dry: satDry, wet: satWet, in: satIn, out: satOut },
    reverb: {
      pre: rvbPre,
      hp: rvbHP,
      damp: rvbDamp,
      conv: rvbConv,
      dry: rvbDry,
      wet: rvbWet,
      in: rvbIn,
      out: rvbOut,
    },
  };

  // This bus's tail sums into the shared master limiter, once and for good.
  busOut.connect(master.sum);

  reconnectFxChain(busId);
  applyAllFx(busId);
}

// Build the whole FX graph: one master tail + a chain per instrument bus.
function buildFxNodes() {
  buildMaster();
  FX_BUS_IDS.forEach((busId) => buildBusFx(busId));
  applyFxModulation();
}

// Rewire one bus's reorderable effects between its input and its output to match
// fxOrders[busId]. Safe to call live — each effect is a self-contained in→out
// pair, so we fully disconnect the movable links and rebuild them.
function reconnectFxChain(busId = activeBus) {
  const bus = fxBuses[busId];
  if (!bus) return;
  bus.input.disconnect();
  fxOrders[busId].forEach((id) => bus[id]?.out.disconnect());
  let prev = bus.input;
  fxOrders[busId].forEach((id) => {
    const eff = bus[id];
    if (!eff) return;
    prev.connect(eff.in);
    prev = eff.out;
  });
  prev.connect(bus.output);
}

function applyFx(id, key, val, busId = activeBus) {
  const fx = fxBuses[busId];
  if (!fx) return;
  if (id === 'beatrepeat') {
    const setParam = (name, value) =>
      fx.beatrepeat.node.parameters.get(name)?.setValueAtTime(value, audioCtx.currentTime);
    if (key === 'interval') setParam('interval', clamp(val, 0.02, 30));
    if (key === 'grid') setParam('grid', clamp(val, 0.005, 1));
    if (key === 'gate') setParam('gate', clamp(Math.round(val), 1, 64));
    if (key === 'pitch') setParam('pitch', clamp(val, -24, 24));
    if (key === 'decay') setParam('decay', clamp(val, 0, 1));
    if (key === 'chance') setParam('chance', clamp(val, 0, 1));
    if (key === 'mix') {
      fx.beatrepeat.wet.gain.value = val;
      fx.beatrepeat.dry.gain.value = 1 - val;
    }
  } else if (id === 'delay') {
    if (key === 'time')
      [fx.delay.tap, fx.delay.pingL, fx.delay.pingR].forEach((tap) =>
        tap.delayTime.setTargetAtTime(clamp(val, 0, MAX_DELAY_SECONDS), audioCtx.currentTime, 0.02),
      );
    if (key === 'feedback')
      [fx.delay.fb, fx.delay.pingLFb, fx.delay.pingRFb].forEach((gain) =>
        gain.gain.setTargetAtTime(Math.min(0.98, val), audioCtx.currentTime, 0.02),
      );
    if (key === 'hp')
      [fx.delay.hpf, fx.delay.pingLHpf, fx.delay.pingRHpf].forEach((filter) =>
        filter.frequency.setTargetAtTime(clamp(val, 20, 2000), audioCtx.currentTime, 0.02),
      );
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
    if (key === 'size' || key === 'decay' || key === 'damping')
      fx.reverb.conv.buffer = makeReverbIR(busId);
    if (key === 'predelay')
      fx.reverb.pre.delayTime.setTargetAtTime(val, audioCtx.currentTime, 0.02);
    if (key === 'damping')
      fx.reverb.damp.frequency.setTargetAtTime(
        getReverbDampingCutoff(busId),
        audioCtx.currentTime,
        0.03,
      );
    if (key === 'mix') {
      fx.reverb.wet.gain.value = val;
      fx.reverb.dry.gain.value = 1 - val;
    }
  }
}

// Apply one master-limiter parameter (the limiter is global, not per-bus).
function applyLimiter(key, val) {
  if (!master?.limiter) return;
  const t = audioCtx.currentTime;
  if (key === 'threshold') master.limiter.comp.threshold.setTargetAtTime(val, t, 0.02);
  if (key === 'attack') master.limiter.comp.attack.setTargetAtTime(val, t, 0.02);
  if (key === 'release') master.limiter.comp.release.setTargetAtTime(val, t, 0.02);
  if (key === 'ratio') master.limiter.comp.ratio.setTargetAtTime(val, t, 0.02);
  if (key === 'knee') master.limiter.comp.knee.setTargetAtTime(val, t, 0.02);
  if (key === 'output') master.limiter.output.gain.setTargetAtTime(val, t, 0.02);
}

function applyLimiterAll() {
  Object.keys(LIMITER).forEach((key) => applyLimiter(key, LIMITER[key]));
}

// Apply all reorderable-effect params for one bus from its state (no limiter).
function applyAllFx(busId = activeBus) {
  FX_DEFS.forEach(({ id, params }) => {
    if (id === 'limiter') return;
    params.forEach(({ key }) => applyFx(id, key, getBaseFxValue(id, key, busId), busId));
  });
  applyDelayMode(busId);
  applyFilterMode(busId);
}

function refreshGen3UI() {
  ['gain', 'pitch', 'detune', 'attack', 'decay', 'sustain', 'release'].forEach((key) => {
    gen3ControlBindings.get(key)?.setValue(GEN3[key]);
  });
  gen3ShapeButtons.forEach((btn, type) => btn.classList.toggle('active', GEN3.type === type));
  if (gen3SusBtnEl) gen3SusBtnEl.classList.toggle('active', GEN3.sustainMode);
}

function refreshLFOUI() {
  LFOS.forEach((lfo, lfoIdx) => {
    refreshLFOControlUI(lfoIdx);
    lfoControlBindings[lfoIdx].get('depth')?.setValue(lfo.depth);
    lfoShapeButtons[lfoIdx].forEach((btn, shape) =>
      btn.classList.toggle('active', lfo.shape === shape),
    );
  });
  refreshBackPanelState();
}

function refreshFilterUI() {
  ['cutoff', 'q', 'mix'].forEach((key) => {
    fxControlBindings.get(`filter:${key}`)?.setValue(FX.filter[key]);
  });
  filterModeButtons.forEach((btn, mode) => btn.classList.toggle('active', FX.filter.mode === mode));
  refreshBackPanelState();
}

function capturePreset() {
  return {
    transport: { bpm: TRANSPORT.bpm },
    gens: state.map((gen) => ({ ...gen })),
    gen3: {
      type: GEN3.type,
      gain: GEN3.gain,
      pitch: GEN3.pitch,
      detune: GEN3.detune,
      attack: GEN3.attack,
      decay: GEN3.decay,
      sustain: GEN3.sustain,
      release: GEN3.release,
      sustainMode: GEN3.sustainMode,
    },
    loops: LOOPS.list.map(serializeLoop),
    activeLoopIndex: LOOPS.editIndex,
    song: {
      entries: SONG.entries.map(({ loopId, repeats }) => ({ loopId, repeats })),
      loop: SONG.loop,
      follow: SONG.follow,
      mode: PLAY.mode,
    },
    fxByBus: JSON.parse(JSON.stringify(fxStates)),
    fxOrderByBus: JSON.parse(JSON.stringify(fxOrders)),
    limiter: { ...LIMITER },
    activeBus,
    lfos: LFOS.map(({ label, rate, sync, syncIndex, shape, depth }) => ({
      label,
      rate,
      sync,
      syncIndex,
      shape,
      depth,
    })),
    gen4: {
      channels: GEN4.channels.map((ch) => ({
        fxSend: ch.fxSend,
        params: { ...ch.params },
      })),
    },
    kickSc: { release: KICK_SC.release, amount: KICK_SC.amount },
    mappings: [...lfoMappings.values()].map(({ genIdx, key, sourceIdx }) => ({
      genIdx,
      key,
      sourceIdx,
    })),
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
    if (typeof gen.grainSizeSync === 'boolean') state[genIdx].grainSizeSync = gen.grainSizeSync;
    if (typeof gen.grainSizeSyncIndex === 'number')
      state[genIdx].grainSizeSyncIndex = gen.grainSizeSyncIndex;
    if (typeof gen.densitySync === 'boolean') state[genIdx].densitySync = gen.densitySync;
    if (typeof gen.densitySyncIndex === 'number')
      state[genIdx].densitySyncIndex = gen.densitySyncIndex;
    refreshGeneratorUI(genIdx);
  });
  resetGranularSources();

  if (preset.gen3) {
    // The chord (lockedMidis) is loop data now — legacy presets carry it here
    // and legacyLoopData() migrates it; bindEditLoop() below restores the Set.
    const { lockedMidis: _legacyChord, ...gen3Params } = preset.gen3;
    Object.assign(GEN3, gen3Params);
    refreshGen3UI();
    if (GEN3.nodes) {
      restartAllGen3Notes();
      applyGen3Modulation();
    }
  }

  if (preset.fxByBus) {
    FX_BUS_IDS.forEach((busId) => {
      const saved = preset.fxByBus[busId];
      if (!saved) return;
      Object.keys(fxStates[busId]).forEach((id) => {
        if (saved[id]) Object.assign(fxStates[busId][id], saved[id]);
      });
    });
    if (preset.fxOrderByBus) {
      FX_BUS_IDS.forEach((busId) => {
        if (Array.isArray(preset.fxOrderByBus[busId])) setFxOrder(preset.fxOrderByBus[busId], busId);
      });
    }
    // Push every bus's loaded state to its audio nodes, then reapply modulation.
    FX_BUS_IDS.forEach((busId) => applyAllFx(busId));
    applyFxModulation();
  }

  if (preset.limiter) {
    Object.assign(LIMITER, preset.limiter);
    applyLimiterAll();
    limiterControls.forEach((control, key) => control.setValue(LIMITER[key]));
  }

  if (preset.activeBus && FX_BUS_IDS.includes(preset.activeBus)) activeBus = preset.activeBus;
  FX = fxStates[activeBus];
  // Rebuild the FX column for the active bus (controls take their loaded values).
  renderActiveBusFx();
  updateFxActiveLabel();
  refreshFilterUI();
  document.querySelectorAll('#generators [data-bus]').forEach((el) => {
    el.classList.toggle('active-instrument', el.dataset.bus === activeBus);
  });

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

  // Loops + song. Legacy presets (one implicit loop) migrate into loop "A".
  const loopsData =
    Array.isArray(preset.loops) && preset.loops.length ? preset.loops : [legacyLoopData(preset)];
  LOOPS.list = [];
  LOOPS.counter = 0;
  loopsData.forEach((data) => LOOPS.list.push(deserializeLoop(data)));
  LOOPS.editIndex = clamp(Math.round(preset.activeLoopIndex) || 0, 0, LOOPS.list.length - 1);
  SONG.entries = [];
  SONG.entryCounter = 0;
  (preset.song?.entries || []).forEach((e) => {
    if (!getLoopById(e?.loopId)) return;
    SONG.entryCounter += 1;
    SONG.entries.push({
      id: `entry-${SONG.entryCounter}`,
      loopId: e.loopId,
      repeats: clamp(Math.round(e.repeats) || 1, 1, 64),
    });
  });
  SONG.loop = preset.song?.loop !== false;
  SONG.follow = preset.song?.follow !== false;
  SONG.cursor.entryIdx = 0;
  SONG.cursor.repeat = 0;
  SONG.audibleEntryIdx = -1;
  bindEditLoop();
  renderLoopsBar();
  renderSongLane();
  setPlayMode(preset.song?.mode === 'song' ? 'song' : 'loop');

  if (preset.gen4?.channels) {
    preset.gen4.channels.forEach((saved, ci) => {
      const ch = GEN4.channels[ci];
      const def = GEN4_DEFS[ci];
      if (!ch || !saved || !def) return;
      if (typeof saved.fxSend === 'boolean') gen4SetChannelFxSend(ci, saved.fxSend);
      if (saved.params) {
        def.paramDefs.forEach((pd) => {
          if (typeof saved.params[pd.key] === 'number') {
            ch.params[pd.key] = clamp(saved.params[pd.key], pd.min, pd.max);
            gen4ControlBindings[ci].get(pd.key)?.setValue(ch.params[pd.key]);
          }
        });
      }
    });
  }

  if (preset.kickSc) {
    document.querySelectorAll('[data-sc-param]').forEach((slider) => {
      const param = slider.dataset.scParam;
      if (param === 'amount' && typeof preset.kickSc.amount === 'number') {
        slider.value = `${clamp(preset.kickSc.amount, 0, 1)}`;
        slider.dispatchEvent(new Event('input'));
      } else if (param === 'release' && typeof preset.kickSc.release === 'number') {
        slider.value = `${clamp(preset.kickSc.release, 0.01, 1)}`;
        slider.dispatchEvent(new Event('input'));
      }
    });
  }

  lfoMappings.clear();
  preset.mappings?.forEach(({ genIdx, key, lfoIdx, sourceIdx }) => {
    const isGranularParam = genIdx < 2 && PARAMS.some((p) => p.key === key);
    const isGen3Param = genIdx === 2 && GEN3_LFO_PARAMS.some((p) => p.key === key);
    const [fxId, fxKey] = typeof key === 'string' ? key.split(':') : [];
    const isFxParam = genIdx === 3 && !!getFxParamBounds(fxId, fxKey);
    const isGen4Param =
      genIdx === 4 &&
      (() => {
        const [chId, paramKey] = typeof key === 'string' ? key.split(':') : [];
        return GEN4_DEFS.some((d) => d.id === chId && d.paramDefs.some((p) => p.key === paramKey));
      })();
    const modSourceIdx = typeof sourceIdx === 'number' ? sourceIdx : lfoIdx;
    if (
      (isGranularParam || isGen3Param || isFxParam || isGen4Param) &&
      modSourceIdx >= 0 &&
      modSourceIdx <= 3
    ) {
      lfoMappings.set(`${genIdx}:${key}`, { genIdx, key, sourceIdx: modSourceIdx });
    }
  });
  rebuildBackWireSVG();
  refreshLFOMappingUI();
  refreshDelayTimeUI();
  refreshDelayModeUI();
  refreshLFOUI();
  sendParams(0);
  sendParams(1);
  applyGen3Modulation();
  applyFxModulation();
  refreshBackPanelState();
}

function formatProjectDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
  } catch (e) {
    return '';
  }
}

function findProjectIndex(name) {
  const norm = name.trim().toLowerCase();
  return projectStore.findIndex((p) => p.name.trim().toLowerCase() === norm);
}

function saveProjectFromInput() {
  const input = getProjectNameInput();
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    setStatus('name required');
    input.focus();
    return;
  }
  const entry = { name, data: capturePreset(), savedAt: Date.now() };
  const existing = findProjectIndex(name);
  if (existing >= 0) projectStore[existing] = entry;
  else projectStore.push(entry);
  currentProjectName = name;
  saveProjectStore();
  persistAudioForScope(`project:${name}`);
  refreshProjectUI();
  setStatus(`saved "${name}"`);
}

function openProject(name) {
  const idx = findProjectIndex(name);
  if (idx < 0) return;
  const proj = projectStore[idx];
  applyPreset(proj.data);
  restoreAudioForScope(`project:${proj.name}`);
  currentProjectName = proj.name;
  const input = getProjectNameInput();
  if (input) input.value = proj.name;
  closeProjectMenu();
  refreshProjectUI();
  setStatus(`opened "${proj.name}"`);
}

function deleteProject(name) {
  const idx = findProjectIndex(name);
  if (idx < 0) return;
  if (!window.confirm(`Delete project "${projectStore[idx].name}"?`)) return;
  deleteAudioForScope(`project:${projectStore[idx].name}`);
  if (projectStore[idx].name === currentProjectName) currentProjectName = null;
  projectStore.splice(idx, 1);
  saveProjectStore();
  refreshProjectUI();
  setStatus(`deleted "${name}"`);
}

function openProjectMenu() {
  projectMenuOpen = true;
  getProjectMenu()?.removeAttribute('hidden');
  getProjectMenuBtn()?.classList.add('open');
  const input = getProjectNameInput();
  if (input) {
    if (currentProjectName) input.value = currentProjectName;
    input.focus();
    input.select();
  }
}

function closeProjectMenu() {
  projectMenuOpen = false;
  getProjectMenu()?.setAttribute('hidden', '');
  getProjectMenuBtn()?.classList.remove('open');
}

function toggleProjectMenu() {
  if (projectMenuOpen) closeProjectMenu();
  else openProjectMenu();
}

function refreshProjectUI() {
  const label = getProjectMenuLabel();
  if (label) label.textContent = currentProjectName || 'Projects';
  const listEl = getProjectList();
  if (!listEl) return;
  listEl.textContent = '';
  if (!projectStore.length) {
    const empty = document.createElement('div');
    empty.className = 'project-empty';
    empty.textContent = 'no saved projects';
    listEl.appendChild(empty);
    return;
  }
  const sorted = [...projectStore].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  sorted.forEach((proj) => {
    const item = document.createElement('div');
    item.className = 'project-item';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'project-open';
    openBtn.classList.toggle('current', proj.name === currentProjectName);

    const nameEl = document.createElement('span');
    nameEl.className = 'project-item-name';
    nameEl.textContent = proj.name;
    openBtn.appendChild(nameEl);

    const dateStr = formatProjectDate(proj.savedAt);
    if (dateStr) {
      const dateEl = document.createElement('span');
      dateEl.className = 'project-item-date';
      dateEl.textContent = dateStr;
      openBtn.appendChild(dateEl);
    }
    openBtn.addEventListener('click', () => openProject(proj.name));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'project-delete';
    delBtn.textContent = '×';
    delBtn.title = `delete "${proj.name}"`;
    delBtn.addEventListener('click', () => deleteProject(proj.name));

    item.appendChild(openBtn);
    item.appendChild(delBtn);
    listEl.appendChild(item);
  });
}

function newProject() {
  if (!defaultProjectSnapshot) return;
  if (!window.confirm('Start a new blank project? Unsaved changes will be lost.')) return;
  // Clone so the pristine snapshot is never mutated by applyPreset.
  applyPreset(JSON.parse(JSON.stringify(defaultProjectSnapshot)));
  queueAutosaveAudio();
  currentProjectName = null;
  const input = getProjectNameInput();
  if (input) input.value = '';
  closeProjectMenu();
  refreshProjectUI();
  setStatus('new project');
}

function buildProjectUI() {
  getProjectMenuBtn()?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleProjectMenu();
  });
  // Clicks inside the menu shouldn't bubble to the document close-handler.
  getProjectMenu()?.addEventListener('click', (event) => event.stopPropagation());
  document.getElementById('projectSaveBtn')?.addEventListener('click', saveProjectFromInput);
  document.getElementById('projectNewBtn')?.addEventListener('click', newProject);
  getProjectNameInput()?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveProjectFromInput();
    }
  });
  document.addEventListener('click', () => {
    if (projectMenuOpen) closeProjectMenu();
  });
  refreshProjectUI();
}

const limiterControls = new Map(); // master-limiter controls (global section)

function buildFxUI() {
  const container = document.getElementById('fx-chain');

  // Column header — names the instrument whose chain is shown/edited.
  const header = document.createElement('div');
  header.className = 'col-header';
  header.innerHTML =
    '<span class="col-title"><span class="col-dot"></span>FX — <span id="fxActiveLabel"></span></span>';
  container.appendChild(header);

  // LFO modulators + sequencer are global (shared across all buses).
  LFOS.forEach((_, lfoIdx) => container.appendChild(buildLFOSection(lfoIdx)));
  container.appendChild(buildSequencerSection());

  // The active bus's reorderable effect sections live here; rebuilt on switch.
  const fxEffects = document.createElement('div');
  fxEffects.id = 'fx-effects';
  container.appendChild(fxEffects);

  // Master limiter — single, global, pinned after the summed mix.
  buildLimiterSection(container);

  initFxReorderDnD(fxEffects);
  renderActiveBusFx();
  updateFxActiveLabel();
}

// Build the global master-limiter section once (binds the global LIMITER state).
function buildLimiterSection(container) {
  const def = FX_DEFS.find((d) => d.id === 'limiter');
  if (!def) return;
  const { section, content } = createFxSection(def.label);
  limiterControls.clear();
  def.params.forEach((p) => {
    const control = makeControlRow(
      p,
      LIMITER[p.key],
      (v) => {
        LIMITER[p.key] = v;
        applyLimiter(p.key, v);
        refreshBackPanelState();
      },
      null,
    );
    limiterControls.set(p.key, control);
    content.appendChild(control);
  });
  fxLimiterSection = section;
  container.appendChild(section);
}

// (Re)build the active bus's reorderable effect sections into #fx-effects.
function renderActiveBusFx() {
  const host = document.getElementById('fx-effects');
  if (!host) return;
  host.innerHTML = '';
  fxControlBindings.clear();
  fxSectionEls.clear();
  filterModeButtons.clear();
  delayModeButtons.clear();

  const fxDefById = new Map(FX_DEFS.map((def) => [def.id, def]));
  fxOrders[activeBus].forEach((fxId) => {
    const def = fxDefById.get(fxId);
    if (!def) return;
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
          refreshBackPanelState();
        });
        filterModeButtons.set(mode, btn);
        modeRow.appendChild(btn);
      });
      content.appendChild(modeRow);
    }

    if (def.id === 'delay') {
      const modeRow = document.createElement('div');
      modeRow.className = 'fx-mode-row';
      [
        ['stereo', 'Stereo'],
        ['pingpong', 'PingPong'],
      ].forEach(([mode, label]) => {
        const btn = document.createElement('button');
        btn.className = 'fx-mode-btn' + (FX.delay.mode === mode ? ' active' : '');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          FX.delay.mode = mode;
          applyDelayMode();
          refreshDelayModeUI();
          refreshBackPanelState();
        });
        delayModeButtons.set(mode, btn);
        modeRow.appendChild(btn);
      });
      content.appendChild(modeRow);
    }

    def.params.forEach((p) => {
      const isMappable = !!getFxParamBounds(def.id, p.key);
      const control = makeControlRow(
        p,
        FX[def.id][p.key],
        (v) => {
          if (def.id === 'delay' && p.key === 'time') {
            if (FX.delay.sync) {
              FX.delay.syncIndex = Math.round(v);
            } else {
              FX.delay.time = v;
            }
            if (isMappable) applyFxModulation();
            else applyFx('delay', 'time', getBaseFxValue('delay', 'time'));
            refreshModulationVisuals();
            refreshBackPanelState();
            return;
          }
          if (def.id === 'beatrepeat' && p.key === 'interval') {
            if (FX.beatrepeat.sync) {
              FX.beatrepeat.syncIndex = Math.round(v);
            } else {
              FX.beatrepeat.interval = v;
            }
            applyFx('beatrepeat', 'interval', getBaseFxValue('beatrepeat', 'interval'));
            refreshModulationVisuals();
            refreshBackPanelState();
            return;
          }
          if (def.id === 'beatrepeat' && p.key === 'grid') {
            if (FX.beatrepeat.gridSync) {
              FX.beatrepeat.gridSyncIndex = Math.round(v);
            } else {
              FX.beatrepeat.grid = v;
            }
            applyFx('beatrepeat', 'grid', getBaseFxValue('beatrepeat', 'grid'));
            refreshModulationVisuals();
            refreshBackPanelState();
            return;
          }
          FX[def.id][p.key] = v;
          if (isMappable) applyFxModulation();
          else applyFx(def.id, p.key, v);
          refreshModulationVisuals();
          refreshBackPanelState();
        },
        isMappable ? { genIdx: 3, key: `${def.id}:${p.key}` } : null,
      );
      fxControlBindings.set(`${def.id}:${p.key}`, control);
      content.appendChild(control);

      if (def.id === 'delay' && p.key === 'time') {
        delaySyncModeControl = buildSyncModeRow(FX.delay.sync, (mode) => {
          FX.delay.sync = mode === 'sync';
          refreshDelayTimeUI();
          if (isMappable) applyFxModulation();
          else applyFx('delay', 'time', getBaseFxValue('delay', 'time'));
          refreshModulationVisuals();
          refreshBackPanelState();
        });
        content.appendChild(delaySyncModeControl);
      }

      if (def.id === 'beatrepeat' && p.key === 'interval') {
        beatRepeatSyncModeControl = buildSyncModeRow(FX.beatrepeat.sync, (mode) => {
          FX.beatrepeat.sync = mode === 'sync';
          refreshBeatRepeatIntervalUI();
          applyFx('beatrepeat', 'interval', getBaseFxValue('beatrepeat', 'interval'));
          refreshModulationVisuals();
          refreshBackPanelState();
        });
        content.appendChild(beatRepeatSyncModeControl);
      }

      if (def.id === 'beatrepeat' && p.key === 'grid') {
        beatRepeatGridSyncModeControl = buildSyncModeRow(FX.beatrepeat.gridSync, (mode) => {
          FX.beatrepeat.gridSync = mode === 'sync';
          refreshBeatRepeatGridUI();
          applyFx('beatrepeat', 'grid', getBaseFxValue('beatrepeat', 'grid'));
          refreshModulationVisuals();
          refreshBackPanelState();
        });
        content.appendChild(beatRepeatGridSyncModeControl);
      }
    });

    section.classList.add('fx-reorderable');
    section.dataset.fxId = def.id;
    enableFxSectionDrag(section, def.label);
    fxSectionEls.set(def.id, section);
    host.appendChild(section);
  });

  refreshDelayTimeUI();
  refreshDelayModeUI();
  refreshBeatRepeatIntervalUI();
  refreshBeatRepeatGridUI();
  refreshModulationVisuals();
}

function updateFxActiveLabel() {
  const el = document.getElementById('fxActiveLabel');
  if (el) el.textContent = FX_BUS_LABELS[activeBus] || '';
}

// Make an instrument the active one: its chain fills the FX column. Controls
// inside a panel keep working — clicking anywhere in a panel just selects it.
function setActiveBus(busId) {
  if (!FX_BUS_IDS.includes(busId)) return;
  activeBus = busId;
  FX = fxStates[activeBus];
  document.querySelectorAll('#generators [data-bus]').forEach((el) => {
    el.classList.toggle('active-instrument', el.dataset.bus === busId);
  });
  updateFxActiveLabel();
  renderActiveBusFx();
  refreshBackPanelState();
}

// ─── FX reordering (drag & drop) ─────────────────────────────────────────────

function enableFxSectionDrag(section, label) {
  const header = section.querySelector('.fx-section-label');
  if (header) {
    const handle = document.createElement('span');
    handle.className = 'fx-drag-handle';
    handle.textContent = '⠿';
    handle.title = `Drag to reorder ${label}`;
    // Arm dragging only when grabbing the handle, so sliders/collapse still work.
    handle.addEventListener('mousedown', () => {
      section.draggable = true;
    });
    handle.addEventListener('click', (e) => e.stopPropagation());
    header.prepend(handle);
  }
  section.addEventListener('dragstart', (e) => {
    section.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', section.dataset.fxId || '');
      } catch (_) {}
    }
  });
  section.addEventListener('dragend', () => {
    section.classList.remove('dragging');
    section.draggable = false;
    commitFxOrderFromDom();
  });
}

function getFxDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.fx-section.fx-reorderable:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  els.forEach((child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  });
  return closest.element;
}

function initFxReorderDnD(container) {
  container.addEventListener('dragover', (e) => {
    const dragging = container.querySelector('.fx-section.dragging');
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const after = getFxDragAfterElement(container, e.clientY);
    if (after == null) {
      // Past the last effect — drop at the end of this bus's effect list.
      container.appendChild(dragging);
    } else if (after !== dragging) {
      container.insertBefore(dragging, after);
    }
  });
  // A mouseup anywhere clears the transient draggable flag (e.g. a handle click
  // that never became a drag).
  window.addEventListener('mouseup', () => {
    fxSectionEls.forEach((el) => {
      el.draggable = false;
    });
  });
}

function commitFxOrderFromDom() {
  const container = document.getElementById('fx-effects');
  if (!container) return;
  const order = [...container.querySelectorAll('.fx-section.fx-reorderable')]
    .map((el) => el.dataset.fxId)
    .filter((id) => DEFAULT_FX_ORDER.includes(id));
  DEFAULT_FX_ORDER.forEach((id) => {
    if (!order.includes(id)) order.push(id);
  });
  fxOrders[activeBus] = order;
  reconnectFxChain(activeBus);
}

function setFxOrder(order, busId = activeBus) {
  if (!Array.isArray(order)) return;
  const next = order.filter((id) => DEFAULT_FX_ORDER.includes(id));
  DEFAULT_FX_ORDER.forEach((id) => {
    if (!next.includes(id)) next.push(id);
  });
  fxOrders[busId] = next;
  reconnectFxChain(busId);
  if (busId === activeBus) renderActiveBusFx();
}

async function start() {
  try {
    await ensureGranularEngine();
    if (anyMicSourceSelected()) {
      setStatus('requesting input…');
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
  const isNewNode = !node;
  if (isNewNode) {
    node = new AudioWorkletNode(audioCtx, 'granular-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [2, 2],
    });
    // Granular 1 (output 0) and Granular 2 (output 1) feed their own FX buses.
    node.connect(fxBuses.gen0.input, 0);
    node.connect(fxBuses.gen1.input, 1);
    node.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.type === 'viz') drawViz(e.data);
      else if (e.data.type === 'frozen-dump') {
        setGenFrozenData(e.data.gen, {
          samples: e.data.buffer,
          frozenAt: e.data.frozenAt || 0,
          sampleRate: audioCtx?.sampleRate || 48000,
        });
      }
    };
  }
  // Sources first, initial params after: a restored frozen take must land in
  // the worklet before a freeze=true params message, or that message would
  // snapshot (and dump) the still-empty live buffer over the real take.
  await syncGranularSourceStates();
  if (isNewNode) {
    sendParams(0);
    sendParams(1);
  }
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

// Build (once) the gate ScriptProcessor and wire its output into the granular
// worklet. Live mic gets routed through this so sub-threshold signal is muted
// before the granulator can hear or visualize it.
function ensureInputGateNode() {
  if (INPUT_GATE.node) return INPUT_GATE.node;
  const gate = audioCtx.createScriptProcessor(1024, 2, 2);
  gate.onaudioprocess = (e) => {
    const inp = e.inputBuffer;
    const out = e.outputBuffer;
    const inL = inp.getChannelData(0);
    const inR = inp.numberOfChannels > 1 ? inp.getChannelData(1) : inL;
    const outL = out.getChannelData(0);
    const outR = out.getChannelData(1);
    if (!INPUT_GATE.enabled) {
      outL.set(inL);
      outR.set(inR);
      INPUT_GATE.env = 1;
      return;
    }
    const sr = audioCtx.sampleRate;
    const aCoef = 1 - Math.exp(-1 / Math.max(INPUT_GATE.attackMs * 0.001 * sr, 1));
    const rCoef = 1 - Math.exp(-1 / Math.max(INPUT_GATE.releaseMs * 0.001 * sr, 1));
    const thr = INPUT_GATE.threshold;
    let env = INPUT_GATE.env;
    for (let i = 0; i < inL.length; i++) {
      const l = inL[i];
      const r = inR[i];
      const level = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      const target = level >= thr ? 1 : 0;
      // fast attack opens the gate, slow release holds it through zero-crossings
      const coef = target > env ? aCoef : rCoef;
      env += (target - env) * coef;
      outL[i] = l * env;
      outR[i] = r * env;
    }
    INPUT_GATE.env = env;
  };
  gate.connect(node);
  INPUT_GATE.node = gate;
  return gate;
}

async function ensureMicInput({ forceReconnect = false } = {}) {
  if (!node) await ensureGranularEngine();
  if (granularInputSource && micStream && !forceReconnect) return;
  disconnectGranularInput({ stopTracks: true });
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (INPUT_SOURCE.selectedId && INPUT_SOURCE.selectedId !== 'default') {
    audioConstraints.deviceId = { exact: INPUT_SOURCE.selectedId };
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  granularInputSource = audioCtx.createMediaStreamSource(micStream);
  granularInputSource.connect(ensureInputGateNode());
  const activeDeviceId = micStream.getAudioTracks()[0]?.getSettings?.().deviceId;
  if (activeDeviceId && INPUT_SOURCE.devices.some((device) => device.deviceId === activeDeviceId)) {
    INPUT_SOURCE.selectedId = activeDeviceId;
  }
  await refreshInputDevices();
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
    // Reinstate a persisted frozen take into the worklet's freeze buffer.
    if (source.frozenData && state[genIdx].freeze) {
      const buf = source.frozenData.samples.slice();
      node.port.postMessage(
        { type: 'restore-frozen', gen: genIdx, buffer: buf, frozenAt: source.frozenData.frozenAt },
        [buf.buffer],
      );
    }
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
  setGenFrozenData(genIdx, null);
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
    setGenFrozenData(genIdx, null);
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
  stopGen4Sequencer();
  GEN4.nodes = null;
  disconnectGranularInput({ stopTracks: true });
  if (audioCtx) audioCtx.close();
  audioCtx = node = master = null;
  FX_BUS_IDS.forEach((id) => (fxBuses[id] = null));
  granularModulePromise = null;
  bitReducerModulePromise = null;
  beatRepeatModulePromise = null;
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
  drawGenVizIdle(0);
  drawGenVizIdle(1);
  drawGenVizEmpty(2);
  refreshBackPanelState();
}

document.getElementById('startBtn').addEventListener('click', () => {
  started ? stop() : start();
});

document.getElementById('transportStopBtn').addEventListener('click', () => {
  stopGen4Sequencer();
  stopAllGen3Notes();
  refreshTransportStopBtn();
});

getInputSelect()?.addEventListener('change', async (e) => {
  INPUT_SOURCE.selectedId = e.target.value;
  if (started && anyMicSourceSelected()) {
    try {
      setStatus('switching input…');
      await ensureMicInput({ forceReconnect: true });
      setStatus(getGranularStatusText());
    } catch (err) {
      setStatus('error: ' + err.message);
      console.error(err);
    }
  }
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

function syncGateUI() {
  const enable = getGateEnable();
  const slider = getGateSlider();
  const val = getGateVal();
  const box = enable?.closest('.gate-box');
  if (!enable || !slider) return;
  INPUT_GATE.enabled = enable.checked;
  const db = Number(slider.value);
  INPUT_GATE.threshold = dbToLinear(db);
  slider.disabled = !enable.checked;
  if (val) val.textContent = `${db} dB`;
  if (box) box.classList.toggle('active', enable.checked);
}

getGateEnable()?.addEventListener('change', syncGateUI);
getGateSlider()?.addEventListener('input', syncGateUI);
syncGateUI();

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  refreshInputDevices();
});

loadProjectStore();
adoptInitialLoop();
buildUI();
setSourceDurationSec(0, LIVE_SOURCE_SECONDS);
setSourceDurationSec(1, LIVE_SOURCE_SECONDS);
buildFxUI();
buildProjectUI();
renderLoopsBar();
renderSongLane();
initModeToggle();
buildBackPanel();
buildVisualPanel();
refreshInputDevices();
initTempoDrag();
initViewToggle();
refreshRecordButton();
setTransportBpm(TRANSPORT.bpm);
// Snapshot the pristine default state now, before any project is loaded.
defaultProjectSnapshot = capturePreset();
// Bring back whatever the user was working on last session.
restoreAutosave();
setInterval(writeAutosave, AUTOSAVE_INTERVAL_MS);
window.addEventListener('beforeunload', () => {
  writeAutosave();
  flushAutosaveAudio();
});
setPanelView('front');
getStartBtn().textContent = getIdleStartButtonLabel();

window.addEventListener('resize', () => {
  if (UI_VIEW.mode === 'back') rebuildBackWireSVG();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearBackPatchSelection();
    closeProjectMenu();
    closeSongBlockMenu();
    closeModSourceMenu();
  }
  if (event.key === 'Tab' && !event.target.closest('input, textarea, select')) {
    event.preventDefault();
    setPanelView(UI_VIEW.mode === 'front' ? 'back' : 'front');
  }
});
