// grnsh — main thread: mic capture, worklet setup, UI wiring.

const THEME_STORAGE_KEY = 'grnsh-theme-v1';
const APP_THEMES = new Set(['original', 'sober', 'slate-arrangement', 'slate-session', 'neon-flux', 'aurora']);
const LEGACY_THEME_NAMES = {
  ableton: 'slate-arrangement',
  'ableton-session': 'slate-session',
};

function setAppTheme(theme, { persist = true } = {}) {
  const migrated = LEGACY_THEME_NAMES[theme] || theme;
  const next = APP_THEMES.has(migrated) ? migrated : 'original';
  document.documentElement.dataset.theme = next;
  const select = document.getElementById('themeSelect');
  if (select) select.value = next;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (_) {}
  }
}

try {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'original';
  setAppTheme(savedTheme, { persist: false });
  if (LEGACY_THEME_NAMES[savedTheme]) {
    localStorage.setItem(THEME_STORAGE_KEY, document.documentElement.dataset.theme);
  }
} catch (_) {
  setAppTheme('original', { persist: false });
}

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
  downloadName: null, // one-shot override used by the song bounce
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
  btn.textContent = '●';
  btn.title = REC.isRecording ? 'Stop recording' : 'Record';
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
  a.download = REC.downloadName || `grnsh-${stamp}.wav`;
  REC.downloadName = null;
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

// ── Undo / redo ── whole-workspace snapshots (same shape as the autosave
// data), captured a beat after each user gesture. Source audio clips are not
// part of the snapshot, so undo never blanks a loaded file or frozen take.

const HISTORY_LIMIT = 100;
const HISTORY_DEBOUNCE_MS = 400;
const HISTORY = { stack: [], index: -1, timer: null, applying: false };

function historyCaptureNow() {
  if (HISTORY.applying) return;
  clearTimeout(HISTORY.timer);
  HISTORY.timer = null;
  const snap = JSON.stringify(capturePreset());
  if (snap === HISTORY.stack[HISTORY.index]) return;
  HISTORY.stack.length = HISTORY.index + 1; // a new edit clears the redo tail
  HISTORY.stack.push(snap);
  if (HISTORY.stack.length > HISTORY_LIMIT) HISTORY.stack.shift();
  HISTORY.index = HISTORY.stack.length - 1;
  refreshHistoryButtons();
}

function scheduleHistoryCapture() {
  if (HISTORY.applying) return;
  clearTimeout(HISTORY.timer);
  HISTORY.timer = setTimeout(historyCaptureNow, HISTORY_DEBOUNCE_MS);
}

function historyInputListener(event) {
  // Text entry commits on 'change' (blur/Enter); capturing live keystrokes
  // would snapshot half-typed clamped values — "1" of "175" landing as 40 bpm.
  const target = event.target;
  if (
    target instanceof Element &&
    target.matches('input[type="text"], input[type="number"]:not([readonly]), textarea')
  )
    return;
  scheduleHistoryCapture();
}

function historyApply(index) {
  const snap = HISTORY.stack[index];
  if (!snap) return;
  HISTORY.index = index;
  HISTORY.applying = true;
  try {
    applyPreset(JSON.parse(snap), { resetSources: false });
  } finally {
    HISTORY.applying = false;
  }
  refreshHistoryButtons();
}

function undo() {
  // A pending (debounced) edit lands first, so it becomes the redo state.
  historyCaptureNow();
  if (HISTORY.index <= 0) {
    setStatus('nothing to undo');
    return;
  }
  historyApply(HISTORY.index - 1);
  setStatus('undo');
}

function redo() {
  if (HISTORY.timer) historyCaptureNow();
  if (HISTORY.index >= HISTORY.stack.length - 1) {
    setStatus('nothing to redo');
    return;
  }
  historyApply(HISTORY.index + 1);
  setStatus('redo');
}

function refreshHistoryButtons() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) undoBtn.disabled = HISTORY.index <= 0;
  if (redoBtn) redoBtn.disabled = HISTORY.index >= HISTORY.stack.length - 1;
}

function initHistory() {
  HISTORY.stack = [JSON.stringify(capturePreset())];
  HISTORY.index = 0;
  // Every workspace mutation ends in one of these gestures; capture is
  // debounced, so a knob drag lands as a single history entry.
  document.addEventListener('change', scheduleHistoryCapture, true);
  document.addEventListener('input', historyInputListener, true);
  window.addEventListener('pointerup', scheduleHistoryCapture, true);
  window.addEventListener('keyup', scheduleHistoryCapture, true);
  document.getElementById('undoBtn')?.addEventListener('click', undo);
  document.getElementById('redoBtn')?.addEventListener('click', redo);
  refreshHistoryButtons();
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
    // The merged buffers already exist — handing them to the mastering view
    // costs no copy and no processing until that view is opened.
    setMasteringSource(left, right, audioCtx.sampleRate, REC.downloadName || 'recording');
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

// ── Song bounce ── renders the arrangement to a WAV: master is unhooked from
// the speakers, the song plays once from the top through the real graph while
// the record tap captures it, and capture stops after the song ends plus an
// FX-tail grace period. Realtime (the graph is live), but hands-off and
// exact-length.

const BOUNCE_TAIL_MS = 2000;
const BOUNCE = {
  active: false,
  muted: false,
  pollTimer: null,
  progressTimer: null,
  tailTimer: null,
  phase: 'idle',
  songSeconds: 0,
  tailStartedAt: 0,
  prevMode: 'loop',
  prevSongLoop: true,
};

function getBounceSongSeconds() {
  const secPerStep = 60 / TRANSPORT.bpm / 4;
  return SONG.entries.reduce((seconds, entry) => {
    const loop = getLoopById(entry.loopId);
    if (!loop) return seconds;
    return seconds + loop.gen4.stepCount * Math.max(1, entry.repeats) * secPerStep;
  }, 0);
}

function setBounceProgress(progress) {
  const wrap = document.getElementById('bounceProgress');
  const fill = document.getElementById('bounceProgressFill');
  const label = document.getElementById('bounceProgressLabel');
  const normalized = clamp(progress, 0, 1);
  const percent = Math.round(normalized * 100);
  if (wrap) {
    wrap.hidden = !BOUNCE.active;
    wrap.setAttribute('aria-valuenow', String(percent));
  }
  if (fill) fill.style.width = `${percent}%`;
  if (label) label.textContent = `${percent}%`;
}

function refreshBounceProgress() {
  if (!BOUNCE.active) {
    setBounceProgress(0);
    return;
  }
  const tailSeconds = BOUNCE_TAIL_MS / 1000;
  const totalSeconds = Math.max(0.001, BOUNCE.songSeconds + tailSeconds);
  const songShare = BOUNCE.songSeconds / totalSeconds;
  if (BOUNCE.phase === 'preparing') {
    setBounceProgress(0);
    return;
  }
  if (BOUNCE.phase === 'tail') {
    const tailElapsed = Math.max(0, performance.now() - BOUNCE.tailStartedAt) / 1000;
    setBounceProgress(songShare + clamp(tailElapsed / tailSeconds, 0, 1) * (1 - songShare));
    return;
  }
  const renderedSeconds = audioCtx ? REC.sampleCount / audioCtx.sampleRate : 0;
  setBounceProgress(clamp(renderedSeconds / Math.max(0.001, BOUNCE.songSeconds), 0, 1) * songShare);
}

async function bounceSong() {
  if (BOUNCE.active) {
    finishBounce('bounce cancelled', { save: false });
    return;
  }
  if (REC.isRecording) {
    setStatus('stop recording first');
    return;
  }
  if (SONG.entries.length === 0) {
    setStatus('song is empty — add loops to the song lane');
    return;
  }
  if (isTransportOn()) await stripPlayToggle();
  BOUNCE.prevMode = PLAY.mode;
  BOUNCE.prevSongLoop = SONG.loop;
  BOUNCE.active = true;
  BOUNCE.phase = 'preparing';
  BOUNCE.songSeconds = getBounceSongSeconds();
  BOUNCE.tailStartedAt = 0;
  refreshBounceUI();
  try {
    setPlayMode('song');
    SONG.loop = false; // play the arrangement once, then the scheduler stops
    await ensureTransportEngine();
    if (!started) await start();
    await startRecording();
    // Silent render: the record tap keeps feeding, the speakers get nothing.
    try {
      master.output.disconnect(audioCtx.destination);
      BOUNCE.muted = true;
    } catch (e) {}
    startGen4Sequencer();
    if (!GEN4.playing) {
      finishBounce('bounce failed to start', { save: false });
      return;
    }
    BOUNCE.phase = 'rendering';
    BOUNCE.progressTimer = setInterval(refreshBounceProgress, 100);
    refreshBounceProgress();
    setStatus('bouncing song…');
    BOUNCE.pollTimer = setInterval(() => {
      if (!GEN4.playing && !BOUNCE.tailTimer) {
        clearInterval(BOUNCE.pollTimer);
        BOUNCE.pollTimer = null;
        BOUNCE.phase = 'tail';
        BOUNCE.tailStartedAt = performance.now();
        refreshBounceProgress();
        BOUNCE.tailTimer = setTimeout(() => finishBounce(), BOUNCE_TAIL_MS);
      }
    }, 200);
  } catch (err) {
    finishBounce(`bounce failed: ${err.message}`, { save: false });
  }
}

function finishBounce(statusText, { save = true } = {}) {
  clearInterval(BOUNCE.pollTimer);
  BOUNCE.pollTimer = null;
  clearInterval(BOUNCE.progressTimer);
  BOUNCE.progressTimer = null;
  clearTimeout(BOUNCE.tailTimer);
  BOUNCE.tailTimer = null;
  if (!BOUNCE.active) return;
  setBounceProgress(save ? 1 : 0);
  BOUNCE.active = false;
  BOUNCE.phase = 'idle';
  if (GEN4.playing) stopGen4Sequencer();
  if (REC.isRecording) {
    if (save) {
      REC.downloadName = `${(currentProjectName || 'grnsh').replace(/[^\w.-]+/g, '_')}-song.wav`;
    } else {
      // Discard: stopRecording only downloads when samples exist.
      REC.left = [];
      REC.right = [];
      REC.sampleCount = 0;
    }
    stopRecording();
  }
  if (BOUNCE.muted) {
    BOUNCE.muted = false;
    try {
      master.output.connect(audioCtx.destination);
    } catch (e) {}
  }
  SONG.loop = BOUNCE.prevSongLoop;
  setPlayMode(BOUNCE.prevMode);
  refreshBounceUI();
  setStatus(statusText || 'song bounced');
}

function refreshBounceUI() {
  const btn = document.getElementById('bounceBtn');
  if (!btn) return;
  btn.classList.toggle('active', BOUNCE.active);
  btn.title = BOUNCE.active
    ? 'Cancel bounce'
    : 'Bounce song to WAV — silent one-pass render of the arrangement';
  refreshBounceProgress();
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
  if (!started) {
    c.fillStyle = '#5a5a5a';
    c.font = '500 9px ui-monospace, monospace';
    c.fillText('click to start', W / 2, H / 2 + 27);
  }
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
  { key: 'decay', min: 0, max: 2, step: 0.01, unit: 's' },
  { key: 'sustain', min: 0, max: 1, step: 0.01, unit: '' },
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
  refreshBackPanelState();
}

// Boot everything transport playback needs: audio graph, drum nodes AND the
// granular worklet — so restored file buffers / frozen takes sound on ▶ play.
async function ensureTransportEngine() {
  if (!node) await ensureGranularEngine();
  else await ensureAudioEngine();
  if (!GEN4.nodes) buildGen4Nodes();
  startGenVizLoop();
  startLFOLoop();
  if (!started) setStatus('playing');
}

function setGranularRunning() {
  started = true;
  refreshSongTransportUI();
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

function getEffectiveGeneratorParams(genIdx, base = state[genIdx]) {
  const effective = { ...base };
  if (effective.grainSizeSync)
    effective.grainSizeMs = beatsToSeconds(getGrainSyncStep(effective.grainSizeSyncIndex).beats) * 1000;
  if (effective.densitySync)
    effective.density = 1 / beatsToSeconds(getGrainSyncStep(effective.densitySyncIndex).beats);
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
    decay: GEN3.decay,
    sustain: GEN3.sustain,
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
  // The worklet hears the audible loop's sound: in song mode with follow off,
  // the loop being edited (state) differs from the one sounding.
  const audibleGens = getAudibleLoop()?.gens?.[genIdx];
  const base =
    audibleGens && audibleGens !== state[genIdx]
      ? { ...audibleGens, freeze: state[genIdx].freeze }
      : state[genIdx];
  const effective = getEffectiveGeneratorParams(genIdx, base);
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
  led.classList.remove('active', 'lfo-1', 'lfo-2', 'lfo-seq', 'lfo-sc');
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
  if (lfoTarget && lfoTarget.genIdx >= 0 && lfoTarget.genIdx < 2) {
    knob.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openKnobContextMenu(
        { genIdx: lfoTarget.genIdx, key: lfoTarget.key, label: p.label },
        event.clientX,
        event.clientY,
      );
    });
  }

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
    if (e.button !== 0) return;
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
    const mixControls = buildInstrumentMixControls(busId);
    const headerActions = panel.querySelector('.col-header > .gen-header-actions');
    if (headerActions) headerActions.appendChild(mixControls);
    else panel.querySelector('.col-header')?.appendChild(mixControls);
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
  const effective = getEffectiveGen3Params();
  const attackEnd = now + GEN3.attack;
  const decayEnd = attackEnd + effective.decay;

  envelope.gain.cancelScheduledValues(now);
  envelope.gain.setValueAtTime(0, now);

  if (GEN3.attack > 0) envelope.gain.linearRampToValueAtTime(1, attackEnd);
  else envelope.gain.setValueAtTime(1, now);

  if (effective.decay > 0) envelope.gain.linearRampToValueAtTime(effective.sustain, decayEnd);
  else envelope.gain.setValueAtTime(effective.sustain, attackEnd);
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
    const ms = Math.max(0, GEN3.attack + getEffectiveGen3Params().decay) * 1000;
    entry.autoReleaseTimer = setTimeout(() => removeGen3Note(midi), ms);
  }
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
  refreshBackPanelState();
}

function syncGen3SustainChord(targetMidis) {
  if (!GEN3.sustainMode || !GEN3.nodes) return;
  [...GEN3.activeNotes.keys()].forEach((midi) => {
    if (!targetMidis.has(midi)) removeGen3Note(midi);
  });
  targetMidis.forEach((midi) => {
    if (!GEN3.activeNotes.has(midi)) addGen3Note(midi, midiNoteToFrequency(midi));
  });
}

function startGen3SustainChord() {
  const loop = PLAY.mode === 'song' ? getSchedulerLoop() : getEditLoop();
  syncGen3SustainChord(loop?.gen3?.lockedMidis || GEN3.lockedMidis);
}

function releaseGen3SustainChord() {
  if (!GEN3.sustainMode) return;
  [...GEN3.activeNotes.keys()].forEach((midi) => removeGen3Note(midi));
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
          // During Song playback this edits the focused loop without
          // retargeting the chord that belongs to the audible arrangement entry.
          if (GEN3.lockedMidis.has(midi)) {
            GEN3.lockedMidis.delete(midi);
          } else {
            GEN3.lockedMidis.add(midi);
          }
          if (!(PLAY.mode === 'song' && GEN4.playing)) {
            await ensureAudioEngine();
            syncGen3SustainChord(GEN3.lockedMidis);
          }
          refreshGen3KeyStates();
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
      await ensureAudioEngine();
      const targetLoop = PLAY.mode === 'song' && GEN4.playing ? getAudibleLoop() : getEditLoop();
      syncGen3SustainChord(targetLoop?.gen3?.lockedMidis || GEN3.lockedMidis);
    } else {
      // Switched to sequencer: stop all playing, keep locked visual
      stopAllGen3Notes();
      refreshGen3KeyStates();
    }
  });

  const actions = document.createElement('div');
  actions.className = 'gen-header-actions';
  actions.appendChild(susBtn);

  header.append(title, shapes, actions);
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
    const isMappable = GEN3_LFO_PARAMS.some(({ key }) => key === p.key);
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
  {
    id: 'fm',
    label: 'FM',
    color: '#e06ab5',
    paramDefs: [
      { key: 'tune', label: 'Tune', min: 30, max: 1200, step: 1, value: 220, unit: 'Hz' },
      { key: 'ratio', label: 'Ratio', min: 0.25, max: 8, step: 0.05, value: 2, unit: '' },
      { key: 'index', label: 'Index', min: 0, max: 20, step: 0.1, value: 3, unit: '' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'attack', label: 'Attack', min: 0.001, max: 1, step: 0.001, value: 0.005, unit: 's' },
      { key: 'decay', label: 'Decay', min: 0.03, max: 2, step: 0.01, value: 0.35, unit: 's' },
      {
        key: 'modDecay',
        label: 'Mod Decay',
        min: 0.01,
        max: 2,
        step: 0.01,
        value: 0.3,
        unit: 's',
      },
      { key: 'tone', label: 'Tone', min: 200, max: 16000, step: 100, value: 12000, unit: 'Hz' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.65, unit: '' },
    ],
  },
];

const GEN4_PRESETS = {
  kick: [
    { name: 'Default', values: { tune: 70, decay: 0.85, punch: 0.36, drive: 0, gain: 1 } },
    { name: 'Deep', values: { tune: 48, decay: 0.72, punch: 0.62, drive: 0.08, gain: 0.95 } },
    { name: 'Tight', values: { tune: 82, decay: 0.18, punch: 0.78, drive: 0.05, gain: 0.9 } },
    { name: 'Driven', values: { tune: 58, decay: 0.5, punch: 0.72, drive: 0.8, gain: 0.82 } },
  ],
  snare: [
    { name: 'Default', values: { tune: 360, decay: 0.09, snap: 1, gain: 0.96 } },
    { name: 'Tight', values: { tune: 310, decay: 0.11, snap: 0.9, gain: 0.9 } },
    { name: 'Fat', values: { tune: 210, decay: 0.32, snap: 0.62, gain: 0.92 } },
    { name: 'Bright', values: { tune: 440, decay: 0.18, snap: 1, gain: 0.78 } },
  ],
  hat: [
    { name: 'Default', values: { decay: 0.06, tone: 11200, gain: 0.6 } },
    { name: 'Closed', values: { decay: 0.025, tone: 13500, gain: 0.52 } },
    { name: 'Open', values: { decay: 0.32, tone: 9800, gain: 0.55 } },
    { name: 'Dark', values: { decay: 0.12, tone: 5200, gain: 0.7 } },
  ],
  perc: [
    { name: 'Default', values: { tune: 165, ratio: 1.6, index: 1.6, decay: 0.06, gain: 0.7 } },
    { name: 'Wood', values: { tune: 145, ratio: 1.4, index: 0.9, decay: 0.12, gain: 0.75 } },
    { name: 'Bell', values: { tune: 330, ratio: 3.5, index: 4.8, decay: 0.45, gain: 0.6 } },
    { name: 'Metal', values: { tune: 520, ratio: 6.2, index: 8.2, decay: 0.2, gain: 0.55 } },
  ],
  fm: [
    {
      name: 'Default',
      values: { tune: 220, ratio: 2, index: 3, feedback: 0, attack: 0.005, decay: 0.35, modDecay: 0.3, tone: 12000, gain: 0.65 },
    },
    {
      name: 'Sub Bass',
      values: { tune: 55, ratio: 0.5, index: 1.2, feedback: 0.08, attack: 0.005, decay: 0.55, modDecay: 0.3, tone: 1800, gain: 0.8 },
    },
    {
      name: 'Bell',
      values: { tune: 440, ratio: 3.5, index: 8, feedback: 0.18, attack: 0.002, decay: 1.4, modDecay: 1.7, tone: 11000, gain: 0.55 },
    },
    {
      name: 'Pluck',
      values: { tune: 220, ratio: 2, index: 4, feedback: 0.05, attack: 0.001, decay: 0.16, modDecay: 0.08, tone: 6500, gain: 0.7 },
    },
    {
      name: 'Zap',
      values: { tune: 110, ratio: 5.25, index: 12, feedback: 0.55, attack: 0.001, decay: 0.22, modDecay: 0.06, tone: 14000, gain: 0.55 },
    },
  ],
};

let gen4StepCountBtns = [];
let gen4SwingInput = null;
const gen4PresetSelects = new Map();

function getMatchingGen4PresetIndex(ci) {
  const ch = GEN4.channels[ci];
  const presets = GEN4_PRESETS[ch?.id] || [];
  return presets.findIndex(({ values }) =>
    Object.entries(values).every(([key, value]) => ch.params[key] === value),
  );
}

function refreshGen4PresetSelection(ci) {
  const select = gen4PresetSelects.get(ci);
  if (!select) return;
  const presetIndex = getMatchingGen4PresetIndex(ci);
  select.value = presetIndex < 0 ? '' : `${presetIndex}`;
}

function markGen4PresetCustom(ci) {
  const select = gen4PresetSelects.get(ci);
  if (select) select.value = '';
}

function applyGen4Preset(ci, presetIndex) {
  const ch = GEN4.channels[ci];
  const preset = GEN4_PRESETS[ch?.id]?.[presetIndex];
  if (!ch || !preset) return;
  Object.entries(preset.values).forEach(([key, value]) => {
    ch.params[key] = value;
    gen4ControlBindings[ci].get(key)?.setValue(value);
  });
  for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
  if (ci === gen4SelectedNoteChannel && gen4EditorMode === 'notes') {
    for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
  }
  refreshGen4PresetSelection(ci);
  refreshBackPanelState();
}

function buildGen4PresetSelect(ci) {
  const ch = GEN4.channels[ci];
  const presets = GEN4_PRESETS[ch?.id];
  if (!presets?.length) return null;
  const select = document.createElement('select');
  select.className = 'fx-preset-select drum-preset-select';
  select.title = `Choose a ${ch.id} preset`;

  const customOption = document.createElement('option');
  customOption.value = '';
  customOption.textContent = 'Custom';
  select.appendChild(customOption);
  presets.forEach(({ name }, presetIndex) => {
    const option = document.createElement('option');
    option.value = `${presetIndex}`;
    option.textContent = name;
    select.appendChild(option);
  });
  select.addEventListener('change', () => {
    if (select.value !== '') applyGen4Preset(ci, Number(select.value));
  });
  select.addEventListener('click', (event) => event.stopPropagation());
  select.addEventListener('keydown', (event) => event.stopPropagation());
  gen4PresetSelects.set(ci, select);
  refreshGen4PresetSelection(ci);
  return select;
}

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
      notes: new Array(32).fill(null),
      velocity: new Array(32).fill(1.0),
      timing: new Array(32).fill(0),
      locks: Array.from({ length: 32 }, () => ({})),
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
const gen4ParamSections = new Map();
let gen4VariationBtns = [];
let gen4FillBtn = null;
const GEN4_NOTE_MIN = 24;
const GEN4_NOTE_MAX = 127;
const gen4EditorModeButtons = new Map();
const gen4NoteLaneButtons = new Map();
let gen4EditorMode = 'grid';
let gen4SelectedNoteChannel = Math.max(
  0,
  GEN4_DEFS.findIndex((def) => def.id === 'fm'),
);
let gen4GridEl = null;
let gen4HintsEl = null;
let gen4NoteEditorEl = null;
let gen4NoteRollEl = null;
let gen4NotePencilBtn = null;
let gen4NotePencilEnabled = true;
let gen4NoteCellEls = Array.from({ length: 32 }, () => new Map());
let gen4NotePlayheadStep = -1;
let gen4LockSelection = null;
let gen4LockClearBtn = null;
const gen4NoteDrawState = {
  active: false,
  action: 'draw',
  pointerId: null,
  visited: new Set(),
};
let gen4DisplayFrame = null;
const gen4FillState = { active: false, loopId: null, pattern: null };
const gen4DragState = {
  active: false,
  ci: 0,
  si: 0,
  startX: 0,
  startY: 0,
  startVel: 1,
  startTiming: 0,
  axis: null,
  moved: false,
  suppressClick: false,
};

addEventListener('mousemove', (e) => {
  if (!gen4DragState.active) return;
  const { ci, si, startX, startY, startVel, startTiming } = gen4DragState;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (!gen4DragState.axis) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
    gen4DragState.axis = Math.abs(dx) >= Math.abs(dy) ? 'timing' : 'velocity';
    gen4DragState.moved = true;
    gen4DragState.suppressClick = true;
  }
  if (gen4DragState.axis === 'timing') {
    GEN4.channels[ci].timing[si] = clamp(startTiming + Math.round(dx / 12), -4, 4);
    gen4ApplyStepBtn(ci, si);
    return;
  }
  const next = clamp(startVel + (startY - e.clientY) / 80, 0.05, 1.0);
  GEN4.channels[ci].velocity[si] = next;
  gen4StepEls[ci][si]?.style.setProperty('--step-velocity', next);
});

window.addEventListener('mouseup', () => {
  gen4DragState.active = false;
  if (gen4DragState.suppressClick) {
    setTimeout(() => {
      gen4DragState.suppressClick = false;
    }, 0);
  }
});

function buildGen4Nodes() {
  if (!audioCtx || GEN4.nodes) return;
  const ac = audioCtx;

  const noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < ac.sampleRate; i++) noiseData[i] = Math.random() * 2 - 1;

  const channelFxOuts = GEN4.channels.map((ch) => {
    const gain = ac.createGain();
    gain.gain.value = ch.muted ? 0 : 1;
    gain.connect(fxBuses.gen4.input);
    return gain;
  });
  const channelDryOuts = GEN4.channels.map((ch) => {
    const gain = ac.createGain();
    gain.gain.value = ch.muted ? 0 : 1;
    // Dry hits still pass through the drums bus output so instrument-level
    // solo/mute remains authoritative.
    gain.connect(fxBuses.gen4.output);
    return gain;
  });

  GEN4.nodes = { channelFxOuts, channelDryOuts, noiseBuf };
}

const gen4FxSendBtns = [];
const gen4MuteBtns = [];

function gen4SetChannelMuted(ci, muted) {
  const ch = GEN4.channels[ci];
  if (!ch) return;
  ch.muted = muted;

  const outputs = [GEN4.nodes?.channelFxOuts?.[ci], GEN4.nodes?.channelDryOuts?.[ci]].filter(Boolean);
  if (outputs.length && audioCtx) {
    const now = audioCtx.currentTime;
    outputs.forEach((out) => {
      out.gain.cancelScheduledValues(now);
      out.gain.setTargetAtTime(muted ? 0 : 1, now, 0.005);
    });
  }

  const btn = gen4MuteBtns[ci];
  if (btn) {
    btn.classList.toggle('muted', muted);
    btn.setAttribute('aria-pressed', String(muted));
    btn.title = muted ? 'Unmute channel' : 'Mute channel';
    btn.closest('.drum-row')?.classList.toggle('channel-muted', muted);
  }
  gen4NoteLaneButtons.get(ci)?.classList.toggle('muted', muted);
}

function gen4SetChannelFxSend(ci, send) {
  const ch = GEN4.channels[ci];
  ch.fxSend = send;
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

function gen4TriggerOsc(time, midis = GEN3.lockedMidis) {
  if (!audioCtx || GEN3.sustainMode || midis.size === 0) return;
  // Snapshot the chord now — in song mode the bound loop may change before the
  // scheduled timeout fires.
  const notes = [...midis];
  const delayMs = Math.max(0, time - audioCtx.currentTime) * 1000;
  setTimeout(() => {
    const oscChannel = GEN4.channels.find((channel) => channel.id === 'osc');
    if (!audioCtx || oscChannel?.muted) return;
    notes.forEach((midi) => {
      if (GEN3.activeNotes.has(midi)) removeGen3Note(midi);
      addGen3Note(midi, midiNoteToFrequency(midi));
    });
  }, delayMs);
}

function gen4TriggerFmSynth(time, velocity, p, dest) {
  const ac = audioCtx;
  const mod = ac.createOscillator();
  const modGain = ac.createGain();
  const carrier = ac.createOscillator();
  const feedback = ac.createGain();
  const feedbackDelay = ac.createDelay(0.01);
  const envelope = ac.createGain();
  const tone = ac.createBiquadFilter();
  const modFrequency = p.tune * p.ratio;
  const modDepth = Math.max(0.001, modFrequency * p.index);
  const ampEnd = time + p.attack + p.decay;
  const modEnd = time + p.modDecay;
  const stopTime = Math.max(ampEnd, modEnd) + 0.05;

  mod.type = 'sine';
  mod.frequency.setValueAtTime(modFrequency, time);
  modGain.gain.setValueAtTime(modDepth, time);
  modGain.gain.exponentialRampToValueAtTime(0.001, modEnd);
  mod.connect(modGain);

  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(p.tune, time);
  modGain.connect(carrier.frequency);
  feedback.gain.setValueAtTime(p.tune * p.feedback * 4, time);
  feedbackDelay.delayTime.setValueAtTime(1 / ac.sampleRate, time);
  carrier.connect(feedback);
  feedback.connect(feedbackDelay);
  feedbackDelay.connect(carrier.frequency);

  envelope.gain.setValueAtTime(0.001, time);
  envelope.gain.linearRampToValueAtTime(velocity * p.gain, time + p.attack);
  envelope.gain.exponentialRampToValueAtTime(0.001, ampEnd);
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(p.tone, time);
  tone.Q.setValueAtTime(0.7, time);
  carrier.connect(envelope);
  envelope.connect(tone);
  tone.connect(dest);

  mod.start(time);
  carrier.start(time);
  mod.stop(stopTime);
  carrier.stop(stopTime);
}

function getEffectiveGen4Params(ci, locks = null) {
  const ch = GEN4.channels[ci];
  const def = GEN4_DEFS[ci];
  const effective = { ...ch.params, ...(locks || {}) };
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

function midiNoteToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function applyGen4StepNote(ch, p, midi, locks = null) {
  if (!Number.isFinite(midi) || ch.id === 'osc') return;
  const key = ch.id === 'hat' ? 'tone' : 'tune';
  if (locks && Object.hasOwn(locks, key)) return;
  const paramDef = GEN4_DEFS.find((def) => def.id === ch.id)?.paramDefs.find(
    (param) => param.key === key,
  );
  if (!paramDef) return;
  const modulationOffset = p[key] - ch.params[key];
  p[key] = clamp(midiNoteToFrequency(midi) + modulationOffset, paramDef.min, paramDef.max);
}

function gen4FireChannel(ci, time, velocity, midi = null, loop = null, locks = null) {
  const ch = GEN4.channels[ci];
  if (ch.muted) return;
  const p = getEffectiveGen4Params(ci, locks);
  applyGen4StepNote(ch, p, midi, locks);
  const sendToFx = locks && Object.hasOwn(locks, '_fxSend') ? locks._fxSend : ch.fxSend;
  const dest = sendToFx ? GEN4.nodes.channelFxOuts[ci] : GEN4.nodes.channelDryOuts[ci];
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
      gen4TriggerOsc(
        time,
        loop ? loop.gen3.lockedMidis : GEN3.lockedMidis,
      );
      break;
    case 'fm':
      gen4TriggerFmSynth(time, velocity, p, dest);
      break;
  }
}

function gen4ScheduleTick() {
  if (!audioCtx || !GEN4.nodes || !GEN4.playing) return;
  const secPerStep = 60.0 / TRANSPORT.bpm / 4;
  const secPerSixtyFourth = 60.0 / TRANSPORT.bpm / 16;
  const scheduleHorizon = GEN4.scheduleAheadTime + secPerSixtyFourth * 4;
  while (GEN4.nextStepTime < audioCtx.currentTime + scheduleHorizon) {
    // The pattern to schedule from: the edited loop in loop mode, the loop at
    // the song cursor in song mode. Resolved per step so a pattern boundary
    // can hand off to the next arrangement entry mid-lookahead.
    let loop = getSchedulerLoop();
    if (!loop) {
      stopGen4Sequencer();
      return;
    }
    let pattern = getGen4PlaybackPattern(loop);
    let step = GEN4.schedulerStep + 1;
    if (step >= pattern.stepCount) {
      if (gen4FillState.active && gen4FillState.loopId === loop.id) clearGen4Fill();
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
      pattern = getGen4PlaybackPattern(loop);
      step = 0;
    }
    GEN4.schedulerStep = step;
    // Swing delays every other 16th, topping out at a perfect-triplet feel
    // (offbeat at 2/3 of the pair). The step grid itself stays straight so
    // pattern boundaries and stutter spacing are unaffected; the schedule
    // entry carries the swung time so the playhead tracks what is heard.
    const swingOffset = step % 2 === 1 ? ((loop.gen4.swing || 0) * secPerStep) / 3 : 0;
    gen4Schedule.push({
      step,
      time: GEN4.nextStepTime + swingOffset,
      loopId: loop.id,
      entryIdx: PLAY.mode === 'song' ? SONG.cursor.entryIdx : -1,
      repeat: PLAY.mode === 'song' ? SONG.cursor.repeat : 0,
    });
    if (gen4Schedule.length > 48) gen4Schedule.shift();
    pattern.channels.forEach((pat, ci) => {
      if (!pat.steps[step]) return;
      if (Math.random() > pat.probability[step]) return;
      const count = pat.stutter[step];
      const timing = clamp(Math.round(pat.timing?.[step] || 0), -4, 4);
      const stepTime = Math.max(
        audioCtx.currentTime,
        GEN4.nextStepTime + swingOffset + timing * secPerSixtyFourth,
      );
      for (let r = 0; r < count; r++) {
        gen4FireChannel(
          ci,
          stepTime + r * (secPerStep / count),
          pat.velocity[step],
          pat.notes[step],
          loop,
          pat.locks?.[step],
        );
      }
    });
    GEN4.nextStepTime += secPerStep;
  }
}

function refreshGen4SwingUI() {
  const loop = getEditLoop();
  const swing = loop ? loop.gen4.swing || 0 : 0;
  // Leave the field alone while the user is typing in it.
  if (gen4SwingInput && gen4SwingInput.readOnly) {
    gen4SwingInput.value = String(Math.round(swing * 100));
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
  if (gen4EditorMode === 'notes') refreshGen4NotePlayhead();
}

function gen4IsStepDefault(ch, stepIdx) {
  return (
    !ch.steps[stepIdx] &&
    ch.notes[stepIdx] === null &&
    ch.velocity[stepIdx] === 1.0 &&
    ch.timing[stepIdx] === 0 &&
    Object.keys(ch.locks[stepIdx]).length === 0 &&
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
      ch.notes[dest] = ch.notes[src];
      ch.velocity[dest] = ch.velocity[src];
      ch.timing[dest] = ch.timing[src];
      ch.locks[dest] = { ...ch.locks[src] };
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
  if (gen4EditorMode === 'notes') {
    for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
    gen4NoteRollEl?.querySelectorAll('.drum-note-step-number').forEach((el, si) => {
      el.classList.toggle('step-inactive', si >= n);
    });
  }
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
  else {
    STEP_SEQ.currentStep = 0;
    STEP_SEQ.elapsed = 0;
    const seq = getSchedulerLoop()?.seq;
    STEP_SEQ.currentValue = seq ? seq.steps[0] || 0 : 0;
    refreshSequencerUI();
  }
  startGen3SustainChord();
  // Phase-lock modulation to the transport: LFOs restart at phase 0 and the
  // beat-repeat interval clocks realign, so play always begins on the bar
  // instead of wherever the free-running phases drifted while stopped.
  LFOS.forEach((lfo) => {
    lfo.phase = 0;
    lfo.currentValue = getLFOValue(lfo);
  });
  lfoLastTs = 0;
  FX_BUS_IDS.forEach((busId) => fxBuses[busId]?.beatrepeat.node.port.postMessage('reset'));
  GEN4.nextStepTime = audioCtx.currentTime;
  GEN4.schedulerTimer = setInterval(gen4ScheduleTick, GEN4.scheduleInterval);
  if (!gen4DisplayFrame) gen4DisplayFrame = requestAnimationFrame(gen4DisplayTick);
  refreshSongTransportUI();
}

function stopGen4Sequencer() {
  GEN4.playing = false;
  releaseGen3SustainChord();
  clearInterval(GEN4.schedulerTimer);
  GEN4.schedulerTimer = null;
  if (gen4DisplayFrame) {
    cancelAnimationFrame(gen4DisplayFrame);
    gen4DisplayFrame = null;
  }
  GEN4.displayStep = -1;
  SONG.audibleEntryIdx = -1;
  clearGen4Fill();
  // Back to the edit loop's sound now that nothing is audible.
  sendParams(0);
  sendParams(1);
  renderSongPlayhead();
  gen4RefreshStepDisplay();
  refreshSongTransportUI();
}

const GEN4_PROB_CYCLE = [1.0, 0.75, 0.5, 0.25];

function gen4ApplyStepBtn(ci, si) {
  const btn = gen4StepEls[ci][si];
  if (!btn) return;
  const ch = GEN4.channels[ci];
  const on = ch.steps[si];
  btn.classList.toggle('on', on);
  btn.style.setProperty('--step-velocity', ch.velocity[si]);
  const timing = clamp(Math.round(ch.timing?.[si] || 0), -4, 4);
  btn.title = on
    ? `Velocity ${Math.round(ch.velocity[si] * 100)}% · timing ${timing > 0 ? '+' : ''}${timing}/64`
    : '';

  const noteEl = btn.querySelector('.drum-step-note');
  if (noteEl) {
    const midi = Number.isFinite(ch.notes[si]) ? ch.notes[si] : getGen4BaseMidi(ci);
    noteEl.textContent = ch.id === 'osc' ? 'CHD' : formatMidiNote(midi);
    noteEl.hidden = !on;
  }

  const stutterEl = btn.querySelector('.drum-step-stutter');
  if (stutterEl) {
    const s = ch.stutter[si];
    stutterEl.textContent = s > 1 ? `×${s}` : '';
    stutterEl.hidden = s <= 1;
  }

  const timingEl = btn.querySelector('.drum-step-timing');
  if (timingEl) {
    timingEl.textContent = timing === 0 ? '' : `${timing > 0 ? '+' : '−'}${Math.abs(timing)}`;
    timingEl.hidden = !on || timing === 0;
  }

  const lockEl = btn.querySelector('.drum-step-lock');
  const hasLocks = hasGen4StepLocks(ci, si);
  btn.classList.toggle('has-locks', on && hasLocks);
  if (lockEl) lockEl.hidden = !on || !hasLocks;

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

function formatMidiNote(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function frequencyToMidi(frequency) {
  return Math.round(69 + 12 * Math.log2(Math.max(1, frequency) / 440));
}

function getGen4BaseMidi(ci) {
  const ch = GEN4.channels[ci];
  if (ch.id === 'osc') return [...GEN3.lockedMidis][0] ?? 60;
  const key = ch.id === 'hat' ? 'tone' : 'tune';
  return frequencyToMidi(ch.params[key] || 261.63);
}

function getGen4NoteFocusMidi(ci) {
  const ch = GEN4.channels[ci];
  const assigned = ch.notes.find((midi, si) => ch.steps[si] && Number.isFinite(midi));
  return Number.isFinite(assigned) ? assigned : getGen4BaseMidi(ci);
}

function refreshGen4NoteStep(stepIdx) {
  const ch = GEN4.channels[gen4SelectedNoteChannel];
  const selectedMidi = ch.steps[stepIdx] ? ch.notes[stepIdx] : null;
  const inheritedMidi =
    ch.steps[stepIdx] && !Number.isFinite(selectedMidi)
      ? clamp(getGen4BaseMidi(gen4SelectedNoteChannel), GEN4_NOTE_MIN, GEN4_NOTE_MAX)
      : null;
  gen4NoteCellEls[stepIdx].forEach((cell, midi) => {
    cell.classList.toggle('on', midi === selectedMidi);
    cell.classList.toggle('inherited', midi === inheritedMidi);
    cell.classList.toggle('step-inactive', stepIdx >= GEN4.stepCount);
  });
}

function editGen4NoteCell(stepIdx, midi, action) {
  if (stepIdx >= GEN4.stepCount) return;
  const ch = GEN4.channels[gen4SelectedNoteChannel];
  const currentMidi = Number.isFinite(ch.notes[stepIdx])
    ? ch.notes[stepIdx]
    : clamp(getGen4BaseMidi(gen4SelectedNoteChannel), GEN4_NOTE_MIN, GEN4_NOTE_MAX);

  if (action === 'erase') {
    if (!ch.steps[stepIdx] || currentMidi !== midi) return;
    ch.steps[stepIdx] = false;
    ch.notes[stepIdx] = null;
    ch.timing[stepIdx] = 0;
    ch.locks[stepIdx] = {};
    ch.stutter[stepIdx] = 1;
    ch.probability[stepIdx] = 1;
  } else {
    ch.steps[stepIdx] = true;
    ch.notes[stepIdx] = midi;
  }

  gen4ApplyStepBtn(gen4SelectedNoteChannel, stepIdx);
  refreshGen4NoteStep(stepIdx);
}

function editGen4NoteCellFromElement(cell) {
  if (!(cell instanceof HTMLElement) || !cell.classList.contains('drum-note-cell')) return;
  if (cell.classList.contains('step-inactive')) return;
  const stepIdx = Number(cell.dataset.step);
  const midi = Number(cell.dataset.midi);
  const visitKey = `${stepIdx}:${midi}`;
  if (gen4NoteDrawState.visited.has(visitKey)) return;
  gen4NoteDrawState.visited.add(visitKey);
  editGen4NoteCell(stepIdx, midi, gen4NoteDrawState.action);
}

function refreshGen4NotePlayhead() {
  gen4NoteCellEls[gen4NotePlayheadStep]?.forEach((cell) => cell.classList.remove('current'));
  gen4NotePlayheadStep =
    GEN4.displayStep >= 0 && GEN4.displayStep < GEN4.stepCount ? GEN4.displayStep : -1;
  gen4NoteCellEls[gen4NotePlayheadStep]?.forEach((cell) => cell.classList.add('current'));
}

function refreshGen4NoteEditor() {
  gen4EditorModeButtons.forEach((btn, mode) => {
    btn.classList.toggle('active', mode === gen4EditorMode);
  });
  gen4NoteLaneButtons.forEach((btn, ci) => {
    btn.classList.toggle('active', ci === gen4SelectedNoteChannel);
  });
  if (gen4GridEl) gen4GridEl.hidden = gen4EditorMode === 'notes';
  if (gen4HintsEl) gen4HintsEl.hidden = gen4EditorMode === 'notes';
  if (gen4NoteEditorEl) gen4NoteEditorEl.hidden = gen4EditorMode !== 'notes';
  if (gen4EditorMode === 'notes') {
    for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
    refreshGen4NotePlayhead();
  }
}

function hasGen4StepLocks(ci, si) {
  return Object.keys(GEN4.channels[ci]?.locks?.[si] || {}).length > 0;
}

function refreshGen4LockEditor() {
  GEN4_DEFS.forEach((def, ci) => {
    for (let si = 0; si < 32; si++) {
      gen4StepEls[ci][si]?.classList.toggle(
        'lock-selected',
        gen4EditorMode === 'locks' && gen4LockSelection?.ci === ci && gen4LockSelection?.si === si,
      );
    }
    const selected = gen4EditorMode === 'locks' && gen4LockSelection?.ci === ci;
    const locks = selected ? GEN4.channels[ci].locks[gen4LockSelection.si] : null;
    def.paramDefs.forEach(({ key }) => {
      const control = gen4ControlBindings[ci].get(key);
      if (!control) return;
      const locked = !!locks && Object.hasOwn(locks, key);
      control.classList.toggle('parameter-locked', locked);
      control.setValue(locked ? locks[key] : GEN4.channels[ci].params[key]);
    });
    const presetSelect = gen4PresetSelects.get(ci);
    if (presetSelect) presetSelect.disabled = selected;
    const fxButton = gen4FxSendBtns[ci];
    if (fxButton) {
      const fxLocked = !!locks && Object.hasOwn(locks, '_fxSend');
      fxButton.classList.toggle('locked', fxLocked);
      fxButton.classList.toggle('active', fxLocked ? locks._fxSend : GEN4.channels[ci].fxSend);
      fxButton.title = fxLocked
        ? `Step FX routing locked ${locks._fxSend ? 'on' : 'off'}`
        : 'Send to FX chain — click to bypass the drum effects';
    }
  });
  if (gen4LockClearBtn) {
    const hasSelection = gen4EditorMode === 'locks' && !!gen4LockSelection;
    gen4LockClearBtn.hidden = gen4EditorMode !== 'locks';
    gen4LockClearBtn.disabled = !hasSelection || !hasGen4StepLocks(gen4LockSelection.ci, gen4LockSelection.si);
  }
}

function selectGen4LockStep(ci, si) {
  if (GEN4_DEFS[ci]?.paramDefs.length === 0 || !GEN4.channels[ci]?.steps[si]) return;
  gen4LockSelection = { ci, si };
  gen4ParamSections.get(ci)?.setCollapsed(false);
  refreshGen4LockEditor();
}

function clearSelectedGen4Locks() {
  if (!gen4LockSelection) return;
  const { ci, si } = gen4LockSelection;
  GEN4.channels[ci].locks[si] = {};
  gen4ApplyStepBtn(ci, si);
  refreshGen4LockEditor();
}

function renderGen4NoteRoll() {
  if (!gen4NoteRollEl) return;
  gen4NoteRollEl.textContent = '';
  gen4NoteCellEls = Array.from({ length: 32 }, () => new Map());
  gen4NotePlayheadStep = -1;
  const def = GEN4_DEFS[gen4SelectedNoteChannel];
  const ch = GEN4.channels[gen4SelectedNoteChannel];
  const pitchKey = ch.id === 'hat' ? 'tone' : 'tune';
  const pitchDef = def.paramDefs.find((param) => param.key === pitchKey);
  gen4NoteEditorEl?.style.setProperty('--ch-color', def.color);
  const visibleMidis = [];
  for (let midi = GEN4_NOTE_MAX; midi >= GEN4_NOTE_MIN; midi--) {
    const frequency = midiNoteToFrequency(midi);
    if (!pitchDef || (frequency >= pitchDef.min && frequency <= pitchDef.max)) {
      visibleMidis.push(midi);
    }
  }

  const stepHeader = document.createElement('div');
  stepHeader.className = 'drum-note-row drum-note-step-header';
  const corner = document.createElement('span');
  corner.className = 'drum-note-label';
  corner.textContent = 'Note';
  stepHeader.appendChild(corner);
  for (let si = 0; si < 32; si++) {
    const number = document.createElement('span');
    number.className = 'drum-note-step-number';
    number.textContent = `${si + 1}`;
    number.classList.toggle('step-inactive', si >= GEN4.stepCount);
    stepHeader.appendChild(number);
  }
  gen4NoteRollEl.appendChild(stepHeader);

  visibleMidis.forEach((midi) => {
    const row = document.createElement('div');
    row.className = 'drum-note-row';
    if ([1, 3, 6, 8, 10].includes(midi % 12)) row.classList.add('black-key');

    const noteLabel = document.createElement('span');
    noteLabel.className = 'drum-note-label';
    noteLabel.textContent = formatMidiNote(midi);
    row.appendChild(noteLabel);

    for (let si = 0; si < 32; si++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'drum-note-cell';
      cell.dataset.step = `${si}`;
      cell.dataset.midi = `${midi}`;
      cell.title = `${def.label} · step ${si + 1} · ${formatMidiNote(midi)}`;
      cell.classList.toggle('on', ch.steps[si] && ch.notes[si] === midi);
      cell.classList.toggle('step-inactive', si >= GEN4.stepCount);
      cell.addEventListener('click', () => {
        if (gen4NotePencilEnabled) return;
        if (si >= GEN4.stepCount) return;
        const currentMidi = Number.isFinite(ch.notes[si])
          ? ch.notes[si]
          : clamp(getGen4BaseMidi(gen4SelectedNoteChannel), GEN4_NOTE_MIN, GEN4_NOTE_MAX);
        const isSelected = ch.steps[si] && currentMidi === midi;
        editGen4NoteCell(si, midi, isSelected ? 'erase' : 'draw');
      });
      gen4NoteCellEls[si].set(midi, cell);
      row.appendChild(cell);
    }
    gen4NoteRollEl.appendChild(row);
  });

  const requestedFocusMidi = getGen4NoteFocusMidi(gen4SelectedNoteChannel);
  const focusMidi = visibleMidis.reduce(
    (closest, midi) =>
      Math.abs(midi - requestedFocusMidi) < Math.abs(closest - requestedFocusMidi) ? midi : closest,
    visibleMidis[0],
  );
  requestAnimationFrame(() => {
    const rowHeight = gen4NoteRollEl.firstElementChild?.getBoundingClientRect().height || 18;
    const targetY = (visibleMidis.indexOf(focusMidi) + 1) * rowHeight;
    gen4NoteRollEl.scrollTop = Math.max(0, targetY - gen4NoteRollEl.clientHeight * 0.45);
  });
  for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
  refreshGen4NotePlayhead();
}

function setGen4NoteChannel(ci) {
  if (!GEN4_DEFS[ci] || GEN4_DEFS[ci].id === 'osc') return;
  gen4SelectedNoteChannel = ci;
  gen4NoteLaneButtons.forEach((btn, idx) => btn.classList.toggle('active', idx === ci));
  renderGen4NoteRoll();
}

function setGen4EditorMode(mode) {
  if (mode !== 'grid' && mode !== 'notes' && mode !== 'locks') return;
  gen4EditorMode = mode;
  if (mode === 'notes' && gen4NoteCellEls.every((cells) => cells.size === 0)) {
    renderGen4NoteRoll();
  }
  if (gen4HintsEl) {
    gen4HintsEl.innerHTML =
      mode === 'locks'
        ? '<span class="drum-hint"><span class="drum-hint-key">select step</span> edit its instrument controls · locked values glow</span>'
        : '<span class="drum-hint"><span class="drum-hint-key">drag ↕</span> velocity</span><span class="drum-hints-sep">·</span><span class="drum-hint"><span class="drum-hint-key">drag ↔</span> timing</span><span class="drum-hints-sep">·</span><span class="drum-hint"><span class="drum-hint-key">shift + click</span> active step → cycle probability</span><span class="drum-hints-sep">·</span><span class="drum-hint"><span class="drum-hint-key">right-click</span> active step → cycle stutter</span>';
  }
  refreshGen4NoteEditor();
  refreshGen4LockEditor();
}

function buildGen4NoteEditor() {
  const editor = document.createElement('div');
  editor.className = 'drum-note-editor';
  editor.hidden = true;

  const lanes = document.createElement('div');
  lanes.className = 'drum-note-lanes';
  GEN4_DEFS.forEach((def, ci) => {
    if (def.id === 'osc') return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drum-note-lane-btn';
    btn.textContent = def.label;
    btn.style.setProperty('--ch-color', def.color);
    btn.addEventListener('click', () => setGen4NoteChannel(ci));
    gen4NoteLaneButtons.set(ci, btn);
    lanes.appendChild(btn);
  });

  const pencil = document.createElement('button');
  pencil.type = 'button';
  pencil.className = 'drum-note-pencil-btn active';
  pencil.textContent = '✎';
  pencil.title = 'Pencil: drag to draw; start on a note to erase';
  pencil.setAttribute('aria-label', 'Pencil tool');
  pencil.setAttribute('aria-pressed', 'true');
  pencil.addEventListener('click', () => {
    gen4NotePencilEnabled = !gen4NotePencilEnabled;
    pencil.classList.toggle('active', gen4NotePencilEnabled);
    pencil.setAttribute('aria-pressed', String(gen4NotePencilEnabled));
  });
  lanes.appendChild(pencil);
  gen4NotePencilBtn = pencil;

  const roll = document.createElement('div');
  roll.className = 'drum-note-roll';
  roll.addEventListener('pointerdown', (event) => {
    if (!gen4NotePencilEnabled || event.button !== 0) return;
    const cell = event.target.closest('.drum-note-cell');
    if (!cell || cell.classList.contains('step-inactive')) return;
    event.preventDefault();
    const stepIdx = Number(cell.dataset.step);
    const midi = Number(cell.dataset.midi);
    const ch = GEN4.channels[gen4SelectedNoteChannel];
    const currentMidi = Number.isFinite(ch.notes[stepIdx])
      ? ch.notes[stepIdx]
      : clamp(getGen4BaseMidi(gen4SelectedNoteChannel), GEN4_NOTE_MIN, GEN4_NOTE_MAX);
    gen4NoteDrawState.active = true;
    gen4NoteDrawState.action = ch.steps[stepIdx] && currentMidi === midi ? 'erase' : 'draw';
    gen4NoteDrawState.pointerId = event.pointerId;
    gen4NoteDrawState.visited.clear();
    roll.setPointerCapture(event.pointerId);
    editGen4NoteCellFromElement(cell);
  });
  roll.addEventListener('pointermove', (event) => {
    if (!gen4NoteDrawState.active || event.pointerId !== gen4NoteDrawState.pointerId) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.drum-note-cell');
    if (cell && roll.contains(cell)) editGen4NoteCellFromElement(cell);
  });
  const finishPencilGesture = (event) => {
    if (!gen4NoteDrawState.active || event.pointerId !== gen4NoteDrawState.pointerId) return;
    gen4NoteDrawState.active = false;
    gen4NoteDrawState.pointerId = null;
    gen4NoteDrawState.visited.clear();
  };
  roll.addEventListener('pointerup', finishPencilGesture);
  roll.addEventListener('pointercancel', finishPencilGesture);
  editor.append(lanes, roll);
  gen4NoteEditorEl = editor;
  gen4NoteRollEl = roll;
  return editor;
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

  const editorModeGroup = document.createElement('div');
  editorModeGroup.className = 'drum-editor-mode-group';
  [
    ['grid', 'Grid'],
    ['notes', 'Notes'],
    ['locks', 'Lock'],
  ].forEach(([mode, label]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drum-editor-mode-btn';
    btn.textContent = label;
    btn.classList.toggle('active', gen4EditorMode === mode);
    btn.addEventListener('click', () => setGen4EditorMode(mode));
    gen4EditorModeButtons.set(mode, btn);
    editorModeGroup.appendChild(btn);
  });
  actions.appendChild(editorModeGroup);

  gen4LockClearBtn = document.createElement('button');
  gen4LockClearBtn.type = 'button';
  gen4LockClearBtn.className = 'drum-lock-clear-btn';
  gen4LockClearBtn.textContent = 'CLR';
  gen4LockClearBtn.title = 'Clear parameter locks on the selected step';
  gen4LockClearBtn.disabled = true;
  gen4LockClearBtn.hidden = true;
  gen4LockClearBtn.addEventListener('click', clearSelectedGen4Locks);
  actions.appendChild(gen4LockClearBtn);

  const variationGroup = document.createElement('div');
  variationGroup.className = 'drum-variation-group';
  gen4VariationBtns = ['A', 'B', 'C'].map((label, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drum-variation-btn';
    btn.textContent = label;
    btn.title = index === 0 ? 'Original variation' : `Variation ${label} — generated once, then editable`;
    btn.addEventListener('click', () => setGen4Variation(index));
    if (index > 0) {
      btn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openGen4VariationMenu(index, event.clientX, event.clientY);
      });
    }
    variationGroup.appendChild(btn);
    return btn;
  });
  gen4FillBtn = document.createElement('button');
  gen4FillBtn.type = 'button';
  gen4FillBtn.className = 'drum-fill-btn';
  gen4FillBtn.textContent = 'Fill';
  gen4FillBtn.title = 'Generate a temporary fill for the rest of this cycle';
  gen4FillBtn.addEventListener('click', toggleGen4Fill);
  variationGroup.appendChild(gen4FillBtn);
  actions.appendChild(variationGroup);

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

  // Swing value box — same interaction as the tempo box: vertical drag with
  // pointer lock, double-click to type, Enter/blur commits.
  const swingBox = document.createElement('div');
  swingBox.className = 'drum-swing-box';
  swingBox.title =
    'Swing — drag vertically, double-click to type. Delays every other 16th, 100% = triplet feel (per loop)';
  const swingLabel = document.createElement('span');
  swingLabel.className = 'drum-swing-label';
  swingLabel.textContent = 'swing';
  gen4SwingInput = document.createElement('input');
  gen4SwingInput.type = 'number';
  gen4SwingInput.className = 'drum-swing-input';
  gen4SwingInput.min = '0';
  gen4SwingInput.max = '100';
  gen4SwingInput.step = '1';
  gen4SwingInput.value = '0';
  gen4SwingInput.readOnly = true;
  const swingSuffix = document.createElement('span');
  swingSuffix.className = 'drum-swing-suffix';
  swingSuffix.textContent = '%';

  const commitSwing = (pct) => {
    const loop = getEditLoop();
    if (!loop || !Number.isFinite(pct)) return;
    loop.gen4.swing = clamp(pct, 0, 100) / 100;
  };

  let swingArmed = false;
  let swingDragging = false;
  let swingDragPct = 0;
  let swingDownY = 0;

  gen4SwingInput.addEventListener('dblclick', () => {
    gen4SwingInput.readOnly = false;
    gen4SwingInput.focus();
    gen4SwingInput.select();
  });
  gen4SwingInput.addEventListener('blur', () => {
    commitSwing(Number.parseFloat(gen4SwingInput.value));
    gen4SwingInput.readOnly = true;
    refreshGen4SwingUI();
  });
  gen4SwingInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gen4SwingInput.blur();
  });

  swingBox.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!gen4SwingInput.readOnly) return; // typing mode — leave it alone
    e.preventDefault();
    swingArmed = true;
    swingDownY = e.clientY;
    swingDragPct = Math.round((getEditLoop()?.gen4.swing || 0) * 100);
    swingBox.setPointerCapture(e.pointerId);
  });
  swingBox.addEventListener('pointermove', (e) => {
    if (!swingArmed && !swingDragging) return;
    if (!swingDragging) {
      if (Math.abs(e.clientY - swingDownY) < 3) return; // still a click
      swingDragging = true;
      swingArmed = false;
      swingBox.classList.add('dragging');
      gen4SwingInput.blur();
      swingBox.requestPointerLock?.();
    }
    swingDragPct = clamp(swingDragPct - e.movementY * (e.shiftKey ? 0.1 : 0.5), 0, 100);
    commitSwing(swingDragPct);
    refreshGen4SwingUI();
  });
  const endSwingDrag = (e) => {
    swingArmed = false;
    if (swingBox.hasPointerCapture(e.pointerId)) swingBox.releasePointerCapture(e.pointerId);
    if (!swingDragging) return;
    swingDragging = false;
    swingBox.classList.remove('dragging');
    if (document.pointerLockElement === swingBox) document.exitPointerLock();
  };
  swingBox.addEventListener('pointerup', endSwingDrag);
  swingBox.addEventListener('pointercancel', endSwingDrag);

  swingBox.append(swingLabel, gen4SwingInput, swingSuffix);
  actions.appendChild(swingBox);

  header.append(title, actions);
  panel.appendChild(header);

  const hints = document.createElement('div');
  hints.className = 'drum-hints';
  hints.innerHTML =
    '<span class="drum-hint"><span class="drum-hint-key">drag ↕</span> velocity</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">drag ↔</span> timing</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">shift + click</span> active step → cycle probability</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">right-click</span> active step → cycle stutter</span>';
  panel.appendChild(hints);
  gen4HintsEl = hints;

  // Step grid
  const grid = document.createElement('div');
  grid.className = 'drum-grid';
  gen4GridEl = grid;

  GEN4_DEFS.forEach((def, ci) => {
    const ch = GEN4.channels[ci];
    const row = document.createElement('div');
    row.className = 'drum-row';
    row.style.setProperty('--ch-color', def.color);

    const lbl = document.createElement(def.id === 'osc' ? 'div' : 'button');
    if (def.id !== 'osc') lbl.type = 'button';
    lbl.className = 'drum-row-label';
    lbl.textContent = def.label;
    if (def.id === 'osc') {
      lbl.title = 'Triggers the notes selected in Gen 3';
      lbl.classList.add('fixed-note-source');
    } else {
      lbl.title = `Edit ${def.label} notes`;
      lbl.addEventListener('click', () => {
        setGen4NoteChannel(ci);
        setGen4EditorMode('notes');
      });
    }

    const stepsEl = document.createElement('div');
    stepsEl.className = 'drum-steps';
    stepsEl.style.setProperty('--step-count', GEN4.stepCount);

    for (let si = 0; si < 32; si++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'drum-step';
      gen4StepEls[ci][si] = btn;

      const noteEl = document.createElement('span');
      noteEl.className = 'drum-step-note';
      noteEl.hidden = true;
      btn.appendChild(noteEl);

      const stutterEl = document.createElement('span');
      stutterEl.className = 'drum-step-stutter';
      stutterEl.hidden = true;
      btn.appendChild(stutterEl);

      const timingEl = document.createElement('span');
      timingEl.className = 'drum-step-timing';
      timingEl.hidden = true;
      btn.appendChild(timingEl);

      const lockEl = document.createElement('span');
      lockEl.className = 'drum-step-lock';
      lockEl.textContent = 'L';
      lockEl.hidden = true;
      btn.appendChild(lockEl);

      const probEl = document.createElement('span');
      probEl.className = 'drum-step-prob';
      probEl.hidden = true;
      btn.appendChild(probEl);

      if (si >= GEN4.stepCount) btn.classList.add('step-inactive');
      gen4ApplyStepBtn(ci, si);

      btn.addEventListener('click', (e) => {
        if (gen4DragState.suppressClick) {
          gen4DragState.suppressClick = false;
          return;
        }
        if (gen4EditorMode === 'locks') {
          selectGen4LockStep(ci, si);
          return;
        }
        if (e.shiftKey && ch.steps[si]) {
          gen4CycleProbability(ci, si);
          return;
        }
        ch.steps[si] = !ch.steps[si];
        // reset glitch state when turning off
        if (!ch.steps[si]) {
          ch.notes[si] = null;
          ch.timing[si] = 0;
          ch.locks[si] = {};
          ch.stutter[si] = 1;
          ch.probability[si] = 1.0;
        }
        gen4ApplyStepBtn(ci, si);
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (gen4EditorMode === 'locks') return;
        if (ch.steps[si]) gen4CycleStutter(ci, si);
      });

      btn.addEventListener('mousedown', (e) => {
        if (!ch.steps[si] || e.shiftKey || e.button !== 0 || gen4EditorMode === 'locks') return;
        gen4DragState.active = true;
        gen4DragState.ci = ci;
        gen4DragState.si = si;
        gen4DragState.startX = e.clientX;
        gen4DragState.startY = e.clientY;
        gen4DragState.startVel = ch.velocity[si];
        gen4DragState.startTiming = ch.timing[si];
        gen4DragState.axis = null;
        gen4DragState.moved = false;
        gen4DragState.suppressClick = false;
        e.preventDefault();
      });

      stepsEl.appendChild(btn);
    }

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'drum-mute-btn';
    muteBtn.classList.toggle('muted', ch.muted);
    muteBtn.textContent = 'M';
    muteBtn.title = ch.muted ? 'Unmute channel' : 'Mute channel';
    muteBtn.setAttribute('aria-label', `Mute ${def.label}`);
    muteBtn.setAttribute('aria-pressed', String(ch.muted));
    gen4MuteBtns[ci] = muteBtn;
    muteBtn.addEventListener('click', () => {
      gen4SetChannelMuted(ci, !ch.muted);
    });

    const actions = document.createElement('div');
    actions.className = 'drum-row-actions';
    if (def.id !== 'osc') {
      const fxBtn = document.createElement('button');
      fxBtn.type = 'button';
      fxBtn.className = 'drum-fx-btn';
      fxBtn.classList.toggle('active', ch.fxSend);
      fxBtn.textContent = 'FX';
      fxBtn.title = 'Send to FX chain — click to bypass the drum effects';
      gen4FxSendBtns[ci] = fxBtn;
      fxBtn.addEventListener('click', () => {
        if (gen4EditorMode === 'locks' && gen4LockSelection?.ci === ci) {
          const locks = ch.locks[gen4LockSelection.si];
          locks._fxSend = Object.hasOwn(locks, '_fxSend') ? !locks._fxSend : !ch.fxSend;
          gen4ApplyStepBtn(ci, gen4LockSelection.si);
          refreshGen4LockEditor();
          return;
        }
        gen4SetChannelFxSend(ci, !ch.fxSend);
      });
      actions.appendChild(fxBtn);
    }
    actions.appendChild(muteBtn);

    row.append(lbl, stepsEl, actions);
    row.classList.toggle('channel-muted', ch.muted);
    grid.appendChild(row);
  });

  panel.appendChild(grid);
  panel.appendChild(buildGen4NoteEditor());

  // Param sections (one per channel, collapsed by default)
  const paramsWrap = document.createElement('div');
  paramsWrap.className = 'drum-params';

  GEN4_DEFS.forEach((def, ci) => {
    if (def.paramDefs.length === 0) return;
    const ch = GEN4.channels[ci];
    const { section, header, content, toggle, setCollapsed } = createFxSection(
      def.label,
      'drum-param-section',
    );
    section.querySelector('.fx-section-label').style.color = def.color;
    const presetSelect = buildGen4PresetSelect(ci);
    if (presetSelect) header.insertBefore(presetSelect, toggle);
    setCollapsed(true);
    gen4ParamSections.set(ci, { section, setCollapsed });

    const controls = document.createElement('div');
    controls.className = 'gen-controls';
    controls.style.setProperty('--gen-accent', def.color);

    def.paramDefs.forEach((p) => {
      const ctrl = makeControlRow(
        p,
        ch.params[p.key],
        (v) => {
          if (gen4EditorMode === 'locks' && gen4LockSelection?.ci === ci) {
            const locks = ch.locks[gen4LockSelection.si];
            locks[p.key] = v;
            ctrl.classList.add('parameter-locked');
            gen4ApplyStepBtn(ci, gen4LockSelection.si);
            refreshGen4LockEditor();
            return;
          }
          markGen4PresetCustom(ci);
          ch.params[p.key] = v;
          if (p.key === 'tune' || p.key === 'tone') {
            for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
            if (ci === gen4SelectedNoteChannel && gen4EditorMode === 'notes') {
              for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
            }
          }
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
  refreshGen4NoteEditor();
  refreshGen4VariationUI();
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

const FX_PRESETS = {
  beatrepeat: [
    {
      name: 'Off',
      values: {
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
    },
    {
      name: 'Tight Stutter',
      values: {
        interval: 0.25,
        sync: true,
        syncIndex: 2,
        grid: 63,
        gridSync: true,
        gridSyncIndex: 1,
        gate: 4,
        pitch: 0,
        decay: 0.82,
        chance: 1,
        mix: 0.62,
      },
    },
    {
      name: 'Pitch Scatter',
      values: {
        interval: 0.5,
        sync: true,
        syncIndex: 4,
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2,
        gate: 6,
        pitch: 12,
        decay: 0.7,
        chance: 0.62,
        mix: 0.7,
      },
    },
    {
      name: 'Tape Stop',
      values: {
        interval: 1,
        sync: true,
        syncIndex: 6,
        grid: 250,
        gridSync: true,
        gridSyncIndex: 3,
        gate: 8,
        pitch: -12,
        decay: 0.58,
        chance: 1,
        mix: 0.78,
      },
    },
  ],
  delay: [
    {
      name: 'Off',
      values: { time: 0.3, feedback: 0.35, hp: 20, mix: 0, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Slapback',
      values: { time: 0.12, feedback: 0.18, hp: 120, mix: 0.28, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Dub Echo',
      values: { time: 0.375, feedback: 0.72, hp: 350, mix: 0.45, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Ping Pong',
      values: { time: 0.5, feedback: 0.65, hp: 180, mix: 0.42, sync: true, syncIndex: 4, mode: 'pingpong' },
    },
  ],
  filter: [
    { name: 'Off', values: { mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 } },
    { name: 'Warm Low-pass', values: { mode: 'lowpass', cutoff: 1600, q: 0.9, mix: 1 } },
    { name: 'Telephone', values: { mode: 'bandpass', cutoff: 1400, q: 1.4, mix: 0.9 } },
    { name: 'Resonant High-pass', values: { mode: 'highpass', cutoff: 480, q: 7, mix: 0.8 } },
  ],
  bitreduce: [
    { name: 'Off', values: { bits: 8, rate: 1, mix: 0 } },
    { name: '12-bit', values: { bits: 12, rate: 0.72, mix: 0.35 } },
    { name: 'Crunchy', values: { bits: 8, rate: 0.35, mix: 0.6 } },
    { name: 'Destroyed', values: { bits: 4, rate: 0.08, mix: 0.85 } },
  ],
  sat: [
    { name: 'Off', values: { drive: 0.3, mix: 0 } },
    { name: 'Warm', values: { drive: 0.18, mix: 0.35 } },
    { name: 'Driven', values: { drive: 0.5, mix: 0.65 } },
    { name: 'Hard Clip', values: { drive: 0.88, mix: 0.9 } },
  ],
  reverb: [
    { name: 'Off', values: { size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 } },
    { name: 'Room', values: { size: 0.7, decay: 1.3, predelay: 0.008, damping: 0.65, mix: 0.25 } },
    { name: 'Hall', values: { size: 2.8, decay: 4.8, predelay: 0.025, damping: 0.45, mix: 0.38 } },
    { name: 'Cavern', values: { size: 5, decay: 7, predelay: 0.06, damping: 0.3, mix: 0.5 } },
  ],
  limiter: [
    {
      name: 'Balanced',
      values: { threshold: -8, attack: 0.003, release: 0.12, ratio: 20, knee: 0, output: 0.96 },
    },
    {
      name: 'Gentle',
      values: { threshold: -4, attack: 0.01, release: 0.2, ratio: 6, knee: 8, output: 0.96 },
    },
    {
      name: 'Loud',
      values: { threshold: -12, attack: 0.002, release: 0.12, ratio: 20, knee: 2, output: 0.98 },
    },
    {
      name: 'Maximizer',
      values: { threshold: -10, attack: 0.001, release: 0.08, ratio: 40, knee: 1, output: 1.2 },
    },
    {
      name: 'Brickwall',
      values: { threshold: -18, attack: 0.001, release: 0.06, ratio: 40, knee: 0, output: 0.95 },
    },
  ],
};

// Per-instrument FX buses. Each instrument (granular 1/2, synth, drums) owns an
// independent effect chain; one instrument is "active" and its chain is shown and
// edited in the FX column. All bus outputs sum into a single global master limiter.
const FX_BUS_IDS = ['gen0', 'gen1', 'gen3', 'gen4'];
const FX_BUS_LABELS = { gen0: 'Granular 1', gen1: 'Granular 2', gen3: 'Synth', gen4: 'Drums' };
const INSTRUMENT_MIX = Object.fromEntries(
  FX_BUS_IDS.map((busId) => [busId, { muted: false, solo: false }]),
);
const instrumentMixButtons = new Map();

function refreshInstrumentMixUI() {
  const hasSolo = FX_BUS_IDS.some((busId) => INSTRUMENT_MIX[busId].solo);
  FX_BUS_IDS.forEach((busId) => {
    const mix = INSTRUMENT_MIX[busId];
    const buttons = instrumentMixButtons.get(busId);
    buttons?.mute.classList.toggle('active', mix.muted);
    buttons?.solo.classList.toggle('active', mix.solo);
    buttons?.mute.setAttribute('aria-pressed', mix.muted ? 'true' : 'false');
    buttons?.solo.setAttribute('aria-pressed', mix.solo ? 'true' : 'false');

    const panel = document.querySelector(`#generators [data-bus="${busId}"]`);
    panel?.classList.toggle('instrument-muted', mix.muted);
    panel?.classList.toggle('instrument-soloed', mix.solo);
    panel?.classList.toggle('instrument-silent', mix.muted || (hasSolo && !mix.solo));
  });
}

function applyInstrumentMixState() {
  const hasSolo = FX_BUS_IDS.some((busId) => INSTRUMENT_MIX[busId].solo);
  FX_BUS_IDS.forEach((busId) => {
    const mix = INSTRUMENT_MIX[busId];
    const audible = !mix.muted && (!hasSolo || mix.solo);
    const output = fxBuses[busId]?.output;
    if (output && audioCtx) {
      output.gain.setTargetAtTime(audible ? 1 : 0, audioCtx.currentTime, 0.01);
    }
  });
  refreshInstrumentMixUI();
}

function buildInstrumentMixControls(busId) {
  const controls = document.createElement('div');
  controls.className = 'instrument-mix-controls';

  const solo = document.createElement('button');
  solo.type = 'button';
  solo.className = 'instrument-mix-btn instrument-solo-btn';
  solo.textContent = 'S';
  solo.title = `Solo ${FX_BUS_LABELS[busId]}`;
  solo.setAttribute('aria-label', `Solo ${FX_BUS_LABELS[busId]}`);
  solo.setAttribute('aria-pressed', 'false');
  solo.addEventListener('click', (event) => {
    event.stopPropagation();
    INSTRUMENT_MIX[busId].solo = !INSTRUMENT_MIX[busId].solo;
    applyInstrumentMixState();
  });

  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'instrument-mix-btn instrument-mute-btn';
  mute.textContent = 'M';
  mute.title = `Mute ${FX_BUS_LABELS[busId]}`;
  mute.setAttribute('aria-label', `Mute ${FX_BUS_LABELS[busId]}`);
  mute.setAttribute('aria-pressed', 'false');
  mute.addEventListener('click', (event) => {
    event.stopPropagation();
    INSTRUMENT_MIX[busId].muted = !INSTRUMENT_MIX[busId].muted;
    applyInstrumentMixState();
  });

  controls.append(solo, mute);
  instrumentMixButtons.set(busId, { solo, mute });
  return controls;
}

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
const songBlockEls = new Map(); // entry id → block element
let songPlayBtnEl = null;
let songAddBtnEl = null;
let songPlayheadRendered = { entryIdx: -2, repeat: -2 };

function createGen4PatternData(stepCount = 16) {
  return {
    stepCount,
    channels: GEN4_DEFS.map(() => ({
      steps: new Array(32).fill(false),
      notes: new Array(32).fill(null),
      velocity: new Array(32).fill(1.0),
      timing: new Array(32).fill(0),
      locks: Array.from({ length: 32 }, () => ({})),
      stutter: new Array(32).fill(1),
      probability: new Array(32).fill(1.0),
    })),
  };
}

function cloneGen4Pattern(pattern) {
  const clone = createGen4PatternData(pattern?.stepCount || 16);
  clone.channels.forEach((channel, ci) => {
    const source = pattern?.channels?.[ci];
    if (!source) return;
    channel.steps = [...source.steps];
    channel.notes = [...source.notes];
    channel.velocity = [...source.velocity];
    channel.timing = [...source.timing];
    channel.locks = source.locks.map((locks) => ({ ...locks }));
    channel.stutter = [...source.stutter];
    channel.probability = [...source.probability];
  });
  return clone;
}

function serializeGen4Pattern(pattern) {
  if (!pattern) return null;
  return {
    stepCount: pattern.stepCount,
    channels: pattern.channels.map((channel) => ({
      steps: [...channel.steps],
      notes: [...channel.notes],
      velocity: [...channel.velocity],
      timing: [...channel.timing],
      locks: channel.locks.map((locks) => ({ ...locks })),
      stutter: [...channel.stutter],
      probability: [...channel.probability],
    })),
  };
}

function deserializeGen4Pattern(data) {
  const stepCount = [12, 15, 16, 32].includes(data?.stepCount) ? data.stepCount : 16;
  const pattern = createGen4PatternData(stepCount);
  (data?.channels || []).forEach((saved, ci) => {
    const channel = pattern.channels[ci];
    const def = GEN4_DEFS[ci];
    if (!channel || !saved || !def) return;
    if (Array.isArray(saved.steps))
      saved.steps.slice(0, 32).forEach((value, si) => (channel.steps[si] = !!value));
    if (Array.isArray(saved.notes))
      saved.notes.slice(0, 32).forEach((value, si) => {
        channel.notes[si] = Number.isFinite(value) ? clamp(Math.round(value), 0, 127) : null;
      });
    if (Array.isArray(saved.velocity))
      saved.velocity
        .slice(0, 32)
        .forEach((value, si) => (channel.velocity[si] = clamp(value, 0.05, 1)));
    if (Array.isArray(saved.timing))
      saved.timing
        .slice(0, 32)
        .forEach((value, si) => (channel.timing[si] = clamp(Math.round(value), -4, 4)));
    if (Array.isArray(saved.locks))
      saved.locks.slice(0, 32).forEach((values, si) => {
        if (!values || typeof values !== 'object') return;
        def.paramDefs.forEach((pd) => {
          if (typeof values[pd.key] === 'number') {
            channel.locks[si][pd.key] = clamp(values[pd.key], pd.min, pd.max);
          }
        });
        if (typeof values._fxSend === 'boolean') channel.locks[si]._fxSend = values._fxSend;
      });
    if (Array.isArray(saved.stutter))
      saved.stutter
        .slice(0, 32)
        .forEach((value, si) => (channel.stutter[si] = clamp(Math.round(value), 1, 4)));
    if (Array.isArray(saved.probability))
      saved.probability
        .slice(0, 32)
        .forEach((value, si) => (channel.probability[si] = clamp(value, 0, 1)));
  });
  return pattern;
}

function ensureGen4Variations(loop) {
  if (!loop?.gen4) return;
  if (!Array.isArray(loop.gen4.variations)) {
    loop.gen4.variations = [
      { stepCount: loop.gen4.stepCount, channels: loop.gen4.channels },
      null,
      null,
    ];
    loop.gen4.activeVariation = 0;
  }
  while (loop.gen4.variations.length < 3) loop.gen4.variations.push(null);
  loop.gen4.activeVariation = clamp(Math.round(loop.gen4.activeVariation || 0), 0, 2);
  loop.gen4.variations[loop.gen4.activeVariation] = {
    stepCount: loop.gen4.stepCount,
    channels: loop.gen4.channels,
  };
}

function generateGen4Variation(source, intensity = 1) {
  const pattern = cloneGen4Pattern(source);
  pattern.channels.forEach((channel) => {
    for (let si = 0; si < pattern.stepCount; si++) {
      if (!channel.steps[si]) continue;
      channel.velocity[si] = clamp(
        channel.velocity[si] * (0.82 + Math.random() * 0.26),
        0.05,
        1,
      );
      if (Math.random() < 0.12 * intensity) channel.probability[si] = intensity > 1 ? 0.5 : 0.75;
      if (Math.random() < 0.08 * intensity) channel.stutter[si] = intensity > 1 ? 3 : 2;
    }
  });
  return pattern;
}

function generateGen4Fill(source) {
  const pattern = cloneGen4Pattern(source);
  const start = Math.max(0, pattern.stepCount - 4);
  pattern.channels.forEach((channel, ci) => {
    const id = GEN4_DEFS[ci].id;
    if (id === 'kick' || id === 'osc') return;
    for (let si = start; si < pattern.stepCount; si++) {
      if (!channel.steps[si] && Math.random() < 0.62) channel.steps[si] = true;
      if (!channel.steps[si]) continue;
      channel.velocity[si] = clamp(0.55 + Math.random() * 0.4, 0.05, 1);
      channel.timing[si] = Math.floor(Math.random() * 3) - 1;
      channel.probability[si] = 1;
      if (si >= pattern.stepCount - 2 && Math.random() < 0.55) {
        channel.stutter[si] = 2 + Math.floor(Math.random() * 3);
      }
    }
  });
  return pattern;
}

function createLoopData(name) {
  do {
    LOOPS.counter += 1;
  } while (LOOPS.list.some((l) => l.id === `loop-${LOOPS.counter}`));
  const pattern = createGen4PatternData(16);
  const loop = {
    id: `loop-${LOOPS.counter}`,
    name,
    // New loops inherit the sound currently on the granulators, so switching
    // to a fresh loop never jumps the audio; freeze stays engine state.
    gens: [{ ...state[0], freeze: false }, { ...state[1], freeze: false }],
    gen4: {
      stepCount: pattern.stepCount,
      swing: 0,
      channels: pattern.channels,
    },
    gen3: { lockedMidis: new Set() },
    seq: {
      steps: Array.from({ length: 16 }, () => 0),
      subdivision: 16,
      stepBeats: 0.25,
    },
  };
  ensureGen4Variations(loop);
  return loop;
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
      gens: [state[0], state[1]],
      gen4: {
        stepCount: GEN4.stepCount,
        swing: 0,
        channels: GEN4.channels.map((ch) => ({
          steps: ch.steps,
          notes: ch.notes,
          velocity: ch.velocity,
          timing: ch.timing,
          locks: ch.locks,
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
  ensureGen4Variations(LOOPS.list[0]);
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

function refreshGen4VariationUI() {
  const loop = getEditLoop();
  const active = loop?.gen4?.activeVariation || 0;
  gen4VariationBtns.forEach((btn, index) => btn.classList.toggle('active', index === active));
  if (gen4FillBtn) gen4FillBtn.classList.toggle('active', gen4FillState.active);
}

function setGen4Variation(index) {
  const loop = getEditLoop();
  if (!loop || index < 0 || index > 2) return;
  ensureGen4Variations(loop);
  const currentIndex = loop.gen4.activeVariation;
  if (index === currentIndex) return;
  if (gen4FillState.active) clearGen4Fill();
  loop.gen4.variations[currentIndex] = {
    stepCount: loop.gen4.stepCount,
    channels: loop.gen4.channels,
  };
  if (!loop.gen4.variations[index]) {
    loop.gen4.variations[index] = generateGen4Variation(
      loop.gen4.variations[0],
      index === 1 ? 1 : 1.8,
    );
  }
  const pattern = loop.gen4.variations[index];
  loop.gen4.activeVariation = index;
  loop.gen4.stepCount = pattern.stepCount;
  loop.gen4.channels = pattern.channels;
  gen4LockSelection = null;
  bindEditLoop();
  refreshGen4VariationUI();
}

let gen4VariationMenuEl = null;

function closeGen4VariationMenu() {
  if (!gen4VariationMenuEl) return;
  gen4VariationMenuEl.remove();
  gen4VariationMenuEl = null;
}

function regenerateGen4Variation(index) {
  const loop = getEditLoop();
  if (!loop || index < 1 || index > 2) return;
  ensureGen4Variations(loop);
  if (gen4FillState.active) clearGen4Fill();
  loop.gen4.variations[index] = generateGen4Variation(
    loop.gen4.variations[0],
    index === 1 ? 1 : 1.8,
  );
  if (loop.gen4.activeVariation === index) {
    const pattern = loop.gen4.variations[index];
    loop.gen4.stepCount = pattern.stepCount;
    loop.gen4.channels = pattern.channels;
    gen4LockSelection = null;
    bindEditLoop();
  }
  setStatus(`variation ${index === 1 ? 'B' : 'C'} generated again`);
  refreshGen4VariationUI();
}

function openGen4VariationMenu(index, x, y) {
  closeGen4VariationMenu();
  closeKnobContextMenu();
  closeModSourceMenu();

  const menu = document.createElement('div');
  menu.className = 'mod-source-menu knob-context-menu';
  gen4VariationMenuEl = menu;

  const title = document.createElement('div');
  title.className = 'mod-source-menu-title';
  title.textContent = `Variation ${index === 1 ? 'B' : 'C'}`;

  const generateBtn = document.createElement('button');
  generateBtn.type = 'button';
  generateBtn.className = 'mod-source-option knob-context-option';
  generateBtn.textContent = 'Generate again';
  generateBtn.addEventListener('click', () => {
    regenerateGen4Variation(index);
    closeGen4VariationMenu();
  });

  menu.append(title, generateBtn);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

window.addEventListener('pointerdown', (event) => {
  if (gen4VariationMenuEl && !gen4VariationMenuEl.contains(event.target)) {
    closeGen4VariationMenu();
  }
});

function clearGen4Fill() {
  gen4FillState.active = false;
  gen4FillState.loopId = null;
  gen4FillState.pattern = null;
  refreshGen4VariationUI();
}

function toggleGen4Fill() {
  if (gen4FillState.active) {
    clearGen4Fill();
    return;
  }
  const loop = getSchedulerLoop() || getEditLoop();
  if (!loop) return;
  gen4FillState.active = true;
  gen4FillState.loopId = loop.id;
  gen4FillState.pattern = generateGen4Fill(loop.gen4);
  refreshGen4VariationUI();
}

function getGen4PlaybackPattern(loop) {
  if (gen4FillState.active && gen4FillState.loopId === loop?.id && gen4FillState.pattern) {
    return gen4FillState.pattern;
  }
  return loop?.gen4;
}

function serializeLoop(loop) {
  ensureGen4Variations(loop);
  return {
    id: loop.id,
    name: loop.name,
    gens: loop.gens.map((g) => ({ ...g })),
    gen4: {
      stepCount: loop.gen4.stepCount,
      swing: loop.gen4.swing || 0,
      channels: serializeGen4Pattern(loop.gen4).channels,
      activeVariation: loop.gen4.activeVariation,
      variations: loop.gen4.variations.map(serializeGen4Pattern),
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
  // Legacy loops (saved before per-loop gen params) keep the seed from
  // createLoopData — the sound that was global when the preset was made.
  if (Array.isArray(data?.gens)) {
    data.gens.slice(0, 2).forEach((saved, gi) => {
      if (saved && typeof saved === 'object') {
        Object.assign(loop.gens[gi], saved, { freeze: false });
      }
    });
  }
  const g4 = data?.gen4;
  const activePattern = deserializeGen4Pattern(g4);
  loop.gen4.stepCount = activePattern.stepCount;
  loop.gen4.channels = activePattern.channels;
  if (typeof g4?.swing === 'number') loop.gen4.swing = clamp(g4.swing, 0, 1);
  if (Array.isArray(g4?.variations)) {
    loop.gen4.variations = g4.variations.slice(0, 3).map((saved) =>
      saved && typeof saved === 'object' ? deserializeGen4Pattern(saved) : null,
    );
    while (loop.gen4.variations.length < 3) loop.gen4.variations.push(null);
    loop.gen4.activeVariation = clamp(Math.round(g4.activeVariation || 0), 0, 2);
    if (!loop.gen4.variations[loop.gen4.activeVariation]) {
      loop.gen4.activeVariation = 0;
    }
    if (!loop.gen4.variations[0]) loop.gen4.variations[0] = activePattern;
    const selectedPattern = loop.gen4.variations[loop.gen4.activeVariation] || activePattern;
    loop.gen4.stepCount = selectedPattern.stepCount;
    loop.gen4.channels = selectedPattern.channels;
  } else {
    loop.gen4.variations = [activePattern, null, null];
    loop.gen4.activeVariation = 0;
  }
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
        notes: ch?.notes,
        velocity: ch?.velocity,
        timing: ch?.timing,
        locks: ch?.locks,
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
  for (let gi = 0; gi < 2; gi++) {
    const gens = loop.gens[gi];
    gens.freeze = state[gi].freeze; // freeze follows the engine, not the loop
    state[gi] = gens;
    refreshGeneratorUI(gi);
    // Re-run the position setter so the waveform playhead tracks the bound value.
    setGeneratorParam(gi, 'positionSec', gens.positionSec, { send: false });
    sendParams(gi);
  }
  GEN4.channels.forEach((ch, ci) => {
    const pat = loop.gen4.channels[ci];
    ch.steps = pat.steps;
    ch.notes = pat.notes;
    ch.velocity = pat.velocity;
    ch.timing = pat.timing;
    ch.locks = pat.locks;
    ch.stutter = pat.stutter;
    ch.probability = pat.probability;
  });
  const sustainChordShouldFollowEditLoop =
    GEN3.sustainMode &&
    !!GEN3.nodes &&
    (GEN4.playing || GEN3.activeNotes.size > 0) &&
    !(PLAY.mode === 'song' && GEN4.playing);
  GEN3.lockedMidis = loop.gen3.lockedMidis;
  STEP_SEQ.steps = loop.seq.steps;
  STEP_SEQ.subdivision = loop.seq.subdivision;
  STEP_SEQ.stepBeats = loop.seq.stepBeats;
  STEP_SEQ.currentStep = Math.min(STEP_SEQ.currentStep, getSeqActiveStepCount() - 1);
  STEP_SEQ.currentValue = STEP_SEQ.steps[STEP_SEQ.currentStep] || 0;

  gen4SetStepCount(loop.gen4.stepCount, { duplicateOnExpand: false });
  refreshGen4SwingUI();
  refreshGen4VariationUI();
  GEN4.channels.forEach((_, ci) => {
    for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
  });
  gen4RefreshStepDisplay();
  if (gen4EditorMode === 'notes') refreshGen4NoteEditor();
  if (gen4EditorMode === 'locks') refreshGen4LockEditor();

  if (sustainChordShouldFollowEditLoop) syncGen3SustainChord(GEN3.lockedMidis);
  refreshGen3KeyStates();
  refreshSequencerUI();
  refreshBackPanelState();
  applyMappedModulationTargets();
}

function selectEditLoop(index) {
  if (index < 0 || index >= LOOPS.list.length) return;
  if (index !== LOOPS.editIndex) {
    LOOPS.editIndex = index;
    gen4LockSelection = null;
    if (gen4FillState.active && PLAY.mode === 'loop') clearGen4Fill();
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

async function deleteLoop(index) {
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
  if (!(await appConfirm(msg, { confirmLabel: 'Delete', danger: true }))) return;
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
    } else {
      // Follow off: the edit binding stays put, so push the new audible
      // loop's gen sound to the worklet directly.
      sendParams(0);
      sendParams(1);
    }
    const audibleLoop = getAudibleLoop();
    if (audibleLoop) syncGen3SustainChord(audibleLoop.gen3.lockedMidis);
  }
  renderSongPlayhead(audible.repeat);
}

function renderSongPlayhead(repeat = -1) {
  const entryIdx = SONG.audibleEntryIdx;
  if (songPlayheadRendered.entryIdx === entryIdx && songPlayheadRendered.repeat === repeat) return;
  songPlayheadRendered = { entryIdx, repeat };
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
}

function isTransportOn() {
  return GEN4.playing || (started && audioCtx?.state === 'running');
}

function refreshSongTransportUI() {
  if (!songPlayBtnEl) return;
  const on = isTransportOn();
  songPlayBtnEl.textContent = on ? '◼' : '▶';
  songPlayBtnEl.title =
    (on ? 'Stop' : PLAY.mode === 'song' ? 'Play the song' : 'Play the loop') + ' (space)';
  songPlayBtnEl.classList.toggle('active', on);
}

// The single transport control: ▶ boots the whole engine (granular worklet,
// mic capture when a mic source is selected, drum nodes) and starts the
// sequencer; ◼ stops the sequencer and suspends the audio context so
// everything falls silent while keeping all state for the next ▶.
async function stripPlayToggle() {
  if (isTransportOn()) {
    stopGen4Sequencer();
    stopAllGen3Notes();
    if (audioCtx && audioCtx.state === 'running') await audioCtx.suspend();
    setStatus('stopped');
  } else {
    await ensureTransportEngine();
    if (!started) await start();
    startGen4Sequencer();
    setStatus('playing');
  }
  refreshSongTransportUI();
}

function initStripPlayBtn() {
  songPlayBtnEl = document.getElementById('stripPlayBtn');
  songPlayBtnEl?.addEventListener('click', stripPlayToggle);
  refreshSongTransportUI();
}

// ── Settings modal (input device, mic gate, shortcuts) ──

function getSettingsModal() {
  return document.getElementById('settingsMenu');
}

function closeSettingsMenu() {
  const modal = getSettingsModal();
  if (modal?.open) modal.close();
}

function initSettingsMenu() {
  const modal = getSettingsModal();
  const btn = document.getElementById('settingsMenuBtn');
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.value = document.documentElement.dataset.theme || 'original';
    themeSelect.addEventListener('change', () => setAppTheme(themeSelect.value));
  }
  btn?.addEventListener('click', () => {
    modal?.open ? modal.close() : modal?.showModal();
    btn.classList.toggle('open', !!modal?.open);
  });
  // A click on the ::backdrop reports the dialog itself as target.
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) modal.close();
  });
  modal?.addEventListener('close', () => btn?.classList.remove('open'));
}

// ── In-app confirm dialog ── replaces window.confirm so destructive actions
// keep the app's look instead of raising the browser's native modal.

let confirmDialogResolve = null;

function appConfirm(message, { confirmLabel = 'OK', danger = false } = {}) {
  const dialog = document.getElementById('confirmDialog');
  if (!dialog?.showModal) return Promise.resolve(window.confirm(message));
  const msgEl = document.getElementById('confirmDialogMsg');
  const okBtn = document.getElementById('confirmDialogOk');
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
    if (msgEl) msgEl.textContent = message;
    if (okBtn) {
      okBtn.textContent = confirmLabel;
      okBtn.classList.toggle('danger', danger);
    }
    dialog.showModal();
    okBtn?.focus();
  });
}

function settleConfirmDialog(result) {
  const resolve = confirmDialogResolve;
  confirmDialogResolve = null;
  const dialog = document.getElementById('confirmDialog');
  if (dialog?.open) dialog.close();
  resolve?.(result);
}

function initConfirmDialog() {
  const dialog = document.getElementById('confirmDialog');
  if (!dialog) return;
  document
    .getElementById('confirmDialogOk')
    ?.addEventListener('click', () => settleConfirmDialog(true));
  document
    .getElementById('confirmDialogCancel')
    ?.addEventListener('click', () => settleConfirmDialog(false));
  // Esc lands here as a native close; settle already ran for button clicks.
  dialog.addEventListener('close', () => {
    const resolve = confirmDialogResolve;
    confirmDialogResolve = null;
    resolve?.(false);
  });
  // A click on the ::backdrop reports the dialog itself as target.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) settleConfirmDialog(false);
  });
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
  // Switch seamlessly while playing: the step grid (nextStepTime) is left
  // untouched so the tempo never hiccups — only what gets scheduled changes.
  if (GEN4.playing && mode === 'song' && SONG.entries.length === 0) stopGen4Sequencer();
  PLAY.mode = mode;
  if (GEN4.playing) {
    if (mode === 'song') {
      SONG.cursor.entryIdx = 0;
      SONG.cursor.repeat = 0;
      SONG.audibleEntryIdx = -1;
    } else {
      SONG.audibleEntryIdx = -1;
      renderSongPlayhead();
      sendParams(0);
      sendParams(1);
    }
  }
  const lane = document.getElementById('songLane');
  if (lane) lane.hidden = mode !== 'song';
  refreshModeToggleUI();
  refreshSongTransportUI();
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

// Vertical trackpad/wheel motion pans a horizontal strip; native horizontal
// deltas pass through untouched. Guarded so re-renders don't stack listeners.
function attachStripWheelPan(el) {
  if (!el || el.dataset.wheelPan) return;
  el.dataset.wheelPan = '1';
  el.addEventListener(
    'wheel',
    (e) => {
      if (e.altKey) return; // ⌥ scroll fine-tunes repeats on song blocks
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
}

function renderLoopsBar() {
  const bar = document.getElementById('loopsBar');
  if (!bar) return;
  attachStripWheelPan(bar);
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
    badge.title = 'Repeats — click to cycle, ⌥ scroll to fine-tune';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const pos = SONG_REPEAT_CYCLE.indexOf(entry.repeats);
      const nextRepeats =
        pos >= 0
          ? SONG_REPEAT_CYCLE[(pos + 1) % SONG_REPEAT_CYCLE.length]
          : SONG_REPEAT_CYCLE[0];
      setSongEntryRepeats(entry.id, nextRepeats);
    });

    block.title = `${loop?.name ?? '?'} — right-click: cycles / remove · ⌥ scroll: ±1 cycle`;
    block.addEventListener('click', () => {
      const idx = LOOPS.list.findIndex((l) => l.id === entry.loopId);
      if (idx >= 0) selectEditLoop(idx);
    });
    block.addEventListener('wheel', (e) => {
      // Plain scrolling pans the strip (see attachStripWheelPan) — only a
      // deliberate ⌥ scroll edits repeats, so panning across blocks can't
      // mutate them.
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
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
  attachStripWheelPan(blocksWrap);
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

// ── Knob context menu ──

let knobContextMenuEl = null;

function closeKnobContextMenu() {
  if (!knobContextMenuEl) return;
  knobContextMenuEl.remove();
  knobContextMenuEl = null;
}

function copyGeneratorParamToOtherLoops(genIdx, key) {
  const source = state[genIdx];
  const editLoop = getEditLoop();
  const keys =
    key === 'grainSizeMs'
      ? [key, 'grainSizeSync', 'grainSizeSyncIndex']
      : key === 'density'
        ? [key, 'densitySync', 'densitySyncIndex']
        : [key];
  let copied = 0;

  LOOPS.list.forEach((loop) => {
    if (loop === editLoop || !loop.gens?.[genIdx]) return;
    keys.forEach((paramKey) => {
      loop.gens[genIdx][paramKey] = source[paramKey];
    });
    copied += 1;
  });

  setStatus(copied > 0 ? `copied to ${copied} other loop${copied === 1 ? '' : 's'}` : 'no other loops');
}

function openKnobContextMenu(target, x, y) {
  closeKnobContextMenu();
  closeModSourceMenu();

  const menu = document.createElement('div');
  menu.className = 'mod-source-menu knob-context-menu';
  knobContextMenuEl = menu;

  const title = document.createElement('div');
  title.className = 'mod-source-menu-title';
  title.textContent = target.label;

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'mod-source-option knob-context-option';
  copyBtn.textContent = 'Copy to other loops';
  copyBtn.disabled = LOOPS.list.length < 2;
  copyBtn.addEventListener('click', () => {
    copyGeneratorParamToOtherLoops(target.genIdx, target.key);
    closeKnobContextMenu();
  });

  menu.append(title, copyBtn);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
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
  closeKnobContextMenu();
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
  if (knobContextMenuEl && !knobContextMenuEl.contains(e.target)) closeKnobContextMenu();
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

function setTransportBpm(value, { refresh = true, updateField = true } = {}) {
  if (!Number.isFinite(value)) return;
  const decimals = (BPM_BOUNDS.step.toString().split('.')[1] || '').length;
  TRANSPORT.bpm = clamp(quantize(value, BPM_BOUNDS.step, decimals), BPM_BOUNDS.min, BPM_BOUNDS.max);
  const bpmInput = getBpmInput();
  // updateField false while the user is typing — rewriting mid-keystroke
  // would clamp "1" to "40" before they can finish "175".
  if (bpmInput && updateField) bpmInput.value = TRANSPORT.bpm.toFixed(decimals);
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

  // Ableton-style value drag: press anywhere on the box (the number included)
  // and drag vertically. The pointer is locked so the cursor disappears and
  // the drag never hits a screen edge; a plain click on the number still
  // focuses it for typing. Shift = fine (0.01/px), normal = 0.1/px.
  let armed = false; // pressed, not yet decided click-vs-drag
  let dragging = false;
  let dragBpm = 0; // unquantized accumulator — keeps sub-step motion smooth
  let downY = 0;

  // The number is readonly until double-clicked, so the box is one drag
  // surface (no text cursor, no accidental selection); Enter/blur commits
  // typing and re-arms the drag.
  if (bpmInput) {
    bpmInput.addEventListener('dblclick', () => {
      bpmInput.readOnly = false;
      bpmInput.focus();
      bpmInput.select();
    });
    bpmInput.addEventListener('blur', () => {
      bpmInput.readOnly = true;
      setTransportBpm(TRANSPORT.bpm);
    });
    bpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') bpmInput.blur();
    });
  }

  tempoBox.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (bpmInput && !bpmInput.readOnly) return; // typing mode — leave it alone
    e.preventDefault();
    armed = true;
    downY = e.clientY;
    dragBpm = TRANSPORT.bpm;
    tempoBox.setPointerCapture(e.pointerId);
  });

  tempoBox.addEventListener('pointermove', (e) => {
    if (!armed && !dragging) return;
    if (!dragging) {
      if (Math.abs(e.clientY - downY) < 3) return; // still a click
      dragging = true;
      armed = false;
      tempoBox.classList.add('dragging');
      bpmInput?.blur();
      tempoBox.requestPointerLock?.();
    }
    // movementY works locked and unlocked alike.
    dragBpm = clamp(
      dragBpm - e.movementY * (e.shiftKey ? 0.01 : 0.1),
      BPM_BOUNDS.min,
      BPM_BOUNDS.max,
    );
    setTransportBpm(dragBpm);
  });

  const endDrag = (e) => {
    armed = false;
    if (tempoBox.hasPointerCapture(e.pointerId)) tempoBox.releasePointerCapture(e.pointerId);
    if (!dragging) return;
    dragging = false;
    tempoBox.classList.remove('dragging');
    if (document.pointerLockElement === tempoBox) document.exitPointerLock();
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
  if (key === 'decay') return 'Decay';
  if (key === 'sustain') return 'Sustain';
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

// ── Mastering view ── a lazy fourth panel that polishes rendered audio
// (the song bounce or a loaded WAV). Nothing here touches the live graph:
// the DOM is built on first entry, preview runs on its own AudioContext
// (suspended on exit), and the final render happens in an OfflineAudioContext.
// While the view is closed the feature costs zero CPU.

const MASTERING = {
  built: false,
  source: null, // { left, right, sampleRate, name }
  params: {
    lowGain: 0,
    lowFreq: 120,
    lowQ: 0.7,
    lowDynThresh: 0,
    lowDynRange: 0,
    lowMidGain: 0,
    lowMidFreq: 350,
    lowMidQ: 1,
    lowMidDynThresh: 0,
    lowMidDynRange: 0,
    midGain: 0,
    midFreq: 900,
    midQ: 0.7,
    midDynThresh: 0,
    midDynRange: 0,
    highMidGain: 0,
    highMidFreq: 3000,
    highMidQ: 1,
    highMidDynThresh: 0,
    highMidDynRange: 0,
    highGain: 0,
    highFreq: 8000,
    highQ: 0.7,
    highDynThresh: 0,
    highDynRange: 0,
    compThreshold: -18,
    compRatio: 2,
    compAttack: 0.03,
    compRelease: 0.25,
    compMakeup: 0,
    optoReduction: 0,
    optoMakeup: 0,
    optoMode: '2a',
    tapeDrive: 0,
    tapeBump: 0,
    tapeRolloff: 20,
    tapeLevel: 0,
    excTune: 3000,
    excHarmonics: 0,
    excMix: 0,
    ottDepth: 0,
    ottTime: 1,
    ottIn: 0,
    ottOut: 0,
    ottLow: 0,
    ottMid: 0,
    ottHigh: 0,
    levelerGain: 0, // input trim — always the first thing the signal meets
    width: 1,
    widthBassFreq: 0, // 0 = full-range; raise it to keep lows mono when widening
    enabled: { eq: true, opto: true, comp: true, ott: true, tape: true, exciter: true, width: true, limit: true },
    drive: 0,
    ceiling: -1,
    outGain: 0,
    order: ['eq', 'opto', 'comp', 'ott', 'tape', 'exciter', 'width', 'limit'],
  },
  ctx: null, // preview AudioContext — created on demand, suspended on view exit
  preview: null, // { srcNode, chain, analysers, startAt, duration }
  previewBuffer: null, // AudioBuffer cache for the current source
  renderedPeaks: null, // decimated min/max envelope of the last offline render
  vizFrame: null, // rAF id — only ever set while preview is playing
  meterHover: null, // { x, y } in CSS px over the meter canvas, null when pointer is outside
  eqHover: null, // { x, y } in CSS px over the EQ canvas, null when pointer is outside
  eqBandIndex: 0,
  eqSolo: false,
  playheadSec: 0,
  loopMode: 'off', // off | section | all
  loopSelection: null, // { start, end } in seconds
  els: {},
};

const MASTERING_PEAK_BINS = 2048;

function buildMasteringPeaks(L, R) {
  const bins = Math.min(MASTERING_PEAK_BINS, L.length);
  const mins = new Float32Array(bins);
  const maxs = new Float32Array(bins);
  const per = L.length / bins;
  for (let b = 0; b < bins; b++) {
    let min = 1;
    let max = -1;
    const start = Math.floor(b * per);
    const end = Math.min(Math.floor((b + 1) * per), L.length);
    for (let i = start; i < end; i++) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    mins[b] = min > max ? 0 : min;
    maxs[b] = min > max ? 0 : max;
  }
  return { mins, maxs, bins };
}

const dbToLin = (db) => Math.pow(10, db / 20);

function setMasteringSource(left, right, sampleRate, name) {
  if (MASTERING.built) stopMasteringPreview({ preservePosition: false });
  MASTERING.source = { left, right, sampleRate, name: name || 'audio' };
  MASTERING.previewBuffer = null;
  MASTERING.renderedPeaks = null; // stale — belongs to the previous source
  MASTERING.playheadSec = 0;
  MASTERING.loopMode = 'off';
  MASTERING.loopSelection = null;
  if (MASTERING.built) {
    refreshMasteringSourceUI();
  }
}

const MASTERING_MODULE_IDS = ['eq', 'opto', 'comp', 'ott', 'tape', 'exciter', 'width', 'limit'];

// Keeps whatever saved order is valid and appends any modules it doesn't know
// yet, so an order saved before a module existed survives the upgrade.
function getMasteringOrder() {
  const saved = Array.isArray(MASTERING.params.order) ? MASTERING.params.order : [];
  const seen = new Set();
  const order = [];
  saved.concat(MASTERING_MODULE_IDS).forEach((id) => {
    if (MASTERING_MODULE_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  });
  return order;
}

// Chain shared by preview and offline render — ctx-agnostic node builder.
// Three modules (eq / comp / limit) wired in the user's order, output trim
// always last.
// Contexts whose audioWorklet has the dynamic-EQ module loaded. Await
// ensureMasteringEqModule(ctx) before the first buildMasteringChain on a ctx;
// if loading failed the builder silently falls back to static biquads.
const masteringEqModuleCtxs = new WeakSet();

async function ensureMasteringEqModule(ctx) {
  if (masteringEqModuleCtxs.has(ctx)) return;
  try {
    await Promise.all([
      ctx.audioWorklet.addModule(workletUrl('dynamic-eq-processor.js')),
      ctx.audioWorklet.addModule(workletUrl('ott-processor.js')),
    ]);
    masteringEqModuleCtxs.add(ctx);
  } catch (e) {}
}

function buildMasteringChain(ctx, { eqSolo = MASTERING.eqSolo, bypassAll = MASTERING.bypassAll } = {}) {
  // EQ: the dynamic-EQ worklet when its module is loaded on this ctx,
  // otherwise five static peaking biquads.
  let dynEq = null;
  let low = null;
  let lowMid = null;
  let mid = null;
  let highMid = null;
  let high = null;
  let eqInput;
  let eqTail;
  if (masteringEqModuleCtxs.has(ctx)) {
    dynEq = new AudioWorkletNode(ctx, 'dynamic-eq-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    if (ctx === MASTERING.ctx) {
      dynEq.port.onmessage = (e) => {
        if (e.data?.liveGains) {
          MASTERING.liveEqGains = e.data.liveGains;
          MASTERING.liveEqDirty = true;
        }
      };
    }
    eqInput = dynEq;
    eqTail = dynEq;
  } else {
    low = ctx.createBiquadFilter();
    low.type = 'peaking';
    lowMid = ctx.createBiquadFilter();
    lowMid.type = 'peaking';
    mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    highMid = ctx.createBiquadFilter();
    highMid.type = 'peaking';
    high = ctx.createBiquadFilter();
    high.type = 'peaking';
    low.connect(lowMid);
    lowMid.connect(mid);
    mid.connect(highMid);
    highMid.connect(high);
    eqInput = low;
    eqTail = high;
  }

  let eqOutput = eqTail;
  let eqAudition = null;
  if (eqSolo) {
    eqAudition = ctx.createBiquadFilter();
    eqAudition.type = 'bandpass';
    eqTail.connect(eqAudition);
    eqOutput = eqAudition;
  }

  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 6;
  const makeup = ctx.createGain();
  comp.connect(makeup);

  // Opto-style program compressor: slow attack, gentle ratio, huge soft knee.
  const optoComp = ctx.createDynamicsCompressor();
  const optoMakeup = ctx.createGain();
  optoComp.connect(optoMakeup);

  // Tape: drive into the kneed saturator (level-compensated so quiet material
  // stays unity), head-bump low shelf, HF rolloff, output trim.
  const tapeIn = ctx.createGain();
  const tapeShaper = ctx.createWaveShaper();
  tapeShaper.oversample = '4x';
  tapeShaper.curve = getMasteringClipCurve();
  const tapeComp = ctx.createGain();
  const tapeBump = ctx.createBiquadFilter();
  tapeBump.type = 'lowshelf';
  tapeBump.frequency.value = 80;
  const tapeRoll = ctx.createBiquadFilter();
  tapeRoll.type = 'lowpass';
  tapeRoll.Q.value = 0.7071;
  const tapeLevel = ctx.createGain();
  tapeIn.connect(tapeShaper);
  tapeShaper.connect(tapeComp);
  tapeComp.connect(tapeBump);
  tapeBump.connect(tapeRoll);
  tapeRoll.connect(tapeLevel);

  // Exciter: parallel high band → saturation → mixed back under the dry path.
  const excIn = ctx.createGain();
  const excSum = ctx.createGain();
  const excHp = ctx.createBiquadFilter();
  excHp.type = 'highpass';
  excHp.Q.value = 0.7071;
  const excDrive = ctx.createGain();
  const excShaper = ctx.createWaveShaper();
  excShaper.oversample = '4x';
  excShaper.curve = getMasteringTanhCurve();
  const excMix = ctx.createGain();
  excIn.connect(excSum); // dry
  excIn.connect(excHp);
  excHp.connect(excDrive);
  excDrive.connect(excShaper);
  excShaper.connect(excMix);
  excMix.connect(excSum);

  // Width: M/S matrix; the side signal is high-passed (bass stays mono),
  // scaled, and folded back: L' = M + w·S, R' = M − w·S.
  const widthIn = ctx.createGain();
  const widthSplit = ctx.createChannelSplitter(2);
  const midLIn = ctx.createGain();
  const midRIn = ctx.createGain();
  const sideLIn = ctx.createGain();
  const sideRIn = ctx.createGain();
  midLIn.gain.value = 0.5;
  midRIn.gain.value = 0.5;
  sideLIn.gain.value = 0.5;
  sideRIn.gain.value = -0.5;
  const widthMidSum = ctx.createGain();
  const widthSideSum = ctx.createGain();
  const widthSideHp = ctx.createBiquadFilter();
  widthSideHp.type = 'highpass';
  widthSideHp.Q.value = 0.7071;
  const widthPos = ctx.createGain();
  const widthNeg = ctx.createGain();
  const widthOutL = ctx.createGain();
  const widthOutR = ctx.createGain();
  const widthMerge = ctx.createChannelMerger(2);
  widthIn.connect(widthSplit);
  widthSplit.connect(midLIn, 0);
  widthSplit.connect(midRIn, 1);
  widthSplit.connect(sideLIn, 0);
  widthSplit.connect(sideRIn, 1);
  midLIn.connect(widthMidSum);
  midRIn.connect(widthMidSum);
  sideLIn.connect(widthSideSum);
  sideRIn.connect(widthSideSum);
  widthSideSum.connect(widthSideHp);
  widthSideHp.connect(widthPos);
  widthSideHp.connect(widthNeg);
  widthMidSum.connect(widthOutL);
  widthMidSum.connect(widthOutR);
  widthPos.connect(widthOutL);
  widthNeg.connect(widthOutR);
  widthOutL.connect(widthMerge, 0, 0);
  widthOutR.connect(widthMerge, 0, 1);

  // OTT: 3-band up/down compression worklet; a plain gain stands in (bit-
  // transparent, matching depth 0) if the worklet module isn't available.
  let ott = null;
  if (masteringEqModuleCtxs.has(ctx)) {
    ott = new AudioWorkletNode(ctx, 'ott-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  }
  const ottNode = ott || ctx.createGain();

  const drive = ctx.createGain();
  const preClip = ctx.createGain();
  const clip = ctx.createWaveShaper();
  clip.oversample = '4x';
  const postClip = ctx.createGain();
  drive.connect(preClip);
  preClip.connect(clip);
  clip.connect(postClip);

  const modules = {
    eq: { input: eqInput, output: eqOutput },
    ott: { input: ottNode, output: ottNode },
    opto: { input: optoComp, output: optoMakeup },
    comp: { input: comp, output: makeup },
    tape: { input: tapeIn, output: tapeLevel },
    exciter: { input: excIn, output: excSum },
    width: { input: widthIn, output: widthMerge },
    limit: { input: drive, output: postClip },
  };
  const out = ctx.createGain();
  const chainIn = ctx.createGain();
  // True bypass: disabled modules are left out of the path entirely. Global
  // bypass short-circuits everything — leveler included (chainIn stays at
  // unity via applyMasteringParams).
  const active = bypassAll
    ? []
    : getMasteringOrder().filter((id) => MASTERING.params.enabled?.[id] !== false);
  let prevOut = chainIn;
  active.forEach((id) => {
    prevOut.connect(modules[id].input);
    prevOut = modules[id].output;
  });
  prevOut.connect(out);

  const chain = {
    input: chainIn,
    output: out,
    bypassAll,
    nodes: {
      chainIn,
      low,
      lowMid,
      mid,
      highMid,
      high,
      eqAudition,
      dynEq,
      ott,
      optoComp,
      optoMakeup,
      comp,
      makeup,
      tapeIn,
      tapeShaper,
      tapeComp,
      tapeBump,
      tapeRoll,
      tapeLevel,
      excHp,
      excDrive,
      excMix,
      widthSideHp,
      widthPos,
      widthNeg,
      drive,
      preClip,
      clip,
      postClip,
      out,
    },
  };
  applyMasteringParams(chain);
  return chain;
}

let masteringTanhCurve = null;

function getMasteringTanhCurve() {
  if (!masteringTanhCurve) {
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(2 * x);
    }
    masteringTanhCurve = curve;
  }
  return masteringTanhCurve;
}

// Live reorder: keep the playing source, swap the chain behind it.
function rebuildMasteringPreviewChain() {
  const pv = MASTERING.preview;
  if (!pv || !MASTERING.ctx) return;
  try {
    pv.srcNode.disconnect();
    pv.chain.output.disconnect();
  } catch (e) {}
  const chain = buildMasteringChain(MASTERING.ctx);
  pv.srcNode.connect(chain.input);
  chain.output.connect(MASTERING.ctx.destination);
  if (pv.splitter) chain.output.connect(pv.splitter); // keep the spectrum fed
  if (MASTERING.meter?.tap) chain.output.connect(MASTERING.meter.tap); // and the LUFS/peak tap
  pv.chain = chain;
}

let masteringClipCurve = null;

function getMasteringClipCurve() {
  if (!masteringClipCurve) {
    // Unity gain (slope exactly 1) below the knee, tanh squash above it, so
    // program material under the ceiling passes untouched and only peaks
    // saturate. The WaveShaper clamps inputs beyond ±1 to the curve edge,
    // which caps the worst case just under the ceiling.
    const N = 4096;
    const curve = new Float32Array(N);
    const knee = 0.7; // ≈ −3 dB below the (normalized) ceiling
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      const ax = Math.abs(x);
      const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
      curve[i] = Math.sign(x) * y;
    }
    masteringClipCurve = curve;
  }
  return masteringClipCurve;
}

function applyMasteringParams(chain) {
  if (!chain) return;
  const p = MASTERING.params;
  const n = chain.nodes;
  if (n.chainIn) n.chainIn.gain.value = chain.bypassAll ? 1 : dbToLin(p.levelerGain);
  if (n.dynEq) {
    n.dynEq.port.postMessage({
      bands: MASTERING_EQ_BANDS.map((band) => ({
        freq: p[band.freqKey],
        gain: p[band.gainKey],
        q: p[band.qKey],
        thresh: p[band.threshKey],
        range: p[band.rangeKey],
      })),
    });
  } else if (n.low) {
    n.low.frequency.value = p.lowFreq;
    n.low.gain.value = p.lowGain;
    n.low.Q.value = p.lowQ;
    n.lowMid.frequency.value = p.lowMidFreq;
    n.lowMid.gain.value = p.lowMidGain;
    n.lowMid.Q.value = p.lowMidQ;
    n.mid.frequency.value = p.midFreq;
    n.mid.gain.value = p.midGain;
    n.mid.Q.value = p.midQ;
    n.highMid.frequency.value = p.highMidFreq;
    n.highMid.gain.value = p.highMidGain;
    n.highMid.Q.value = p.highMidQ;
    n.high.frequency.value = p.highFreq;
    n.high.gain.value = p.highGain;
    n.high.Q.value = p.highQ;
  }
  if (n.eqAudition) {
    const band = MASTERING_EQ_BANDS[MASTERING.eqBandIndex] || MASTERING_EQ_BANDS[0];
    n.eqAudition.frequency.value = p[band.freqKey];
    n.eqAudition.Q.value = p[band.qKey];
  }
  n.comp.threshold.value = p.compThreshold;
  n.comp.ratio.value = p.compRatio;
  n.comp.attack.value = p.compAttack;
  n.comp.release.value = p.compRelease;
  n.makeup.gain.value = dbToLin(p.compMakeup);
  if (n.optoComp) {
    // 2A: slow and creamy; 3A: a touch faster and firmer.
    const is3a = p.optoMode === '3a';
    n.optoComp.threshold.value = -p.optoReduction;
    n.optoComp.ratio.value = is3a ? 4 : 3;
    n.optoComp.attack.value = is3a ? 0.003 : 0.01;
    n.optoComp.release.value = is3a ? 0.3 : 0.6;
    n.optoComp.knee.value = is3a ? 10 : 18;
    n.optoMakeup.gain.value = dbToLin(p.optoMakeup);
  }
  if (n.tapeIn) {
    const driveLin = dbToLin(p.tapeDrive);
    n.tapeIn.gain.value = driveLin;
    n.tapeComp.gain.value = 1 / driveLin; // unity at low level, saturation on peaks
    n.tapeBump.gain.value = p.tapeBump;
    n.tapeRoll.frequency.value = Math.min(p.tapeRolloff * 1000, 20000);
    n.tapeLevel.gain.value = dbToLin(p.tapeLevel);
  }
  if (n.ott) {
    n.ott.port.postMessage({
      depth: p.ottDepth / 100,
      time: p.ottTime,
      inGain: p.ottIn,
      outGain: p.ottOut,
      bandGains: [p.ottLow, p.ottMid, p.ottHigh],
    });
  }
  if (n.excHp) {
    n.excHp.frequency.value = p.excTune;
    n.excDrive.gain.value = dbToLin(p.excHarmonics);
    n.excMix.gain.value = p.excMix / 100;
  }
  if (n.widthSideHp) {
    n.widthSideHp.frequency.value = Math.max(10, p.widthBassFreq);
    n.widthPos.gain.value = p.width;
    n.widthNeg.gain.value = -p.width;
  }
  n.drive.gain.value = dbToLin(p.drive);
  const ceil = dbToLin(p.ceiling);
  n.preClip.gain.value = 1 / ceil;
  n.clip.curve = getMasteringClipCurve();
  n.postClip.gain.value = ceil;
  n.out.gain.value = dbToLin(p.outGain);
}

function getMasteringDuration() {
  const s = MASTERING.source;
  return s ? s.left.length / s.sampleRate : 0;
}

function getMasteringLoopBounds() {
  const duration = getMasteringDuration();
  if (duration <= 0 || MASTERING.loopMode === 'off') return null;
  if (MASTERING.loopMode === 'all') return { start: 0, end: duration };
  const selection = MASTERING.loopSelection;
  if (!selection || selection.end - selection.start < 0.05) return null;
  return {
    start: clamp(selection.start, 0, duration),
    end: clamp(selection.end, 0, duration),
  };
}

function getMasteringPlayhead() {
  const pv = MASTERING.preview;
  const duration = getMasteringDuration();
  if (!pv || !MASTERING.ctx) return clamp(MASTERING.playheadSec, 0, duration);
  const elapsed = Math.max(0, MASTERING.ctx.currentTime - pv.startAt);
  let position;
  if (pv.loopEnd > pv.loopStart) {
    const length = pv.loopEnd - pv.loopStart;
    const relative = pv.offsetSec - pv.loopStart + elapsed;
    position = pv.loopStart + (((relative % length) + length) % length);
  } else {
    position = Math.min(pv.offsetSec + elapsed, pv.duration);
  }
  MASTERING.playheadSec = position;
  return position;
}

function updateMasteringTransportUI(position = MASTERING.playheadSec) {
  const duration = getMasteringDuration();
  const input = MASTERING.els.positionInput;
  if (input) {
    input.max = `${duration}`;
    input.disabled = duration <= 0;
    if (document.activeElement !== input) input.value = position.toFixed(2);
  }
  if (MASTERING.els.durationLabel) {
    MASTERING.els.durationLabel.textContent = `/ ${duration.toFixed(2)} s`;
  }
  const selectionReady = Boolean(
    MASTERING.loopSelection && MASTERING.loopSelection.end - MASTERING.loopSelection.start >= 0.05,
  );
  if (MASTERING.els.loopSectionBtn) {
    MASTERING.els.loopSectionBtn.disabled = duration <= 0 || !selectionReady;
    MASTERING.els.loopSectionBtn.classList.toggle(
      'active',
      MASTERING.loopMode === 'section',
    );
  }
  if (MASTERING.els.loopAllBtn) {
    MASTERING.els.loopAllBtn.disabled = duration <= 0;
    MASTERING.els.loopAllBtn.classList.toggle('active', MASTERING.loopMode === 'all');
  }
}

function drawMasteringOverlay(position = getMasteringPlayhead()) {
  const overlay = MASTERING.els.waveOverlay;
  if (!overlay) return;
  const dpr = window.devicePixelRatio || 1;
  const w = overlay.clientWidth || 600;
  const h = overlay.clientHeight || 90;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  const g = overlay.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const duration = getMasteringDuration();
  updateMasteringTransportUI(position);
  if (duration <= 0) return;

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent-0').trim() || '#3cb870';
  const accentFx = styles.getPropertyValue('--accent-fx').trim() || '#d4892a';
  const selection = MASTERING.loopSelection;
  if (selection && selection.end > selection.start) {
    const x1 = (selection.start / duration) * w;
    const x2 = (selection.end / duration) * w;
    g.globalAlpha = MASTERING.loopMode === 'section' ? 0.24 : 0.12;
    g.fillStyle = accent;
    g.fillRect(x1, 0, Math.max(1, x2 - x1), h);
    g.globalAlpha = 0.9;
    g.fillRect(x1, 0, 1, h);
    g.fillRect(x2 - 1, 0, 1, h);
    g.globalAlpha = 1;
  }
  if (MASTERING.loopMode === 'all') {
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
  }

  const x = Math.round((clamp(position, 0, duration) / duration) * w) + 0.5;
  g.strokeStyle = accentFx;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, 0);
  g.lineTo(x, h);
  g.stroke();
}

function stopMasteringPreview({ preservePosition = true } = {}) {
  const pv = MASTERING.preview;
  if (pv && preservePosition) MASTERING.playheadSec = getMasteringPlayhead();
  if (MASTERING.vizFrame) {
    cancelAnimationFrame(MASTERING.vizFrame);
    MASTERING.vizFrame = null;
  }
  destroyMasteringMeter();
  MASTERING.liveEqGains = null;
  MASTERING.liveEqDirty = false;
  if (MASTERING.built) {
    drawMasteringMetersIdle();
    drawMasteringEq(); // drop the live dots
  }
  MASTERING.preview = null;
  if (pv) {
    try {
      pv.srcNode.onended = null;
      pv.srcNode.stop();
    } catch (e) {}
    try {
      pv.srcNode.disconnect();
      pv.chain.output.disconnect();
    } catch (e) {}
  }
  MASTERING.els.previewBtn?.classList.remove('active');
  if (MASTERING.els.previewBtn) MASTERING.els.previewBtn.textContent = '▶ preview';
  drawMasteringOverlay(MASTERING.playheadSec);
}

// ── Metering ── a ScriptProcessor tap on the chain output feeds streaming
// BS.1770 K-weighting (real biquads with persistent state, not an FFT
// approximation), so momentary/short-term LUFS, sample peaks, and stereo
// correlation are measured continuously. Everything is torn down with the
// preview — the meters cost nothing while idle.

const METER_FLOOR_DB = -60;
const METER_PEAK_FALL = 28; // dB/s display ballistics
const METER_HOLD_MS = 1600;

function newBiquadState() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function stepBiquad(state, [b0, b1, b2, a1, a2], x) {
  const y = b0 * x + b1 * state.x1 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = x;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

function createMasteringMeter(ctx, chainOutput) {
  const sr = ctx.sampleRate;
  const meter = {
    shelfCoefs: rbjHighShelf(sr, 1681.97, 3.99976, 0.7071752),
    hpCoefs: rbjHighpass(sr, 38.135, 0.5003),
    fL1: newBiquadState(),
    fL2: newBiquadState(),
    fR1: newBiquadState(),
    fR2: newBiquadState(),
    blocks: [], // { ms, corr, dur } newest-last, ~3s kept
    framePeakL: 0,
    framePeakR: 0,
    dispL: METER_FLOOR_DB,
    dispR: METER_FLOOR_DB,
    holdL: { db: METER_FLOOR_DB, until: 0 },
    holdR: { db: METER_FLOOR_DB, until: 0 },
    corr: 0,
    lastTick: performance.now(),
    tap: null,
    sink: null,
  };

  const tap = ctx.createScriptProcessor(4096, 2, 2);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  tap.onaudioprocess = (e) => {
    const inL = e.inputBuffer.getChannelData(0);
    const inR = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : inL;
    e.outputBuffer.getChannelData(0).set(inL);
    e.outputBuffer.getChannelData(1).set(inR);
    let peakL = 0;
    let peakR = 0;
    let sumK = 0;
    let sumLR = 0;
    let sumL2 = 0;
    let sumR2 = 0;
    for (let i = 0; i < inL.length; i++) {
      const l = inL[i];
      const r = inR[i];
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
      const kl = stepBiquad(meter.fL2, meter.hpCoefs, stepBiquad(meter.fL1, meter.shelfCoefs, l));
      const kr = stepBiquad(meter.fR2, meter.hpCoefs, stepBiquad(meter.fR1, meter.shelfCoefs, r));
      sumK += kl * kl + kr * kr;
      sumLR += l * r;
      sumL2 += l * l;
      sumR2 += r * r;
    }
    meter.framePeakL = Math.max(meter.framePeakL, peakL);
    meter.framePeakR = Math.max(meter.framePeakR, peakR);
    const denom = Math.sqrt(sumL2 * sumR2);
    meter.blocks.push({
      ms: sumK / inL.length,
      corr: denom > 1e-12 ? sumLR / denom : 0,
      dur: inL.length / sr,
    });
    let total = 0;
    for (let i = meter.blocks.length - 1; i >= 0; i--) {
      total += meter.blocks[i].dur;
      if (total > 3.2) {
        meter.blocks.splice(0, i);
        break;
      }
    }
  };
  chainOutput.connect(tap);
  tap.connect(sink);
  sink.connect(ctx.destination);
  meter.tap = tap;
  meter.sink = sink;
  return meter;
}

function destroyMasteringMeter() {
  const meter = MASTERING.meter;
  if (!meter) return;
  MASTERING.meter = null;
  if (meter.tap) {
    meter.tap.onaudioprocess = null;
    try {
      meter.tap.disconnect();
    } catch (e) {}
  }
  try {
    meter.sink?.disconnect();
  } catch (e) {}
}

function meterWindowLufs(meter, windowSec) {
  let total = 0;
  let energy = 0;
  for (let i = meter.blocks.length - 1; i >= 0; i--) {
    const b = meter.blocks[i];
    total += b.dur;
    energy += b.ms * b.dur;
    if (total >= windowSec) break;
  }
  if (total <= 0 || energy <= 0) return -Infinity;
  return -0.691 + 10 * Math.log10(energy / total);
}

const meterDbToX = (db, w) => clamp((db - METER_FLOOR_DB) / -METER_FLOOR_DB, 0, 1) * w;

function updatePeakBallistics(meter, key, holdKey, framePeak, dt, now) {
  const target = framePeak > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(framePeak)) : METER_FLOOR_DB;
  meter[key] = Math.max(target, meter[key] - METER_PEAK_FALL * dt);
  const hold = meter[holdKey];
  if (target >= hold.db) {
    hold.db = target;
    hold.until = now + METER_HOLD_MS;
  } else if (now > hold.until) {
    hold.db = Math.max(target, hold.db - METER_PEAK_FALL * 1.5 * dt);
  }
}

function formatMeterHz(f) {
  return f < 1000 ? `${Math.round(f)} Hz` : `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz`;
}

// Cursor frequency readout over the spectrum area — spectrum shares the EQ's log axis.
function drawMeterHoverFreq(g, w, specH, col) {
  const hov = MASTERING.meterHover;
  if (!hov || hov.y > specH) return;
  const f = eqXToFreq(hov.x, w);
  g.strokeStyle = col;
  g.globalAlpha = 0.4;
  g.beginPath();
  g.moveTo(Math.round(hov.x) + 0.5, 0);
  g.lineTo(Math.round(hov.x) + 0.5, specH);
  g.stroke();
  g.globalAlpha = 1;
  g.font = '8px ui-monospace, monospace';
  const lbl = formatMeterHz(f);
  const tw = g.measureText(lbl).width;
  const tx = hov.x + 5 + tw > w - 2 ? hov.x - tw - 5 : hov.x + 5;
  const ty = clamp(hov.y, 22, specH - 4);
  g.fillStyle = col;
  g.fillText(lbl, tx, ty);
}

function drawMasteringMeters(pv) {
  const canvas = MASTERING.els.meterCanvas;
  const meter = MASTERING.meter;
  if (!canvas || !meter) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 140;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent-0').trim() || '#3cb870';
  const accentFx = styles.getPropertyValue('--accent-fx').trim() || '#d4892a';
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#5a5a5a';
  const borderCol = styles.getPropertyValue('--border').trim() || '#3a3a3a';

  const now = performance.now();
  const dt = Math.min(0.1, (now - meter.lastTick) / 1000);
  meter.lastTick = now;

  // ── Spectrum (log frequency, post-chain, L/R averaged) ──
  const specH = h - 46;
  const an0 = pv.analysers[0];
  const an1 = pv.analysers[1];
  if (!meter.freq0) {
    meter.freq0 = new Float32Array(an0.frequencyBinCount);
    meter.freq1 = new Float32Array(an1.frequencyBinCount);
  }
  an0.getFloatFrequencyData(meter.freq0);
  an1.getFloatFrequencyData(meter.freq1);
  const sr = MASTERING.ctx.sampleRate;
  const binHz = sr / 2 / an0.frequencyBinCount;
  g.beginPath();
  g.moveTo(0, specH);
  for (let x = 0; x <= w; x += 2) {
    const f = EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, x / w);
    const bin = clamp(Math.round(f / binHz), 0, an0.frequencyBinCount - 1);
    const db = (meter.freq0[bin] + meter.freq1[bin]) / 2; // ~[-100, 0]
    const norm = clamp((db + 90) / 80, 0, 1);
    g.lineTo(x, specH - norm * (specH - 14));
  }
  g.lineTo(w, specH);
  g.closePath();
  g.globalAlpha = 0.25;
  g.fillStyle = accent;
  g.fill();
  g.globalAlpha = 1;
  g.strokeStyle = accent;
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = mutedCol;
  g.font = '7px ui-monospace, monospace';
  [[100, '100'], [1000, '1k'], [10000, '10k']].forEach(([f, lbl]) => {
    g.fillText(lbl, eqFreqToX(f, w) + 2, specH - 3);
  });
  drawMeterHoverFreq(g, w, specH, accentFx);

  // ── Loudness / correlation / gain-reduction readout ──
  const momentary = meterWindowLufs(meter, 0.4);
  const shortTerm = meterWindowLufs(meter, 3.0);
  const recent = meter.blocks.slice(-6);
  const rawCorr = recent.length
    ? recent.reduce((acc, b) => acc + b.corr, 0) / recent.length
    : 0;
  meter.corr = meter.corr * 0.7 + rawCorr * 0.3;
  const gr =
    (pv.chain.nodes.comp.reduction || 0) + (pv.chain.nodes.optoComp?.reduction || 0);
  const fmtLufs = (v) => (Number.isFinite(v) ? v.toFixed(1) : '−∞');
  g.font = '9px ui-monospace, monospace';
  g.fillStyle = accentFx;
  g.fillText(`M ${fmtLufs(momentary)}`, 8, 12);
  g.fillStyle = mutedCol;
  g.fillText(`S ${fmtLufs(shortTerm)} LUFS`, 78, 12);
  g.fillText(`CORR ${meter.corr >= 0 ? '+' : ''}${meter.corr.toFixed(2)}`, 190, 12);
  g.fillStyle = gr < -0.5 ? accentFx : mutedCol;
  g.fillText(`GR ${gr.toFixed(1)} dB`, 280, 12);

  // ── Stereo peak bars with scale + hold ticks ──
  updatePeakBallistics(meter, 'dispL', 'holdL', meter.framePeakL, dt, now);
  updatePeakBallistics(meter, 'dispR', 'holdR', meter.framePeakR, dt, now);
  meter.framePeakL = 0;
  meter.framePeakR = 0;
  const bars = [
    ['L', meter.dispL, meter.holdL],
    ['R', meter.dispR, meter.holdR],
  ];
  const barH = 8;
  const redX = meterDbToX(-1, w - 20);
  bars.forEach(([lbl, db, hold], i) => {
    const by = specH + 6 + i * (barH + 4);
    g.fillStyle = mutedCol;
    g.font = '7px ui-monospace, monospace';
    g.fillText(lbl, 2, by + barH - 1);
    const bx = 12;
    const bw = w - 20;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(bx, by, bw, barH);
    const fillW = meterDbToX(db, bw);
    g.fillStyle = accent;
    g.fillRect(bx, by, Math.min(fillW, redX), barH);
    if (fillW > redX) {
      g.fillStyle = '#d05050';
      g.fillRect(bx + redX, by, fillW - redX, barH);
    }
    const hx = bx + meterDbToX(hold.db, bw);
    g.fillStyle = hold.db > -1 ? '#d05050' : accentFx;
    g.fillRect(hx - 1, by, 2, barH);
    g.fillStyle = mutedCol;
    g.font = '7px ui-monospace, monospace';
    g.fillText(`${db <= METER_FLOOR_DB ? '−∞' : db.toFixed(1)}`, bx + bw - 26, by + barH - 1);
  });
  // dB scale ticks under the bars.
  g.fillStyle = mutedCol;
  [-60, -30, -18, -12, -6, -3].forEach((db) => {
    const x = 12 + meterDbToX(db, w - 20);
    g.fillRect(x, h - 10, 1, 3);
    g.fillText(`${db}`, x + 2, h - 3);
  });

  g.strokeStyle = borderCol;
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function drawMasteringMetersIdle() {
  const canvas = MASTERING.els.meterCanvas;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 140;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#5a5a5a';
  g.fillStyle = mutedCol;
  g.font = '9px ui-monospace, monospace';
  g.fillText('meters run during preview — M/S LUFS · peaks · correlation · spectrum · GR', 8, 14);
  const accentFx = styles.getPropertyValue('--accent-fx').trim() || '#d4892a';
  drawMeterHoverFreq(g, w, h - 46, accentFx);
}

// Per-frame output viz — runs ONLY while preview plays.
function masteringVizTick() {
  MASTERING.vizFrame = null;
  const pv = MASTERING.preview;
  if (!pv || !MASTERING.ctx) return;
  drawMasteringOverlay();
  drawMasteringMeters(pv);
  MASTERING.liveEqDirty = false;
  drawMasteringEq(); // spectrum backdrop + live per-band gain dots move with the music
  MASTERING.vizFrame = requestAnimationFrame(masteringVizTick);
}

function getMasteringPreviewBuffer(ctx) {
  const s = MASTERING.source;
  if (!s) return null;
  if (
    !MASTERING.previewBuffer ||
    MASTERING.previewBuffer.length !== s.left.length ||
    MASTERING.previewBuffer.sampleRate !== s.sampleRate
  ) {
    const buf = ctx.createBuffer(2, s.left.length, s.sampleRate);
    buf.getChannelData(0).set(s.left);
    buf.getChannelData(1).set(s.right);
    MASTERING.previewBuffer = buf;
  }
  return MASTERING.previewBuffer;
}

async function startMasteringPreview(offsetSec = MASTERING.playheadSec) {
  if (!MASTERING.source) {
    setStatus('no audio in mastering — bounce the song or load a wav');
    return;
  }
  if (!MASTERING.ctx) MASTERING.ctx = new AudioContext();
  const ctx = MASTERING.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  await ensureMasteringEqModule(ctx);
  const duration = getMasteringDuration();
  const loopBounds = getMasteringLoopBounds();
  let offset = clamp(offsetSec, 0, duration);
  if (loopBounds && (offset < loopBounds.start || offset >= loopBounds.end)) {
    offset = loopBounds.start;
  } else if (!loopBounds && offset >= duration - 0.001) {
    offset = 0;
  }
  const chain = buildMasteringChain(ctx);
  const srcNode = ctx.createBufferSource();
  srcNode.buffer = getMasteringPreviewBuffer(ctx);
  if (loopBounds) {
    srcNode.loop = true;
    srcNode.loopStart = loopBounds.start;
    srcNode.loopEnd = loopBounds.end;
  }
  srcNode.connect(chain.input);
  chain.output.connect(ctx.destination);
  // Post-chain stereo analysers for the output meters.
  const splitter = ctx.createChannelSplitter(2);
  chain.output.connect(splitter);
  const analysers = [0, 1].map((ch) => {
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    splitter.connect(an, ch);
    return an;
  });
  const preview = {
    srcNode,
    chain,
    splitter,
    analysers,
    startAt: ctx.currentTime,
    offsetSec: offset,
    loopStart: loopBounds?.start ?? 0,
    loopEnd: loopBounds?.end ?? 0,
    duration: srcNode.buffer.duration,
  };
  MASTERING.preview = preview;
  MASTERING.playheadSec = offset;
  srcNode.onended = () => {
    if (MASTERING.preview !== preview) return;
    MASTERING.playheadSec = 0;
    stopMasteringPreview({ preservePosition: false });
  };
  srcNode.start(0, offset);
  MASTERING.meter = createMasteringMeter(ctx, chain.output);
  MASTERING.els.previewBtn?.classList.add('active');
  if (MASTERING.els.previewBtn) MASTERING.els.previewBtn.textContent = '■ stop';
  if (!MASTERING.vizFrame) MASTERING.vizFrame = requestAnimationFrame(masteringVizTick);
}

async function seekMasteringPreview(seconds) {
  const duration = getMasteringDuration();
  if (duration <= 0) return;
  let target = clamp(Number(seconds) || 0, 0, duration);
  const loopBounds = getMasteringLoopBounds();
  if (
    MASTERING.loopMode === 'section' &&
    loopBounds &&
    (target < loopBounds.start || target >= loopBounds.end)
  ) {
    target = loopBounds.start;
  }
  const wasPlaying = Boolean(MASTERING.preview);
  if (wasPlaying) stopMasteringPreview({ preservePosition: false });
  MASTERING.playheadSec = target;
  drawMasteringOverlay(target);
  if (wasPlaying) await startMasteringPreview(target);
}

async function setMasteringLoopMode(mode) {
  if (mode === 'section' && !MASTERING.loopSelection) {
    setStatus('drag across the waveform to select a loop section');
    return;
  }
  const position = getMasteringPlayhead();
  const wasPlaying = Boolean(MASTERING.preview);
  if (wasPlaying) stopMasteringPreview({ preservePosition: false });
  MASTERING.loopMode = mode;
  let nextPosition = position;
  const bounds = getMasteringLoopBounds();
  if (bounds && (nextPosition < bounds.start || nextPosition >= bounds.end)) {
    nextPosition = bounds.start;
  }
  MASTERING.playheadSec = nextPosition;
  updateMasteringTransportUI(nextPosition);
  drawMasteringOverlay(nextPosition);
  if (wasPlaying) await startMasteringPreview(nextPosition);
}

async function toggleMasteringPreview() {
  if (MASTERING.preview) {
    stopMasteringPreview();
    return;
  }
  await startMasteringPreview();
}

async function renderMastering() {
  const s = MASTERING.source;
  if (!s) {
    setStatus('no audio in mastering — bounce the song or load a wav');
    return;
  }
  setStatus('rendering master…');
  const tail = Math.round(s.sampleRate * 0.05);
  const oc = new OfflineAudioContext(2, s.left.length + tail, s.sampleRate);
  await ensureMasteringEqModule(oc);
  const buf = oc.createBuffer(2, s.left.length, s.sampleRate);
  buf.getChannelData(0).set(s.left);
  buf.getChannelData(1).set(s.right);
  // Band solo is an audition aid and must never be printed into the master.
  // The export always renders the processed chain — global bypass is a
  // listening A/B tool, not a render mode.
  const chain = buildMasteringChain(oc, { eqSolo: false, bypassAll: false });
  const srcNode = oc.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(chain.input);
  chain.output.connect(oc.destination);
  srcNode.start();
  const rendered = await oc.startRendering();
  const L = rendered.getChannelData(0);
  const R = rendered.getChannelData(1);
  const lufs = measureIntegratedLufs(L, R, s.sampleRate);
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  if (MASTERING.els.meters) {
    MASTERING.els.meters.textContent = `${Number.isFinite(lufs) ? lufs.toFixed(1) : '−∞'} LUFS · peak ${Number.isFinite(peakDb) ? peakDb.toFixed(2) : '−∞'} dBFS`;
  }
  MASTERING.renderedPeaks = buildMasteringPeaks(L, R);
  drawMasteringWave();
  REC.downloadName = `${(s.name || 'grnsh').replace(/\.wav$/i, '').replace(/[^\w.-]+/g, '_')}-master.wav`;
  downloadRecording(encodeWav(L, R, s.sampleRate));
  setStatus('master rendered');
}

// Integrated loudness per ITU-R BS.1770: K-weighting (RBJ biquads at the
// source rate), 400ms blocks with 75% overlap, −70 LUFS absolute gate then
// −10 LU relative gate.
function measureIntegratedLufs(left, right, sampleRate) {
  const shelf = rbjHighShelf(sampleRate, 1681.97, 3.99976, 0.7071752);
  const hp = rbjHighpass(sampleRate, 38.135, 0.5003);
  const kwL = applyBiquad(applyBiquad(left, shelf), hp);
  const kwR = applyBiquad(applyBiquad(right, shelf), hp);
  const blockLen = Math.round(sampleRate * 0.4);
  const hop = Math.round(sampleRate * 0.1);
  if (kwL.length < blockLen) return -Infinity;
  const blocks = [];
  for (let start = 0; start + blockLen <= kwL.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + blockLen; i++) sum += kwL[i] * kwL[i] + kwR[i] * kwR[i];
    const ms = sum / blockLen;
    blocks.push(-0.691 + 10 * Math.log10(ms || 1e-12));
  }
  const absGated = blocks.filter((l) => l > -70);
  if (!absGated.length) return -Infinity;
  const mean = (arr) =>
    10 * Math.log10(arr.reduce((acc, l) => acc + Math.pow(10, l / 10), 0) / arr.length);
  const relThreshold = mean(absGated) - 10 + 0.691;
  const relGated = absGated.filter((l) => l > relThreshold - 0.691);
  if (!relGated.length) return -Infinity;
  return mean(relGated);
}

function rbjHighShelf(sr, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const sqA = Math.sqrt(A);
  const b0 = A * (A + 1 + (A - 1) * cosw + 2 * sqA * alpha);
  const b1 = -2 * A * (A - 1 + (A + 1) * cosw);
  const b2 = A * (A + 1 + (A - 1) * cosw - 2 * sqA * alpha);
  const a0 = A + 1 - (A - 1) * cosw + 2 * sqA * alpha;
  const a1 = 2 * (A - 1 - (A + 1) * cosw);
  const a2 = A + 1 - (A - 1) * cosw - 2 * sqA * alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function rbjHighpass(sr, f0, q) {
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

function applyBiquad(input, [b0, b1, b2, a1, a2]) {
  const out = new Float32Array(input.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

async function loadMasteringFile(file) {
  try {
    const raw = await file.arrayBuffer();
    // decodeAudioData resamples to the context rate — pin a fixed 48k so
    // results are deterministic regardless of the output device.
    const decodeCtx = new OfflineAudioContext(2, 2, 48000);
    const buf = await decodeCtx.decodeAudioData(raw);
    const left = new Float32Array(buf.getChannelData(0));
    const right = new Float32Array(
      buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0),
    );
    setMasteringSource(left, right, buf.sampleRate, file.name);
    setStatus(`loaded "${file.name}" into mastering`);
  } catch (e) {
    setStatus('could not decode that audio file');
  }
}

function refreshMasteringSourceUI() {
  const s = MASTERING.source;
  const info = MASTERING.els.sourceInfo;
  if (info) {
    info.textContent = s
      ? `${s.name} — ${(s.left.length / s.sampleRate).toFixed(1)}s @ ${s.sampleRate}Hz`
      : 'no audio yet — bounce the song or load a wav';
  }
  if (MASTERING.els.meters && !s) MASTERING.els.meters.textContent = '';
  drawMasteringWave();
  drawMasteringOverlay(MASTERING.playheadSec);
}

function drawMasteringWave() {
  const canvas = MASTERING.els.wave;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 90;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const s = MASTERING.source;
  if (!s) return;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent-0').trim() || '#3cb870';
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#5a5a5a';
  const rendered = MASTERING.renderedPeaks;
  const mid = h / 2;

  // Source envelope — accent when it's the only layer, dimmed under a render.
  g.strokeStyle = rendered ? mutedCol : accent;
  g.lineWidth = 1;
  const samplesPerCol = Math.max(1, Math.floor(s.left.length / w));
  g.beginPath();
  for (let x = 0; x < w; x++) {
    let min = 1,
      max = -1;
    const start = x * samplesPerCol;
    const end = Math.min(start + samplesPerCol, s.left.length);
    for (let i = start; i < end; i++) {
      const v = (s.left[i] + s.right[i]) * 0.5;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) continue;
    g.moveTo(x + 0.5, mid - max * (mid - 2));
    g.lineTo(x + 0.5, mid - min * (mid - 2) + 0.5);
  }
  g.stroke();

  // Last render on top — the actual output the export produced.
  if (rendered) {
    g.strokeStyle = accent;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const b = Math.min(rendered.bins - 1, Math.floor((x / w) * rendered.bins));
      g.moveTo(x + 0.5, mid - rendered.maxs[b] * (mid - 2));
      g.lineTo(x + 0.5, mid - rendered.mins[b] * (mid - 2) + 0.5);
    }
    g.stroke();
    g.fillStyle = mutedCol;
    g.font = '7px ui-monospace, monospace';
    g.fillText('source', 6, 10);
    g.fillStyle = accent;
    g.fillText('master', 6, 19);
  }
}

const MASTERING_CONTROL_SPECS = [
  {
    id: 'comp',
    section: 'Glue Comp',
    controls: [
      { key: 'compThreshold', label: 'Thresh', min: -40, max: 0, step: 0.5, unit: 'dB' },
      { key: 'compRatio', label: 'Ratio', min: 1, max: 10, step: 0.5, unit: '' },
      { key: 'compAttack', label: 'Attack', min: 0.001, max: 0.1, step: 0.001, unit: 's' },
      { key: 'compRelease', label: 'Release', min: 0.05, max: 1, step: 0.01, unit: 's' },
      { key: 'compMakeup', label: 'Makeup', min: 0, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'opto',
    section: 'Opto',
    controls: [
      { key: 'optoReduction', label: 'Reduction', min: 0, max: 40, step: 0.5, unit: 'dB' },
      { key: 'optoMakeup', label: 'Gain', min: 0, max: 24, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'ott',
    section: 'OTT',
    controls: [
      { key: 'ottDepth', label: 'Depth', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'ottTime', label: 'Time', min: 0.33, max: 3, step: 0.01, unit: 'x' },
      { key: 'ottIn', label: 'In', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottOut', label: 'Out', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottLow', label: 'Low', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottMid', label: 'Mid', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottHigh', label: 'High', min: -12, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'tape',
    section: 'Tape',
    controls: [
      { key: 'tapeDrive', label: 'Drive', min: 0, max: 18, step: 0.5, unit: 'dB' },
      { key: 'tapeBump', label: 'Bump', min: 0, max: 6, step: 0.5, unit: 'dB' },
      { key: 'tapeRolloff', label: 'Rolloff', min: 8, max: 20, step: 0.5, unit: 'kHz' },
      { key: 'tapeLevel', label: 'Level', min: -12, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'exciter',
    section: 'Exciter',
    controls: [
      { key: 'excTune', label: 'Tune', min: 1000, max: 8000, step: 100, unit: 'Hz' },
      { key: 'excHarmonics', label: 'Harmonics', min: 0, max: 24, step: 0.5, unit: 'dB' },
      { key: 'excMix', label: 'Mix', min: 0, max: 50, step: 1, unit: '%' },
    ],
  },
  {
    id: 'width',
    section: 'Width',
    controls: [
      { key: 'width', label: 'Width', min: 0, max: 2, step: 0.05, unit: '' },
      { key: 'widthBassFreq', label: 'Bass Mono', min: 0, max: 300, step: 5, unit: 'Hz' },
    ],
  },
  {
    id: 'limit',
    section: 'Limit',
    controls: [
      { key: 'drive', label: 'Drive', min: 0, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ceiling', label: 'Ceiling', min: -6, max: -0.1, step: 0.1, unit: 'dB' },
      { key: 'outGain', label: 'Output', min: -12, max: 6, step: 0.5, unit: 'dB' },
    ],
  },
];

// ── Graphical EQ ── log-frequency response plot with five draggable,
// fully-parametric band handles: horizontal = frequency, vertical = gain.
// The compact control below the graph edits Q for the selected band.

const MASTERING_EQ_BANDS = [
  {
    gainKey: 'lowGain',
    threshKey: 'lowDynThresh',
    rangeKey: 'lowDynRange',
    freqKey: 'lowFreq',
    qKey: 'lowQ',
    label: 'LOW',
    fmin: 20,
    fmax: 300,
    defaultQ: 0.7,
  },
  {
    gainKey: 'lowMidGain',
    threshKey: 'lowMidDynThresh',
    rangeKey: 'lowMidDynRange',
    freqKey: 'lowMidFreq',
    qKey: 'lowMidQ',
    label: 'LOW MID',
    fmin: 80,
    fmax: 1500,
    defaultQ: 1,
  },
  {
    gainKey: 'midGain',
    threshKey: 'midDynThresh',
    rangeKey: 'midDynRange',
    freqKey: 'midFreq',
    qKey: 'midQ',
    label: 'MID',
    fmin: 200,
    fmax: 5000,
    defaultQ: 0.7,
  },
  {
    gainKey: 'highMidGain',
    threshKey: 'highMidDynThresh',
    rangeKey: 'highMidDynRange',
    freqKey: 'highMidFreq',
    qKey: 'highMidQ',
    label: 'HIGH MID',
    fmin: 800,
    fmax: 12000,
    defaultQ: 1,
  },
  {
    gainKey: 'highGain',
    threshKey: 'highDynThresh',
    rangeKey: 'highDynRange',
    freqKey: 'highFreq',
    qKey: 'highQ',
    label: 'HIGH',
    fmin: 3000,
    fmax: 18000,
    defaultQ: 0.7,
  },
];
const EQ_DB_RANGE = 12;
const EQ_FMIN = 20;
const EQ_FMAX = 20000;
const EQ_DISPLAY_SR = 48000;

function rbjLowShelf(sr, f0, gainDb, q) {
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

function rbjPeaking(sr, f0, gainDb, q) {
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

function biquadMagnitudeDb([b0, b1, b2, a1, a2], freq, sr) {
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

function masteringEqResponseDb(freq) {
  const p = MASTERING.params;
  return MASTERING_EQ_BANDS.reduce((sum, band) => {
    const coeffs = rbjPeaking(
      EQ_DISPLAY_SR,
      p[band.freqKey],
      p[band.gainKey],
      p[band.qKey],
    );
    return sum + biquadMagnitudeDb(coeffs, freq, EQ_DISPLAY_SR);
  }, 0);
}

const eqFreqToX = (f, w) => (Math.log(f / EQ_FMIN) / Math.log(EQ_FMAX / EQ_FMIN)) * w;
const eqXToFreq = (x, w) => EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, clamp(x / w, 0, 1));
const eqDbToY = (db, h) => h / 2 - (db / EQ_DB_RANGE) * (h / 2 - 8);
const eqYToDb = (y, h) => clamp(((h / 2 - y) / (h / 2 - 8)) * EQ_DB_RANGE, -EQ_DB_RANGE, EQ_DB_RANGE);

function drawMasteringEq() {
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
  const selBand = MASTERING_EQ_BANDS[MASTERING.eqBandIndex];
  if (selBand) {
    const coeffs = rbjPeaking(
      EQ_DISPLAY_SR,
      MASTERING.params[selBand.freqKey],
      MASTERING.params[selBand.gainKey],
      MASTERING.params[selBand.qKey],
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

  // Combined response curve.
  g.strokeStyle = bandCols[0];
  g.lineWidth = 1.5;
  g.beginPath();
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const f = EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, i / steps);
    const y = eqDbToY(clamp(masteringEqResponseDb(f), -EQ_DB_RANGE, EQ_DB_RANGE), h);
    if (i === 0) g.moveTo(eqFreqToX(f, w), y);
    else g.lineTo(eqFreqToX(f, w), y);
  }
  g.stroke();

  // Band handles.
  MASTERING_EQ_BANDS.forEach((band, bi) => {
    const x = eqFreqToX(MASTERING.params[band.freqKey], w);
    const y = eqDbToY(MASTERING.params[band.gainKey], h);
    const range = MASTERING.params[band.rangeKey] || 0;
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
      // Live effective gain while previewing — the moving part.
      const live = MASTERING.liveEqGains?.[bi];
      if (MASTERING.preview && typeof live === 'number') {
        const ly = eqDbToY(clamp(live, -EQ_DB_RANGE, EQ_DB_RANGE), h);
        g.fillStyle = bandCols[bi];
        g.beginPath();
        g.arc(x, ly, 2.5, 0, Math.PI * 2);
        g.fill();
      }
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

function setMasteringEqReadout(band) {
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
  el.textContent = `${band.label} ${fLabel} Hz ${dB >= 0 ? '+' : ''}${dB.toFixed(1)} dB · Q ${q.toFixed(2)}`;
}

// ── Mastering persistence ── params ride inside the preset (autosave, named
// projects, file export, undo history). No mastering data → reset to defaults
// so an old project never inherits the previous project's chain.

const MASTERING_DEFAULT_PARAMS = JSON.parse(JSON.stringify(MASTERING.params));

function applyMasteringPreset(saved) {
  const src = saved && typeof saved === 'object' ? saved : MASTERING_DEFAULT_PARAMS;
  const p = MASTERING.params;
  Object.keys(MASTERING_DEFAULT_PARAMS).forEach((key) => {
    if (key === 'order' || key === 'enabled') return;
    const fallback = MASTERING_DEFAULT_PARAMS[key];
    p[key] = typeof src[key] === typeof fallback ? src[key] : fallback;
  });
  p.order = Array.isArray(src.order) ? [...src.order] : [...MASTERING_DEFAULT_PARAMS.order];
  p.order = getMasteringOrder(); // sanitizes unknown/missing module ids
  p.enabled = { ...MASTERING_DEFAULT_PARAMS.enabled };
  if (src.enabled && typeof src.enabled === 'object') {
    MASTERING_MODULE_IDS.forEach((id) => {
      if (typeof src.enabled[id] === 'boolean') p.enabled[id] = src.enabled[id];
    });
  }
  rebuildMasterPanelUI();
}

// Loaded params can change knob values, chain order, and bypass states at
// once — rebuilding the (cheap, static) panel DOM is simpler and safer than
// patching every control in place. A running preview keeps playing and gets
// the new chain swapped in behind it.
function rebuildMasterPanelUI() {
  if (!MASTERING.built) return;
  const panel = document.getElementById('masterPanel');
  if (panel) panel.innerHTML = '';
  MASTERING.built = false;
  MASTERING.els = {};
  buildMasterPanel();
  if (MASTERING.preview) {
    rebuildMasteringPreviewChain();
    if (MASTERING.els.previewBtn) {
      MASTERING.els.previewBtn.classList.add('active');
      MASTERING.els.previewBtn.textContent = '■ stop';
    }
  }
}

// Grip dots: pure affordance — the whole label is the drag handle, this just
// makes that discoverable.
function makeMasteringDragGrip() {
  const grip = document.createElement('span');
  grip.className = 'master-drag-grip';
  grip.textContent = '⠿';
  grip.setAttribute('aria-hidden', 'true');
  return grip;
}

// Power toggle for one chain module: true bypass via a chain rebuild, so an
// off module costs nothing and colors nothing.
function makeMasteringModulePower(id, box) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'master-power';
  btn.title = 'Enable / bypass module';
  const sync = () => {
    const on = MASTERING.params.enabled[id] !== false;
    btn.classList.toggle('active', on);
    box.classList.toggle('bypassed', !on);
  };
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    MASTERING.params.enabled[id] = MASTERING.params.enabled[id] === false;
    sync();
    rebuildMasteringPreviewChain();
  });
  return btn;
}

function buildMasteringEqSection() {
  const box = document.createElement('div');
  box.className = 'master-section master-section-eq';
  box.dataset.module = 'eq';
  const label = document.createElement('div');
  label.className = 'master-section-label';
  label.textContent = 'EQ';
  label.title = 'Drag to reorder the chain';
  label.prepend(makeMasteringDragGrip());
  label.prepend(makeMasteringModulePower('eq', box));
  const readout = document.createElement('span');
  readout.className = 'master-eq-readout';
  MASTERING.els.eqReadout = readout;
  label.appendChild(readout);
  box.appendChild(label);

  const canvas = document.createElement('canvas');
  canvas.className = 'master-eq-canvas';
  canvas.title =
    'Drag: ↔ frequency, ↕ gain (shift = fine) · wheel: Q · alt-click / double-click: reset band · type exact values below';
  MASTERING.els.eqCanvas = canvas;
  box.appendChild(canvas);

  // Pro-Q-style band strip: colored chips select a band, the value boxes
  // below edit it by typing (Enter commits, Esc reverts, ↑↓/wheel nudge).
  const soloBtn = document.createElement('button');
  soloBtn.type = 'button';
  soloBtn.className = 'master-eq-solo';
  soloBtn.textContent = 'S';
  soloBtn.title = 'Solo selected band while previewing';
  soloBtn.classList.toggle('active', MASTERING.eqSolo);
  const chipRow = document.createElement('div');
  chipRow.className = 'master-eq-bands';
  const CHIP_LABELS = ['LOW', 'LM', 'MID', 'HM', 'HI'];
  const CHIP_COLORS = ['c0', 'c1', 'c2', 'c1', 'c0']; // mirror the canvas band colors
  const chips = MASTERING_EQ_BANDS.map((band, bi) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `master-eq-chip ${CHIP_COLORS[bi]}`;
    chip.textContent = CHIP_LABELS[bi];
    chip.title = band.label;
    chip.addEventListener('click', () => selectBand(band));
    return chip;
  });
  chipRow.append(...chips, soloBtn);
  box.appendChild(chipRow);

  // Dynamics (THR/RNG): the band's gain is pulled down (up to RNG dB) while
  // its own energy sits above THR — downward dynamic EQ, off at range 0.
  const valueRow = document.createElement('div');
  valueRow.className = 'master-eq-values';
  box.appendChild(valueRow);

  let activeBand = null;

  const selectedBand = () => MASTERING_EQ_BANDS[MASTERING.eqBandIndex] || MASTERING_EQ_BANDS[0];
  const syncBandControls = () => {
    chips.forEach((chip, ci) => chip.classList.toggle('active', ci === MASTERING.eqBandIndex));
    Object.values(boxes).forEach((b) => b.show());
  };
  const bandChanged = (band) => {
    applyMasteringParams(MASTERING.preview?.chain);
    setMasteringEqReadout(band);
    syncBandControls();
    drawMasteringEq();
  };
  const selectBand = (band) => {
    const previousIndex = MASTERING.eqBandIndex;
    MASTERING.eqBandIndex = MASTERING_EQ_BANDS.indexOf(band);
    syncBandControls();
    setMasteringEqReadout(band);
    drawMasteringEq();
    if (MASTERING.eqSolo && previousIndex !== MASTERING.eqBandIndex) {
      rebuildMasteringPreviewChain();
    }
  };

  const fmtHzInput = (f) =>
    f >= 1000 ? `${(f / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : `${Math.round(f)}`;
  const parseHzInput = (raw) => {
    const s = raw.toLowerCase().replace(/\s|hz/g, '');
    const n = parseFloat(s.replace('k', ''));
    if (!Number.isFinite(n)) return NaN;
    // "1.2k" is explicit; bare values under 20 (below the 20 Hz display floor)
    // read as kHz, so "12" lands on 12 kHz instead of clamping to a minimum.
    return s.includes('k') || n < 20 ? n * 1000 : n;
  };

  // Same interaction as the tempo box: the number is readonly so the whole
  // box is one drag surface (vertical drag with pointer lock, shift = fine);
  // double-click switches to typing, Enter/blur commits, Esc reverts.
  const makeValueBox = ({ label, title, get, set, format, parse, nudge, dragStep }) => {
    const wrap = document.createElement('div');
    wrap.className = 'master-eq-value';
    const cap = document.createElement('span');
    cap.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.readOnly = true;
    input.title = title;
    wrap.append(cap, input);
    valueRow.appendChild(wrap);
    const show = () => {
      if (document.activeElement !== input) input.value = format(get());
    };
    const commit = () => {
      const v = parse(input.value.trim());
      if (Number.isFinite(v)) {
        set(v);
        bandChanged(selectedBand());
      }
      input.value = format(get());
    };

    input.addEventListener('dblclick', () => {
      input.readOnly = false;
      input.focus();
      input.select();
    });
    input.addEventListener('blur', () => {
      commit();
      input.readOnly = true;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') {
        input.value = format(get());
        input.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
        bandChanged(selectedBand());
        input.value = format(get());
      }
    });
    input.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
        bandChanged(selectedBand());
        show();
      },
      { passive: false },
    );

    let armed = false; // pressed, not yet decided click-vs-drag
    let dragging = false;
    let dragVal = 0; // unrounded accumulator — keeps sub-step motion smooth
    let downY = 0;
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!input.readOnly) return; // typing mode — leave it alone
      e.preventDefault();
      armed = true;
      downY = e.clientY;
      dragVal = get();
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!armed && !dragging) return;
      if (!dragging) {
        if (Math.abs(e.clientY - downY) < 3) return; // still a click
        dragging = true;
        armed = false;
        wrap.classList.add('dragging');
        wrap.requestPointerLock?.();
      }
      // movementY works locked and unlocked alike; up = increase.
      dragVal = dragStep(dragVal, -e.movementY, e.shiftKey);
      set(dragVal);
      bandChanged(selectedBand());
      show();
    });
    const endDrag = (e) => {
      armed = false;
      if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove('dragging');
      if (document.pointerLockElement === wrap) document.exitPointerLock();
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    return { show };
  };

  const p = MASTERING.params;
  const boxes = {
    freq: makeValueBox({
      label: 'FREQ',
      title: 'Band frequency — drag ↕ (shift = fine), double-click to type Hz ("250", "1.2k")',
      get: () => p[selectedBand().freqKey],
      set: (v) => {
        const band = selectedBand();
        p[band.freqKey] = clamp(Math.round(v), band.fmin, band.fmax);
      },
      format: fmtHzInput,
      parse: parseHzInput,
      nudge: (dir, big) => {
        const band = selectedBand();
        const cur = p[band.freqKey];
        let next = Math.round(cur * Math.pow(big ? 1.12 : 1.02, dir));
        if (next === cur) next = cur + dir;
        p[band.freqKey] = clamp(next, band.fmin, band.fmax);
      },
      dragStep: (v, dy, fine) => {
        const band = selectedBand();
        return clamp(v * Math.exp(dy * (fine ? 0.0012 : 0.006)), band.fmin, band.fmax);
      },
    }),
    gain: makeValueBox({
      label: 'GAIN',
      title: 'Band gain (dB) — drag ↕ (shift = fine), double-click to type',
      get: () => p[selectedBand().gainKey],
      set: (v) => {
        p[selectedBand().gainKey] = clamp(Math.round(v * 10) / 10, -EQ_DB_RANGE, EQ_DB_RANGE);
      },
      format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`,
      parse: (raw) => parseFloat(raw.replace(/db/gi, '')),
      nudge: (dir, big) => {
        const band = selectedBand();
        p[band.gainKey] = clamp(
          Math.round((p[band.gainKey] + dir * (big ? 1 : 0.1)) * 10) / 10,
          -EQ_DB_RANGE,
          EQ_DB_RANGE,
        );
      },
      dragStep: (v, dy, fine) =>
        clamp(v + dy * (fine ? 0.02 : 0.1), -EQ_DB_RANGE, EQ_DB_RANGE),
    }),
    q: makeValueBox({
      label: 'Q',
      title: 'Band Q — drag ↕, double-click to type · also: wheel over the curve display',
      get: () => p[selectedBand().qKey],
      set: (v) => {
        p[selectedBand().qKey] = clamp(Math.round(v * 100) / 100, 0.1, 12);
      },
      format: (v) => v.toFixed(2),
      parse: parseFloat,
      nudge: (dir, big) => {
        const band = selectedBand();
        const next = p[band.qKey] * Math.pow(big ? 1.25 : 1.05, dir);
        p[band.qKey] = clamp(Math.round(next * 100) / 100, 0.1, 12);
      },
      dragStep: (v, dy, fine) => clamp(v * Math.exp(dy * (fine ? 0.002 : 0.01)), 0.1, 12),
    }),
    thresh: makeValueBox({
      label: 'THR',
      title:
        'Dynamic threshold (dB) — the band ducks while its energy sits above this · drag ↕, double-click to type',
      get: () => p[selectedBand().threshKey],
      set: (v) => {
        p[selectedBand().threshKey] = clamp(Math.round(v), -60, 0);
      },
      format: (v) => `${Math.round(v)}`,
      parse: (raw) => parseFloat(raw.replace(/db/gi, '')),
      nudge: (dir, big) => {
        const band = selectedBand();
        p[band.threshKey] = clamp(p[band.threshKey] + dir * (big ? 6 : 1), -60, 0);
      },
      dragStep: (v, dy, fine) => clamp(v + dy * (fine ? 0.05 : 0.3), -60, 0),
    }),
    range: makeValueBox({
      label: 'RNG',
      title:
        'Dynamic range (dB) — how far the band can be pulled down, 0 = static band · drag ↕, double-click to type',
      get: () => p[selectedBand().rangeKey],
      set: (v) => {
        p[selectedBand().rangeKey] = clamp(Math.round(v * 10) / 10, 0, 18);
      },
      format: (v) => (v > 0 ? v.toFixed(1) : 'off'),
      parse: (raw) => (raw.toLowerCase() === 'off' ? 0 : parseFloat(raw.replace(/db/gi, ''))),
      nudge: (dir, big) => {
        const band = selectedBand();
        p[band.rangeKey] = clamp(
          Math.round((p[band.rangeKey] + dir * (big ? 3 : 0.5)) * 10) / 10,
          0,
          18,
        );
      },
      dragStep: (v, dy, fine) => clamp(v + dy * (fine ? 0.02 : 0.1), 0, 18),
    }),
  };

  soloBtn.addEventListener('click', () => {
    MASTERING.eqSolo = !MASTERING.eqSolo;
    soloBtn.classList.toggle('active', MASTERING.eqSolo);
    soloBtn.title = MASTERING.eqSolo
      ? 'Stop soloing the selected band'
      : 'Solo selected band while previewing';
    rebuildMasteringPreviewChain();
    setStatus(MASTERING.eqSolo ? `soloing EQ ${selectedBand().label.toLowerCase()}` : 'EQ solo off');
  });

  const bandAtPoint = (px, py, w, h, radius = 12) => {
    let best = null;
    let bestDist = radius; // px hit radius
    MASTERING_EQ_BANDS.forEach((band) => {
      const x = eqFreqToX(MASTERING.params[band.freqKey], w);
      const y = eqDbToY(MASTERING.params[band.gainKey], h);
      const d = Math.hypot(px - x, py - y);
      if (d < bestDist) {
        bestDist = d;
        best = band;
      }
    });
    return best;
  };

  const resetBand = (band) => {
    p[band.gainKey] = 0;
    p[band.qKey] = band.defaultQ;
    p[band.threshKey] = 0;
    p[band.rangeKey] = 0;
    bandChanged(band);
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const band = bandAtPoint(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    if (!band) return;
    e.preventDefault();
    selectBand(band);
    if (e.altKey) {
      resetBand(band);
      return;
    }
    activeBand = band;
    MASTERING.eqHover = null;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (!activeBand) {
      canvas.style.cursor = bandAtPoint(px, py, rect.width, rect.height) ? 'grab' : 'crosshair';
      MASTERING.eqHover = { x: px, y: py };
      if (!MASTERING.preview) drawMasteringEq();
      return;
    }
    const f = clamp(eqXToFreq(px, rect.width), activeBand.fmin, activeBand.fmax);
    const rawDb = eqYToDb(py, rect.height);
    const dB = e.shiftKey ? Math.round(rawDb * 10) / 10 : Math.round(rawDb * 2) / 2;
    p[activeBand.freqKey] = Math.round(f);
    p[activeBand.gainKey] = dB;
    bandChanged(activeBand);
  });
  const endEqDrag = (e) => {
    if (!activeBand) return;
    activeBand = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endEqDrag);
  canvas.addEventListener('pointercancel', endEqDrag);
  canvas.addEventListener('pointerleave', () => {
    if (activeBand) return; // pointer capture keeps the drag alive off-canvas
    MASTERING.eqHover = null;
    canvas.style.cursor = '';
    drawMasteringEq();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const band =
        bandAtPoint(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, 24) ||
        selectedBand();
      const factor = Math.exp((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.03 : 0.1));
      p[band.qKey] = clamp(Math.round(p[band.qKey] * factor * 100) / 100, 0.1, 12);
      bandChanged(band);
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const band = bandAtPoint(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
    if (!band) return;
    selectBand(band);
    resetBand(band);
  });

  syncBandControls();
  setMasteringEqReadout(selectedBand());

  return box;
}

function buildMasterPanel() {
  if (MASTERING.built) return;
  MASTERING.built = true;
  const panel = document.getElementById('masterPanel');
  if (!panel) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'master-toolbar';

  const sourceInfo = document.createElement('span');
  sourceInfo.className = 'master-source-info';
  MASTERING.els.sourceInfo = sourceInfo;

  const bounceBtn = document.createElement('button');
  bounceBtn.type = 'button';
  bounceBtn.textContent = 'Bounce song → here';
  bounceBtn.title = 'Silent one-pass render of the arrangement, fed straight into mastering';
  bounceBtn.addEventListener('click', bounceSong);

  const loadInput = document.createElement('input');
  loadInput.type = 'file';
  loadInput.accept = 'audio/*';
  loadInput.hidden = true;
  loadInput.addEventListener('change', () => {
    const file = loadInput.files?.[0];
    loadInput.value = '';
    if (file) loadMasteringFile(file);
  });
  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.textContent = 'Load WAV';
  loadBtn.addEventListener('click', () => loadInput.click());

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.textContent = '▶ preview';
  previewBtn.title = 'Play the source through the mastering chain';
  previewBtn.addEventListener('click', toggleMasteringPreview);
  MASTERING.els.previewBtn = previewBtn;

  const bypassBtn = document.createElement('button');
  bypassBtn.type = 'button';
  bypassBtn.className = 'master-bypass-btn';
  bypassBtn.textContent = 'Bypass';
  bypassBtn.title = 'A/B: hear the raw source — whole chain and leveler out of the path (export still renders processed)';
  bypassBtn.classList.toggle('active', !!MASTERING.bypassAll);
  bypassBtn.addEventListener('click', () => {
    MASTERING.bypassAll = !MASTERING.bypassAll;
    bypassBtn.classList.toggle('active', MASTERING.bypassAll);
    document
      .getElementById('masterPanel')
      ?.classList.toggle('chain-bypassed', MASTERING.bypassAll);
    rebuildMasteringPreviewChain();
    setStatus(MASTERING.bypassAll ? 'mastering bypassed — raw source' : 'mastering chain active');
  });
  MASTERING.els.bypassBtn = bypassBtn;

  const positionBox = document.createElement('label');
  positionBox.className = 'master-position-box';
  positionBox.title = 'Seek to an exact second';
  const positionInput = document.createElement('input');
  positionInput.type = 'number';
  positionInput.className = 'master-position-input';
  positionInput.min = '0';
  positionInput.step = '0.01';
  positionInput.value = '0.00';
  const durationLabel = document.createElement('span');
  durationLabel.className = 'master-duration-label';
  durationLabel.textContent = '/ 0.00 s';
  positionBox.append(positionInput, durationLabel);
  MASTERING.els.positionInput = positionInput;
  MASTERING.els.durationLabel = durationLabel;
  const commitMasteringSeek = () => seekMasteringPreview(Number(positionInput.value));
  positionInput.addEventListener('change', commitMasteringSeek);
  positionInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitMasteringSeek();
    positionInput.blur();
  });

  const loopSectionBtn = document.createElement('button');
  loopSectionBtn.type = 'button';
  loopSectionBtn.className = 'master-loop-btn';
  loopSectionBtn.textContent = 'Loop sel';
  loopSectionBtn.title = 'Drag across the waveform, then loop that section';
  loopSectionBtn.addEventListener('click', () => {
    setMasteringLoopMode(MASTERING.loopMode === 'section' ? 'off' : 'section');
  });
  MASTERING.els.loopSectionBtn = loopSectionBtn;

  const loopAllBtn = document.createElement('button');
  loopAllBtn.type = 'button';
  loopAllBtn.className = 'master-loop-btn';
  loopAllBtn.textContent = 'Loop all';
  loopAllBtn.title = 'Loop the complete song during preview';
  loopAllBtn.addEventListener('click', () => {
    setMasteringLoopMode(MASTERING.loopMode === 'all' ? 'off' : 'all');
  });
  MASTERING.els.loopAllBtn = loopAllBtn;

  const renderBtn = document.createElement('button');
  renderBtn.type = 'button';
  renderBtn.textContent = 'Render & export WAV';
  renderBtn.title = 'Offline render through the chain, measures LUFS/peak, downloads the wav';
  renderBtn.addEventListener('click', renderMastering);

  const meters = document.createElement('span');
  meters.className = 'master-meters';
  meters.title = 'Integrated loudness (BS.1770) and sample peak of the last render — aim near −14 LUFS for streaming';
  MASTERING.els.meters = meters;

  toolbar.append(
    sourceInfo,
    bounceBtn,
    loadBtn,
    loadInput,
    previewBtn,
    bypassBtn,
    positionBox,
    loopSectionBtn,
    loopAllBtn,
    renderBtn,
    meters,
  );
  panel.appendChild(toolbar);
  panel.classList.toggle('chain-bypassed', !!MASTERING.bypassAll);

  const waveWrap = document.createElement('div');
  waveWrap.className = 'master-wave-wrap';
  const wave = document.createElement('canvas');
  wave.className = 'master-wave';
  wave.title = 'Click to seek · drag to select and loop a section';
  MASTERING.els.wave = wave;
  const waveOverlay = document.createElement('canvas');
  waveOverlay.className = 'master-wave-overlay';
  MASTERING.els.waveOverlay = waveOverlay;
  waveWrap.append(wave, waveOverlay);
  panel.appendChild(waveWrap);

  let waveDrag = null;
  const waveSecondAt = (clientX) => {
    const rect = wave.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * getMasteringDuration();
  };
  wave.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !MASTERING.source) return;
    e.preventDefault();
    wave.setPointerCapture(e.pointerId);
    waveDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startSec: waveSecondAt(e.clientX),
      moved: false,
      previousSelection: MASTERING.loopSelection ? { ...MASTERING.loopSelection } : null,
    };
  });
  wave.addEventListener('pointermove', (e) => {
    if (!waveDrag || e.pointerId !== waveDrag.pointerId) return;
    if (Math.abs(e.clientX - waveDrag.startX) >= 4) waveDrag.moved = true;
    if (!waveDrag.moved) return;
    const currentSec = waveSecondAt(e.clientX);
    MASTERING.loopSelection = {
      start: Math.min(waveDrag.startSec, currentSec),
      end: Math.max(waveDrag.startSec, currentSec),
    };
    updateMasteringTransportUI();
    drawMasteringOverlay();
  });
  wave.addEventListener('pointerup', (e) => {
    if (!waveDrag || e.pointerId !== waveDrag.pointerId) return;
    const drag = waveDrag;
    waveDrag = null;
    if (wave.hasPointerCapture(e.pointerId)) wave.releasePointerCapture(e.pointerId);
    if (drag.moved && MASTERING.loopSelection?.end - MASTERING.loopSelection?.start >= 0.05) {
      setMasteringLoopMode('section');
      setStatus(
        `looping ${MASTERING.loopSelection.start.toFixed(2)}–${MASTERING.loopSelection.end.toFixed(2)} s`,
      );
    } else {
      MASTERING.loopSelection = drag.previousSelection;
      seekMasteringPreview(waveSecondAt(e.clientX));
    }
  });
  wave.addEventListener('pointercancel', (e) => {
    if (!waveDrag || e.pointerId !== waveDrag.pointerId) return;
    MASTERING.loopSelection = waveDrag.previousSelection;
    waveDrag = null;
    updateMasteringTransportUI();
    drawMasteringOverlay();
  });

  const meterCanvas = document.createElement('canvas');
  meterCanvas.className = 'master-meters-canvas';
  meterCanvas.title =
    'Output metering — momentary/short-term LUFS (K-weighted), stereo peaks with hold, phase correlation, comp gain reduction, spectrum';
  MASTERING.els.meterCanvas = meterCanvas;
  meterCanvas.addEventListener('pointermove', (e) => {
    const rect = meterCanvas.getBoundingClientRect();
    MASTERING.meterHover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // While the preview plays the rAF loop repaints; idle needs an explicit redraw.
    if (!MASTERING.vizFrame) drawMasteringMetersIdle();
  });
  meterCanvas.addEventListener('pointerleave', () => {
    MASTERING.meterHover = null;
    if (!MASTERING.vizFrame) drawMasteringMetersIdle();
  });
  panel.appendChild(meterCanvas);

  // Leveler: plain input trim, permanently first in the signal path — not a
  // chain module, so it can't be reordered or bypassed (0 dB = off).
  const leveler = document.createElement('div');
  leveler.className = 'master-leveler';
  const levelerLabel = document.createElement('span');
  levelerLabel.className = 'master-section-label';
  levelerLabel.textContent = 'Leveler · input';
  const levelerRow = makeControlRow(
    { key: 'levelerGain', label: 'Gain', min: -24, max: 24, step: 0.5, unit: 'dB' },
    MASTERING.params.levelerGain,
    (v) => {
      MASTERING.params.levelerGain = v;
      applyMasteringParams(MASTERING.preview?.chain);
    },
  );
  leveler.append(levelerLabel, levelerRow);
  panel.appendChild(leveler);

  const controls = document.createElement('div');
  controls.className = 'master-controls';
  MASTERING.els.controls = controls;

  const sections = { eq: buildMasteringEqSection() };
  MASTERING_CONTROL_SPECS.forEach(({ id, section, controls: specs }) => {
    const box = document.createElement('div');
    box.className = 'master-section';
    box.dataset.module = id;
    const label = document.createElement('div');
    label.className = 'master-section-label';
    label.textContent = section;
    label.title = 'Drag to reorder the chain';
    label.prepend(makeMasteringDragGrip());
    label.prepend(makeMasteringModulePower(id, box));
    box.appendChild(label);
    if (id === 'opto') {
      // 2A (slow, creamy) / 3A (faster, firmer) character switch.
      const modeGroup = document.createElement('div');
      modeGroup.className = 'master-opto-modes';
      ['2a', '3a'].forEach((mode) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = mode.toUpperCase();
        btn.classList.toggle('active', MASTERING.params.optoMode === mode);
        btn.addEventListener('click', () => {
          MASTERING.params.optoMode = mode;
          modeGroup
            .querySelectorAll('button')
            .forEach((b) => b.classList.toggle('active', b === btn));
          applyMasteringParams(MASTERING.preview?.chain);
        });
        modeGroup.appendChild(btn);
      });
      label.appendChild(modeGroup);
    }
    specs.forEach((spec) => {
      const row = makeControlRow(spec, MASTERING.params[spec.key], (v) => {
        MASTERING.params[spec.key] = v;
        applyMasteringParams(MASTERING.preview?.chain);
      });
      box.appendChild(row);
    });
    sections[id] = box;
  });
  getMasteringOrder().forEach((id) => controls.appendChild(sections[id]));

  // Reorder by dragging a section's label; the audio chain follows the DOM
  // order (output trim always stays last).
  Object.values(sections).forEach((box) => {
    const label = box.querySelector('.master-section-label');
    label.draggable = true;
    label.addEventListener('dragstart', (e) => {
      box.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', box.dataset.module);
        } catch (_) {}
      }
    });
    label.addEventListener('dragend', () => {
      box.classList.remove('dragging');
      const order = [...controls.querySelectorAll('.master-section')].map(
        (el) => el.dataset.module,
      );
      if (order.join() !== getMasteringOrder().join()) {
        MASTERING.params.order = order;
        rebuildMasteringPreviewChain();
        setStatus(`master chain: ${order.join(' → ')}`);
      }
    });
  });
  controls.addEventListener('dragover', (e) => {
    const dragging = controls.querySelector('.master-section.dragging');
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const others = [...controls.querySelectorAll('.master-section:not(.dragging)')];
    const after = others.find((el) => {
      const rect = el.getBoundingClientRect();
      return e.clientX < rect.left + rect.width / 2;
    });
    if (!after) controls.appendChild(dragging);
    else if (after !== dragging) controls.insertBefore(dragging, after);
  });

  panel.appendChild(controls);

  refreshMasteringSourceUI();
  drawMasteringEq();
}

function enterMasteringView() {
  buildMasterPanel();
  refreshMasteringSourceUI();
  drawMasteringEq(); // re-entry redraw: theme or window size may have changed
  if (!MASTERING.preview) drawMasteringMetersIdle();
}

function leaveMasteringView() {
  if (!MASTERING.built) return;
  stopMasteringPreview();
  // Suspend (not close) so re-entry is instant; a suspended context costs
  // nothing per-frame.
  MASTERING.ctx?.suspend?.();
}

const PANEL_VIEWS = ['front', 'back', 'visual', 'master'];

function setPanelView(mode) {
  UI_VIEW.mode = mode;
  // Mirror the view into the URL so a refresh lands back on the same panel;
  // the default front view keeps the URL clean.
  try {
    const url = new URL(window.location);
    if (mode === 'front') url.searchParams.delete('view');
    else url.searchParams.set('view', mode);
    history.replaceState(null, '', url);
  } catch (e) {}
  document.getElementById('loopStrip')?.classList.toggle('hidden-panel', mode !== 'front');
  getFrontWorkspace()?.classList.toggle('hidden-panel', mode !== 'front');
  getBackPanel()?.classList.toggle('hidden-panel', mode !== 'back');
  document.getElementById('visualPanel')?.classList.toggle('hidden-panel', mode !== 'visual');
  document.getElementById('masterPanel')?.classList.toggle('hidden-panel', mode !== 'master');
  getViewToggle()
    ?.querySelectorAll('.view-btn')
    .forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));
  if (mode === 'master') enterMasteringView();
  else leaveMasteringView();
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

  const header = document.createElement('div');
  header.className = 'fx-section-label';
  header.tabIndex = 0;
  header.setAttribute('role', 'button');

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
  header.addEventListener('keydown', (event) => {
    if (event.target !== header || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    setCollapsed(!section.classList.contains('collapsed'));
  });

  header.append(title, toggle);
  section.append(header, content);
  setCollapsed(false);

  return { section, header, content, toggle, setCollapsed };
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
  applyInstrumentMixState();
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
    instrumentMix: Object.fromEntries(
      FX_BUS_IDS.map((busId) => [busId, { ...INSTRUMENT_MIX[busId] }]),
    ),
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
        muted: ch.muted,
        fxSend: ch.fxSend,
        params: { ...ch.params },
      })),
    },
    kickSc: { release: KICK_SC.release, amount: KICK_SC.amount },
    mastering: JSON.parse(JSON.stringify(MASTERING.params)),
    mappings: [...lfoMappings.values()].map(({ genIdx, key, sourceIdx }) => ({
      genIdx,
      key,
      sourceIdx,
    })),
  };
}

function applyPreset(preset, { resetSources = true } = {}) {
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
  if (resetSources) resetGranularSources();

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

  FX_BUS_IDS.forEach((busId) => {
    const saved = preset.instrumentMix?.[busId];
    INSTRUMENT_MIX[busId].muted = saved?.muted === true;
    INSTRUMENT_MIX[busId].solo = saved?.solo === true;
  });
  applyInstrumentMixState();

  if (preset.limiter) {
    Object.assign(LIMITER, preset.limiter);
    applyLimiterAll();
    limiterControls.forEach((control, key) => control.setValue(LIMITER[key]));
    refreshFxPresetSelection('limiter');
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
    GEN4.channels.forEach((ch, ci) => {
      const def = GEN4_DEFS[ci];
      if (!def) return;
      gen4SetChannelMuted(ci, false);
      gen4SetChannelFxSend(ci, def.id !== 'kick');
      def.paramDefs.forEach((pd) => {
        ch.params[pd.key] = pd.value;
        gen4ControlBindings[ci].get(pd.key)?.setValue(pd.value);
      });
      refreshGen4PresetSelection(ci);
    });
    preset.gen4.channels.forEach((saved, ci) => {
      const ch = GEN4.channels[ci];
      const def = GEN4_DEFS[ci];
      if (!ch || !saved || !def) return;
      gen4SetChannelMuted(ci, saved.muted === true);
      if (typeof saved.fxSend === 'boolean') gen4SetChannelFxSend(ci, saved.fxSend);
      def.paramDefs.forEach((pd) => {
        const savedValue = saved.params?.[pd.key];
        ch.params[pd.key] =
          typeof savedValue === 'number' ? clamp(savedValue, pd.min, pd.max) : pd.value;
        gen4ControlBindings[ci].get(pd.key)?.setValue(ch.params[pd.key]);
      });
      refreshGen4PresetSelection(ci);
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
  applyMasteringPreset(preset.mastering || null);
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

function saveProject(name) {
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

function saveProjectFromInput() {
  const input = getProjectNameInput();
  if (!input) return;
  const name = input.value.trim();
  if (!name) {
    setStatus('name required');
    input.focus();
    return;
  }
  saveProject(name);
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

// ── Project file export/import ── a portable .grnsh.json: the full preset
// plus both generators' source clips (float32 samples, base64), so a project
// survives browser-data wipes and moves between machines.

function floatsToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToFloats(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Same conditions as persistAudioForScope, but reading the live source state
// into a JSON-safe shape.
function captureExportAudio() {
  const audio = {};
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const source = getSourceState(genIdx);
    if (source.mode === 'file' && source.bufferData) {
      audio[`gen${genIdx}`] = {
        mode: 'file',
        samples: floatsToBase64(source.bufferData),
        sampleRate: audioCtx?.sampleRate || 48000,
        durationSec: source.durationSec,
        fileName: source.fileName,
      };
    } else if (source.mode === 'mic' && source.frozenData && state[genIdx].freeze) {
      audio[`gen${genIdx}`] = {
        mode: 'frozen',
        samples: floatsToBase64(source.frozenData.samples),
        frozenAt: source.frozenData.frozenAt,
        sampleRate: source.frozenData.sampleRate,
      };
    }
  }
  return audio;
}

function exportProjectFile() {
  const name = currentProjectName || getProjectNameInput()?.value.trim() || 'grnsh-project';
  const payload = {
    format: 'grnsh-project',
    version: 1,
    name,
    savedAt: Date.now(),
    data: capturePreset(),
    audio: captureExportAudio(),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, '_')}.grnsh.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`exported "${name}"`);
}

async function importProjectFile(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (e) {
    payload = null;
  }
  if (payload?.format !== 'grnsh-project' || !payload.data) {
    setStatus('import failed: not a grnsh project file');
    return;
  }
  applyPreset(payload.data);
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const clip = payload.audio?.[`gen${genIdx}`];
    if (!clip?.samples) continue;
    try {
      await applyRestoredClip(genIdx, { ...clip, samples: base64ToFloats(clip.samples) });
    } catch (e) {}
  }
  queueAutosaveAudio();
  currentProjectName = typeof payload.name === 'string' && payload.name ? payload.name : null;
  const input = getProjectNameInput();
  if (input && currentProjectName) input.value = currentProjectName;
  closeProjectMenu();
  refreshProjectUI();
  historyCaptureNow();
  setStatus(`imported "${currentProjectName || 'project'}" — Save to keep it`);
}

async function deleteProject(name) {
  const idx = findProjectIndex(name);
  if (idx < 0) return;
  const confirmed = await appConfirm(`Delete project "${projectStore[idx].name}"?`, {
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  if (findProjectIndex(name) !== idx) return; // store changed while the dialog was up
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

async function newProject() {
  if (!defaultProjectSnapshot) return;
  const confirmed = await appConfirm('Start a new blank project? Unsaved changes will be lost.', {
    confirmLabel: 'New project',
  });
  if (!confirmed) return;
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
  document.getElementById('projectExportBtn')?.addEventListener('click', exportProjectFile);
  const importInput = document.getElementById('projectImportInput');
  document
    .getElementById('projectImportBtn')
    ?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (file) importProjectFile(file);
  });
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
const fxPresetSelects = new Map();

function getFxPresetState(effectId) {
  return effectId === 'limiter' ? LIMITER : FX[effectId];
}

function getMatchingFxPresetIndex(effectId) {
  const current = getFxPresetState(effectId);
  if (!current) return -1;
  return (FX_PRESETS[effectId] || []).findIndex(({ values }) =>
    Object.entries(values).every(([key, value]) => current[key] === value),
  );
}

function refreshFxPresetSelection(effectId) {
  const select = fxPresetSelects.get(effectId);
  if (!select) return;
  const presetIndex = getMatchingFxPresetIndex(effectId);
  select.value = presetIndex < 0 ? '' : `${presetIndex}`;
}

function markFxPresetCustom(effectId) {
  const select = fxPresetSelects.get(effectId);
  if (select) select.value = '';
}

function applyFxPreset(effectId, presetIndex) {
  const preset = FX_PRESETS[effectId]?.[presetIndex];
  const target = getFxPresetState(effectId);
  if (!preset || !target) return;
  Object.assign(target, preset.values);

  if (effectId === 'limiter') {
    applyLimiterAll();
    limiterControls.forEach((control, key) => control.setValue(LIMITER[key]));
    refreshFxPresetSelection(effectId);
  } else {
    applyAllFx(activeBus);
    applyFxModulation();
    renderActiveBusFx();
  }
  refreshBackPanelState();
}

function buildFxPresetSelect(effectId) {
  const presets = FX_PRESETS[effectId];
  if (!presets?.length) return null;

  const select = document.createElement('select');
  select.className = 'fx-preset-select';
  select.title = `Choose a ${effectId} preset`;

  const customOption = document.createElement('option');
  customOption.value = '';
  customOption.textContent = 'Custom';
  select.appendChild(customOption);

  presets.forEach(({ name }, presetIndex) => {
    const option = document.createElement('option');
    option.value = `${presetIndex}`;
    option.textContent = name;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (select.value === '') return;
    applyFxPreset(effectId, Number(select.value));
  });
  select.addEventListener('click', (event) => event.stopPropagation());
  select.addEventListener('keydown', (event) => event.stopPropagation());

  fxPresetSelects.set(effectId, select);
  refreshFxPresetSelection(effectId);
  return select;
}

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
  const { section, header, content, toggle } = createFxSection(def.label);
  limiterControls.clear();
  const presetSelect = buildFxPresetSelect(def.id);
  if (presetSelect) header.insertBefore(presetSelect, toggle);
  def.params.forEach((p) => {
    const control = makeControlRow(
      p,
      LIMITER[p.key],
      (v) => {
        markFxPresetCustom(def.id);
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
  DEFAULT_FX_ORDER.forEach((effectId) => fxPresetSelects.delete(effectId));

  const fxDefById = new Map(FX_DEFS.map((def) => [def.id, def]));
  fxOrders[activeBus].forEach((fxId) => {
    const def = fxDefById.get(fxId);
    if (!def) return;
    const { section, header, content, toggle } = createFxSection(def.label);
    const presetSelect = buildFxPresetSelect(def.id);
    if (presetSelect) header.insertBefore(presetSelect, toggle);

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
          markFxPresetCustom(def.id);
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
          markFxPresetCustom(def.id);
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
          markFxPresetCustom(def.id);
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
          markFxPresetCustom(def.id);
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
          markFxPresetCustom(def.id);
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
          markFxPresetCustom(def.id);
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

  setStatus('idle');
  resetGenVizState(0);
  resetGenVizState(1);
  drawGenVizIdle(0);
  drawGenVizIdle(1);
  drawGenVizEmpty(2);
  refreshBackPanelState();
}

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
  if (Number.isFinite(next)) setTransportBpm(next, { updateField: false });
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
  if (BOUNCE.active) {
    finishBounce('bounce cancelled', { save: false });
    return;
  }
  REC.isRecording ? stopRecording() : startRecording();
});

document.getElementById('bounceBtn')?.addEventListener('click', bounceSong);

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
initStripPlayBtn();
initSettingsMenu();
initConfirmDialog();
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
initHistory();
setInterval(writeAutosave, AUTOSAVE_INTERVAL_MS);
window.addEventListener('beforeunload', () => {
  writeAutosave();
  flushAutosaveAudio();
});
{
  // Restore the panel a refresh happened on (?view=master etc.).
  const requestedView = new URLSearchParams(window.location.search).get('view');
  setPanelView(PANEL_VIEWS.includes(requestedView) ? requestedView : 'front');
}

window.addEventListener('resize', () => {
  if (UI_VIEW.mode === 'back') rebuildBackWireSVG();
  if (UI_VIEW.mode === 'master' && MASTERING.built) {
    drawMasteringWave();
    drawMasteringOverlay();
    drawMasteringEq();
    if (!MASTERING.preview) drawMasteringMetersIdle();
  }
});

window.addEventListener('keydown', (event) => {
  // While any modal dialog is up, keys belong to it — Esc closes it natively,
  // and Space/Tab must not reach the transport or panel toggle underneath.
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') {
    clearBackPatchSelection();
    closeProjectMenu();
    closeSongBlockMenu();
    closeModSourceMenu();
    closeGen4VariationMenu();
    closeSettingsMenu();
  }
  if (event.key === 'Tab' && !event.target.closest('input, textarea, select')) {
    event.preventDefault();
    setPanelView(UI_VIEW.mode === 'front' ? 'back' : 'front');
  }
  if (event.code === 'Space' && !event.target.closest('input, textarea, select')) {
    // preventDefault also swallows the "space clicks the focused button"
    // default, so a focused ▶ doesn't toggle twice.
    event.preventDefault();
    stripPlayToggle();
  }
});

// Capture phase: inputs that stopPropagation (rename fields, fx headers)
// must never let ⌘S fall through to the browser's save-page dialog.
window.addEventListener(
  'keydown',
  (event) => {
    if (document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (currentProjectName) saveProject(currentProjectName);
      else openProjectMenu(); // unnamed project — pick a name first
    }
    // Readonly fields (the tempo box outside typing mode) have no native text
    // undo — only a genuinely editable field keeps the browser's ⌘Z.
    const inTextField = event.target.closest?.(
      'input[type="text"]:not([readonly]), input[type="number"]:not([readonly]), textarea',
    );
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !inTextField) {
      // Text fields keep the browser's native text undo.
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'y' && !inTextField) {
      event.preventDefault();
      redo();
    }
  },
  { capture: true },
);
