// grnsh — main thread: mic capture, worklet setup, UI wiring.

const THEME_STORAGE_KEY = 'grnsh-theme-v1';
const APP_THEMES = new Set([
  'original',
  'sober',
  'slate-arrangement',
  'slate-session',
  'neon-flux',
  'aurora',
  'acid-circuit',
  'solar-ritual',
]);
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
let resonatorModulePromise = null;
let grainArpModulePromise = null;
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
  connFrame: null,
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
  if (status) {
    status.textContent = text;
    status.title = text;
  }
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

function midiToFreqHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqHzToMidi(freq) {
  return 69 + 12 * Math.log2(Math.max(1, freq) / 440);
}

function formatResonatorNote(midi) {
  const m = Math.round(midi);
  return `${GEN4_ROOT_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

function getResonatorFreqHz(busId = activeBus) {
  const r = fxStates[busId].resonator;
  return clamp(r.noteMode ? midiToFreqHz(r.note) : r.freq, 40, 2000);
}

function getBeatRepeatIntervalSeconds(busId = activeBus) {
  const b = fxStates[busId].beatrepeat;
  return b.sync ? beatsToSeconds(getTempoStep(b.syncIndex).beats) : b.interval;
}

function getBeatRepeatGridSeconds(busId = activeBus) {
  const b = fxStates[busId].beatrepeat;
  return b.gridSync ? beatsToSeconds(getGrainSyncStep(b.gridSyncIndex).beats) : b.grid / 1000;
}

function getGrainArpGridSeconds(busId = activeBus) {
  const g = fxStates[busId].grainarp;
  return g.gridSync ? beatsToSeconds(getGrainSyncStep(g.gridSyncIndex).beats) : g.grid / 1000;
}

function getLfoRateHz(lfo) {
  return lfo.sync ? 1 / beatsToSeconds(getTempoStep(lfo.syncIndex).beats) : lfo.rate;
}

function refreshRecordButton() {
  const btn = getRecordBtn();
  if (!btn) return;
  btn.classList.toggle('active', REC.isRecording);
  btn.textContent = REC.isRecording ? '■ STOP REC' : '●';
  btn.title = REC.isRecording ? 'Stop and save recording' : 'Start recording';
  btn.setAttribute('aria-label', REC.isRecording ? 'Stop and save recording' : 'Start recording');
  btn.setAttribute('aria-pressed', String(REC.isRecording));
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
// The mastering source wav (bounced song or loaded file) rides along under
// `<scope>:master`.

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
  const ms = MASTERING.source;
  const masterKey = `${scope}:master`;
  if (ms?.left?.length) {
    await audioClipPut(masterKey, {
      mode: 'master',
      left: ms.left,
      right: ms.right,
      sampleRate: ms.sampleRate,
      name: ms.name,
    });
  } else {
    await audioClipDelete(masterKey);
  }
}

async function deleteAudioForScope(scope) {
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    await audioClipDelete(`${scope}:gen${genIdx}`);
  }
  await audioClipDelete(`${scope}:master`);
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
    if (clip) {
      await applyRestoredClip(genIdx, clip);
    } else {
      // bindEditLoop may temporarily preserve a file position beyond the
      // placeholder 10-second duration while waiting for its audio. If no
      // clip exists, this is the point where that placeholder becomes final.
      setSourceDurationSec(genIdx, getSourceState(genIdx).durationSec);
    }
  }
  const masterClip = await audioClipGet(`${scope}:master`);
  if (masterClip?.left?.length && masterClip.right?.length) {
    setMasteringSource(
      masterClip.left,
      masterClip.right,
      masterClip.sampleRate || 48000,
      masterClip.name,
    );
  } else {
    // A scope without master audio must not inherit the previous project's wav.
    clearMasteringSource();
  }
  // A restore that leaves no generator on the mic releases the input stream.
  if (!anyMicSourceSelected()) disconnectGranularInput({ stopTracks: true });
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

function getViewButtons() {
  return document.querySelectorAll('.view-btn[data-view]');
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
  if (!resonatorModulePromise) {
    resonatorModulePromise = audioCtx.audioWorklet.addModule(workletUrl('resonator-processor.js'));
  }
  if (!grainArpModulePromise) {
    grainArpModulePromise = audioCtx.audioWorklet.addModule(workletUrl('grain-arp-processor.js'));
  }
  await Promise.all([
    bitReducerModulePromise,
    beatRepeatModulePromise,
    resonatorModulePromise,
    grainArpModulePromise,
  ]);
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

async function startRecording({ bufferSize = 4096 } = {}) {
  if (REC.isRecording) return;
  await ensureAudioEngine();
  if (!master?.output || !audioCtx) return;

  REC.left = [];
  REC.right = [];
  REC.sampleCount = 0;

  const processor = audioCtx.createScriptProcessor(bufferSize, 2, 2);
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
  setStatus('recording — press STOP REC to finish');
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

// ── Stem taps ── during a stems bounce each instrument bus gets its own
// capture tap on its post-FX output (pre master limiter/mastering), so one
// realtime pass yields a wav per bus alongside the master.
const STEM_TAPS = { active: false, taps: [] };

function startStemTaps({ bufferSize = 4096 } = {}) {
  stopStemTaps({ save: false });
  STEM_TAPS.taps = FX_BUS_IDS.map((busId) => {
    const bus = fxBuses[busId];
    if (!bus) return null;
    const processor = audioCtx.createScriptProcessor(bufferSize, 2, 2);
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    const tap = { busId, processor, sink, left: [], right: [], sampleCount: 0, peak: 0 };
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer;
      const inL = input.getChannelData(0);
      const inR = input.numberOfChannels > 1 ? input.getChannelData(1) : inL;
      tap.left.push(new Float32Array(inL));
      tap.right.push(new Float32Array(inR));
      tap.sampleCount += inL.length;
      for (let i = 0; i < inL.length; i += 64) {
        const a = Math.abs(inL[i]);
        if (a > tap.peak) tap.peak = a;
      }
    };
    bus.output.connect(processor);
    processor.connect(sink);
    sink.connect(audioCtx.destination);
    return tap;
  }).filter(Boolean);
  STEM_TAPS.active = STEM_TAPS.taps.length > 0;
}

function stopStemTaps({ save = false, baseName = 'grnsh' } = {}) {
  const taps = STEM_TAPS.taps;
  STEM_TAPS.taps = [];
  STEM_TAPS.active = false;
  let written = 0;
  taps.forEach((tap) => {
    try {
      fxBuses[tap.busId]?.output.disconnect(tap.processor);
    } catch (e) {}
    try {
      tap.processor.disconnect();
    } catch (e) {}
    tap.processor.onaudioprocess = null;
    try {
      tap.sink.disconnect();
    } catch (e) {}
    // Skip silent stems — an unused instrument shouldn't cost a download.
    if (save && tap.sampleCount > 0 && tap.peak > 1e-5 && audioCtx) {
      const left = mergeFloat32(tap.left, tap.sampleCount);
      const right = mergeFloat32(tap.right, tap.sampleCount);
      REC.downloadName = `${baseName}-stem-${tap.busId}.wav`;
      downloadRecording(encodeWav(left, right, audioCtx.sampleRate));
      written += 1;
    }
    tap.left = [];
    tap.right = [];
  });
  return written;
}

// ── Song bounce ── renders the arrangement to a WAV: master is unhooked from
// the speakers while the real graph feeds the record tap. A non-looping song
// renders once plus its FX tail; Song Loop repeats until the selected limit.

const BOUNCE_TAIL_MS = 2000;
const BOUNCE_CAPTURE_BUFFER_SIZE = 16384;
// Jumps can loop the song; a 100%-chance ∞ jump would render forever. The
// bounce stops (and saves) at this limit.
const BOUNCE_CAP_FACTOR = 4;
const BOUNCE = {
  active: false,
  muted: false,
  pollTimer: null,
  progressTimer: null,
  tailTimer: null,
  phase: 'idle',
  songSeconds: 0,
  capSeconds: 0,
  renderedSeconds: 0,
  tailStartedAt: 0,
  prevMode: 'loop',
  prevSongLoop: true,
  prevScheduleAheadTime: 0.15,
};

function getBounceSongSeconds() {
  const secPerStep = 60 / TRANSPORT.bpm / 4;
  return SONG.entries.reduce((seconds, entry) => {
    const loop = getLoopById(entry.loopId);
    if (!loop) return seconds;
    return seconds + loop.gen4.stepCount * Math.max(1, entry.repeats) * secPerStep;
  }, 0);
}

// Written length from the playing cursor onward, assuming a straight run to
// the end. Recomputed per progress tick, so every jump, skipped block, or
// condition re-aims the estimate instead of leaving the bar stuck on the
// original linear guess.
function getBounceRemainingSeconds() {
  const secPerStep = 60 / TRANSPORT.bpm / 4;
  let seconds = 0;
  SONG.entries.forEach((entry, i) => {
    if (i < SONG.cursor.entryIdx) return;
    const loop = getLoopById(entry.loopId);
    if (!loop) return;
    let cycles = Math.max(1, entry.repeats);
    if (i === SONG.cursor.entryIdx) {
      cycles = Math.max(1, cycles - Math.max(0, SONG.cursor.repeat));
    }
    seconds += loop.gen4.stepCount * cycles * secPerStep;
  });
  return seconds;
}

function formatSongClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Approximate song length for the header/bounce readouts. Expected weighs
// each entry by its probability and drops entries whose condition skips the
// first visit; jumps are flagged as open-ended rather than modeled.
function getSongLengthEstimate() {
  const secPerStep = 60 / TRANSPORT.bpm / 4;
  let written = 0;
  let expected = 0;
  let openEnded = false;
  SONG.entries.forEach((entry) => {
    const loop = getLoopById(entry.loopId);
    if (!loop) return;
    const len = loop.gen4.stepCount * Math.max(1, entry.repeats) * secPerStep;
    written += len;
    const cond = SONG_CONDITIONS[entry.cond || 0];
    if (!cond?.b || cond.a === 1) expected += len * (entry.prob ?? 1);
    if (entry.jump?.targetId && (entry.jump.chance ?? 1) > 0) openEnded = true;
  });
  return { written, expected, openEnded };
}

function setBounceProgress(progress) {
  const normalized = clamp(progress, 0, 1);
  const percent = Math.round(normalized * 100);
  // Two bars: the transport strip's, and the master toolbar's (the strip is
  // hidden in master view, where bounces are also triggered).
  [document.getElementById('bounceProgress'), MASTERING.els.bounceProgress].forEach((wrap) => {
    if (!wrap) return;
    wrap.hidden = !BOUNCE.active;
    wrap.setAttribute('aria-valuenow', String(percent));
    const fill = wrap.querySelector('.bounce-progress-fill');
    const label = wrap.querySelector('.bounce-progress-label');
    if (fill) fill.style.width = `${percent}%`;
    if (label) label.textContent = `${percent}%`;
  });
}

function refreshBounceProgress() {
  if (!BOUNCE.active) {
    setBounceProgress(0);
    return;
  }
  const tailSeconds = BOUNCE_TAIL_MS / 1000;
  if (BOUNCE.phase === 'preparing') {
    setBounceProgress(0);
    return;
  }
  if (BOUNCE.phase === 'tail') {
    const done = BOUNCE.renderedSeconds;
    const total = Math.max(0.001, done + tailSeconds);
    const tailElapsed = Math.max(0, performance.now() - BOUNCE.tailStartedAt) / 1000;
    setBounceProgress(
      (done + clamp(tailElapsed, 0, tailSeconds)) / total,
    );
    return;
  }
  // elapsed / (elapsed + live remaining): honest under jumps — the bar dips
  // when a jump throws the song backward instead of pinning at 100%.
  const elapsed = audioCtx ? REC.sampleCount / audioCtx.sampleRate : 0;
  if (BOUNCE.prevSongLoop) {
    setBounceProgress(elapsed / Math.max(0.001, BOUNCE.capSeconds));
    return;
  }
  const total = Math.max(0.001, elapsed + getBounceRemainingSeconds() + tailSeconds);
  setBounceProgress(clamp(elapsed / total, 0, 1));
}

function muteBounceOutput() {
  if (!master?.output || !audioCtx || BOUNCE.muted) return;
  try {
    master.output.disconnect(audioCtx.destination);
    BOUNCE.muted = true;
  } catch (e) {}
}

async function bounceSong(opts = {}) {
  // The settings menu picks the default; ⇧-click on the bounce button inverts it.
  const stems = opts?.invert === true ? !BOUNCE_RENDER.stems : BOUNCE_RENDER.stems;
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
  if (audioCtx?.state === 'running') await stopTransport();
  BOUNCE.prevMode = PLAY.mode;
  BOUNCE.prevSongLoop = SONG.loop;
  BOUNCE.prevScheduleAheadTime = GEN4.scheduleAheadTime;
  BOUNCE.active = true;
  BOUNCE.phase = 'preparing';
  BOUNCE.songSeconds = getBounceSongSeconds();
  const userCap = Number(BOUNCE_CAP.value);
  BOUNCE.capSeconds =
    Number.isFinite(userCap) && userCap > 0
      ? userCap
      : Math.max(BOUNCE.songSeconds * BOUNCE_CAP_FACTOR, BOUNCE.songSeconds + 30);
  BOUNCE.renderedSeconds = 0;
  BOUNCE.tailStartedAt = 0;
  GEN4.scheduleAheadTime = Math.max(GEN4.scheduleAheadTime, 0.5);
  refreshBounceUI();
  try {
    // Existing engines are suspended above, so unplugging the monitor here is
    // silent. A new engine is unplugged again immediately after it is built.
    muteBounceOutput();
    setPlayMode('song');
    SONG.loop = BOUNCE.prevSongLoop;
    await ensureTransportEngine();
    muteBounceOutput();
    if (!started) await start();
    await startRecording({ bufferSize: BOUNCE_CAPTURE_BUFFER_SIZE });
    if (stems) startStemTaps({ bufferSize: BOUNCE_CAPTURE_BUFFER_SIZE });
    startGen4Sequencer();
    if (!GEN4.playing) {
      finishBounce('bounce failed to start', { save: false });
      return;
    }
    BOUNCE.phase = 'rendering';
    BOUNCE.progressTimer = setInterval(refreshBounceProgress, 100);
    refreshBounceProgress();
    setStatus(
      BOUNCE.prevSongLoop
        ? `loop → max ${formatSongClock(BOUNCE.capSeconds)}`
        : `bounce ≈${formatSongClock(BOUNCE.songSeconds)} · max ${formatSongClock(BOUNCE.capSeconds)}`,
    );
    BOUNCE.pollTimer = setInterval(() => {
      const elapsed = audioCtx ? REC.sampleCount / audioCtx.sampleRate : 0;
      if (GEN4.playing && elapsed > BOUNCE.capSeconds) {
        finishBounce(
          BOUNCE.prevSongLoop
            ? `song bounced at ${formatSongClock(BOUNCE.capSeconds)} limit`
            : `bounce stopped at ${Math.round(BOUNCE.capSeconds)}s safety limit — check ∞ jumps`,
        );
        return;
      }
      if (!GEN4.playing && !BOUNCE.tailTimer) {
        clearInterval(BOUNCE.pollTimer);
        BOUNCE.pollTimer = null;
        BOUNCE.phase = 'tail';
        BOUNCE.renderedSeconds = elapsed;
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
  GEN4.scheduleAheadTime = BOUNCE.prevScheduleAheadTime;
  if (GEN4.playing) stopGen4Sequencer();
  let stemCount = 0;
  if (STEM_TAPS.active) {
    stemCount = stopStemTaps({
      save,
      baseName: (currentProjectName || 'grnsh').replace(/[^\w.-]+/g, '_'),
    });
  }
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
  const restoreMonitor = BOUNCE.muted;
  BOUNCE.muted = false;
  SONG.loop = BOUNCE.prevSongLoop;
  setPlayMode(BOUNCE.prevMode);
  // The bounce booted the engine; a bounce always begins from a stopped
  // transport, so return to silence instead of leaving the granulars running.
  Promise.resolve(stopTransport()).finally(() => {
    if (!restoreMonitor || !master?.output || !audioCtx) return;
    try {
      master.output.connect(audioCtx.destination);
    } catch (e) {}
  });
  refreshBounceUI();
  setStatus(statusText || (stemCount ? `song bounced + ${stemCount} stems` : 'song bounced'));
}

function refreshBounceUI() {
  const btn = document.getElementById('bounceBtn');
  if (!btn) return;
  btn.classList.toggle('active', BOUNCE.active);
  btn.title = BOUNCE.active
    ? 'Cancel bounce'
    : `Bounce song to WAV — ${BOUNCE_RENDER.stems ? 'master + per-instrument stems' : 'master only'} (set in ⚙ options; ⇧-click for the other mode)`;
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

function drawGenCaptureHint(c, gi, W, H, frozen = state[gi]?.freeze) {
  if (gi > 1 || frozen || !started || getSourceState(gi)?.mode !== 'mic') return;
  const label = '● LIVE BUFFER · CLICK TO STOP';

  c.save();
  c.font = '700 9px ui-monospace, monospace';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const labelWidth = Math.ceil(c.measureText(label).width) + 18;
  const x = Math.round((W - labelWidth) / 2);
  const y = 8;
  c.fillStyle = 'rgba(9, 18, 12, 0.88)';
  c.fillRect(x, y, labelWidth, 20);
  c.strokeStyle = `${GEN_VIZ[gi].line}b8`;
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, y + 0.5, labelWidth - 1, 19);
  c.fillStyle = GEN_VIZ[gi].line;
  c.fillText(label, W / 2, y + 10.5);
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
    c.fillText('press play to start', W / 2, H / 2 + 27);
  }
  c.restore();
  drawGenCaptureHint(c, gi, W, H);
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

  drawGenCaptureHint(c, gi, W, H);

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

  drawGenCaptureHint(c, gi, W, H, state.frozen);
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
    grainSizeMs: 308,
    density: 20,
    positionSec: 0.51,
    spraySec: 0.05,
    pitch: 0,
    pitchJitter: 0,
    spread: 0.63,
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
    positionSec: 3.26,
    spraySec: 0.03,
    pitch: 0,
    pitchJitter: 0,
    spread: 1,
    gain: 0.34,
    reverse: true,
    envType: 'soft',
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
let resonatorNoteModeControl = null;
let beatRepeatSyncModeControl = null;
let beatRepeatGridSyncModeControl = null;
let grainArpGridSyncModeControl = null;
let grainArpHoldButton = null;
const grainArpPatternButtons = new Map();
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
  { id: 'beatrepeat', key: 'gate', min: 1, max: 32 },
  { id: 'beatrepeat', key: 'pitch', min: -24, max: 24, unit: 'st' },
  { id: 'beatrepeat', key: 'decay', min: 0, max: 1 },
  { id: 'beatrepeat', key: 'chance', min: 0, max: 1 },
  { id: 'beatrepeat', key: 'mix', min: 0, max: 1 },
  { id: 'grainarp', key: 'chance', min: 0, max: 1 },
  { id: 'grainarp', key: 'shape', min: 0, max: 1 },
  { id: 'grainarp', key: 'scatter', min: 0, max: 1 },
  { id: 'grainarp', key: 'reverse', min: 0, max: 1 },
  { id: 'grainarp', key: 'feedback', min: 0, max: 0.85 },
  { id: 'grainarp', key: 'mix', min: 0, max: 1 },
  { id: 'delay', key: 'time', min: 0, max: MAX_DELAY_SECONDS },
  { id: 'delay', key: 'feedback', min: 0, max: 0.95 },
  { id: 'delay', key: 'mix', min: 0, max: 1 },
  { id: 'filter', key: 'cutoff', min: 80, max: 14000 },
  { id: 'filter', key: 'q', min: 0.1, max: 20 },
  { id: 'filter', key: 'mix', min: 0, max: 1 },
  { id: 'resonator', key: 'freq', min: 40, max: 2000 },
  { id: 'resonator', key: 'decay', min: 0, max: 0.98 },
  { id: 'resonator', key: 'int2', min: -24, max: 24, unit: 'st' },
  { id: 'resonator', key: 'int3', min: -24, max: 24, unit: 'st' },
  { id: 'resonator', key: 'harm2', min: 0, max: 1 },
  { id: 'resonator', key: 'harm3', min: 0, max: 1 },
  { id: 'resonator', key: 'mix', min: 0, max: 1 },
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
  { id: 'grainarp', title: 'Grain Arp' },
  { id: 'delay', title: 'Delay' },
  { id: 'filter', title: 'Filter' },
  { id: 'resonator', title: 'Resonator' },
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
    refreshGeneratorCaptureUI(genIdx);
    if (send) sendParams(genIdx);
  }
}

function anyMicSourceSelected() {
  return GRANULAR_SOURCES.some((source) => source.mode === 'mic');
}

function canFreezeGenerator(genIdx) {
  return started && getSourceState(genIdx)?.mode === 'mic';
}

function refreshGeneratorCaptureUI(genIdx) {
  const frozen = !!state[genIdx]?.freeze;
  const isMic = getSourceState(genIdx)?.mode === 'mic';
  const captureStopped = isMic && frozen;
  const canFreeze = canFreezeGenerator(genIdx);
  const freezeBtn = genFreezeButtons[genIdx];
  const canvas = genVizCanvases[genIdx];

  if (freezeBtn) {
    freezeBtn.disabled = !canFreeze;
    freezeBtn.classList.toggle('active', captureStopped);
    freezeBtn.textContent = captureStopped ? 'Resume ▶' : 'Freeze ❄︎';
    freezeBtn.title = captureStopped
      ? 'Resume this granular live buffer'
      : 'Stop this granular live buffer';
  }

  if (canvas) {
    canvas.classList.toggle('capture-live', isMic && canFreeze && !captureStopped);
    canvas.classList.remove('capture-frozen');
    canvas.title = !isMic
      ? 'Drag to choose the playback position'
      : captureStopped
        ? 'Capture stopped; use Resume above to restart it, or drag to choose the playback position'
        : canFreeze
          ? 'Click to stop this granular live buffer; drag to choose the playback position'
          : 'The live buffer starts with playback';
  }
}

function toggleGeneratorFreeze(genIdx) {
  if (!canFreezeGenerator(genIdx)) return;
  const frozen = !state[genIdx].freeze;
  state[genIdx].freeze = frozen;
  // On freeze the worklet answers with a persisted frozen-dump. Resuming
  // drops that take and returns this generator to its rolling live buffer.
  if (!frozen) setGenFrozenData(genIdx, null);
  refreshGeneratorCaptureUI(genIdx);
  sendParams(genIdx);
  setStatus(
    frozen
      ? `granular ${genIdx + 1} capture stopped — press Resume to restart`
      : `granular ${genIdx + 1} live capture resumed`,
  );
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
  refreshGeneratorCaptureUI(genIdx);
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

function setGeneratorParam(genIdx, key, value, { send = true, deferMaxClamp = false } = {}) {
  const param = getParamBounds(genIdx, key);
  if (!param) return;
  const finiteValue = Number.isFinite(value) ? value : param.min;
  const next = Math.max(
    param.min,
    deferMaxClamp && key === 'positionSec' ? finiteValue : Math.min(param.max, finiteValue),
  );
  state[genIdx][key] = next;
  const control = genControlBindings[genIdx].get(key);
  if (deferMaxClamp && key === 'positionSec') {
    // Keep the restored value representable until applyRestoredClip supplies
    // the WAV's real duration and performs the authoritative clamp.
    control?.setConfig({ min: param.min, max: Math.max(param.max, next) });
  }
  control?.setValue(next);
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
      effective[key] = Math.max(
        paramDef.min,
        Math.min(paramDef.max, effective[key] + getModOffset(sourceIdx, scaled, paramDef)),
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

function getGen3SoundState() {
  if (PLAY.mode === 'song' && GEN4.playing) {
    const audibleEntry = SONG.entries[SONG.audibleEntryIdx];
    const base =
      getLoopById(audibleEntry?.loopId)?.gen3 ||
      getSchedulerLoop()?.gen3 ||
      getEditLoop()?.gen3 ||
      GEN3;
    // Mid-morph the synth blends toward the next block's gen3 sound, same
    // ramp as the granular gens (numerics glide, type/sustainMode snap at
    // the midpoint).
    const morphTo = SONG_MORPH.t > 0 ? SONG_MORPH.loop?.gen3 : null;
    if (morphTo && morphTo !== base) return lerpGens(base, morphTo, SONG_MORPH.t);
    return base;
  }
  return GEN3;
}

function getEffectiveGen3Params(base = getGen3SoundState()) {
  const effective = {
    gain: base.gain,
    pitch: base.pitch,
    detune: base.detune,
    decay: base.decay,
    sustain: base.sustain,
  };
  if (lfoMappings.size > 0) {
    lfoMappings.forEach(({ genIdx, key, sourceIdx }) => {
      if (genIdx !== 2) return;
      const paramDef = getGen3ParamBounds(key);
      const scaled = getModSourceScaledValue(sourceIdx);
      if (!paramDef || scaled === null) return;
      effective[key] = Math.max(
        paramDef.min,
        Math.min(paramDef.max, effective[key] + getModOffset(sourceIdx, scaled, paramDef)),
      );
    });
  }
  return effective;
}

// Offset a mapping contributes: sources are bipolar −1..1 over half the param
// range — except SEQ 1 into a semitone param, where the seq's 1/12 levels map
// one-to-one to semitones (a +7 step moves the pitch a fifth).
function getModOffset(sourceIdx, scaled, paramDef) {
  if (sourceIdx === 2 && paramDef?.unit === 'st') return Math.round(scaled * 12);
  return scaled * ((paramDef.max - paramDef.min) * 0.5);
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
  if (sourceIdx === 4) {
    const v = TRIG_SC.envelope * 2 * TRIG_SC.amount;
    return TRIG_SC.invert ? v : -v;
  }
  return null;
}

function getBaseFxValue(id, key, busId = activeBus) {
  if (id === 'delay' && key === 'time') return getDelayTimeSeconds(busId);
  if (id === 'beatrepeat' && key === 'interval') return getBeatRepeatIntervalSeconds(busId);
  if (id === 'beatrepeat' && key === 'grid') return getBeatRepeatGridSeconds(busId);
  if (id === 'grainarp' && key === 'grid') return getGrainArpGridSeconds(busId);
  if (id === 'resonator' && key === 'freq') return getResonatorFreqHz(busId);
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
  return Math.max(
    paramDef.min,
    Math.min(paramDef.max, base + getModOffset(mapping.sourceIdx, scaled, paramDef)),
  );
}

const MIXER_PAN_PARAM = { min: -1, max: 1, step: 0.01, unit: '' };

function getEffectiveMixerPan(busId) {
  const base = INSTRUMENT_MIX[busId]?.pan ?? 0;
  const mapping = lfoMappings.get(`5:${busId}:pan`);
  if (!mapping) return base;
  const scaled = getModSourceScaledValue(mapping.sourceIdx);
  if (scaled === null) return base;
  return clamp(
    base + getModOffset(mapping.sourceIdx, scaled, MIXER_PAN_PARAM),
    MIXER_PAN_PARAM.min,
    MIXER_PAN_PARAM.max,
  );
}

let modVisualsActive = false; // were modulation visuals showing last frame?

let backStateLastLiveRefresh = 0;
let modVisualsLastLiveRefresh = 0;

function applyMappedModulationTargets() {
  const hasMappings = lfoMappings.size > 0;
  const gens = hasMappings ? new Set([...lfoMappings.values()].map((m) => m.genIdx)) : new Set();
  if (hasMappings) {
    gens.forEach((gi) => {
      if (gi === 2) applyGen3Modulation();
      else if (gi === 3) applyFxModulationMapped();
      else if (gi === 4) applyGen4Modulation();
      else if (gi === 5) applyMixerPanModulationMapped();
      else sendParams(gi);
    });
  }
  // Visual refreshes only matter for the panel currently on screen. Skip the
  // front-control mod visuals once there's nothing to show (one extra frame to
  // clear), and only run the back panel's live meter while the back view is up.
  // The live sweep touches every control's DOM, so cap it at ~30Hz — the
  // final clear when the last mapping goes away still runs immediately.
  if (UI_VIEW.mode === 'front' && (hasMappings || modVisualsActive)) {
    const now = performance.now();
    if (!hasMappings || now - modVisualsLastLiveRefresh >= 33) {
      modVisualsLastLiveRefresh = now;
      refreshModulationVisuals();
    }
  }
  // The back board rewrites every module's subtitles/meters — too heavy to run
  // each frame alongside the wire loop, so cap this live refresh at ~30Hz.
  // Event-driven refreshBackPanelState() calls stay immediate.
  if (UI_VIEW.mode === 'back') {
    const now = performance.now();
    if (now - backStateLastLiveRefresh >= 33) {
      backStateLastLiveRefresh = now;
      refreshBackPanelState();
    }
  }
  if (UI_VIEW.mode === 'mixer' && gens.has(5)) {
    const now = performance.now();
    if (now - mixerModVisualsLastRefresh >= 33) {
      mixerModVisualsLastRefresh = now;
      refreshMixerPanModulationVisuals();
    }
  }
  modVisualsActive = hasMappings;
}

// ── Song morph ── while an entry with `morph ×N` runs its final N cycles,
// the worklet hears a blend between this block's gens and the next block's,
// ramped by playback position. Numeric params interpolate; anything else
// snaps at the midpoint; freeze stays engine state. updateSongMorph drives t
// per display frame; the blend lives inside sendParams so a knob tweak
// mid-morph re-sends blended values, never raw ones.
const SONG_MORPH = { t: 0, gens: null, loop: null };

function lerpGens(a, b, t) {
  const out = { ...(t < 0.5 ? a : b) };
  Object.keys(out).forEach((k) => {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') {
      out[k] = a[k] + (b[k] - a[k]) * t;
    }
  });
  if ('freeze' in a) out.freeze = a.freeze;
  return out;
}

function sendParams(genIdx) {
  if (!node) return;
  // The worklet hears the audible loop's sound: in song mode with follow off,
  // the loop being edited (state) differs from the one sounding.
  const audibleGens = getAudibleLoop()?.gens?.[genIdx];
  let base =
    audibleGens && audibleGens !== state[genIdx]
      ? { ...audibleGens, freeze: state[genIdx].freeze }
      : state[genIdx];
  const morphTo =
    SONG_MORPH.t > 0 && PLAY.mode === 'song' && GEN4.playing
      ? SONG_MORPH.gens?.[genIdx]
      : null;
  if (morphTo && morphTo !== base) base = lerpGens(base, morphTo, SONG_MORPH.t);
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
  // Full sweep — run on discrete events (map/unmap, preset load) so removed
  // mappings settle back to their base values.
  FX_BUS_IDS.forEach((busId) => {
    FX_LFO_PARAMS.forEach(({ id, key }) => {
      applyFx(id, key, getEffectiveFxValue(id, key, busId), busId);
    });
  });
  reconcileFxIdleSplices();
}

// Per-frame fast path: only write the params that actually have a mapping.
// The full sweep above is ~120 AudioParam writes; under modulation that ran
// every frame and flooded the audio thread with automation events.
function applyFxModulationMapped() {
  lfoMappings.forEach(({ genIdx, key }) => {
    if (genIdx !== 3) return;
    const sep = key.indexOf(':');
    const id = key.slice(0, sep);
    const paramKey = key.slice(sep + 1);
    FX_BUS_IDS.forEach((busId) => {
      applyFx(id, paramKey, getEffectiveFxValue(id, paramKey, busId), busId);
    });
  });
}

function applyMixerPanModulationMapped() {
  if (!audioCtx) return;
  lfoMappings.forEach(({ genIdx, key }) => {
    if (genIdx !== 5) return;
    const [busId, param] = key.split(':');
    if (param !== 'pan' || !FX_BUS_IDS.includes(busId)) return;
    fxBuses[busId]?.mixer?.pan.pan.setTargetAtTime(
      getEffectiveMixerPan(busId),
      audioCtx.currentTime,
      0.01,
    );
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

  const gen3Effective = getEffectiveGen3Params(GEN3);
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
    if (id === 'resonator' && key === 'freq' && FX.resonator.noteMode) {
      // Knob is in note units while modulation runs in Hz — convert the
      // effective pitch back to MIDI so the mod ring still tracks.
      control?.setModValue(freqHzToMidi(getEffectiveFxValue(id, key)));
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
  refreshGeneratorCaptureUI(genIdx);
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
  refreshMixerMappingUI();
  refreshModulationVisuals();
  refreshBackPanelState();
}

function setLFOLedState(led, sourceIdx) {
  led.classList.remove('active', 'lfo-1', 'lfo-2', 'lfo-seq', 'lfo-sc', 'lfo-trig');
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
  if (sourceIdx === 4) {
    led.classList.add('active', 'lfo-trig');
    led.dataset.lfo = 'T';
    led.textContent = 'T';
    led.title = 'Map: Trig SC';
    return;
  }
  led.classList.add('active', `lfo-${sourceIdx + 1}`);
  led.dataset.lfo = `${sourceIdx + 1}`;
  led.textContent = `${sourceIdx + 1}`;
  led.title = `Map: LFO ${sourceIdx + 1}`;
}

function makeControlRow(p, initialValue, onInput, lfoTarget = null, contextTarget = lfoTarget) {
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
  if (contextTarget && contextTarget.genIdx >= 0 && contextTarget.genIdx <= 2) {
    knob.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openKnobContextMenu(
        { genIdx: contextTarget.genIdx, key: contextTarget.key, label: p.label },
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

function buildSyncModeRow(
  isSync,
  onModeChange,
  labels = [
    ['free', 'Free'],
    ['sync', 'Sync'],
  ],
) {
  const row = document.createElement('div');
  row.className = 'fx-mode-row sync-mode-row';

  const buttons = new Map();
  labels.forEach(([mode, label]) => {
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
  row.setMode(isSync ? labels[1][0] : labels[0][0]);
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
  freezeBtn.addEventListener('click', () => toggleGeneratorFreeze(genIdx));
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
  let vizGesture = null;
  vizCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    vizCanvas.setPointerCapture(e.pointerId);
    vizGesture = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    };
  });
  vizCanvas.addEventListener('pointermove', (e) => {
    if (!vizCanvas.hasPointerCapture(e.pointerId) || vizGesture?.pointerId !== e.pointerId) return;
    if (!vizGesture.dragging) {
      const distance = Math.hypot(e.clientX - vizGesture.startX, e.clientY - vizGesture.startY);
      if (distance < 5) return;
      vizGesture.dragging = true;
      vizCanvas.classList.add('dragging');
    }
    updatePositionFromPointer(e.clientX);
  });
  const endVizGesture = (e, { cancelled = false } = {}) => {
    const wasDragging = !!vizGesture?.dragging;
    if (vizCanvas.hasPointerCapture(e.pointerId)) vizCanvas.releasePointerCapture(e.pointerId);
    vizCanvas.classList.remove('dragging');
    vizGesture = null;
    if (cancelled) return;
    if (wasDragging) {
      updatePositionFromPointer(e.clientX);
    } else if (
      getSourceState(genIdx).mode === 'mic' &&
      canFreezeGenerator(genIdx) &&
      !state[genIdx].freeze
    ) {
      toggleGeneratorFreeze(genIdx);
    } else {
      updatePositionFromPointer(e.clientX);
    }
  };
  vizCanvas.addEventListener('pointerup', (e) => endVizGesture(e));
  vizCanvas.addEventListener('pointercancel', (e) => endVizGesture(e, { cancelled: true }));
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
    // The FREE/SYNC toggle lives inside its param's control card — as a
    // sibling it would claim its own grid cell next to the card.
    if (p.key === 'grainSizeMs') {
      const btn = buildGenSyncToggle(() => {
        state[genIdx].grainSizeSync = !state[genIdx].grainSizeSync;
        refreshGenGrainSizeSyncUI(genIdx);
        sendParams(genIdx);
      });
      genGrainSyncModeControls[genIdx] = btn;
      control.appendChild(btn);
    }
    if (p.key === 'density') {
      const btn = buildGenSyncToggle(() => {
        state[genIdx].densitySync = !state[genIdx].densitySync;
        refreshGenDensitySyncUI(genIdx);
        sendParams(genIdx);
      });
      genDensitySyncModeControls[genIdx] = btn;
      control.appendChild(btn);
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

// ─── WebGL2 shader engine ────────────────────────────────────────────────────
// Raymarched kaleidoscopic neon tunnel with HDR feedback trails, plus polar
// spectrum/waveform rings sampled from an audio texture. A post pass adds
// bloom, beat-driven chromatic aberration, tone mapping, vignette and grain.
// The 2D particle renderer above stays as the fallback when WebGL2 (or shader
// compilation) is unavailable.

const VIZ_VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const VIZ_SIM_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPrev;
uniform sampler2D uAudio; // 512x2 R8: row 0 = spectrum, row 1 = waveform
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uLevel;
uniform float uBeat;
uniform float uHue;
uniform vec2 uCam;
uniform vec4 uA; // x speed, y fold, z twist, w feedback decay
uniform vec4 uB; // x glow, y spectrum-ring mix, z warp zoom, w waveform mix
uniform float uStars;  // starfield intensity (mood × slow LFO)
uniform float uStarT;  // integrated star fly-through phase
uniform vec4 uShock;   // kick shockwave: x age (s), y amplitude, z light gate, w per-kick shape seed
uniform float uGlint;  // hat/perc star-glint boost
uniform vec3 uNote;    // osc note flare: x pitch-class angle 0..1, y age, z amp

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 pal(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// Parallax star dust: four depth layers cycling toward the camera. Each layer
// is a sparse hash grid; ph drives scale (far→near) and fades at both ends so
// layers recycle invisibly. Highs push twinkle and brightness.
vec3 stars(vec2 uv) {
  vec3 col = vec3(0.0);
  for (int l = 0; l < 4; l++) {
    float ph = fract(uStarT + float(l) * 0.25);
    float scale = mix(9.0, 0.9, ph);
    float fade = ph * (1.0 - ph) * 4.0;
    vec2 guv = (uv + uCam * (0.05 + ph * 0.25)) * scale + float(l) * 7.31;
    vec2 cell = floor(guv);
    vec2 f = fract(guv) - 0.5;
    float h = hash21(cell);
    if (h < 0.82) continue;
    vec2 off = vec2(hash21(cell + 1.3), hash21(cell + 2.7)) - 0.5;
    float d = length(f - off * 0.8);
    float tw = 0.55 + 0.45 * sin(uTime * (4.0 + h * 14.0) + h * 40.0);
    // Radius scales with the layer so screen size stays pin-point; hard inner
    // edge keeps them crisp instead of glow blobs.
    float r = (0.0028 + ph * 0.0022) * scale;
    float star = smoothstep(r, r * 0.25, d);
    vec3 scol = mix(vec3(1.0), pal(uHue + 0.5 + h * 0.3), 0.4);
    col += scol * star * fade * tw * (0.6 + uHigh * 1.3 + uGlint * 1.6);
  }
  return col * uStars;
}

vec3 tunnel(vec2 uv) {
  vec3 ro = vec3(uCam * 0.5, uTime * uA.x);
  vec3 rd = normalize(vec3(uv - uCam * 0.18, 1.0));
  rd.xy *= rot(uTime * 0.06 + uBass * 0.25);
  vec3 acc = vec3(0.0);
  float t = 0.15;
  for (int i = 0; i < 54; i++) {
    vec3 p = ro + rd * t;
    vec2 q = p.xy;
    q *= rot(p.z * uA.z);
    float wob = 0.55 + 0.12 * sin(p.z * 0.31 + uTime * 0.4);
    for (int f = 0; f < 4; f++) {
      q = abs(q) - uA.y * wob;
      q *= rot(uTime * 0.11 + float(f) * 0.77 + uMid * 0.3);
    }
    float d1 = abs(length(q) - 0.14 - 0.10 * uBass) + 0.004;
    vec2 b = abs(q) - vec2(0.04 + uMid * 0.30, 0.015);
    float d2 = length(max(b, 0.0)) + 0.004;
    float ht = uHue + p.z * 0.015 + float(i) * 0.003;
    acc += pal(ht) * (uB.x * 0.0009) / (0.004 + d1 * d1 * 34.0);
    acc += pal(ht + 0.45) * (uB.x * 0.0006) / (0.004 + d2 * d2 * 52.0);
    t += 0.11 + t * 0.028;
  }
  return acc;
}

vec3 rings(vec2 uv) {
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float f = abs(fract(a / 6.28318 + 0.5) * 2.0 - 1.0); // mirrored for symmetry
  float s = texture(uAudio, vec2(f, 0.25)).r;
  float w = texture(uAudio, vec2(f, 0.75)).r - 0.5;
  vec3 col = vec3(0.0);
  float rs = 0.30 + s * 0.24 + uBass * 0.06;
  float ds = abs(r - rs);
  col += pal(uHue + 0.12 + s * 0.25) * (s * s) * uB.y * 0.0019 / (0.0012 + ds * ds * 9.0);
  float rw = 0.58 + w * 0.42;
  float dw = abs(r - rw);
  col += pal(uHue + 0.62) * (0.25 + uLevel) * uB.w * 0.0011 / (0.0012 + dw * dw * 16.0);
  return col;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  vec3 col = stars(uv) + tunnel(uv) + rings(uv);

  // Kick shockwave: ring expanding from centre at the scheduled hit time.
  float shockR = uShock.x * 1.5;
  float shockBand = exp(-abs(length(uv) - shockR) * 22.0);
  float shockAmp = uShock.y * exp(-uShock.x * 3.0);
  col += pal(uHue + 0.05) * shockBand * shockAmp * 0.9 * uShock.z;

  // Osc note flare: arc at the note's pitch-class angle, drifting outward.
  if (uNote.z > 0.001) {
    float na = uNote.x * 6.28318 - 3.14159;
    float a = atan(uv.y, uv.x);
    float ad = abs(mod(a - na + 3.14159, 6.28318) - 3.14159);
    float flare = exp(-ad * 5.0) * exp(-abs(length(uv) - (0.42 + uNote.y * 0.25)) * 14.0);
    col += pal(uHue + 0.25 + uNote.x * 0.4) * flare * uNote.z * exp(-uNote.y * 3.5) * 1.2;
  }

  // Feedback: sample last frame slightly zoomed + rotated so trails rush
  // outward with the tunnel; tiny channel rotation drifts trail hues. The
  // shockwave also refracts the trail buffer so kicks ripple through history.
  vec2 fuv = vUv - 0.5;
  fuv *= 1.0 - (0.004 + uBeat * 0.018 + uB.z * 0.003 + uBass * 0.004);
  fuv *= rot(0.0035 * sin(uTime * 0.12) + (uMid - 0.25) * 0.005);
  fuv += normalize(fuv + 1e-4) * shockBand * shockAmp * 0.012;
  vec3 prev = texture(uPrev, fuv + 0.5).rgb;
  prev = mix(prev, prev.gbr, 0.012 + uBeat * 0.05);
  col += prev * uA.w;
  frag = vec4(min(col, vec3(60.0)), 1.0);
}
`;

// MINIMAL style: dark, square, geometric. Same uniform names as the psychair
// sim but repurposed — uA: x speed, y grid scale, z rotate rate, w phosphor
// decay; uB: x grid-line mix, y spectrum-bars mix, z cell flicker, w waveform
// mix. Feedback uses max() (phosphor persistence) so nothing blooms white.
const VIZ_MIN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPrev;
uniform sampler2D uAudio;
uniform vec2 uRes;
uniform float uTime;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uLevel;
uniform float uBeat;
uniform float uHue;
uniform vec2 uCam;
uniform vec4 uA;
uniform vec4 uB;
uniform float uStars; // repurposed: glyph density
uniform vec4 uShock;
uniform float uGlint;
uniform vec3 uNote;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  float asp = uRes.x / uRes.y;
  vec2 uv = (vUv - 0.5) * vec2(asp, 1.0);
  uv *= rot(uTime * uA.z);
  uv += uCam * 0.02;
  float t = uTime * uA.x;
  vec3 accent = mix(vec3(1.0), 0.5 + 0.5 * cos(6.28318 * (uHue + vec3(0.0, 0.33, 0.67))), 0.45);
  vec3 col = vec3(0.0);

  // Grid: barely-there lines, breathing with level.
  vec2 g = uv * uA.y;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f);
  float line = smoothstep(0.035, 0.0, min(e.x, e.y));
  col += accent * line * uB.x * (0.035 + uLevel * 0.10);

  // Sparse cell strobes on a quantized clock; half filled, half dimmer.
  // A slow spatial wave gates them so activity travels across the frame
  // instead of twinkling uniformly forever.
  float clk = floor(t * (1.5 + uB.z * 5.0));
  float hc = hash21(cell + clk * 13.71);
  float on = step(0.982 - uB.z * 0.01, hc);
  float inset = step(0.14, f.x) * step(f.x, 0.86) * step(0.14, f.y) * step(f.y, 0.86);
  float fill = step(0.5, hash21(cell + clk * 7.3));
  float waveGate = 0.55 + 0.45 * sin(cell.x * 0.9 + cell.y * 1.3 + uTime * 0.7);
  col += accent * on * inset * mix(0.12, 0.4, fill) * (0.4 + uMid * 0.9) * waveGate;

  // Glyph layer: sparse plus / bracket marks that re-roll on a slow clock.
  float gclk = floor(uTime * 0.21);
  float gh = hash21(cell * 3.1 + gclk * 5.77);
  if (gh > 1.0 - 0.06 * uStars) {
    float gt = hash21(cell * 5.9 + gclk * 3.3);
    vec2 gp = f - 0.5;
    float glyph;
    if (gt < 0.5) {
      glyph = max(step(abs(gp.x), 0.02) * step(abs(gp.y), 0.16),
                  step(abs(gp.y), 0.02) * step(abs(gp.x), 0.16));
    } else {
      glyph = max(step(abs(gp.x + 0.14), 0.02) * step(abs(gp.y), 0.16),
                  step(abs(gp.y + 0.14), 0.02) * step(abs(gp.x), 0.16));
    }
    col += accent * glyph * (0.25 + uHigh * 0.5);
  }

  // Rare row flash: one grid row blinks for a moment every ~13 s.
  float rclk = floor(uTime / 13.0);
  float rphase = fract(uTime / 13.0);
  float rrow = floor((hash21(vec2(rclk, 7.7)) - 0.5) * uA.y * 0.9);
  if (rphase < 0.06 && abs(cell.y - rrow) < 0.5) col += accent * 0.35;

  // Hat ticks: corner dots flashing on a fast clock.
  float th = hash21(cell * 1.7 + floor(uTime * 24.0));
  float corner = step(e.x, 0.07) * step(e.y, 0.07);
  col += accent * corner * step(0.96, th) * uGlint * 0.9;

  // Nested frames: five concentric squares, one per band (bass innermost).
  // Each breathes with its band's energy — spectrum data without EQ-bar
  // literalism.
  if (uB.y > 0.01) {
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float be = texture(uAudio, vec2(0.08 + fi * 0.2, 0.25)).r;
      float rr = 0.12 + fi * 0.09 + be * 0.02;
      float d = abs(max(abs(uv.x), abs(uv.y)) - rr);
      col += accent * smoothstep(0.006, 0.002, d) * be * be * 0.55 * uB.y;
    }
  }

  // Perimeter dashes: segments of a square ring flickering like a data bus.
  if (uB.w > 0.01) {
    float chebP = max(abs(uv.x), abs(uv.y));
    float ringD = abs(chebP - 0.40);
    float ang = atan(uv.y, uv.x) / 6.28318 + 0.5;
    float seg = floor(ang * 32.0);
    float segOn = step(0.55, hash21(vec2(seg, floor(uTime * 2.0))));
    float dash = smoothstep(0.006, 0.002, ringD) * step(fract(ang * 32.0), 0.7);
    col += accent * dash * segOn * (0.15 + uLevel * 0.5) * uB.w;
  }

  // Kick: expanding outline, shape drawn per hit from the seed — square,
  // diamond, or corner brackets — so a 4/4 doesn't stamp the same figure.
  vec2 su = uShock.w > 0.35 && uShock.w < 0.7 ? rot(0.7853) * uv : uv;
  float cheb = max(abs(su.x), abs(su.y));
  float sqBand = smoothstep(0.018, 0.004, abs(cheb - uShock.x * 1.2));
  if (uShock.w >= 0.7) {
    float cornerness = min(abs(su.x), abs(su.y)) / max(cheb, 1e-4);
    sqBand *= step(0.55, cornerness);
  }
  float sAmp = uShock.y * exp(-uShock.x * 2.6);
  col += accent * sqBand * sAmp * 0.7 * uShock.z;

  // Scanner sweeps: slow bands that brighten what they cross — texture
  // reveals itself in passes instead of sitting static.
  float sx = fract(uTime * 0.045) * 2.0 - 1.0;
  float sweep = exp(-abs(uv.x / asp * 2.0 - sx * 1.1) * 18.0);
  float sy = fract(uTime * 0.019) * 2.0 - 1.0;
  float sweepY = exp(-abs(uv.y * 2.0 - sy * 1.1) * 18.0);
  col *= 1.0 + sweep * 1.4 + sweepY * 0.7;
  col += accent * sweep * 0.02;

  // Osc note: vertical hairline at its pitch-class x position.
  if (uNote.z > 0.001) {
    float nx = (uNote.x - 0.5) * asp * 0.9;
    col += accent * smoothstep(0.004, 0.0, abs(uv.x - nx)) * uNote.z * exp(-uNote.y * 3.0) * 0.4;
  }

  vec3 prev = texture(uPrev, vUv).rgb;
  col = max(col, prev * uA.w);
  frag = vec4(col, 1.0);
}
`;

const VIZ_POST_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;
uniform float uLevel;
uniform vec4 uLook; // x bloom, y aberration scale, z grain, w base exposure

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  float ca = (0.0012 + uBeat * 0.010 + uLevel * 0.0015) * uLook.y;
  vec3 col;
  col.r = texture(uTex, uv + c * ca).r;
  col.g = texture(uTex, uv).g;
  col.b = texture(uTex, uv - c * ca).b;
  vec2 px = 2.0 / uRes;
  vec3 bl =
    texture(uTex, uv + vec2(px.x, 0.0)).rgb + texture(uTex, uv - vec2(px.x, 0.0)).rgb +
    texture(uTex, uv + vec2(0.0, px.y)).rgb + texture(uTex, uv - vec2(0.0, px.y)).rgb +
    texture(uTex, uv + px).rgb + texture(uTex, uv - px).rgb +
    texture(uTex, uv + vec2(px.x, -px.y)).rgb + texture(uTex, uv + vec2(-px.x, px.y)).rgb;
  col += bl * uLook.x;
  col = aces(col * (uLook.w + uBeat * 0.25 + uLevel * 0.12));
  col *= 1.0 - r2 * 1.05;
  col += (hash(uv * uRes + fract(uTime) * 113.0) - 0.5) * uLook.z;
  frag = vec4(col, 1.0);
}
`;

// Visual moods: targets the running params lerp toward. dur in seconds.
const VIZGL_SCENES = [
  { label: 'NEON TUNNEL', dur: [24, 40], speed: 1.5, fold: 0.92, twist: 0.16, decay: 0.84, glow: 1.0, ring: 0.8, warp: 1.0, wave: 0.7, hueVel: 0.012, stars: 0.5 },
  { label: 'HYPER RUSH',  dur: [16, 28], speed: 3.4, fold: 0.72, twist: 0.34, decay: 0.885, glow: 0.85, ring: 0.45, warp: 2.4, wave: 0.4, hueVel: 0.05, stars: 0.9 },
  { label: 'CATHEDRAL',   dur: [26, 44], speed: 0.65, fold: 1.28, twist: 0.045, decay: 0.82, glow: 1.3, ring: 1.0, warp: 0.4, wave: 0.9, hueVel: 0.004, stars: 0.3 },
  { label: 'PRISM STORM', dur: [14, 26], speed: 2.3, fold: 0.55, twist: 0.6, decay: 0.85, glow: 0.95, ring: 1.3, warp: 1.6, wave: 0.5, hueVel: 0.09, stars: 0.35 },
  { label: 'DEEP FIELD',  dur: [28, 48], speed: 0.4, fold: 1.55, twist: 0.02, decay: 0.88, glow: 0.55, ring: 1.5, warp: 0.25, wave: 1.2, hueVel: 0.002, stars: 1.3 },
];
const VIZGL_PARAM_KEYS = ['speed', 'fold', 'twist', 'decay', 'glow', 'ring', 'warp', 'wave', 'hueVel', 'stars'];

// MINIMAL moods — same keys, remapped: fold = grid scale, twist = rotate rate,
// decay = phosphor persistence, glow = grid lines, ring = spectrum bars,
// warp = cell flicker, wave = oscilloscope. stars unused.
const VIZMIN_SCENES = [
  { label: 'GRID',   dur: [24, 40], speed: 1.0, fold: 12, twist: 0.0,   decay: 0.55, glow: 1.0,  ring: 0.0,  warp: 0.6, wave: 0.15, hueVel: 0.001,  stars: 0.6 },
  { label: 'FRAMES', dur: [20, 36], speed: 1.0, fold: 14, twist: 0.0,   decay: 0.4,  glow: 0.25, ring: 1.0,  warp: 0.2, wave: 0.0,  hueVel: 0.0015, stars: 0.3 },
  { label: 'SIGNAL', dur: [20, 36], speed: 1.0, fold: 8,  twist: 0.0,   decay: 0.7,  glow: 0.15, ring: 0.25, warp: 0.1, wave: 1.0,  hueVel: 0.001,  stars: 0.2 },
  { label: 'CELLS',  dur: [16, 30], speed: 1.4, fold: 22, twist: 0.004, decay: 0.5,  glow: 0.4,  ring: 0.2,  warp: 1.4, wave: 0.0,  hueVel: 0.003,  stars: 1.0 },
  { label: 'DRIFT',  dur: [26, 44], speed: 0.6, fold: 10, twist: 0.012, decay: 0.75, glow: 0.6,  ring: 0.4,  warp: 0.3, wave: 0.3,  hueVel: 0.0008, stars: 0.5 },
];

const VIZGL = {
  gl: null,
  failed: false,
  lost: false,
  cssW: 0,
  cssH: 0,
  simW: 0,
  simH: 0,
  progSim: null,
  progMin: null,
  progPost: null,
  uniSim: null,
  uniMin: null,
  uniPost: null,
  style: 'psy', // 'psy' (psychair) | 'min' (minimal)
  styleBtns: null,
  texA: null,
  texB: null,
  fbA: null,
  fbB: null,
  audioTex: null,
  audioBytes: new Uint8Array(512 * 2),
  floatFbo: false,
  labelEl: null,
  labelTimer: 0,
  t: 0,
  lastNow: 0,
  hue: 0.58,
  bass: 0,
  mid: 0,
  high: 0,
  level: 0,
  beat: 0,
  beatAvg: 0,
  beatCooldown: 0,
  wanderT: 0,
  starT: 0,
  kickX: 0,
  kickY: 0,
  events: [],
  lastEventT: -10,
  shockAge: 10,
  shockAmp: 0,
  shockSeed: 0,
  kickHeat: 0,
  glint: 0,
  noteAngle: 0.5,
  noteAge: 10,
  noteAmp: 0,
  camX: 0,
  camY: 0,
  sceneIdx: 0,
  sceneTimer: 0,
  sceneDur: 30,
  p: { speed: 1.5, fold: 0.92, twist: 0.16, decay: 0.84, glow: 1.0, ring: 0.8, warp: 1.0, wave: 0.7, hueVel: 0.012, stars: 0.5 },
};

function vizGLCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('viz shader:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function vizGLProgram(gl, fragSrc) {
  const vs = vizGLCompile(gl, gl.VERTEX_SHADER, VIZ_VERT_SRC);
  const fs = vizGLCompile(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('viz link:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function vizGLUniforms(gl, prog, names) {
  const out = {};
  names.forEach((n) => (out[n] = gl.getUniformLocation(prog, n)));
  return out;
}

function resizeVizGLTargets(w, h) {
  const gl = VIZGL.gl;
  [VIZGL.texA, VIZGL.texB].forEach((t) => t && gl.deleteTexture(t));
  [VIZGL.fbA, VIZGL.fbB].forEach((f) => f && gl.deleteFramebuffer(f));
  const make = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const internal = VIZGL.floatFbo ? gl.RGBA16F : gl.RGBA8;
    const type = VIZGL.floatFbo ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  };
  let a = make();
  let b = make();
  gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && VIZGL.floatFbo) {
    // Half-float rendering unsupported after all — rebuild the pair as RGBA8.
    VIZGL.floatFbo = false;
    [a.tex, b.tex].forEach((t) => gl.deleteTexture(t));
    [a.fb, b.fb].forEach((f) => gl.deleteFramebuffer(f));
    a = make();
    b = make();
  }
  VIZGL.texA = a.tex;
  VIZGL.fbA = a.fb;
  VIZGL.texB = b.tex;
  VIZGL.fbB = b.fb;
  VIZGL.simW = w;
  VIZGL.simH = h;
}

function setupVizGLResources() {
  const gl = VIZGL.gl;
  VIZGL.floatFbo = !!gl.getExtension('EXT_color_buffer_float');
  VIZGL.progSim = vizGLProgram(gl, VIZ_SIM_FRAG);
  VIZGL.progMin = vizGLProgram(gl, VIZ_MIN_FRAG);
  VIZGL.progPost = vizGLProgram(gl, VIZ_POST_FRAG);
  if (!VIZGL.progSim || !VIZGL.progMin || !VIZGL.progPost) return;
  const simUniformNames = [
    'uPrev', 'uAudio', 'uRes', 'uTime', 'uBass', 'uMid', 'uHigh', 'uLevel', 'uBeat', 'uHue', 'uCam', 'uA', 'uB', 'uStars', 'uStarT', 'uShock', 'uGlint', 'uNote',
  ];
  VIZGL.uniSim = vizGLUniforms(gl, VIZGL.progSim, simUniformNames);
  VIZGL.uniMin = vizGLUniforms(gl, VIZGL.progMin, simUniformNames);
  VIZGL.uniPost = vizGLUniforms(gl, VIZGL.progPost, ['uTex', 'uRes', 'uTime', 'uBeat', 'uLevel', 'uLook']);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  VIZGL.audioTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, VIZGL.audioTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 512, 2, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  VIZGL.simW = 0; // force render-target rebuild on the next frame
}

function initVizGL() {
  const canvas = VIZ.canvas;
  if (!canvas || VIZGL.failed || VIZGL.gl) return;
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    VIZGL.failed = true;
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    VIZGL.lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    VIZGL.lost = false;
    setupVizGLResources();
  });
  VIZGL.gl = gl;
  setupVizGLResources();
  if (!VIZGL.progSim || !VIZGL.progMin || !VIZGL.progPost) {
    // Shaders refused to build; the canvas is stuck bound to WebGL, so the 2D
    // fallback can't claim it — keep the GL loop alive but render nothing.
    VIZGL.failed = true;
    VIZGL.lost = true;
  }
}

// ── Transport-locked events ──────────────────────────────────────
// The gen4 scheduler queues each hit with its scheduled audio time; the viz
// loop fires the visual when audioCtx.currentTime reaches it — beat-perfect,
// no energy-threshold guessing.
function queueVizEvent(id, t, vel, midi = null) {
  if (UI_VIEW.mode !== 'visual' || !VIZGL.gl || !VIZ.animId) return;
  if (VIZGL.events.length > 128) VIZGL.events.length = 0; // runaway guard
  VIZGL.events.push({ id, t, vel, midi });
}

function applyVizEvent(ev) {
  VIZGL.lastEventT = VIZGL.t;
  const vel = Number.isFinite(ev.vel) ? ev.vel : 1;
  switch (ev.id) {
    case 'kick': {
      VIZGL.shockAge = 0;
      VIZGL.shockSeed = Math.random();
      // Habituation (minimal style): steady four-on-the-floor fades toward a
      // third of full amplitude; a break lets the heat drain so the first
      // kick back slams. Psychair keeps full-force warps.
      const heatScale = VIZGL.style === 'min' ? 1 / (1 + VIZGL.kickHeat * 0.8) : 1;
      VIZGL.kickHeat = Math.min(3, VIZGL.kickHeat + 1);
      VIZGL.shockAmp = (0.45 + vel * 0.75) * heatScale;
      VIZGL.beat = 1;
      break;
    }
    case 'snare': {
      const a = Math.random() * Math.PI * 2;
      VIZGL.kickX += Math.cos(a) * 0.3 * vel;
      VIZGL.kickY += Math.sin(a) * 0.22 * vel;
      VIZGL.beat = Math.max(VIZGL.beat, 0.75 * vel);
      break;
    }
    case 'hat':
      VIZGL.glint = Math.min(1.5, VIZGL.glint + 0.7 * vel);
      break;
    case 'osc': {
      const midi = Number.isFinite(ev.midi) ? ev.midi : 60;
      VIZGL.noteAngle = (midi % 12) / 12;
      VIZGL.noteAge = 0;
      VIZGL.noteAmp = 0.5 + vel * 0.5;
      break;
    }
    default: // perc / fm / smp
      VIZGL.glint = Math.min(1.5, VIZGL.glint + 0.3 * vel);
      VIZGL.hue = (VIZGL.hue + 0.012) % 1;
      break;
  }
}

function processVizEvents() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const evs = VIZGL.events;
  let i = 0;
  while (i < evs.length) {
    const ev = evs[i];
    if (ev.t > now + 0.001) {
      i += 1;
      continue;
    }
    evs.splice(i, 1);
    if (ev.t >= now - 0.5) applyVizEvent(ev); // drop stale leftovers silently
  }
}

function vizShowLabel(text, ms = 3000) {
  const el = VIZGL.labelEl;
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(VIZGL.labelTimer);
  VIZGL.labelTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function vizSceneList() {
  return VIZGL.style === 'min' ? VIZMIN_SCENES : VIZGL_SCENES;
}

function advanceVizScene() {
  const list = vizSceneList();
  const jump = 1 + Math.floor(Math.random() * (list.length - 1));
  VIZGL.sceneIdx = (VIZGL.sceneIdx + jump) % list.length;
  VIZGL.sceneTimer = 0;
  const d = list[VIZGL.sceneIdx].dur;
  VIZGL.sceneDur = d[0] + Math.random() * (d[1] - d[0]);
  vizShowLabel(list[VIZGL.sceneIdx].label);
}

function setVizStyle(style) {
  VIZGL.style = style;
  try {
    localStorage.setItem('grnshVizStyle', style);
  } catch (e) {}
  const list = vizSceneList();
  VIZGL.sceneIdx = 0;
  VIZGL.sceneTimer = 0;
  VIZGL.sceneDur = list[0].dur[0];
  // Hard-cut params to the new style's first mood — cross-lerping remapped
  // params (grid scale vs fold amount) produces nonsense frames.
  VIZGL_PARAM_KEYS.forEach((k) => (VIZGL.p[k] = list[0][k]));
  const gl = VIZGL.gl;
  if (gl && VIZGL.fbA) {
    gl.clearColor(0, 0, 0, 1);
    [VIZGL.fbA, VIZGL.fbB].forEach((fb) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
  }
  VIZGL.styleBtns?.forEach((btn, id) => btn.classList.toggle('active', id === style));
  vizShowLabel(style === 'min' ? 'MINIMAL' : 'PSYCHAIR');
}

function renderVizGL() {
  const gl = VIZGL.gl;
  const canvas = VIZ.canvas;
  if (!gl || !canvas) return;

  // Backing store: dpr-aware, capped so the raymarch stays cheap on 4K/retina.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  let bw = Math.max(2, Math.round((VIZGL.cssW || canvas.offsetWidth) * dpr));
  let bh = Math.max(2, Math.round((VIZGL.cssH || canvas.offsetHeight) * dpr));
  if (bw > 2048) {
    bh = Math.round((bh * 2048) / bw);
    bw = 2048;
  }
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const sw = Math.max(2, Math.round(bw * 0.55));
  const sh = Math.max(2, Math.round(bh * 0.55));
  if (sw !== VIZGL.simW || sh !== VIZGL.simH) resizeVizGLTargets(sw, sh);

  const now = performance.now();
  const dt = VIZGL.lastNow ? Math.min(0.05, (now - VIZGL.lastNow) / 1000) : 1 / 60;
  VIZGL.lastNow = now;
  VIZGL.t += dt;

  // ── Audio analysis ────────────────────────────────────────────
  ensureVizAnalyser();
  const freq = VIZ.freqBuf;
  const wave = VIZ.timeBuf;
  if (vizAnalyser && freq) {
    vizAnalyser.getByteFrequencyData(freq);
    vizAnalyser.getByteTimeDomainData(wave);
  }
  const fLen = freq ? freq.length : 1024;
  const bandE = (s, e) => {
    if (!freq) return 0;
    let sum = 0;
    for (let i = s; i < e && i < fLen; i++) sum += freq[i];
    return sum / ((e - s) * 255);
  };
  let bassE = bandE(0, 5);
  let midE = bandE(5, 40);
  let highE = bandE(40, 120);
  let allE = bandE(0, 100);
  if (!vizAnalyser) {
    // No audio yet — breathe gently so the view never sits static.
    bassE = (0.5 + 0.5 * Math.sin(VIZGL.t * 1.7)) * 0.3;
    midE = 0.15 + 0.15 * Math.sin(VIZGL.t * 0.9);
    highE = 0.1;
    allE = 0.18;
  }
  const lk = 1 - Math.exp(-dt * 10);
  VIZGL.bass += (bassE - VIZGL.bass) * lk;
  VIZGL.mid += (midE - VIZGL.mid) * lk;
  VIZGL.high += (highE - VIZGL.high) * lk;
  VIZGL.level += (allE - VIZGL.level) * lk;

  // Transport events first — while they flow, the analyser beat-guesser
  // stands down so kicks don't double-trigger.
  processVizEvents();
  VIZGL.shockAge += dt;
  VIZGL.noteAge += dt;
  VIZGL.glint *= Math.exp(-dt * 6);
  VIZGL.kickHeat *= Math.exp(-dt / 3.5);
  const eventDriven = VIZGL.t - VIZGL.lastEventT < 2;

  VIZGL.beatAvg = VIZGL.beatAvg * 0.94 + bassE * 0.06;
  if (VIZGL.beatCooldown > 0) VIZGL.beatCooldown -= dt;
  if (!eventDriven && VIZGL.beatCooldown <= 0 && bassE > VIZGL.beatAvg * 1.55 && bassE > 0.12) {
    VIZGL.beat = 1;
    VIZGL.beatCooldown = 0.18;
    const ka = Math.random() * Math.PI * 2;
    VIZGL.kickX += Math.cos(ka) * 0.2 * bassE;
    VIZGL.kickY += Math.sin(ka) * 0.15 * bassE;
  }
  VIZGL.beat *= Math.exp(-dt * 7);

  // ── Scene machine ─────────────────────────────────────────────
  VIZGL.sceneTimer += dt;
  if (VIZGL.sceneTimer >= VIZGL.sceneDur) advanceVizScene();
  const styleMin = VIZGL.style === 'min';
  const sc = vizSceneList()[VIZGL.sceneIdx];
  const pk = 1 - Math.exp(-dt * 0.9);
  const p = VIZGL.p;
  VIZGL_PARAM_KEYS.forEach((key) => (p[key] += (sc[key] - p[key]) * pk));
  VIZGL.hue = (VIZGL.hue + p.hueVel * dt * (1 + VIZGL.high * 5) + 1) % 1;

  // ── Camera wander: layered incommensurate sines ≈ smooth 1D noise.
  // Integrated rate (not t × rate) so mid-energy speeds the path without
  // phase jumps; level/bass widen it; beats kick it off-axis briefly.
  VIZGL.wanderT += dt * (0.12 + VIZGL.mid * 0.35 + VIZGL.beat * 0.4);
  const wt = VIZGL.wanderT;
  const amp = 0.3 + VIZGL.level * 0.45 + VIZGL.bass * 0.3;
  const tx =
    (Math.sin(wt) * 0.55 + Math.sin(wt * 2.37 + 1.7) * 0.3 + Math.sin(wt * 5.11 + 4.2) * 0.15) *
      amp + VIZGL.kickX;
  const ty =
    (Math.cos(wt * 0.83 + 0.9) * 0.55 + Math.cos(wt * 2.71 + 3.1) * 0.3 + Math.sin(wt * 4.53 + 2.0) * 0.15) *
      amp + VIZGL.kickY;
  VIZGL.kickX *= Math.exp(-dt * 3.5);
  VIZGL.kickY *= Math.exp(-dt * 3.5);
  const ck = 1 - Math.exp(-dt * 2.2);
  VIZGL.camX += (tx - VIZGL.camX) * ck;
  VIZGL.camY += (ty - VIZGL.camY) * ck;

  // ── Audio texture: sqrt-spaced spectrum row + waveform row ────
  const ab = VIZGL.audioBytes;
  for (let i = 0; i < 512; i++) {
    const t01 = i / 511;
    const bin = Math.min(fLen - 1, Math.floor(t01 * t01 * (fLen - 1)));
    ab[i] = freq ? freq[bin] : 0;
    ab[512 + i] = wave ? wave[Math.min(wave.length - 1, i * 4)] : 128;
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, VIZGL.audioTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, ab);

  // ── Sim pass: accumulate into the back buffer ─────────────────
  gl.bindFramebuffer(gl.FRAMEBUFFER, VIZGL.fbB);
  gl.viewport(0, 0, VIZGL.simW, VIZGL.simH);
  gl.useProgram(styleMin ? VIZGL.progMin : VIZGL.progSim);
  const us = styleMin ? VIZGL.uniMin : VIZGL.uniSim;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, VIZGL.texA);
  gl.uniform1i(us.uPrev, 0);
  gl.uniform1i(us.uAudio, 1);
  gl.uniform2f(us.uRes, VIZGL.simW, VIZGL.simH);
  gl.uniform1f(us.uTime, VIZGL.t);
  gl.uniform1f(us.uBass, VIZGL.bass);
  gl.uniform1f(us.uMid, VIZGL.mid);
  gl.uniform1f(us.uHigh, VIZGL.high);
  gl.uniform1f(us.uLevel, VIZGL.level);
  gl.uniform1f(us.uBeat, VIZGL.beat);
  gl.uniform1f(us.uHue, VIZGL.hue);
  gl.uniform2f(us.uCam, VIZGL.camX * 0.4, VIZGL.camY * 0.3);
  gl.uniform4f(us.uA, p.speed, p.fold, p.twist, p.decay);
  gl.uniform4f(us.uB, p.glow, p.ring, p.warp, p.wave);
  // Star density drifts on a slow two-sine LFO so the dust layer comes and
  // goes even inside one mood; phase is integrated so speed changes are smooth.
  VIZGL.starT += dt * (0.05 + p.speed * 0.03);
  const starLfo = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(VIZGL.t * 0.047 + Math.sin(VIZGL.t * 0.013) * 1.8));
  gl.uniform1f(us.uStars, p.stars * starLfo);
  gl.uniform1f(us.uStarT, VIZGL.starT);
  // Kick light phases in/out on a slow irregular cycle (~1 min on, ~1 min
  // off, few-second crossfade); the trail-warping refraction stays constant.
  const gateWave = Math.sin(VIZGL.t * 0.052) + 0.35 * Math.sin(VIZGL.t * 0.0137);
  const shockLight = Math.min(1, Math.max(0, 0.5 + gateWave * 6));
  gl.uniform4f(us.uShock, VIZGL.shockAge, VIZGL.shockAmp, shockLight, VIZGL.shockSeed);
  gl.uniform1f(us.uGlint, VIZGL.glint);
  gl.uniform3f(us.uNote, VIZGL.noteAngle, VIZGL.noteAge, VIZGL.noteAmp);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // ── Post pass: tone map to screen ─────────────────────────────
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(VIZGL.progPost);
  const up = VIZGL.uniPost;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, VIZGL.texB);
  gl.uniform1i(up.uTex, 0);
  gl.uniform2f(up.uRes, canvas.width, canvas.height);
  gl.uniform1f(up.uTime, VIZGL.t);
  gl.uniform1f(up.uBeat, VIZGL.beat);
  gl.uniform1f(up.uLevel, VIZGL.level);
  // Look grade per style: psychair blooms and smears, minimal stays clean,
  // grainy and slightly darker-of-heart.
  if (styleMin) gl.uniform4f(up.uLook, 0.008, 0.3, 0.05, 0.8);
  else gl.uniform4f(up.uLook, 0.028, 1.0, 0.03, 0.55);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const swapT = VIZGL.texA;
  VIZGL.texA = VIZGL.texB;
  VIZGL.texB = swapT;
  const swapF = VIZGL.fbA;
  VIZGL.fbA = VIZGL.fbB;
  VIZGL.fbB = swapF;
}

function buildVisualPanel() {
  const panel = document.getElementById('visualPanel');
  if (!panel) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'viz-canvas';
  panel.appendChild(canvas);
  VIZ.canvas = canvas;
  // Context is taken lazily on first start: WebGL2 when available; otherwise
  // the canvas stays unbound so the 2D fallback can still claim it.
  const ro = new ResizeObserver(() => {
    VIZGL.cssW = canvas.offsetWidth;
    VIZGL.cssH = canvas.offsetHeight;
    if (!VIZGL.gl) {
      canvas.width = VIZGL.cssW;
      canvas.height = VIZGL.cssH;
    }
  });
  ro.observe(canvas);

  const label = document.createElement('div');
  label.className = 'viz-scene-label';
  panel.appendChild(label);
  VIZGL.labelEl = label;

  const styleBar = document.createElement('div');
  styleBar.className = 'viz-style-bar';
  VIZGL.styleBtns = new Map();
  [
    ['psy', 'PSYCHAIR'],
    ['min', 'MINIMAL'],
  ].forEach(([id, name]) => {
    const btn = document.createElement('button');
    btn.className = 'viz-style-btn';
    btn.textContent = name;
    btn.title = `${name.toLowerCase()} visual style`;
    btn.addEventListener('click', () => setVizStyle(id));
    VIZGL.styleBtns.set(id, btn);
    styleBar.appendChild(btn);
  });
  panel.appendChild(styleBar);
  let savedStyle = 'psy';
  try {
    savedStyle = localStorage.getItem('grnshVizStyle') || 'psy';
  } catch (e) {}
  setVizStyle(savedStyle === 'min' ? 'min' : 'psy');

  canvas.addEventListener('pointerdown', () => {
    VIZGL.beat = 1;
    VIZGL.hue = (VIZGL.hue + 0.31) % 1;
  });
  canvas.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else panel.requestFullscreen?.();
  });
}

function startViz() {
  if (VIZ.animId) return;
  ensureVizAnalyser();
  if (!VIZGL.gl && !VIZGL.failed) {
    initVizGL();
    if (VIZGL.gl && !VIZGL.failed) vizShowLabel('CLICK · PULSE — DBLCLICK · FULLSCREEN', 4500);
  }
  VIZGL.lastNow = 0;
  (function frame() {
    VIZ.animId = requestAnimationFrame(frame);
    if (VIZGL.gl) {
      if (!VIZGL.lost) renderVizGL();
    } else {
      renderViz();
    }
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
  const { canvas } = VIZ;
  if (!canvas) return;
  if (!VIZ.ctx) VIZ.ctx = canvas.getContext('2d');
  const ctx = VIZ.ctx;
  if (!ctx || canvas.width === 0) return;

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
// Gen3 knob defs — shared by the gen3 panel and the drum sequencer's OSC
// param locks (per-step overrides stored in the osc channel's locks array).
const GEN3_PARAM_DEFS = [
  { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, unit: 'st' },
  { key: 'detune', label: 'Detune', min: -100, max: 100, step: 1, unit: 'ct' },
  { key: 'attack', label: 'Attack', min: 0, max: 10, step: 0.01, unit: 's' },
  { key: 'decay', label: 'Decay', min: 0, max: 2, step: 0.01, unit: 's' },
  { key: 'sustain', label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'release', label: 'Release', min: 0, max: 10, step: 0.01, unit: 's' },
];

const GEN3_OSC_TYPES = new Set(['sine', 'triangle', 'square', 'sawtooth', 'noise']);
const GEN3_ARP_RATE_OPTIONS = [
  { beats: 1, label: '1/4' },
  { beats: 0.5, label: '1/8' },
  { beats: 0.25, label: '1/16' },
  { beats: 0.125, label: '1/32' },
];
const GEN3_ARP_DIRECTIONS = new Set(['up', 'down', 'updown', 'random']);
const GEN3_LOOP_PARAM_KEYS = [
  'type',
  ...GEN3_PARAM_DEFS.map(({ key }) => key),
  'sustainMode',
  'arpEnabled',
  'arpRateBeats',
  'arpDirection',
  'arpOctaves',
  'arpGate',
];

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
  arpEnabled: false,
  arpRateBeats: 0.25,
  arpDirection: 'up',
  arpOctaves: 1,
  arpGate: 0.75,
  lockedMidis: new Set(),
  activeNotes: new Map(),
  releasingVoices: new Set(),
  nodes: null,
};

function captureGen3LoopParams(source = GEN3) {
  return Object.fromEntries(GEN3_LOOP_PARAM_KEYS.map((key) => [key, source[key]]));
}

function writeGen3ParamToEditLoop(key, value) {
  const loop = getEditLoop();
  if (loop?.gen3 && GEN3_LOOP_PARAM_KEYS.includes(key)) loop.gen3[key] = value;
}

function applyGen3LoopParams(loop) {
  if (!loop?.gen3) return false;
  let changed = false;
  GEN3_LOOP_PARAM_KEYS.forEach((key) => {
    if (!(key in loop.gen3) || GEN3[key] === loop.gen3[key]) return;
    GEN3[key] = loop.gen3[key];
    changed = true;
  });
  // SUS and ARP are mutually exclusive; a loop carrying both (older saves,
  // partial copies) must not light both buttons. Arp wins, matching load.
  if (GEN3.arpEnabled && GEN3.sustainMode) {
    GEN3.sustainMode = false;
    loop.gen3.sustainMode = false;
    changed = true;
  }
  refreshGen3UI();
  applyGen3Modulation();
  return changed;
}
let gen3ScopeFrame = null;
let gen3ScopeBuf = null; // reused time-domain buffer for the gen3 scope
const gen3NoteEls = new Map();
let gen3ArpBtnEl = null;
let gen3ArpBarEl = null;
let gen3ArpRateSelect = null;
let gen3ArpDirectionSelect = null;
let gen3ArpOctaveSelect = null;
let gen3ArpGateSelect = null;

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

function createGen3SourceNode(freq, ov = null, sound = getGen3SoundState()) {
  if (!GEN3.nodes) return null;
  const ac = audioCtx;
  const effective = getEffectiveGen3Params(sound);
  let src;
  if (sound.type === 'noise') {
    const len = ac.sampleRate;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
  } else {
    src = ac.createOscillator();
    src.type = sound.type;
    src.frequency.setValueAtTime(
      freq * Math.pow(2, (ov?.pitch ?? effective.pitch) / 12),
      ac.currentTime,
    );
    src.detune.setValueAtTime(ov?.detune ?? effective.detune, ac.currentTime);
  }
  return src;
}

function applyGen3VoicePitch(voice, effective = getEffectiveGen3Params()) {
  if (!voice?.source || !audioCtx) return;
  if ('frequency' in voice.source && voice.source.frequency) {
    voice.source.frequency.setValueAtTime(
      voice.freq * Math.pow(2, (voice.ov?.pitch ?? effective.pitch) / 12),
      audioCtx.currentTime,
    );
  }
  if ('detune' in voice.source && voice.source.detune) {
    voice.source.detune.setValueAtTime(voice.ov?.detune ?? effective.detune, audioCtx.currentTime);
  }
}

function applyGen3Envelope(envelope, ov = null, sound = getGen3SoundState()) {
  const now = audioCtx.currentTime;
  const effective = getEffectiveGen3Params(sound);
  const attack = ov?.attack ?? sound.attack;
  const decay = ov?.decay ?? effective.decay;
  const sustain = ov?.sustain ?? effective.sustain;
  // A locked gain is absolute: the voice is scaled so it lands on the locked
  // level after passing through the master gain node downstream.
  const scale = ov?.gain != null ? (sound.gain > 0 ? ov.gain / sound.gain : 0) : 1;
  const attackEnd = now + attack;
  const decayEnd = attackEnd + decay;

  envelope.gain.cancelScheduledValues(now);
  envelope.gain.setValueAtTime(0, now);

  if (attack > 0) envelope.gain.linearRampToValueAtTime(scale, attackEnd);
  else envelope.gain.setValueAtTime(scale, now);

  if (decay > 0) envelope.gain.linearRampToValueAtTime(sustain * scale, decayEnd);
  else envelope.gain.setValueAtTime(sustain * scale, attackEnd);
}

function createGen3Voice(freq, ov = null, sound = getGen3SoundState()) {
  if (!GEN3.nodes) return { source: null, envelope: null, releaseTimer: null };
  const source = createGen3SourceNode(freq, ov, sound);
  const envelope = audioCtx.createGain();
  envelope.gain.setValueAtTime(0, audioCtx.currentTime);
  source.connect(envelope);
  envelope.connect(GEN3.nodes.gain);
  applyGen3Envelope(envelope, ov, sound);
  source.start();
  return { source, envelope, releaseTimer: null };
}

function releaseGen3Voice(voice) {
  if (!voice?.source || !voice.envelope || !audioCtx) {
    stopGen3Voice(voice);
    return;
  }

  const now = audioCtx.currentTime;
  const release = voice.ov?.release ?? voice.sound?.release ?? GEN3.release;
  const stopAfterMs = Math.max(0, release * 1000) + 60;

  clearGen3ReleaseTimer(voice);
  if (voice.envelope.gain.cancelAndHoldAtTime) {
    voice.envelope.gain.cancelAndHoldAtTime(now);
  } else {
    voice.envelope.gain.cancelScheduledValues(now);
    voice.envelope.gain.setValueAtTime(Math.max(voice.envelope.gain.value, 0.0001), now);
  }

  if (release > 0) voice.envelope.gain.linearRampToValueAtTime(0, now + release);
  else voice.envelope.gain.setValueAtTime(0, now);

  GEN3.releasingVoices.add(voice);
  voice.releaseTimer = setTimeout(() => {
    GEN3.releasingVoices.delete(voice);
    stopGen3Voice(voice);
    refreshBackPanelState();
  }, stopAfterMs);
}

function addGen3Note(midi, freq, ov = null, soundOverride = null, autoReleaseMs = null) {
  const sound = { ...(soundOverride || getGen3SoundState()) };
  const entry = { freq, ov, sound, autoReleaseTimer: null, ...createGen3Voice(freq, ov, sound) };
  GEN3.activeNotes.set(midi, entry);
  setGen3NoteActive(midi, true);
  if (Number.isFinite(autoReleaseMs)) {
    entry.autoReleaseTimer = setTimeout(() => {
      if (GEN3.activeNotes.get(midi) === entry) removeGen3Note(midi);
    }, Math.max(1, autoReleaseMs));
  } else if (!sound.sustainMode) {
    const attack = ov?.attack ?? sound.attack;
    const decay = ov?.decay ?? getEffectiveGen3Params(sound).decay;
    const ms = Math.max(0, attack + decay) * 1000;
    entry.autoReleaseTimer = setTimeout(() => {
      if (GEN3.activeNotes.get(midi) === entry) removeGen3Note(midi);
    }, ms);
  }
  refreshBackPanelState();
  return entry;
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
  if (!getGen3SoundState().sustainMode || !GEN3.nodes) return;
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
  const sound = { ...getGen3SoundState() };
  GEN3.activeNotes.forEach((entry, midi) => {
    stopGen3Voice(entry);
    entry.sound = sound;
    Object.assign(entry, createGen3Voice(entry.freq, entry.ov, sound));
  });
  refreshBackPanelState();
}

const GEN3_ARP_RUNTIME = {
  identity: null,
  stepCounter: 0,
  noteIndex: 0,
  session: 0,
};

function resetGen3ArpRuntime({ newSession = false } = {}) {
  GEN3_ARP_RUNTIME.identity = null;
  GEN3_ARP_RUNTIME.stepCounter = 0;
  GEN3_ARP_RUNTIME.noteIndex = 0;
  if (newSession) GEN3_ARP_RUNTIME.session += 1;
}

function getGen3ArpNotes(sound) {
  const source = [...(sound?.lockedMidis || [])].sort((a, b) => a - b);
  if (source.length === 0) return [];
  const notes = new Set();
  const octaves = clamp(Math.round(sound.arpOctaves || 1), 1, 3);
  for (let octave = 0; octave < octaves; octave++) {
    source.forEach((midi) => {
      const shifted = midi + octave * 12;
      if (shifted <= 127) notes.add(shifted);
    });
  }
  const ascending = [...notes].sort((a, b) => a - b);
  if (sound.arpDirection === 'down') return ascending.reverse();
  if (sound.arpDirection === 'updown' && ascending.length > 1) {
    return ascending.concat(ascending.slice(1, -1).reverse());
  }
  return ascending;
}

function scheduleGen3ArpNote(time, midi, sound, stepDuration) {
  const session = GEN3_ARP_RUNTIME.session;
  const delayMs = Math.max(0, time - audioCtx.currentTime) * 1000;
  const gateMs = Math.max(8, stepDuration * clamp(sound.arpGate, 0.1, 1) * 1000);
  setTimeout(() => {
    if (!audioCtx || !GEN4.playing || session !== GEN3_ARP_RUNTIME.session) return;
    if (GEN3.activeNotes.has(midi)) removeGen3Note(midi);
    addGen3Note(midi, midiNoteToFrequency(midi), null, sound, gateMs);
  }, delayMs);
}

function scheduleGen3ArpStep(loop, time) {
  const sound = loop?.gen3;
  if (!sound?.arpEnabled) return;
  const entry = PLAY.mode === 'song' ? SONG.entries[SONG.cursor.entryIdx] : null;
  const visit = entry ? songRuntime(entry.id).visits : 0;
  const identity = entry ? `entry:${entry.id}:visit:${visit}` : `loop:${loop.id}`;
  if (GEN3_ARP_RUNTIME.identity !== identity) {
    GEN3_ARP_RUNTIME.identity = identity;
    GEN3_ARP_RUNTIME.stepCounter = 0;
    GEN3_ARP_RUNTIME.noteIndex = 0;
  }

  const rateBeats = GEN3_ARP_RATE_OPTIONS.some(
    ({ beats }) => Math.abs(beats - sound.arpRateBeats) < 1e-6,
  )
    ? sound.arpRateBeats
    : 0.25;
  const rateDuration = beatsToSeconds(rateBeats);
  const hitsPerStep = rateBeats < 0.25 ? Math.round(0.25 / rateBeats) : 1;
  const stepInterval = rateBeats >= 0.25 ? Math.round(rateBeats / 0.25) : 1;
  const shouldFire = GEN3_ARP_RUNTIME.stepCounter % stepInterval === 0;
  const notes = shouldFire ? getGen3ArpNotes(sound) : [];

  if (notes.length > 0) {
    for (let hit = 0; hit < hitsPerStep; hit++) {
      let midi;
      if (sound.arpDirection === 'random') {
        midi = notes[Math.floor(Math.random() * notes.length)];
      } else {
        midi = notes[GEN3_ARP_RUNTIME.noteIndex % notes.length];
        GEN3_ARP_RUNTIME.noteIndex += 1;
      }
      scheduleGen3ArpNote(time + hit * rateDuration, midi, sound, rateDuration);
    }
  }
  GEN3_ARP_RUNTIME.stepCounter += 1;
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
          // During Song playback of a DIFFERENT loop this only edits the
          // focused loop, without retargeting the audible entry's chord.
          // Editing the loop that is sounding syncs right away.
          if (GEN3.lockedMidis.has(midi)) {
            GEN3.lockedMidis.delete(midi);
          } else {
            GEN3.lockedMidis.add(midi);
          }
          const songPlaying = PLAY.mode === 'song' && GEN4.playing;
          if (!songPlaying || getAudibleLoop() === getEditLoop()) {
            await ensureAudioEngine();
            syncGen3SustainChord(GEN3.lockedMidis);
          }
          refreshGen3KeyStates();
        } else {
          // Sequencer/arp mode: toggle the note pool; transport drives playback.
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
  refreshGen3ScaleHighlight();
  return wrap;
}

function bindGen3CopyContext(el, key, label) {
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openKnobContextMenu({ genIdx: 2, key, label }, event.clientX, event.clientY);
  });
}

function buildGen3ArpSelect(label, key, options, parseValue = (value) => value) {
  const control = document.createElement('label');
  control.className = 'gen3-arp-control';
  const caption = document.createElement('span');
  caption.textContent = label;
  const select = document.createElement('select');
  options.forEach(({ value, text }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  });
  select.addEventListener('change', () => {
    GEN3[key] = parseValue(select.value);
    writeGen3ParamToEditLoop(key, GEN3[key]);
    resetGen3ArpRuntime({ newSession: true });
  });
  bindGen3CopyContext(control, key, `Arp ${label.toLowerCase()}`);
  control.append(caption, select);
  return { control, select };
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
      writeGen3ParamToEditLoop('type', type);
      shapes.querySelectorAll('.osc-shape').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (!(PLAY.mode === 'song' && GEN4.playing && getAudibleLoop() !== getEditLoop())) {
        restartAllGen3Notes();
      }
    });
    btn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openKnobContextMenu(
        { genIdx: 2, key: 'type', label: 'Oscillator shape' },
        event.clientX,
        event.clientY,
      );
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
    if (GEN3.sustainMode) GEN3.arpEnabled = false;
    writeGen3ParamToEditLoop('sustainMode', GEN3.sustainMode);
    writeGen3ParamToEditLoop('arpEnabled', GEN3.arpEnabled);
    resetGen3ArpRuntime({ newSession: true });
    refreshGen3UI();
    const editingAudibleLoop =
      !(PLAY.mode === 'song' && GEN4.playing) || getAudibleLoop() === getEditLoop();
    if (!editingAudibleLoop) return;
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
  bindGen3CopyContext(susBtn, 'sustainMode', 'Sustain mode');

  const arpBtn = document.createElement('button');
  arpBtn.className = 'osc-sus-btn osc-arp-btn' + (GEN3.arpEnabled ? ' active' : '');
  arpBtn.textContent = 'ARP';
  arpBtn.title = 'Arpeggiator — plays the selected keys in sequence';
  gen3ArpBtnEl = arpBtn;
  arpBtn.addEventListener('click', () => {
    GEN3.arpEnabled = !GEN3.arpEnabled;
    if (GEN3.arpEnabled) GEN3.sustainMode = false;
    writeGen3ParamToEditLoop('arpEnabled', GEN3.arpEnabled);
    writeGen3ParamToEditLoop('sustainMode', GEN3.sustainMode);
    resetGen3ArpRuntime({ newSession: true });
    const editingAudibleLoop =
      !(PLAY.mode === 'song' && GEN4.playing) || getAudibleLoop() === getEditLoop();
    if (editingAudibleLoop && GEN3.activeNotes.size > 0) stopAllGen3Notes();
    refreshGen3UI();
    refreshGen3KeyStates();
  });
  bindGen3CopyContext(arpBtn, 'arpEnabled', 'Arpeggiator mode');

  const actions = document.createElement('div');
  actions.className = 'gen-header-actions';
  actions.appendChild(
    buildScaleGroup('Snap the locked keys to the nearest scale note', fitGen3ChordToScale),
  );
  actions.appendChild(susBtn);
  actions.appendChild(arpBtn);

  header.append(title, shapes, actions);
  panel.appendChild(header);

  const arpBar = document.createElement('div');
  arpBar.className = 'gen3-arp-bar';
  gen3ArpBarEl = arpBar;
  const rate = buildGen3ArpSelect(
    'Rate',
    'arpRateBeats',
    GEN3_ARP_RATE_OPTIONS.map(({ beats, label }) => ({ value: String(beats), text: label })),
    Number,
  );
  gen3ArpRateSelect = rate.select;
  const direction = buildGen3ArpSelect('Direction', 'arpDirection', [
    { value: 'up', text: 'Up' },
    { value: 'down', text: 'Down' },
    { value: 'updown', text: 'Up / Down' },
    { value: 'random', text: 'Random' },
  ]);
  gen3ArpDirectionSelect = direction.select;
  const octaves = buildGen3ArpSelect(
    'Octaves',
    'arpOctaves',
    [1, 2, 3].map((value) => ({ value: String(value), text: String(value) })),
    Number,
  );
  gen3ArpOctaveSelect = octaves.select;
  const gate = buildGen3ArpSelect(
    'Gate',
    'arpGate',
    [0.25, 0.5, 0.75, 1].map((value) => ({
      value: String(value),
      text: `${Math.round(value * 100)}%`,
    })),
    Number,
  );
  gen3ArpGateSelect = gate.select;
  arpBar.append(rate.control, direction.control, octaves.control, gate.control);
  panel.appendChild(arpBar);
  arpBar.hidden = !GEN3.arpEnabled;

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
  GEN3_PARAM_DEFS.forEach((p) => {
    const isMappable = GEN3_LFO_PARAMS.some(({ key }) => key === p.key);
    const control = makeControlRow(
      p,
      GEN3[p.key],
      (v) => {
        // Lock mode with an OSC step selected: the knob writes that step's
        // param lock instead of the global gen3 sound.
        const stepLocks = getGen3StepLockTarget();
        if (stepLocks) {
          stepLocks[p.key] = v;
          control.classList.add('parameter-locked');
          gen4ApplyStepBtn(gen4LockSelection.ci, gen4LockSelection.si);
          refreshGen4LockEditor();
          return;
        }
        GEN3[p.key] = v;
        writeGen3ParamToEditLoop(p.key, v);
        if (GEN3.nodes && (p.key === 'gain' || p.key === 'pitch' || p.key === 'detune')) {
          applyGen3Modulation();
        }
        refreshModulationVisuals();
        refreshBackPanelState();
      },
      isMappable ? { genIdx: 2, key: p.key } : null,
      { genIdx: 2, key: p.key },
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
  {
    // Sampler lane — plays a slice of a granular input's audio (a loaded file
    // or a frozen mic take). Start/length are fractions of that buffer.
    id: 'smp',
    label: 'SMP',
    color: '#d8c94a',
    paramDefs: [
      { key: 'source', label: 'Source', min: 0, max: 1, step: 1, value: 0, unit: '' },
      { key: 'start', label: 'Start', min: 0, max: 1, step: 0.001, value: 0, unit: '' },
      { key: 'length', label: 'Length', min: 0.01, max: 1, step: 0.001, value: 0.25, unit: '' },
      { key: 'pitch', label: 'Pitch', min: -24, max: 24, step: 1, value: 0, unit: 'st' },
      { key: 'decay', label: 'Decay', min: 0.02, max: 2, step: 0.01, value: 0.8, unit: 's' },
      { key: 'tone', label: 'Tone', min: 200, max: 16000, step: 100, value: 16000, unit: 'Hz' },
      { key: 'gain', label: 'Gain', min: 0, max: 1, step: 0.01, value: 0.8, unit: '' },
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
  smp: [
    {
      name: 'Default',
      values: { source: 0, start: 0, length: 0.25, pitch: 0, decay: 0.8, tone: 16000, gain: 0.8 },
    },
    {
      name: 'Chop',
      values: { source: 0, start: 0, length: 0.08, pitch: 0, decay: 0.25, tone: 16000, gain: 0.85 },
    },
    {
      name: 'Pad',
      values: { source: 0, start: 0.1, length: 1, pitch: 0, decay: 2, tone: 9000, gain: 0.7 },
    },
    {
      name: 'Dark Half',
      values: { source: 0, start: 0.2, length: 0.35, pitch: -12, decay: 1.2, tone: 3200, gain: 0.8 },
    },
  ],
};

// ── Genre kits ── one selection sets every lane's sound AND writes a groove
// into the edit loop's drum pattern (sound is global, the pattern lands in the
// loop being edited). Step entries: step | [step, velocity] |
// { s, v (velocity), p (probability), st (stutter retrigs), t (timing,
// 1/128ths), n (MIDI note — overrides the lane's tuning for that step) }.
// Optional `mods`: [{ target: '4:<lane>:<param>', source: 'lfo1'|'lfo2'|'seq'|'kick' }]
// — modulation routes applied with the kit (replacing existing drum-lane routes).
const GEN4_KIT_PRESETS = [
  {
    // Captured from a live session — pattern, sounds, and mod routes together.
    name: 'House',
    bpm: 124,
    swing: 0.4,
    stepCount: 32,
    channels: {
      kick: {
        params: { tune: 76, decay: 0.46, punch: 0.5, drive: 0, gain: 1 },
        steps: [0, 4, 8, 12, 16, 20, 24, 28, 30], // pickup kick into the loop
      },
      snare: {
        params: { tune: 135, decay: 0.13, snap: 0.82, gain: 0.99 },
        steps: [{ s: 4, t: 1 }, 12, 20, 28, 30, 31], // fill rolls out of bar 2
      },
      hat: {
        params: { decay: 0.125, tone: 8400, gain: 0.55 },
        steps: [2, 6, 10, 14, 18, 22, 26, 30],
      },
      perc: {
        params: { tune: 255, ratio: 1.4, index: 1.9, decay: 0.1, gain: 0.42 },
        steps: [
          { s: 6, v: 0.69 },
          { s: 10, v: 0.7 },
          { s: 11, v: 0.45 },
          { s: 15, v: 0.35 },
          { s: 19, v: 0.5 },
          { s: 23, v: 0.65 },
          26,
          { s: 27, v: 0.5 },
        ],
      },
      fm: {
        // offbeat sub bounce with a walking note line
        params: { tune: 55, ratio: 0.5, index: 1.2, feedback: 0.08, attack: 0.005, decay: 0.3, modDecay: 0.3, tone: 1800, gain: 0.8 },
        steps: [
          { s: 0, n: 27 },
          2,
          { s: 5, n: 30 },
          6,
          { s: 8, n: 41 },
          10,
          { s: 11, n: 36 },
          14,
          { s: 15, n: 41 },
          18,
          22,
          26,
          { s: 28, n: 38 },
          30,
        ],
      },
    },
    mods: [
      { target: '4:hat:decay', source: 'lfo1' },
      { target: '4:hat:tone', source: 'lfo1' },
      { target: '4:perc:index', source: 'lfo1' },
    ],
  },
  {
    name: 'Drum n Bass',
    bpm: 174,
    swing: 0,
    stepCount: 32,
    channels: {
      kick: {
        // short and clicky — leaves the low end to the sub
        params: { tune: 56, decay: 0.28, punch: 0.8, drive: 0.15, gain: 1 },
        steps: [0, 10, 16, 26],
      },
      snare: {
        // cracky jungle snare; ghost hits between backbeats make the roll
        params: { tune: 250, decay: 0.15, snap: 1, gain: 0.95 },
        steps: [
          4,
          12,
          20,
          28,
          { s: 7, v: 0.3, t: 1 },
          { s: 9, v: 0.25 },
          { s: 15, v: 0.35, t: -1 },
          { s: 23, v: 0.3, t: 1 },
          { s: 25, v: 0.25 },
          { s: 31, v: 0.35, t: -1 },
        ],
      },
      hat: {
        // rolling 16ths, 8th-note accent cycle
        params: { decay: 0.03, tone: 12500, gain: 0.45 },
        steps: [
          [0, 0.75], [1, 0.3], [2, 0.5], [3, 0.3],
          [4, 0.75], [5, 0.3], [6, 0.5], [7, 0.3],
          [8, 0.75], [9, 0.3], [10, 0.5], [11, 0.3],
          [12, 0.75], [13, 0.3], [14, 0.5], [15, 0.3],
          [16, 0.75], [17, 0.3], [18, 0.5], [19, 0.3],
          [20, 0.75], [21, 0.3], [22, 0.5], [23, 0.3],
          [24, 0.75], [25, 0.3], [26, 0.5], [27, 0.3],
          [28, 0.75], [29, 0.3], [30, 0.5], [31, 0.3],
        ],
      },
      perc: {
        // dry rim on the syncopation
        params: { tune: 190, ratio: 1.4, index: 0.9, decay: 0.06, gain: 0.5 },
        steps: [
          [3, 0.4],
          [11, 0.45],
          [19, 0.4],
          [27, 0.45],
          [31, 0.5],
        ],
      },
      fm: {
        // sub bassline under the kick: E1 · E1 · G1 · A1
        params: { tune: 41, ratio: 0.5, index: 0.8, feedback: 0, attack: 0.004, decay: 0.9, modDecay: 0.2, tone: 900, gain: 0.9 },
        steps: [
          { s: 0, n: 28 },
          { s: 10, n: 28 },
          { s: 16, n: 31 },
          { s: 26, n: 33 },
        ],
      },
    },
  },
  {
    // Captured from a live session — pattern, sounds, and mod routes together.
    name: 'Techno',
    bpm: 132,
    swing: 0,
    stepCount: 32,
    channels: {
      kick: {
        params: { tune: 82, decay: 0.69, punch: 0.57, drive: 0.01, gain: 1 },
        steps: [0, 4, 8, 12, 16, 20, 24, 28],
      },
      snare: {
        params: { tune: 500, decay: 0.13, snap: 1, gain: 1 },
        steps: [4, 12, 20, 28],
      },
      hat: {
        // dark open offbeat — the pump
        params: { decay: 0.265, tone: 5000, gain: 0.63 },
        steps: [2, 6, 10, 14, 18, 22, 26, 30],
      },
      perc: {
        // metallic rim on a 3-against-4 cycle — the hypnotic layer
        params: { tune: 605, ratio: 5.8, index: 6.5, decay: 0.07, gain: 0.29 },
        steps: [
          [3, 0.5],
          [6, 0.35],
          [11, 0.5],
          [14, 0.35],
          [19, 0.5],
          [22, 0.35],
          [27, 0.5],
          [30, 0.35],
        ],
      },
      fm: {
        // rolling acid-style bassline around E1–A1
        params: { tune: 62, ratio: 1.8, index: 5, feedback: 0.15, attack: 0.001, decay: 0.55, modDecay: 0.27, tone: 2800, gain: 0.5 },
        steps: [
          { s: 0, n: 28 },
          { s: 1, n: 32 },
          { s: 3, n: 33 },
          { s: 4, n: 31 },
          { s: 6, v: 0.55 },
          { s: 7, n: 30 },
          { s: 8, n: 33 },
          { s: 10, n: 32 },
          { s: 11, n: 31 },
          { s: 12, n: 30 },
          { s: 14, n: 32 },
          { s: 15, n: 33 },
          { s: 17, n: 32 },
          { s: 19, n: 31 },
          { s: 21, n: 33 },
          { s: 22, v: 0.55 },
          { s: 24, n: 33 },
          { s: 25, n: 29 },
          { s: 27, n: 32 },
          { s: 28, n: 31 },
          { s: 30, v: 0.5, p: 0.6 },
          { s: 31, n: 33 },
        ],
      },
    },
    mods: [
      { target: '4:perc:tune', source: 'lfo2' },
      { target: '4:perc:decay', source: 'lfo2' },
      { target: '4:fm:ratio', source: 'lfo1' },
      { target: '4:fm:decay', source: 'lfo2' },
    ],
  },
  {
    // Captured from a live session — pattern, sounds, and mod routes together.
    name: 'Glitch',
    bpm: 100,
    swing: 0,
    stepCount: 32,
    channels: {
      kick: {
        params: { tune: 50, decay: 0.18, punch: 0.43, drive: 0, gain: 0.9 },
        steps: [0, { s: 3, n: 26 }, 8, { s: 11, n: 28 }, 16, 19, 24, 26],
      },
      snare: {
        params: { tune: 150, decay: 0.09, snap: 1, gain: 1 },
        steps: [4, { s: 10, n: 47 }, 12, 20, { s: 23, v: 0.4, p: 0.6 }, 28],
      },
      hat: {
        params: { decay: 0.04, tone: 10800, gain: 0.6 },
        steps: [
          0,
          1,
          { s: 2, p: 0.8 },
          3,
          { s: 5, v: 0.6 },
          7,
          8,
          9,
          { s: 10, p: 0.7 },
          { s: 13, v: 0.5 },
          15,
          { s: 18, p: 0.8 },
          { s: 21, v: 0.6, n: 115 },
          { s: 23, n: 113 },
          { s: 24, n: 112 },
          { s: 26, p: 0.7 },
          { s: 29, v: 0.5 },
          { s: 30, v: 0.4, p: 0.75, st: 2 },
          { s: 31, p: 0.75 },
        ],
      },
      perc: {
        params: { tune: 800, ratio: 8, index: 1.7, decay: 0.04, gain: 0.23 },
        steps: [
          2,
          4,
          5,
          { s: 6, v: 0.5 },
          10,
          13,
          15,
          19,
          { s: 22, v: 0.54, p: 0.25, st: 4 },
          { s: 25, v: 0.4, n: 76 },
          { s: 28, n: 79 },
          { s: 29, p: 0.5, n: 79 },
          30,
        ],
      },
      fm: {
        params: { tune: 1200, ratio: 5.25, index: 16.8, feedback: 0.1, attack: 0.001, decay: 0.11, modDecay: 0.01, tone: 9300, gain: 0.06 },
        steps: [
          5,
          { s: 6, p: 0.25, n: 78 },
          7,
          { s: 14, p: 0.6, n: 75 },
          { s: 17, p: 0.5, n: 80 },
          { s: 30, p: 0.7 },
        ],
      },
    },
    mods: [
      { target: '4:hat:decay', source: 'lfo1' },
      { target: '4:hat:tone', source: 'lfo2' },
      { target: '4:perc:index', source: 'lfo1' },
      { target: '4:perc:decay', source: 'lfo2' },
    ],
  },
];

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

// Apply a genre kit: every lane's sound params plus a fresh groove written
// into the edit loop's active drum pattern (wipes that pattern first).
function applyGen4KitPreset(presetIndex) {
  const kit = GEN4_KIT_PRESETS[presetIndex];
  const loop = getEditLoop();
  if (!kit || !loop) return;
  if (typeof kit.bpm === 'number') setTransportBpm(kit.bpm);
  loop.gen4.swing = kit.swing || 0;

  GEN4.channels.forEach((ch, ci) => {
    const spec = kit.channels[ch.id];
    // Clean slate for the lane — a kit is a groove, not a merge.
    for (let si = 0; si < 32; si++) {
      ch.steps[si] = false;
      ch.notes[si] = null;
      ch.velocity[si] = 1;
      ch.timing[si] = 0;
      ch.locks[si] = {};
      ch.stutter[si] = 1;
      ch.probability[si] = 1;
      ch.condition[si] = 0;
    }
    if (spec?.params) {
      Object.entries(spec.params).forEach(([key, value]) => {
        ch.params[key] = value;
        gen4ControlBindings[ci].get(key)?.setValue(value);
      });
    }
    (spec?.steps || []).forEach((entry) => {
      const e =
        typeof entry === 'number'
          ? { s: entry }
          : Array.isArray(entry)
            ? { s: entry[0], v: entry[1] }
            : entry;
      if (!Number.isInteger(e.s) || e.s < 0 || e.s >= 32) return;
      ch.steps[e.s] = true;
      if (typeof e.v === 'number') ch.velocity[e.s] = e.v;
      if (typeof e.p === 'number') ch.probability[e.s] = e.p;
      if (typeof e.st === 'number') ch.stutter[e.s] = e.st;
      if (typeof e.t === 'number') ch.timing[e.s] = e.t;
      if (Number.isInteger(e.n)) ch.notes[e.s] = clamp(e.n, GEN4_NOTE_MIN, GEN4_NOTE_MAX);
    });
    refreshGen4PresetSelection(ci);
  });

  // Modulation routes: the kit's drum-lane mappings replace any existing ones
  // (clean slate, like the pattern). Non-drum routes are left alone.
  [...lfoMappings.keys()].filter((k) => k.startsWith('4:')).forEach((k) => lfoMappings.delete(k));
  const KIT_MOD_SOURCES = { lfo1: 0, lfo2: 1, seq: 2, kick: 3, trig: 4 };
  (kit.mods || []).forEach(({ target, source }) => {
    const sourceIdx = KIT_MOD_SOURCES[source];
    const match = typeof target === 'string' && target.match(/^4:([a-z]+):(\w+)$/);
    if (sourceIdx === undefined || !match) return;
    const def = GEN4_DEFS.find((d) => d.id === match[1]);
    if (!def?.paramDefs.some((p) => p.key === match[2])) return;
    lfoMappings.set(target, { genIdx: 4, key: `${match[1]}:${match[2]}`, sourceIdx });
  });
  rebuildBackWireSVG();
  refreshLFOMappingUI();

  gen4SetStepCount(kit.stepCount || 16, { duplicateOnExpand: false });
  refreshGen4SwingUI();
  GEN4.channels.forEach((_, ci) => {
    for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
  });
  gen4RefreshStepDisplay();
  if (gen4EditorMode === 'notes') refreshGen4NoteEditor();
  refreshGen4LockEditor();
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
  scheduleAheadTime: 0.15,
  scheduleInterval: 25,
  stepCount: 16,
  nodes: null,
  cycleCount: 0, // pattern passes since play started — drives A:B trig conditions
  condFired: GEN4_DEFS.map(() => false), // last per-lane trig decision, for PRE
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
      condition: new Array(32).fill(0),
      params: Object.fromEntries(def.paramDefs.map((p) => [p.key, p.value])),
    };
  }),
};

const KICK_SC = {
  envelope: 0,
  release: 0.2,
  amount: 1.0,
};

// Second trigger envelope (mod source 4): like Kick SC, but the drum lane that
// fires it is selectable, and `invert` flips the polarity — a normal mapping
// ducks the target on each hit, an inverted one pushes it up (gate-style
// sidechain: the target only opens while the chosen lane is hitting).
const TRIG_SC = {
  envelope: 0,
  release: 0.2,
  amount: 1.0,
  source: 'fm',
  invert: false,
};
const trigScSourceBtns = new Map();
let trigScInvBtn = null;

function refreshTrigScUI() {
  trigScSourceBtns.forEach((btn, id) => btn.classList.toggle('active', TRIG_SC.source === id));
  if (trigScInvBtn) {
    trigScInvBtn.classList.toggle('active', TRIG_SC.invert);
    trigScInvBtn.setAttribute('aria-pressed', TRIG_SC.invert ? 'true' : 'false');
  }
}

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
let gen4NoteStepNumberEls = []; // roll header numbers — double as lock-step selectors
let gen4NotePencilBtn = null;
let gen4NotePencilEnabled = true;
let gen4GenTab = 'euc'; // which generator's controls the toolbar shows
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
    GEN4.channels[ci].timing[si] = clamp(startTiming + Math.round(dx / 6), -8, 8);
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
    // Dry hits skip the reorderable FX but still pass through the drums mixer
    // strip, so its EQ, pan, gain, solo and mute remain authoritative.
    gain.connect(fxBuses.gen4.mixerIn);
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

function gen4TriggerOsc(
  time,
  midis = GEN3.lockedMidis,
  locks = null,
  sound = getGen3SoundState(),
) {
  if (!audioCtx || sound.sustainMode || sound.arpEnabled || midis.size === 0) return;
  // Per-step gen3 param locks — only known synth keys ride along as voice
  // overrides (locks can also carry _fxSend and the like).
  let ov = null;
  if (locks) {
    GEN3_PARAM_DEFS.forEach(({ key }) => {
      if (Object.hasOwn(locks, key)) (ov ||= {})[key] = locks[key];
    });
  }
  // Snapshot the chord now — in song mode the bound loop may change before the
  // scheduled timeout fires.
  const notes = [...midis];
  const delayMs = Math.max(0, time - audioCtx.currentTime) * 1000;
  setTimeout(() => {
    const oscChannel = GEN4.channels.find((channel) => channel.id === 'osc');
    if (!audioCtx || oscChannel?.muted) return;
    notes.forEach((midi) => {
      if (GEN3.activeNotes.has(midi)) removeGen3Note(midi);
      addGen3Note(midi, midiNoteToFrequency(midi), ov, sound);
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

// SMP slice audio: a granular input's loaded file, else its frozen mic take.
// The AudioBuffer is cached per input and rebuilt only when the underlying
// Float32Array (or the audio context) changes.
const gen4SmpCache = [
  { data: null, ctx: null, buf: null },
  { data: null, ctx: null, buf: null },
];

function getGen4SmpSourceAudio(idx) {
  const source = GRANULAR_SOURCES[idx];
  if (!source) return null;
  if (source.mode === 'file' && source.bufferData?.length) {
    // bufferData carries no explicit rate — derive it from the duration.
    const rate =
      source.durationSec > 0
        ? source.bufferData.length / source.durationSec
        : audioCtx.sampleRate;
    return { data: source.bufferData, rate };
  }
  if (source.frozenData?.samples?.length) {
    return { data: source.frozenData.samples, rate: source.frozenData.sampleRate };
  }
  return null;
}

function getGen4SmpBuffer(idx) {
  if (!audioCtx) return null;
  const audio = getGen4SmpSourceAudio(idx);
  if (!audio) return null;
  const slot = gen4SmpCache[idx];
  if (slot.data !== audio.data || slot.ctx !== audioCtx) {
    const rate = clamp(Math.round(audio.rate || audioCtx.sampleRate), 8000, 96000);
    const buf = audioCtx.createBuffer(1, audio.data.length, rate);
    buf.getChannelData(0).set(audio.data);
    slot.data = audio.data;
    slot.ctx = audioCtx;
    slot.buf = buf;
  }
  return slot.buf;
}

function gen4TriggerSmp(time, velocity, p, dest) {
  const buf = getGen4SmpBuffer(p.source >= 0.5 ? 1 : 0);
  if (!buf) return; // nothing loaded or frozen on that input yet
  const ac = audioCtx;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const rate = Math.pow(2, p.pitch / 12);
  src.playbackRate.setValueAtTime(rate, time);
  const offset = clamp(p.start, 0, 1) * buf.duration;
  const sliceDur = Math.max(0.005, Math.min(p.length * buf.duration, buf.duration - offset));
  const playDur = sliceDur / rate;
  const peak = Math.max(0.001, velocity * p.gain);
  const envelope = ac.createGain();
  const tone = ac.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(p.tone, time);
  tone.Q.setValueAtTime(0.7, time);
  // Decay ends no later than the slice does, so the cut never clicks. The
  // exponential ramp can't reach zero — snap to 0 and stop the source at the
  // decay end, or the slice remainder keeps sounding as a quiet ghost tail.
  const end = time + Math.min(playDur, Math.max(p.decay, 0.02));
  envelope.gain.setValueAtTime(0.0001, time);
  envelope.gain.linearRampToValueAtTime(peak, time + 0.003);
  envelope.gain.exponentialRampToValueAtTime(0.001, end);
  envelope.gain.setValueAtTime(0, end);
  src.connect(envelope);
  envelope.connect(tone);
  tone.connect(dest);
  src.start(time, offset, sliceDur);
  src.stop(end + 0.02);
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
    effective[pd.key] = Math.max(
      pd.min,
      Math.min(pd.max, effective[pd.key] + getModOffset(mapping.sourceIdx, scaled, pd)),
    );
  });
  return effective;
}

function midiNoteToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function applyGen4StepNote(ch, p, midi, locks = null) {
  if (!Number.isFinite(midi) || ch.id === 'osc') return;
  if (ch.id === 'smp') {
    // SMP repitches in semitones around C4. The assigned note is the target,
    // and the PITCH knob transposes the whole lane on top (sample tuning) —
    // p.pitch already carries knob + LFO, so add rather than replace. A pitch
    // lock stays absolute: it overrides note and knob alike.
    if (locks && Object.hasOwn(locks, 'pitch')) return;
    const pitchDef = GEN4_DEFS.find((def) => def.id === 'smp').paramDefs.find(
      (param) => param.key === 'pitch',
    );
    p.pitch = clamp(midi - 60 + p.pitch, pitchDef.min, pitchDef.max);
    return;
  }
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
  if (ch.id === TRIG_SC.source) TRIG_SC.envelope = 1.0;
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
        locks,
        loop?.gen3 || GEN3,
      );
      break;
    case 'fm':
      gen4TriggerFmSynth(time, velocity, p, dest);
      break;
    case 'smp':
      gen4TriggerSmp(time, velocity, p, dest);
      break;
  }
  queueVizEvent(ch.id, time, velocity, midi);
}

function gen4ScheduleTick() {
  if (!audioCtx || !GEN4.nodes || !GEN4.playing) return;
  const secPerStep = 60.0 / TRANSPORT.bpm / 4;
  const secPerOneTwentyEighth = 60.0 / TRANSPORT.bpm / 32;
  const scheduleHorizon = GEN4.scheduleAheadTime + secPerOneTwentyEighth * 8;
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
      GEN4.cycleCount += 1;
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
    scheduleGen3ArpStep(loop, GEN4.nextStepTime + swingOffset);
    pattern.channels.forEach((pat, ci) => {
      if (!pat.steps[step]) return;
      const fired = gen4StepConditionMet(pat, ci, step) && Math.random() <= pat.probability[step];
      GEN4.condFired[ci] = fired;
      if (!fired) return;
      const count = pat.stutter[step];
      const timing = clamp(Math.round(pat.timing?.[step] || 0), -8, 8);
      const stepTime = Math.max(
        audioCtx.currentTime,
        GEN4.nextStepTime + swingOffset + timing * secPerOneTwentyEighth,
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
    if (!BOUNCE.active && linkSynced()) {
      // Absolute grid time, re-derived from the live clock offset every step —
      // corrections land as micro-shifts, never as accumulated drift.
      LINK.stepAbs += 1;
      GEN4.nextStepTime = linkStepAudioTime(LINK.stepAbs);
    } else {
      GEN4.nextStepTime += secPerStep;
    }
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
      ch.condition[dest] = ch.condition[src];
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
  GEN4.cycleCount = 0;
  GEN4.condFired.fill(false);
  gen4Schedule.length = 0;
  resetGen3ArpRuntime({ newSession: true });
  if (PLAY.mode === 'song') resetSongPlayback();
  else {
    STEP_SEQ.currentStep = 0;
    STEP_SEQ.elapsed = 0;
    const seq = getSchedulerLoop()?.seq;
    STEP_SEQ.currentValue = seq ? seq.steps[0] || 0 : 0;
    refreshSequencerUI();
  }
  applyGen3Modulation();
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
  if (!BOUNCE.active && LINK.active && !LINK.applyingRemote && !LINK.grid.playing) {
    // We start the linked session: anchor the shared grid slightly ahead so
    // the peer can catch step 0 too.
    LINK.grid = { bpm: TRANSPORT.bpm, origin: linkNow() + 0.15, playing: true };
    linkBroadcastGrid();
  }
  if (!BOUNCE.active && linkSynced()) {
    LINK.stepAbs = linkJoinStep();
    GEN4.nextStepTime = linkStepAudioTime(LINK.stepAbs);
  } else {
    GEN4.nextStepTime = audioCtx.currentTime + 0.01;
  }
  GEN4.schedulerTimer = setInterval(gen4ScheduleTick, GEN4.scheduleInterval);
  gen4ScheduleTick();
  if (!gen4DisplayFrame) gen4DisplayFrame = requestAnimationFrame(gen4DisplayTick);
  refreshSongTransportUI();
}

function stopGen4Sequencer() {
  GEN4.playing = false;
  resetGen3ArpRuntime({ newSession: true });
  releaseGen3SustainChord();
  applyGen3Modulation();
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
  const timing = clamp(Math.round(ch.timing?.[si] || 0), -8, 8);
  btn.title = on
    ? `Velocity ${Math.round(ch.velocity[si] * 100)}% · timing ${timing > 0 ? '+' : ''}${timing}/128`
    : '';

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

  const condEl = btn.querySelector('.drum-step-cond');
  if (condEl) {
    const cond = GEN4_TRIG_CONDITIONS[ch.condition?.[si] || 0];
    condEl.textContent = cond?.label || '';
    condEl.hidden = !on || !cond?.label;
  }
}

function gen4CycleStutter(ci, si) {
  const ch = GEN4.channels[ci];
  ch.stutter[si] = (ch.stutter[si] % 4) + 1;
  gen4ApplyStepBtn(ci, si);
}

// ── Trig conditions ── Elektron-style per-step gates evaluated at schedule
// time: A:B fires on the Ath of every B pattern cycles, FILL only while the
// fill is engaged, PRE/!PRE follow the lane's previous trig decision.
const GEN4_TRIG_CONDITIONS = [
  { id: 'always', label: '' },
  { id: '1:2', label: '1:2', a: 1, b: 2 },
  { id: '2:2', label: '2:2', a: 2, b: 2 },
  { id: '1:4', label: '1:4', a: 1, b: 4 },
  { id: '4:4', label: '4:4', a: 4, b: 4 },
  { id: 'fill', label: 'FIL', fill: true },
  { id: 'pre', label: 'PRE', pre: true },
  { id: 'npre', label: '!PR', pre: false },
];

function gen4CycleCondition(ci, si) {
  const ch = GEN4.channels[ci];
  ch.condition[si] = ((ch.condition[si] || 0) + 1) % GEN4_TRIG_CONDITIONS.length;
  gen4ApplyStepBtn(ci, si);
}

function gen4StepConditionMet(pat, ci, step) {
  const cond = GEN4_TRIG_CONDITIONS[pat.condition?.[step] || 0];
  if (!cond || cond.id === 'always') return true;
  if (cond.b) {
    const cycle = PLAY.mode === 'song' ? SONG.cursor.repeat : GEN4.cycleCount;
    return cycle % cond.b === cond.a - 1;
  }
  if (cond.fill) {
    // Manual fill button, or the song entry's auto-fill cycle (the scheduler
    // resolves that cycle to the cached fill pattern, so identity is the tell).
    return gen4FillState.active || (!!SONG.cursor.fillPattern && pat === SONG.cursor.fillPattern);
  }
  if ('pre' in cond) return GEN4.condFired[ci] === cond.pre;
  return true;
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

// The midi window a lane can actually play: its tune/tone param range mapped
// to midi. Generators clamp into this so a hat never gets a C2 it can't voice
// (and the roll never hides a generated note).
function getGen4LaneMidiRange(ci) {
  const def = GEN4_DEFS[ci];
  const ch = GEN4.channels[ci];
  if (ch.id === 'smp') {
    const pitchDef = def.paramDefs.find((p) => p.key === 'pitch');
    return {
      min: clamp(60 + pitchDef.min, GEN4_NOTE_MIN, GEN4_NOTE_MAX),
      max: clamp(60 + pitchDef.max, GEN4_NOTE_MIN, GEN4_NOTE_MAX),
    };
  }
  const pitchKey = ch.id === 'hat' ? 'tone' : 'tune';
  const pitchDef = def.paramDefs.find((p) => p.key === pitchKey);
  if (!pitchDef) return { min: GEN4_NOTE_MIN, max: GEN4_NOTE_MAX };
  return {
    min: clamp(Math.ceil(frequencyToMidi(pitchDef.min)), GEN4_NOTE_MIN, GEN4_NOTE_MAX),
    max: clamp(Math.floor(frequencyToMidi(pitchDef.max)), GEN4_NOTE_MIN, GEN4_NOTE_MAX),
  };
}

function getGen4BaseMidi(ci) {
  const ch = GEN4.channels[ci];
  if (ch.id === 'osc') return [...GEN3.lockedMidis][0] ?? 60;
  if (ch.id === 'smp') return clamp(Math.round(60 + ch.params.pitch), GEN4_NOTE_MIN, GEN4_NOTE_MAX);
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
    ch.condition[stepIdx] = 0;
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

// The OSC channel has no drum-panel knobs — its locks are edited through the
// gen3 panel itself. Non-null while lock mode has an OSC step selected.
function getGen3StepLockTarget() {
  if (!gen4LockSelection) return null;
  if (GEN4_DEFS[gen4LockSelection.ci]?.id !== 'osc') return null;
  return GEN4.channels[gen4LockSelection.ci].locks[gen4LockSelection.si] || null;
}

function refreshGen4LockEditor() {
  GEN4_DEFS.forEach((def, ci) => {
    for (let si = 0; si < 32; si++) {
      gen4StepEls[ci][si]?.classList.toggle(
        'lock-selected',
        gen4LockSelection?.ci === ci && gen4LockSelection?.si === si,
      );
    }
    const selected = gen4LockSelection?.ci === ci;
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
  // OSC locks live on the gen3 panel's own knobs — mirror lock state there.
  const gen3Locks = getGen3StepLockTarget();
  GEN3_PARAM_DEFS.forEach(({ key }) => {
    const control = gen3ControlBindings.get(key);
    if (!control) return;
    const locked = !!gen3Locks && Object.hasOwn(gen3Locks, key);
    control.classList.toggle('parameter-locked', locked);
    control.setValue(locked ? gen3Locks[key] : GEN3[key]);
  });
  // Roll header numbers double as lock selectors for the current lane; the
  // whole column tints so the selected slot reads at a glance.
  gen4NoteStepNumberEls.forEach((el, si) => {
    el?.classList.toggle(
      'lock-selected',
      gen4LockSelection?.ci === gen4SelectedNoteChannel && gen4LockSelection?.si === si,
    );
  });
  gen4NoteCellEls.forEach((cells, si) => {
    const on = gen4LockSelection?.ci === gen4SelectedNoteChannel && gen4LockSelection?.si === si;
    cells.forEach((cell) => cell.classList.toggle('lock-selected', on));
  });
  if (gen4LockClearBtn) {
    gen4LockClearBtn.hidden = !gen4LockSelection;
    gen4LockClearBtn.disabled =
      !gen4LockSelection || !hasGen4StepLocks(gen4LockSelection.ci, gen4LockSelection.si);
  }
}

function selectGen4LockStep(ci, si) {
  if (!GEN4.channels[ci]?.steps[si]) return;
  gen4LockSelection = { ci, si };
  gen4ParamSections.get(ci)?.setCollapsed(false);
  refreshGen4LockEditor();
}

// Same-step select again → deselect. The single entry point for both the
// grid's alt+click and the roll header's click.
function toggleGen4LockStep(ci, si) {
  if (gen4LockSelection?.ci === ci && gen4LockSelection?.si === si) {
    gen4LockSelection = null;
    refreshGen4LockEditor();
    return;
  }
  selectGen4LockStep(ci, si);
}

// Notes-roll slot selection (pencil off): works on empty slots too — the
// clicked row is remembered, and the first param tweak materializes that
// note (see ensureGen4LockStepActive). Clicking the selected slot again
// deselects; clicking a different row of an empty selected slot re-aims it.
function selectGen4NoteSlot(si, midi = null) {
  const ci = gen4SelectedNoteChannel;
  const active = GEN4.channels[ci]?.steps[si];
  const sameSlot = gen4LockSelection?.ci === ci && gen4LockSelection?.si === si;
  if (sameSlot && (active || (gen4LockSelection.pendingMidi ?? null) === midi)) {
    clearGen4LockSelection();
    return;
  }
  gen4LockSelection = { ci, si, pendingMidi: midi };
  gen4ParamSections.get(ci)?.setCollapsed(false);
  refreshGen4LockEditor();
}

// A lock write on an empty selected slot creates the note first — at the
// clicked row, else inheriting the lane's base note. Returns the slot's
// locks object.
function ensureGen4LockStepActive() {
  if (!gen4LockSelection) return null;
  const { ci, si, pendingMidi } = gen4LockSelection;
  const ch = GEN4.channels[ci];
  if (!ch) return null;
  if (!ch.steps[si]) {
    ch.steps[si] = true;
    ch.notes[si] = Number.isFinite(pendingMidi) ? pendingMidi : null;
    gen4ApplyStepBtn(ci, si);
    if (ci === gen4SelectedNoteChannel) refreshGen4NoteStep(si);
  }
  return ch.locks[si];
}

function clearGen4LockSelection() {
  if (!gen4LockSelection) return;
  gen4LockSelection = null;
  refreshGen4LockEditor();
}

function clearSelectedGen4Locks() {
  if (!gen4LockSelection) return;
  const { ci, si } = gen4LockSelection;
  GEN4.channels[ci].locks[si] = {};
  gen4ApplyStepBtn(ci, si);
  refreshGen4LockEditor();
}

// ── Scale mode (notes editor) ── highlights in-scale rows as a drawing
// guide and offers "fit": snap the selected lane's notes into the scale.
const GEN4_SCALES = [
  ['off', 'No scale', null],
  ['major', 'Major', [0, 2, 4, 5, 7, 9, 11]],
  ['minor', 'Minor', [0, 2, 3, 5, 7, 8, 10]],
  ['harm-minor', 'Harm minor', [0, 2, 3, 5, 7, 8, 11]],
  ['dorian', 'Dorian', [0, 2, 3, 5, 7, 9, 10]],
  ['phrygian', 'Phrygian', [0, 1, 3, 5, 7, 8, 10]],
  ['lydian', 'Lydian', [0, 2, 4, 6, 7, 9, 11]],
  ['mixolydian', 'Mixolydian', [0, 2, 4, 5, 7, 9, 10]],
  ['pent-major', 'Pent major', [0, 2, 4, 7, 9]],
  ['pent-minor', 'Pent minor', [0, 3, 5, 7, 10]],
  ['blues', 'Blues', [0, 3, 5, 6, 7, 10]],
];
const GEN4_SCALE = { scale: 'off', root: 0 };
const GEN4_ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function getGen4ScaleIntervals() {
  return GEN4_SCALES.find(([id]) => id === GEN4_SCALE.scale)?.[2] || null;
}

function isMidiInGen4Scale(midi) {
  const intervals = getGen4ScaleIntervals();
  if (!intervals) return true;
  return intervals.includes((((midi - GEN4_SCALE.root) % 12) + 12) % 12);
}

function snapMidiToGen4Scale(midi) {
  if (isMidiInGen4Scale(midi)) return midi;
  for (let d = 1; d <= 6; d++) {
    if (isMidiInGen4Scale(midi - d)) return midi - d; // ties resolve downward
    if (isMidiInGen4Scale(midi + d)) return midi + d;
  }
  return midi;
}

// One shared musical scale: the drum note roll and the gen3 keys grid read
// the same root/scale, and every scale-select pair on the page stays in sync.
const scaleSelectPairs = [];

function onGlobalScaleChanged() {
  scaleSelectPairs.forEach(([rootSel, scaleSel]) => {
    rootSel.value = `${GEN4_SCALE.root}`;
    scaleSel.value = GEN4_SCALE.scale;
  });
  renderGen4NoteRoll();
  refreshGen3ScaleHighlight();
}

function buildScaleGroup(fitTitle, onFit) {
  const group = document.createElement('div');
  group.className = 'drum-scale-group';
  const rootSelect = document.createElement('select');
  rootSelect.className = 'drum-scale-select';
  rootSelect.title = 'Scale root';
  GEN4_ROOT_NAMES.forEach((name, idx) => {
    const opt = document.createElement('option');
    opt.value = `${idx}`;
    opt.textContent = name;
    rootSelect.appendChild(opt);
  });
  rootSelect.value = `${GEN4_SCALE.root}`;
  rootSelect.addEventListener('change', () => {
    GEN4_SCALE.root = clamp(Number(rootSelect.value) || 0, 0, 11);
    onGlobalScaleChanged();
  });
  const scaleSelect = document.createElement('select');
  scaleSelect.className = 'drum-scale-select';
  scaleSelect.title = 'Scale — in-scale notes highlight';
  GEN4_SCALES.forEach(([id, label]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    scaleSelect.appendChild(opt);
  });
  scaleSelect.value = GEN4_SCALE.scale;
  scaleSelect.addEventListener('change', () => {
    GEN4_SCALE.scale = scaleSelect.value;
    onGlobalScaleChanged();
  });
  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'drum-scale-fit-btn';
  fitBtn.textContent = 'Fit';
  fitBtn.title = fitTitle;
  fitBtn.addEventListener('click', onFit);
  scaleSelectPairs.push([rootSelect, scaleSelect]);
  group.append(rootSelect, scaleSelect, fitBtn);
  return group;
}

function refreshGen3ScaleHighlight() {
  const scaleActive = !!getGen4ScaleIntervals();
  gen3NoteEls.forEach((el, midi) => {
    const inScale = scaleActive && isMidiInGen4Scale(midi);
    el.classList.toggle('in-scale', inScale);
    el.classList.toggle('out-scale', scaleActive && !inScale);
    el.classList.toggle('scale-root', scaleActive && midi % 12 === GEN4_SCALE.root);
  });
}

async function fitGen3ChordToScale() {
  if (!getGen4ScaleIntervals()) {
    setStatus('pick a scale first');
    return;
  }
  if (!GEN3.lockedMidis.size) {
    setStatus('keys: no locked notes to fit');
    return;
  }
  const before = [...GEN3.lockedMidis];
  // 24–83 is the keys grid's C1–B5 range.
  const snapped = before.map((m) => clamp(snapMidiToGen4Scale(m), 24, 83));
  // Mutate in place — the Set is shared by reference with the edit loop.
  GEN3.lockedMidis.clear();
  snapped.forEach((m) => GEN3.lockedMidis.add(m));
  const changed = before.filter((m, i) => snapped[i] !== m).length;
  refreshGen3KeyStates();
  const songPlaying = PLAY.mode === 'song' && GEN4.playing;
  if (GEN3.sustainMode && (!songPlaying || getAudibleLoop() === getEditLoop())) {
    await ensureAudioEngine();
    syncGen3SustainChord(GEN3.lockedMidis);
  }
  setStatus(
    changed > 0
      ? `keys: fitted ${changed} note${changed === 1 ? '' : 's'} to ${GEN4_ROOT_NAMES[GEN4_SCALE.root]} ${GEN4_SCALES.find(([id]) => id === GEN4_SCALE.scale)?.[1].toLowerCase()}`
      : 'keys: already in scale',
  );
}

function fitGen4NotesToScale() {
  if (!getGen4ScaleIntervals()) {
    setStatus('pick a scale first');
    return;
  }
  const ch = GEN4.channels[gen4SelectedNoteChannel];
  if (!ch) return;
  let changed = 0;
  for (let si = 0; si < 32; si++) {
    if (!Number.isFinite(ch.notes[si])) continue;
    const snapped = clamp(snapMidiToGen4Scale(ch.notes[si]), GEN4_NOTE_MIN, GEN4_NOTE_MAX);
    if (snapped !== ch.notes[si]) {
      ch.notes[si] = snapped;
      changed += 1;
    }
  }
  for (let si = 0; si < 32; si++) gen4ApplyStepBtn(gen4SelectedNoteChannel, si);
  renderGen4NoteRoll();
  const label = GEN4_DEFS[gen4SelectedNoteChannel]?.label || 'lane';
  setStatus(
    changed > 0
      ? `${label}: fitted ${changed} note${changed === 1 ? '' : 's'} to ${GEN4_ROOT_NAMES[GEN4_SCALE.root]} ${GEN4_SCALES.find(([id]) => id === GEN4_SCALE.scale)?.[1].toLowerCase()}`
      : `${label}: already in scale`,
  );
}

// ── Note generators ── Euclidean rhythms, chord/scale arpeggios, and random
// melodies for the selected note lane. They write straight into the lane's
// steps/notes; a cleared step resets its glitch state like a manual erase.

function euclideanPattern(pulses, steps, rotation = 0) {
  const out = new Array(steps).fill(false);
  if (pulses <= 0) return out;
  for (let i = 0; i < steps; i++) {
    const j = (((i - rotation) % steps) + steps) % steps;
    out[i] = (j * pulses) % steps < pulses;
  }
  return out;
}

function clearGen4Step(ch, si) {
  ch.steps[si] = false;
  ch.notes[si] = null;
  ch.timing[si] = 0;
  ch.locks[si] = {};
  ch.stutter[si] = 1;
  ch.probability[si] = 1;
  ch.condition[si] = 0;
}

function repaintGen4NoteLane(ci) {
  for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
  renderGen4NoteRoll();
}

function generateGen4Euclid(pulses, rotation) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const steps = GEN4.stepCount;
  const p = clamp(Math.round(pulses), 1, steps);
  const rot = clamp(Math.round(rotation), 0, steps - 1);
  const pattern = euclideanPattern(p, steps, rot);
  for (let si = 0; si < steps; si++) {
    if (pattern[si]) ch.steps[si] = true; // an existing note/glitch state survives
    else if (ch.steps[si]) clearGen4Step(ch, si);
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: euclid ${p}/${steps}${rot ? ` rot ${rot}` : ''}`);
}

// True polyrhythm: N hits spread mathematically evenly across the bar.
// Positions that fall between grid steps land on the nearest step with a
// 1/128-tick timing offset (one step = 8 ticks, max deviation ±4), so
// 5-over-4, 7-over-4 etc. play exactly, not grid-quantized. First hit of the
// cycle is accented. Notes already sitting on a surviving step are kept.
function generateGen4Polyrhythm(hits, rotation) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const n = GEN4.stepCount;
  const count = clamp(Math.round(hits), 2, n);
  const rot = clamp(Math.round(rotation), 0, n - 1);
  const TICKS_PER_STEP = 8; // 1 grid step (1/16) = 8 × 1/128
  const oldSteps = ch.steps.slice(0, n);
  const oldNotes = ch.notes.slice(0, n);
  for (let si = 0; si < n; si++) if (ch.steps[si]) clearGen4Step(ch, si);
  for (let k = 0; k < count; k++) {
    const exact = ((k * n) / count + rot) % n;
    let si = Math.round(exact) % n;
    const frac = exact - Math.round(exact);
    if (ch.steps[si]) continue; // two hits rounded onto one step — keep the first
    ch.steps[si] = true;
    ch.notes[si] = oldSteps[si] ? oldNotes[si] : null;
    ch.timing[si] = clamp(Math.round(frac * TICKS_PER_STEP), -8, 8);
    ch.velocity[si] = k === 0 ? 1 : 0.8;
  }
  repaintGen4NoteLane(ci);
  setStatus(
    `${GEN4_DEFS[ci].label}: polyrhythm ${count} over ${n} steps (micro-timed)${rot ? ` rot ${rot}` : ''}`,
  );
}

// Arp material: gen3's locked chord when keys are locked, else a 1-3-5 triad
// from the roll's scale. Null when neither exists.
function getGen4ArpChord() {
  const locked = [...GEN3.lockedMidis].sort((a, b) => a - b);
  if (locked.length) return locked;
  const intervals = getGen4ScaleIntervals();
  if (!intervals) return null;
  const base = 48 + GEN4_SCALE.root; // around C3
  return [intervals[0], intervals[2 % intervals.length], intervals[4 % intervals.length]].map(
    (semi) => base + semi,
  );
}

// Deterministic traversal orders over the octave-expanded pool. `played` is
// the chord in the order the keys were locked (Set insertion order).
function buildGen4ArpSequence(pool, played, mode) {
  const asc = pool;
  const desc = [...pool].reverse();
  switch (mode) {
    case 'down':
      return desc;
    case 'updown':
      return pool.length > 2 ? asc.concat(desc.slice(1, -1)) : asc;
    case 'downup':
      return pool.length > 2 ? desc.concat(asc.slice(1, -1)) : desc;
    case 'converge': {
      const seq = [];
      for (let lo = 0, hi = asc.length - 1; lo <= hi; lo++, hi--) {
        seq.push(asc[lo]);
        if (hi !== lo) seq.push(asc[hi]);
      }
      return seq;
    }
    case 'diverge':
      return buildGen4ArpSequence(pool, played, 'converge').reverse();
    case 'pinky': {
      const top = asc[asc.length - 1];
      const seq = [];
      asc.slice(0, -1).forEach((midi) => seq.push(midi, top));
      return seq.length ? seq : asc;
    }
    case 'thumb': {
      const bottom = asc[0];
      const seq = [];
      asc.slice(1).forEach((midi) => seq.push(bottom, midi));
      return seq.length ? seq : asc;
    }
    case 'asplayed':
      return played;
    default:
      return asc; // up
  }
}

function gen4ArpVelocity(shape, si, stepCount, cycleHit, seqLen) {
  switch (shape) {
    case 'ramp-up':
      return 0.5 + 0.5 * (si / Math.max(1, stepCount - 1));
    case 'ramp-down':
      return 1 - 0.5 * (si / Math.max(1, stepCount - 1));
    case 'alt':
      return cycleHit % 2 === 0 ? 1 : 0.6;
    case 'cycle':
      return seqLen > 0 && cycleHit % seqLen === 0 ? 1 : 0.65;
    case 'human':
      return 0.65 + Math.random() * 0.35;
    default:
      return 1; // flat
  }
}

function generateGen4Arp({ mode, octaves, everyN, repeat, velShape, chance, ratchet = 'off' }) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const chord = getGen4ArpChord();
  if (!chord) {
    setStatus('arp needs gen3 locked keys or a scale');
    return;
  }
  const lockedPlayed = [...GEN3.lockedMidis];
  const chordPlayed = lockedPlayed.length ? lockedPlayed : chord;
  const range = getGen4LaneMidiRange(ci);
  const pool = [];
  const played = [];
  for (let o = 0; o < octaves; o++) {
    chord.forEach((midi) => pool.push(clamp(midi + o * 12, range.min, range.max)));
    chordPlayed.forEach((midi) => played.push(clamp(midi + o * 12, range.min, range.max)));
  }
  const seq = buildGen4ArpSequence(pool, played, mode);
  let hit = 0; // fired-slot counter; note advances every `repeat` hits
  let walkIdx = 0;
  let cur = seq[0];
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (si % everyN !== 0) {
      if (ch.steps[si]) clearGen4Step(ch, si);
      continue;
    }
    const cycleHit = Math.floor(hit / repeat);
    if (hit % repeat === 0) {
      if (mode === 'random') cur = pool[Math.floor(Math.random() * pool.length)];
      else if (mode === 'walk') {
        walkIdx = clamp(walkIdx + (Math.random() < 0.5 ? -1 : 1), 0, pool.length - 1);
        cur = pool[walkIdx];
      } else cur = seq[cycleHit % seq.length];
    }
    ch.steps[si] = true;
    ch.notes[si] = cur;
    ch.velocity[si] = clamp(
      gen4ArpVelocity(velShape, si, GEN4.stepCount, cycleHit, seq.length),
      0.05,
      1,
    );
    ch.probability[si] = chance;
    ch.stutter[si] =
      ratchet === 'accent' && seq.length > 0 && cycleHit % seq.length === 0
        ? 2
        : ratchet === 'random' && Math.random() < 0.25
          ? 2 + Math.floor(Math.random() * 2)
          : 1;
    hit++;
  }
  repaintGen4NoteLane(ci);
  setStatus(
    `${GEN4_DEFS[ci].label}: arp ${mode} ×${octaves} oct every ${everyN}` +
      `${repeat > 1 ? ` ·×${repeat}` : ''}${chance < 1 ? ` · ${Math.round(chance * 100)}%` : ''}` +
      `${ratchet !== 'off' ? ` · rat ${ratchet}` : ''}`,
  );
}

// Contour melodies: pitch follows a shape across the bar (plus jitter),
// snapped to the scale. Rhythm: 'keep' reuses the lane's rhythm when one
// exists; a numeric density regenerates it.
function generateGen4Melody(contour, density) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const n = GEN4.stepCount;
  const hasRhythm = ch.steps.slice(0, n).some(Boolean);
  const keepRhythm = density === 'keep' && hasRhythm;
  const dens = density === 'keep' ? 0.45 : Number(density);
  const range = getGen4LaneMidiRange(ci);
  const center = clamp(getGen4NoteFocusMidi(ci), range.min, range.max);
  const curve = (t) => {
    switch (contour) {
      case 'rise':
        return t;
      case 'fall':
        return 1 - t;
      case 'arch':
        return Math.sin(Math.PI * t);
      case 'valley':
        return 1 - Math.sin(Math.PI * t);
      case 'zigzag': {
        const u = (t * 4) % 2;
        return u < 1 ? u : 2 - u;
      }
      default:
        return null; // random wander
    }
  };
  for (let si = 0; si < n; si++) {
    const fire = keepRhythm ? ch.steps[si] : Math.random() < dens;
    if (!fire) {
      if (ch.steps[si]) clearGen4Step(ch, si);
      continue;
    }
    const t = n > 1 ? si / (n - 1) : 0;
    const c = curve(t);
    const offset =
      c === null
        ? Math.round((Math.random() * 2 - 1) * 9)
        : Math.round((c - 0.5) * 12 + (Math.random() * 4 - 2));
    ch.steps[si] = true;
    ch.notes[si] = clamp(snapMidiToGen4Scale(center + offset), range.min, range.max);
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: ${contour} melody${keepRhythm ? ' (rhythm kept)' : ''}`);
}

// Bassline generator — rooted on gen3's lowest locked key (else the scale
// root around C2), classic root/fifth/octave figures or an acid-style walk.
function getGen4BassRoot(range) {
  const locked = [...GEN3.lockedMidis];
  const root = locked.length ? Math.min(...locked) : 36 + GEN4_SCALE.root;
  // Prefer the bass register, but never fall below the lane's playable window.
  const hi = Math.min(60, range.max) < range.min ? range.max : Math.min(60, range.max);
  return clamp(root, range.min, hi);
}

function generateGen4Bass(style) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const range = getGen4LaneMidiRange(ci);
  const root = getGen4BassRoot(range);
  const fifth = clamp(snapMidiToGen4Scale(root + 7), range.min, range.max);
  const oct = clamp(root + 12, range.min, range.max);
  for (let si = 0; si < GEN4.stepCount; si++) {
    let on = true;
    let note = root;
    let vel = si % 4 === 0 ? 1 : 0.7;
    if (style === 'root8') {
      note = si % 4 === 3 ? oct : root;
    } else if (style === 'root5') {
      note = [root, root, fifth, root, oct, root, fifth, fifth][si % 8];
    } else {
      // acid: sparse, root-heavy, accents and the odd passing tone
      on = si % 4 === 0 || Math.random() < 0.7;
      const r = Math.random();
      note =
        r < 0.5
          ? root
          : r < 0.65
            ? fifth
            : r < 0.8
              ? oct
              : clamp(
                  snapMidiToGen4Scale(root + [-2, 2, 3, 5][Math.floor(Math.random() * 4)]),
                  range.min,
                  range.max,
                );
      vel = Math.random() < 0.3 ? 1 : 0.55 + Math.random() * 0.25;
    }
    if (!on) {
      if (ch.steps[si]) clearGen4Step(ch, si);
      continue;
    }
    ch.steps[si] = true;
    ch.notes[si] = note;
    ch.velocity[si] = vel;
    ch.probability[si] = 1;
    ch.stutter[si] = style === 'acid' && Math.random() < 0.08 ? 2 : 1;
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: ${style} bassline on ${formatMidiNote(root)}`);
}

// ── Lane transforms ── act on the visible stepCount window of the selected
// lane; structural ops move every per-step array together.

const GEN4_LANE_STEP_KEYS = [
  'steps',
  'notes',
  'velocity',
  'timing',
  'stutter',
  'probability',
  'condition',
  'locks',
];

// Next in-scale note in a direction — plain semitone when no scale is set.
function stepMidiInScale(midi, dir) {
  if (!getGen4ScaleIntervals()) return midi + dir;
  for (let d = 1; d <= 12; d++) {
    if (isMidiInGen4Scale(midi + dir * d)) return midi + dir * d;
  }
  return midi + dir;
}

function rotateGen4Lane(dir) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const n = GEN4.stepCount;
  GEN4_LANE_STEP_KEYS.forEach((key) => {
    const src = ch[key].slice(0, n);
    for (let i = 0; i < n; i++) ch[key][(((i + dir) % n) + n) % n] = src[i];
  });
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: rotated ${dir > 0 ? '→' : '←'}`);
}

function reverseGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const n = GEN4.stepCount;
  GEN4_LANE_STEP_KEYS.forEach((key) => {
    const src = ch[key].slice(0, n);
    for (let i = 0; i < n; i++) ch[key][i] = src[n - 1 - i];
  });
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: reversed`);
}

function invertGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const pitched = [];
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (ch.steps[si] && Number.isFinite(ch.notes[si])) pitched.push(ch.notes[si]);
  }
  if (pitched.length < 2) {
    setStatus('invert needs two or more pitched notes');
    return;
  }
  const axis = Math.min(...pitched) + Math.max(...pitched);
  const invRange = getGen4LaneMidiRange(ci);
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (!ch.steps[si] || !Number.isFinite(ch.notes[si])) continue;
    ch.notes[si] = clamp(snapMidiToGen4Scale(axis - ch.notes[si]), invRange.min, invRange.max);
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: inverted`);
}

function transposeGen4Lane(delta) {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  let changed = 0;
  const range = getGen4LaneMidiRange(ci);
  const base = clamp(getGen4BaseMidi(ci), range.min, range.max);
  for (let si = 0; si < 32; si++) {
    // A note-less active step follows the channel base pitch — pin it to that
    // note first so the whole lane moves, not just explicitly-pitched steps.
    if (ch.steps[si] && !Number.isFinite(ch.notes[si])) ch.notes[si] = base;
    if (!Number.isFinite(ch.notes[si])) continue;
    const next =
      Math.abs(delta) === 12 ? ch.notes[si] + delta : stepMidiInScale(ch.notes[si], delta);
    ch.notes[si] = clamp(next, range.min, range.max);
    changed += 1;
  }
  repaintGen4NoteLane(ci);
  setStatus(
    changed
      ? `${GEN4_DEFS[ci].label}: transposed ${delta > 0 ? '+' : ''}${Math.abs(delta) === 12 ? delta : `${delta} ${getGen4ScaleIntervals() ? 'scale step' : 'semi'}`}`
      : 'no assigned notes to transpose',
  );
}

function humanizeGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (!ch.steps[si]) continue;
    ch.velocity[si] = clamp(ch.velocity[si] * (0.8 + Math.random() * 0.3), 0.05, 1);
    if (Math.random() < 0.6) {
      ch.timing[si] = clamp(ch.timing[si] + (Math.random() < 0.5 ? -1 : 1), -4, 4);
    }
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: humanized velocity + timing`);
}

function glitchGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (!ch.steps[si]) continue;
    if (Math.random() < 0.18) ch.stutter[si] = 2 + Math.floor(Math.random() * 3);
    if (Math.random() < 0.15) ch.probability[si] = 0.5 + Math.random() * 0.4;
    if (Math.random() < 0.1) {
      ch.timing[si] = clamp(ch.timing[si] + (Math.random() < 0.5 ? -2 : 2), -8, 8);
    }
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: glitched (ratchets · probability · timing)`);
}

// Call & response: copy the first half over the second, then mutate the copy
// (drops, scale-step shifts, octave jumps) so B answers A.
function callResponseGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const half = Math.floor(GEN4.stepCount / 2);
  if (half < 2) return;
  GEN4_LANE_STEP_KEYS.forEach((key) => {
    for (let i = 0; i < half; i++) {
      const v = ch[key][i];
      ch[key][half + i] = key === 'locks' ? { ...v } : v;
    }
  });
  for (let i = half; i < half * 2; i++) {
    if (!ch.steps[i]) continue;
    const r = Math.random();
    if (r < 0.15) {
      clearGen4Step(ch, i);
      continue;
    }
    if (!Number.isFinite(ch.notes[i])) continue;
    const abRange = getGen4LaneMidiRange(ci);
    if (r < 0.4) {
      ch.notes[i] = clamp(
        stepMidiInScale(ch.notes[i], Math.random() < 0.5 ? -1 : 1),
        abRange.min,
        abRange.max,
      );
    } else if (r < 0.5) {
      ch.notes[i] = clamp(ch.notes[i] + (Math.random() < 0.5 ? -12 : 12), abRange.min, abRange.max);
    }
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: A→B call & response`);
}

// Gentle evolution: nudge some pitches a scale step, drop a few hits, sprout
// a few new ones (they inherit the lane's base note). Press repeatedly to
// drift a pattern instead of rewriting it.
function mutateGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (ch.steps[si]) {
      const r = Math.random();
      if (r < 0.12 && Number.isFinite(ch.notes[si])) {
        const mutRange = getGen4LaneMidiRange(ci);
        ch.notes[si] = clamp(
          stepMidiInScale(ch.notes[si], Math.random() < 0.5 ? -1 : 1),
          mutRange.min,
          mutRange.max,
        );
      } else if (r < 0.18) {
        clearGen4Step(ch, si);
      }
    } else if (Math.random() < 0.06) {
      ch.steps[si] = true;
      ch.notes[si] = null; // inherits the lane's base note
      ch.velocity[si] = 0.7;
    }
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: mutated`);
}

// Drop every second active step — halve the density, keep the feel.
function thinGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  let keep = true;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (!ch.steps[si]) continue;
    if (!keep) clearGen4Step(ch, si);
    keep = !keep;
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: thinned`);
}

// Each note echoes onto the following free step, quiet and slightly unsure.
function echoGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const n = GEN4.stepCount;
  const srcSteps = ch.steps.slice(0, n);
  const srcNotes = ch.notes.slice(0, n);
  const srcVel = ch.velocity.slice(0, n);
  let added = 0;
  for (let si = 0; si < n; si++) {
    const t = si + 1;
    if (!srcSteps[si] || t >= n || srcSteps[t]) continue;
    ch.steps[t] = true;
    ch.notes[t] = srcNotes[si];
    ch.velocity[t] = clamp((srcVel[si] || 1) * 0.45, 0.05, 1);
    ch.probability[t] = 0.9;
    added += 1;
  }
  repaintGen4NoteLane(ci);
  setStatus(added ? `${GEN4_DEFS[ci].label}: ${added} echo${added === 1 ? '' : 'es'} added` : 'no room for echoes');
}

// Rhythmic negative: fire exactly where the lane was silent.
function flipGen4Rhythm() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (ch.steps[si]) {
      clearGen4Step(ch, si);
    } else {
      ch.steps[si] = true;
      ch.notes[si] = null;
    }
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: rhythm flipped`);
}

// Ghost notes: quiet, unreliable hits sprinkled into empty steps.
function ghostGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  let added = 0;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (ch.steps[si] || Math.random() >= 0.3) continue;
    ch.steps[si] = true;
    ch.notes[si] = null;
    ch.velocity[si] = 0.2 + Math.random() * 0.15;
    ch.probability[si] = 0.6;
    added += 1;
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: ${added} ghost note${added === 1 ? '' : 's'}`);
}

// Groove template: blend velocities toward a 16th-grid accent map
// (quarters strong, eighths medium, offbeats soft).
function grooveGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  for (let si = 0; si < GEN4.stepCount; si++) {
    if (!ch.steps[si]) continue;
    const pos = si % 4;
    const target = pos === 0 ? 1 : pos === 2 ? 0.75 : 0.55;
    ch.velocity[si] = clamp(ch.velocity[si] * 0.3 + target * 0.7, 0.05, 1);
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: groove accents applied`);
}

// Build ramp: probability rises across the bar, so each cycle starts sparse
// and fills in toward the turnaround.
function rampGen4Lane() {
  const ci = gen4SelectedNoteChannel;
  const ch = GEN4.channels[ci];
  if (!ch) return;
  const n = GEN4.stepCount;
  for (let si = 0; si < n; si++) {
    if (!ch.steps[si]) continue;
    const t = n > 1 ? si / (n - 1) : 1;
    ch.probability[si] = clamp(0.25 + 0.75 * t, 0.05, 1);
  }
  repaintGen4NoteLane(ci);
  setStatus(`${GEN4_DEFS[ci].label}: build ramp (sparse → full)`);
}

function renderGen4NoteRoll() {
  if (!gen4NoteRollEl) return;
  gen4NoteRollEl.textContent = '';
  gen4NoteCellEls = Array.from({ length: 32 }, () => new Map());
  gen4NotePlayheadStep = -1;
  const def = GEN4_DEFS[gen4SelectedNoteChannel];
  const ch = GEN4.channels[gen4SelectedNoteChannel];
  const laneRange = getGen4LaneMidiRange(gen4SelectedNoteChannel);
  gen4NoteEditorEl?.style.setProperty('--ch-color', def.color);
  // Rows: the lane's playable window, plus any assigned note that fell
  // outside it (legacy patterns, imports) — a hit must never be invisible.
  const assigned = new Set();
  for (let si = 0; si < 32; si++) {
    if (ch.steps[si] && Number.isFinite(ch.notes[si])) assigned.add(ch.notes[si]);
  }
  const visibleMidis = [];
  for (let midi = GEN4_NOTE_MAX; midi >= GEN4_NOTE_MIN; midi--) {
    if (assigned.has(midi) || (midi >= laneRange.min && midi <= laneRange.max)) {
      visibleMidis.push(midi);
    }
  }

  const stepHeader = document.createElement('div');
  stepHeader.className = 'drum-note-row drum-note-step-header';
  const corner = document.createElement('span');
  corner.className = 'drum-note-label';
  corner.textContent = 'Note';
  stepHeader.appendChild(corner);
  gen4NoteStepNumberEls = new Array(32).fill(null);
  for (let si = 0; si < 32; si++) {
    const number = document.createElement('span');
    number.className = 'drum-note-step-number';
    number.textContent = `${si + 1}`;
    number.classList.toggle('step-inactive', si >= GEN4.stepCount);
    number.title = 'Click: select this slot for param editing (knobs write to it)';
    number.addEventListener('click', () => {
      if (si >= GEN4.stepCount) return;
      selectGen4NoteSlot(si);
    });
    gen4NoteStepNumberEls[si] = number;
    stepHeader.appendChild(number);
  }
  gen4NoteRollEl.appendChild(stepHeader);
  refreshGen4LockEditor();

  const scaleActive = !!getGen4ScaleIntervals();
  visibleMidis.forEach((midi) => {
    const row = document.createElement('div');
    row.className = 'drum-note-row';
    if ([1, 3, 6, 8, 10].includes(midi % 12)) row.classList.add('black-key');
    if (scaleActive) {
      const inScale = isMidiInGen4Scale(midi);
      row.classList.toggle('out-scale', !inScale);
      row.classList.toggle('scale-root', midi % 12 === GEN4_SCALE.root);
    }

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
        // Pencil off = select mode: pick the slot for param editing; a knob
        // tweak on an empty slot creates this row's note with that value.
        selectGen4NoteSlot(si, midi);
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
  // The selected instrument's param panel opens; the rest fold away.
  gen4ParamSections.forEach(({ setCollapsed }, idx) => setCollapsed(idx !== ci));
  renderGen4NoteRoll();
}

function setGen4EditorMode(mode) {
  if (mode !== 'grid' && mode !== 'notes') return;
  gen4EditorMode = mode;
  if (mode === 'notes' && gen4NoteCellEls.every((cells) => cells.size === 0)) {
    renderGen4NoteRoll();
  }
  refreshGen4NoteEditor();
  refreshGen4LockEditor();
}

// Instant tooltips, app-wide — the native title waits ~1s before showing.
// Any element with a title gets an immediate tooltip instead: the title is
// stripped while hovered (suppresses the native bubble) and handed back on
// leave, so runtime `.title =` writes keep working. Canvases keep native
// titles (they draw their own hover readouts); note-roll cells are skipped
// (hundreds of them — pure hover noise while drawing).
let uiTipEl = null;

function ensureUiTip() {
  if (uiTipEl) return uiTipEl;
  uiTipEl = document.createElement('div');
  uiTipEl.className = 'ui-tip';
  uiTipEl.hidden = true;
  document.body.appendChild(uiTipEl);
  return uiTipEl;
}

function hideUiTip() {
  if (uiTipEl) uiTipEl.hidden = true;
}

function initInstantTips() {
  document.addEventListener(
    'pointerover',
    (e) => {
      const el = e.target.closest?.('[title], [data-tip]');
      if (!(el instanceof Element) || el.tagName === 'CANVAS') return;
      if (el.classList.contains('drum-note-cell')) return;
      if (el.hasAttribute('title')) {
        el.dataset.tip = el.getAttribute('title');
        el.removeAttribute('title');
      }
      const text = el.dataset.tip;
      if (!text) return;
      const tip = ensureUiTip();
      tip.textContent = text;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      tip.style.left = '0px'; // reset so the width measures unconstrained
      const tw = tip.offsetWidth;
      tip.style.left = `${clamp(r.left + r.width / 2 - tw / 2, 4, window.innerWidth - tw - 4)}px`;
      const below = r.bottom + 6;
      tip.style.top =
        below + tip.offsetHeight > window.innerHeight - 4
          ? `${Math.max(4, r.top - tip.offsetHeight - 6)}px`
          : `${below}px`;
    },
    true,
  );
  document.addEventListener(
    'pointerout',
    (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!(el instanceof Element)) return;
      // Hand the title back so dynamic title updates keep working.
      if (!el.hasAttribute('title')) el.setAttribute('title', el.dataset.tip);
      delete el.dataset.tip;
      hideUiTip();
    },
    true,
  );
  document.addEventListener('pointerdown', hideUiTip, true);
}

initInstantTips();

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
  pencil.title =
    'Pencil on: drag to draw, start on a note to erase · Pencil off: click selects a slot for param editing';
  pencil.setAttribute('aria-label', 'Pencil tool');
  pencil.setAttribute('aria-pressed', 'true');
  pencil.addEventListener('click', () => {
    gen4NotePencilEnabled = !gen4NotePencilEnabled;
    pencil.classList.toggle('active', gen4NotePencilEnabled);
    pencil.setAttribute('aria-pressed', String(gen4NotePencilEnabled));
  });
  lanes.appendChild(pencil);
  gen4NotePencilBtn = pencil;

  lanes.appendChild(
    buildScaleGroup("Snap this lane's notes to the nearest scale note", fitGen4NotesToScale),
  );

  // ── Generator toolbar: euclid rhythm / chord arp / random melody ──
  const makeGenSelect = (title, options, value) => {
    const sel = document.createElement('select');
    sel.className = 'drum-scale-select';
    sel.title = title;
    options.forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = `${val}`;
      opt.textContent = label;
      sel.appendChild(opt);
    });
    sel.value = `${value}`;
    return sel;
  };
  const makeGenBtn = (label, title, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drum-scale-fit-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  };

  // One generator visible at a time: EUC/ARP/MEL/BASS tabs swap their
  // controls, and a single GO button runs the active one.
  const genRow = document.createElement('div');
  genRow.className = 'drum-note-gen';
  const genLabel = document.createElement('span');
  genLabel.className = 'drum-note-gen-label';
  genLabel.textContent = 'gen';
  genRow.appendChild(genLabel);

  const genTabs = document.createElement('div');
  genTabs.className = 'drum-gen-tabs';
  genRow.appendChild(genTabs);

  const genTabBtns = new Map();
  const genPanels = new Map();
  const setGenTab = (id) => {
    gen4GenTab = id;
    genTabBtns.forEach((btn, tid) => btn.classList.toggle('active', tid === id));
    genPanels.forEach(({ panel }, tid) => {
      panel.hidden = tid !== id;
    });
  };
  const addGenTab = (id, label, title, controls, run) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'drum-gen-tab';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', () => setGenTab(id));
    genTabBtns.set(id, btn);
    genTabs.appendChild(btn);
    const panel = document.createElement('div');
    panel.className = 'drum-gen-panel';
    panel.append(...controls);
    panel.hidden = true;
    genPanels.set(id, { panel, run });
    genRow.appendChild(panel);
  };

  const eucPulses = makeGenSelect(
    'Euclid pulses',
    Array.from({ length: 32 }, (_, i) => [i + 1, `${i + 1}`]),
    5,
  );
  const eucRotate = makeGenSelect(
    'Euclid rotation',
    Array.from({ length: 32 }, (_, i) => [i, `r${i}`]),
    0,
  );

  const arpMode = makeGenSelect(
    'Arp pattern',
    [
      ['up', 'Up'],
      ['down', 'Down'],
      ['updown', 'UpDn'],
      ['downup', 'DnUp'],
      ['converge', 'Conv'],
      ['diverge', 'Div'],
      ['pinky', 'Pinky'],
      ['thumb', 'Thumb'],
      ['asplayed', 'Play'],
      ['random', 'Rand'],
      ['walk', 'Walk'],
    ],
    'up',
  );
  const arpOct = makeGenSelect(
    'Arp octave span',
    [
      [1, '1 oct'],
      [2, '2 oct'],
      [3, '3 oct'],
    ],
    1,
  );
  const arpRate = makeGenSelect(
    'Arp note rate — "3-poly" fires every 3 steps for a polymeter against the bar',
    [
      [1, '1/16'],
      [2, '1/8'],
      [3, '3-poly'],
      [4, '1/4'],
    ],
    1,
  );
  const arpRepeat = makeGenSelect(
    'Repeat each note N times before advancing',
    [
      [1, '×1'],
      [2, '×2'],
      [3, '×3'],
    ],
    1,
  );
  const arpVel = makeGenSelect(
    'Velocity shape across the pattern',
    [
      ['flat', 'Vel –'],
      ['ramp-up', 'Vel ↑'],
      ['ramp-down', 'Vel ↓'],
      ['alt', 'Vel alt'],
      ['cycle', 'Accent'],
      ['human', 'Human'],
    ],
    'flat',
  );
  const arpChance = makeGenSelect(
    'Step probability — below 100% the pattern evolves every cycle',
    [
      [1, '100%'],
      [0.9, '90%'],
      [0.75, '75%'],
      [0.5, '50%'],
    ],
    1,
  );
  const arpRatchet = makeGenSelect(
    'Ratchets — retrigger steps: on sequence-cycle accents, or randomly',
    [
      ['off', 'Rat –'],
      ['accent', 'Rat acc'],
      ['random', 'Rat rnd'],
    ],
    'off',
  );
  const melContour = makeGenSelect(
    'Melody contour — the pitch shape across the bar',
    [
      ['random', 'Rand'],
      ['rise', 'Rise'],
      ['fall', 'Fall'],
      ['arch', 'Arch'],
      ['valley', 'Valley'],
      ['zigzag', 'ZigZag'],
    ],
    'random',
  );
  const melDensity = makeGenSelect(
    'Melody rhythm — keep the lane rhythm, or regenerate at a density',
    [
      ['keep', 'Keep'],
      [0.25, '25%'],
      [0.5, '50%'],
      [0.75, '75%'],
    ],
    'keep',
  );
  const bassStyle = makeGenSelect(
    'Bassline style — rooted on gen3’s lowest locked key or the scale root',
    [
      ['root8', 'Root-8ve'],
      ['root5', 'Root-5th'],
      ['acid', 'Acid'],
    ],
    'root8',
  );

  const polyHits = makeGenSelect(
    'Hits per bar — spread mathematically evenly, micro-timed between grid steps',
    Array.from({ length: 15 }, (_, i) => [i + 2, `${i + 2}`]),
    5,
  );
  const polyRotate = makeGenSelect(
    'Polyrhythm rotation (in grid steps)',
    Array.from({ length: 32 }, (_, i) => [i, `r${i}`]),
    0,
  );

  addGenTab(
    'euc',
    'EUC',
    'Euclidean rhythm — spread N pulses evenly; existing notes survive',
    [eucPulses, eucRotate],
    () => generateGen4Euclid(Number(eucPulses.value), Number(eucRotate.value)),
  );
  addGenTab(
    'poly',
    'POLY',
    'True polyrhythm — N hits over the bar, exact positions via 1/128 micro-timing (try 5 or 7 against a 16-step kick)',
    [polyHits, polyRotate],
    () => generateGen4Polyrhythm(Number(polyHits.value), Number(polyRotate.value)),
  );
  addGenTab(
    'arp',
    'ARP',
    'Arpeggiate gen3 locked keys (or the scale triad) across the lane',
    [arpMode, arpOct, arpRate, arpRepeat, arpVel, arpChance, arpRatchet],
    () =>
      generateGen4Arp({
        mode: arpMode.value,
        octaves: Number(arpOct.value),
        everyN: Number(arpRate.value),
        repeat: Number(arpRepeat.value),
        velShape: arpVel.value,
        chance: Number(arpChance.value),
        ratchet: arpRatchet.value,
      }),
  );
  addGenTab(
    'mel',
    'MEL',
    'Generate a scale-snapped melody following a contour',
    [melContour, melDensity],
    () => generateGen4Melody(melContour.value, melDensity.value),
  );
  addGenTab('bass', 'BASS', 'Generate a bassline figure across the lane', [bassStyle], () =>
    generateGen4Bass(bassStyle.value),
  );

  const genRun = makeGenBtn('GO', 'Run the selected generator on this lane', () =>
    genPanels.get(gen4GenTab)?.run(),
  );
  genRun.classList.add('drum-gen-run');
  genRow.appendChild(genRun);
  setGenTab(genPanels.has(gen4GenTab) ? gen4GenTab : 'euc');

  // ── Transform row: non-generative edits, grouped by what they touch ──
  const editRow = document.createElement('div');
  editRow.className = 'drum-note-gen';
  const editLabel = document.createElement('span');
  editLabel.className = 'drum-note-gen-label';
  editLabel.textContent = 'edit';
  editRow.appendChild(editLabel);
  const addEditGroup = (caption, items) => {
    const group = document.createElement('div');
    group.className = 'drum-note-edit-group';
    const cap = document.createElement('span');
    cap.className = 'drum-note-edit-caption';
    cap.textContent = caption;
    group.appendChild(cap);
    items.forEach(([label, title, fn]) => group.appendChild(makeGenBtn(label, title, fn)));
    editRow.appendChild(group);
  };
  addEditGroup('time', [
    ['◀', 'Rotate the pattern one step earlier', () => rotateGen4Lane(-1)],
    ['▶', 'Rotate the pattern one step later', () => rotateGen4Lane(1)],
    ['Rev', 'Reverse the pattern in time (retrograde)', reverseGen4Lane],
    ['Flip', 'Rhythmic negative — fire exactly where the lane was silent', flipGen4Rhythm],
  ]);
  addEditGroup('pitch', [
    ['−1', 'Transpose down a scale step (semitone without a scale)', () => transposeGen4Lane(-1)],
    ['+1', 'Transpose up a scale step (semitone without a scale)', () => transposeGen4Lane(1)],
    ['Oct−', 'Transpose down an octave', () => transposeGen4Lane(-12)],
    ['Oct+', 'Transpose up an octave', () => transposeGen4Lane(12)],
    ['Inv', 'Mirror the pitches around the pattern’s center', invertGen4Lane],
  ]);
  addEditGroup('feel', [
    ['Hum', 'Humanize — jitter velocity and micro-timing', humanizeGen4Lane],
    ['Groove', 'Blend velocities toward a 16th-grid accent template', grooveGen4Lane],
    ['Ramp', 'Probability build — each cycle starts sparse and fills toward the turnaround', rampGen4Lane],
  ]);
  addEditGroup('vary', [
    ['Mut', 'Mutate — nudge a few pitches, drop and sprout a few hits; press repeatedly to evolve', mutateGen4Lane],
    ['A→B', 'Copy the first half over the second with mutations (call & response)', callResponseGen4Lane],
    ['Thin', 'Drop every second active step', thinGen4Lane],
    ['Echo', 'Add a quiet echo of each note on the following free step', echoGen4Lane],
    ['Ghost', 'Sprinkle quiet low-probability ghost notes into empty steps', ghostGen4Lane],
    ['Glitch', 'Sprinkle ratchets, probability dips, and timing nudges', glitchGen4Lane],
  ]);

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
  editor.append(lanes, genRow, editRow, roll);
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

  // Genre kit — one-shot action: sets every lane's sound, writes a groove into
  // this loop's pattern, and moves the transport to the genre's tempo.
  const kitSelect = document.createElement('select');
  kitSelect.className = 'fx-preset-select drum-preset-select drum-kit-select';
  kitSelect.title = "Genre kit — sets drum sounds + tempo and overwrites this loop's drum pattern";
  const kitPlaceholder = document.createElement('option');
  kitPlaceholder.value = '';
  kitPlaceholder.textContent = 'Kit…';
  kitSelect.appendChild(kitPlaceholder);
  GEN4_KIT_PRESETS.forEach(({ name }, kitIndex) => {
    const option = document.createElement('option');
    option.value = `${kitIndex}`;
    option.textContent = name;
    kitSelect.appendChild(option);
  });
  kitSelect.addEventListener('change', () => {
    if (kitSelect.value === '') return;
    applyGen4KitPreset(Number(kitSelect.value));
    kitSelect.value = ''; // action, not state — the pattern is the user's now
  });
  kitSelect.addEventListener('click', (event) => event.stopPropagation());
  kitSelect.addEventListener('keydown', (event) => event.stopPropagation());
  actions.appendChild(kitSelect);

  const editorModeGroup = document.createElement('div');
  editorModeGroup.className = 'drum-editor-mode-group';
  [
    ['grid', 'Grid'],
    ['notes', 'Notes'],
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
    '<span class="drum-hint"><span class="drum-hint-key">shift + click</span> probability</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">right-click</span> stutter</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint"><span class="drum-hint-key">⌘ + click</span> trig condition</span>' +
    '<span class="drum-hints-sep">·</span>' +
    '<span class="drum-hint" title="Knobs write to the selected step; Esc deselects">' +
    '<span class="drum-hint-key">alt + click</span> param-lock</span>';
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

      const condEl = document.createElement('span');
      condEl.className = 'drum-step-cond';
      condEl.hidden = true;
      btn.appendChild(condEl);

      if (si >= GEN4.stepCount) btn.classList.add('step-inactive');
      gen4ApplyStepBtn(ci, si);

      btn.addEventListener('click', (e) => {
        if (gen4DragState.suppressClick) {
          gen4DragState.suppressClick = false;
          return;
        }
        if (e.altKey) {
          // Alt+click: select the step for param locks (adding it if empty);
          // alt+click on the selected step deselects.
          if (!ch.steps[si]) {
            ch.steps[si] = true;
            gen4ApplyStepBtn(ci, si);
            selectGen4LockStep(ci, si);
          } else {
            toggleGen4LockStep(ci, si);
          }
          return;
        }
        if ((e.metaKey || e.ctrlKey) && ch.steps[si]) {
          gen4CycleCondition(ci, si);
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
          ch.condition[si] = 0;
          if (gen4LockSelection?.ci === ci && gen4LockSelection?.si === si) {
            gen4LockSelection = null;
            refreshGen4LockEditor();
          }
        }
        gen4ApplyStepBtn(ci, si);
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (ch.steps[si]) gen4CycleStutter(ci, si);
      });

      btn.addEventListener('mousedown', (e) => {
        if (!ch.steps[si] || e.shiftKey || e.altKey || e.button !== 0) return;
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
        if (gen4LockSelection?.ci === ci) {
          const locks = ensureGen4LockStepActive();
          if (!locks) return;
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
          if (gen4LockSelection?.ci === ci) {
            const locks = ensureGen4LockStepActive();
            if (!locks) return;
            locks[p.key] = v;
            ctrl.classList.add('parameter-locked');
            gen4ApplyStepBtn(ci, gen4LockSelection.si);
            refreshGen4LockEditor();
            return;
          }
          markGen4PresetCustom(ci);
          ch.params[p.key] = v;
          if (p.key === 'tune' || p.key === 'tone' || (def.id === 'smp' && p.key === 'pitch')) {
            for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
            if (ci === gen4SelectedNoteChannel && gen4EditorMode === 'notes') {
              for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
            }
          }
        },
        { genIdx: 4, key: `${def.id}:${p.key}` },
      );
      if (def.id === 'smp' && p.key === 'source') {
        ctrl.setFormatter((v) => (v >= 0.5 ? 'B' : 'A'));
      }
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
    id: 'grainarp',
    label: 'Grain Arp',
    params: [
      { key: 'grid', label: 'Grid', min: 10, max: 500, step: 1, value: 250, unit: 'ms' },
      { key: 'chance', label: 'Activity', min: 0, max: 1, step: 0.01, value: 1, unit: '' },
      { key: 'shape', label: 'Shape', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'reverse', label: 'Reverse', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
      { key: 'feedback', label: 'Repeats', min: 0, max: 0.85, step: 0.01, value: 0.25, unit: '' },
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
    id: 'resonator',
    label: 'Resonator',
    params: [
      { key: 'freq', label: 'Freq', min: 40, max: 2000, step: 1, value: 220, unit: 'Hz' },
      { key: 'decay', label: 'Decay', min: 0, max: 0.98, step: 0.01, value: 0.85, unit: '' },
      { key: 'damp', label: 'Damp', min: 200, max: 12000, step: 10, value: 4200, unit: 'Hz' },
      { key: 'int2', label: 'Note 2', min: -24, max: 24, step: 1, value: 12, unit: 'st' },
      { key: 'harm2', label: 'Level 2', min: 0, max: 1, step: 0.01, value: 0.5, unit: '' },
      { key: 'int3', label: 'Note 3', min: -24, max: 24, step: 1, value: 7, unit: 'st' },
      { key: 'harm3', label: 'Level 3', min: 0, max: 1, step: 0.01, value: 0.3, unit: '' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
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
  grainarp: [
    {
      name: 'Off',
      values: {
        grid: 250,
        gridSync: true,
        gridSyncIndex: 4,
        pattern: 'oct',
        chance: 1,
        shape: 0.3,
        scatter: 0,
        reverse: 0,
        feedback: 0.25,
        mix: 0,
      },
    },
    {
      name: 'Octave Bloom',
      values: {
        grid: 250,
        gridSync: true,
        gridSyncIndex: 4, // 1/8
        pattern: 'oct',
        chance: 0.85,
        shape: 0.25,
        scatter: 0,
        reverse: 0.15,
        feedback: 0.45,
        mix: 0.5,
      },
    },
    {
      name: 'Rising Sparkle',
      values: {
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2, // 1/16
        pattern: 'up',
        chance: 0.7,
        shape: 0.15,
        scatter: 0,
        reverse: 0,
        feedback: 0.3,
        mix: 0.45,
      },
    },
    {
      name: 'Falling Ghost',
      values: {
        grid: 250,
        gridSync: true,
        gridSyncIndex: 5, // 1/4T
        pattern: 'down',
        chance: 0.6,
        shape: 0.6,
        scatter: 0.3,
        reverse: 0.35,
        feedback: 0.55,
        mix: 0.5,
      },
    },
    {
      name: 'Scatter',
      values: {
        grid: 125,
        gridSync: true,
        gridSyncIndex: 2, // 1/16
        pattern: 'rand',
        chance: 0.5,
        shape: 0.4,
        scatter: 0.7,
        reverse: 0.25,
        feedback: 0.35,
        mix: 0.45,
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
  resonator: [
    {
      name: 'Off',
      values: {
        freq: 220,
        noteMode: false,
        note: 57,
        decay: 0.85,
        damp: 4200,
        int2: 12,
        int3: 7,
        harm2: 0.5,
        harm3: 0.3,
        mix: 0,
      },
    },
    {
      name: 'Sub Drone',
      values: {
        freq: 55,
        noteMode: true,
        note: 33, // A1 = 55Hz
        decay: 0.94,
        damp: 2200,
        int2: 12, // octave
        int3: 19, // octave + fifth
        harm2: 0.6,
        harm3: 0.25,
        mix: 0.5,
      },
    },
    {
      name: 'Major Triad',
      values: {
        freq: 220,
        noteMode: true,
        note: 57, // A3
        decay: 0.9,
        damp: 5200,
        int2: 4, // major third
        int3: 7, // fifth
        harm2: 0.7,
        harm3: 0.7,
        mix: 0.45,
      },
    },
    {
      name: 'Minor Triad',
      values: {
        freq: 220,
        noteMode: true,
        note: 57, // A3
        decay: 0.9,
        damp: 5200,
        int2: 3, // minor third
        int3: 7, // fifth
        harm2: 0.7,
        harm3: 0.7,
        mix: 0.45,
      },
    },
    {
      name: 'Metallic',
      values: {
        freq: 440,
        noteMode: true,
        note: 69, // A4 = 440Hz
        decay: 0.9,
        damp: 9000,
        int2: 12,
        int3: 19,
        harm2: 0.8,
        harm3: 0.7,
        mix: 0.55,
      },
    },
    {
      name: 'Glass Bell',
      values: {
        freq: 880,
        noteMode: true,
        note: 81, // A5 = 880Hz
        decay: 0.82,
        damp: 6500,
        int2: 19, // octave + fifth
        int3: 24, // two octaves
        harm2: 0.45,
        harm3: 0.6,
        mix: 0.4,
      },
    },
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
function makeDefaultInstrumentMixState() {
  return {
    muted: false,
    solo: false,
    gainDb: 0,
    pan: 0,
    eqEnabled: true,
    eqLow: 0,
    eqLowMid: 0,
    eqMid: 0,
    eqPresence: 0,
    eqHigh: 0,
  };
}
const INSTRUMENT_MIX = Object.fromEntries(
  FX_BUS_IDS.map((busId) => [busId, makeDefaultInstrumentMixState()]),
);
const instrumentMixButtons = new Map();
const MIXER = {
  built: false,
  strips: new Map(),
  master: null,
  meterBuffers: new WeakMap(),
  raf: null,
};
let mixerModVisualsLastRefresh = 0;

function refreshInstrumentMixUI() {
  const hasSolo = FX_BUS_IDS.some((busId) => INSTRUMENT_MIX[busId].solo);
  FX_BUS_IDS.forEach((busId) => {
    const mix = INSTRUMENT_MIX[busId];
    const buttons = instrumentMixButtons.get(busId);
    buttons?.mute.classList.toggle('active', mix.muted);
    buttons?.solo.classList.toggle('active', mix.solo);
    buttons?.mute.setAttribute('aria-pressed', mix.muted ? 'true' : 'false');
    buttons?.solo.setAttribute('aria-pressed', mix.solo ? 'true' : 'false');

    const strip = MIXER.strips.get(busId);
    strip?.mute.classList.toggle('active', mix.muted);
    strip?.solo.classList.toggle('active', mix.solo);
    strip?.mute.setAttribute('aria-pressed', mix.muted ? 'true' : 'false');
    strip?.solo.setAttribute('aria-pressed', mix.solo ? 'true' : 'false');
    strip?.el.classList.toggle('mixer-channel-silent', mix.muted || (hasSolo && !mix.solo));

    const panel = document.querySelector(`#generators [data-bus="${busId}"]`);
    panel?.classList.toggle('instrument-muted', mix.muted);
    panel?.classList.toggle('instrument-soloed', mix.solo);
    panel?.classList.toggle('instrument-silent', mix.muted || (hasSolo && !mix.solo));
  });
}

function reconnectInstrumentEq(busId) {
  const bus = fxBuses[busId];
  const mix = INSTRUMENT_MIX[busId];
  if (!bus?.mixer || !mix) return;
  bus.mixer.input.disconnect();
  bus.mixer.high.disconnect();
  if (mix.eqEnabled) {
    bus.mixer.input.connect(bus.mixer.low);
    bus.mixer.high.connect(bus.mixer.pan);
  } else {
    bus.mixer.input.connect(bus.mixer.pan);
  }
  bus.mixer.eqEnabled = mix.eqEnabled;
}

function applyInstrumentMixState() {
  const hasSolo = FX_BUS_IDS.some((busId) => INSTRUMENT_MIX[busId].solo);
  FX_BUS_IDS.forEach((busId) => {
    const mix = INSTRUMENT_MIX[busId];
    const audible = !mix.muted && (!hasSolo || mix.solo);
    const bus = fxBuses[busId];
    if (bus && audioCtx) {
      if (bus.mixer.eqEnabled !== mix.eqEnabled) reconnectInstrumentEq(busId);
      // Drop any ramp frozen by a suspended context before targeting anew.
      bus.output.gain.cancelScheduledValues(audioCtx.currentTime);
      bus.output.gain.setTargetAtTime(
        audible && mix.gainDb > -59.9 ? dbToLinear(clamp(mix.gainDb, -60, 6)) : 0,
        audioCtx.currentTime,
        0.01,
      );
      bus.mixer.pan.pan.setTargetAtTime(getEffectiveMixerPan(busId), audioCtx.currentTime, 0.01);
      bus.mixer.low.gain.setTargetAtTime(
        clamp(mix.eqLow, -18, 18),
        audioCtx.currentTime,
        0.02,
      );
      bus.mixer.lowMid.gain.setTargetAtTime(
        clamp(mix.eqLowMid, -18, 18),
        audioCtx.currentTime,
        0.02,
      );
      bus.mixer.mid.gain.setTargetAtTime(
        clamp(mix.eqMid, -18, 18),
        audioCtx.currentTime,
        0.02,
      );
      bus.mixer.presence.gain.setTargetAtTime(
        clamp(mix.eqPresence, -18, 18),
        audioCtx.currentTime,
        0.02,
      );
      bus.mixer.high.gain.setTargetAtTime(
        clamp(mix.eqHigh, -18, 18),
        audioCtx.currentTime,
        0.02,
      );
    }
  });
  refreshInstrumentMixUI();
}

function setInstrumentSolo(busId, solo) {
  if (!FX_BUS_IDS.includes(busId)) return;
  if (solo && !SOLO_MODE.additive) {
    FX_BUS_IDS.forEach((id) => (INSTRUMENT_MIX[id].solo = false));
  }
  INSTRUMENT_MIX[busId].solo = solo;
  applyInstrumentMixState();
}

function setInstrumentMuted(busId, muted) {
  if (!FX_BUS_IDS.includes(busId)) return;
  INSTRUMENT_MIX[busId].muted = muted;
  applyInstrumentMixState();
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
    setInstrumentSolo(busId, !INSTRUMENT_MIX[busId].solo);
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
    setInstrumentMuted(busId, !INSTRUMENT_MIX[busId].muted);
  });

  controls.append(solo, mute);
  instrumentMixButtons.set(busId, { solo, mute });
  return controls;
}

function formatMixerDb(value) {
  if (value <= -59.9) return '−∞';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function formatMixerPan(value) {
  if (Math.abs(value) < 0.01) return 'C';
  return `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`;
}

function buildMixerKnob(busId, key, label, spec, format, modTarget = null) {
  const group = document.createElement('div');
  group.className = 'mixer-knob-group';
  const title = document.createElement('span');
  title.className = 'mixer-control-label';
  title.textContent = label;
  const value = document.createElement('span');
  value.className = 'mixer-control-value';

  let current = INSTRUMENT_MIX[busId][key];
  const commit = (next) => {
    current = next;
    INSTRUMENT_MIX[busId][key] = next;
    value.textContent = format(next);
    knob.setAttribute('aria-valuenow', `${next}`);
    knob.setAttribute('aria-valuetext', format(next));
    applyInstrumentMixState();
  };
  const knob = makeKnob({ ...spec, resetValue: spec.resetValue }, current, commit);
  knob.setAttribute('tabindex', '0');
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', `${FX_BUS_LABELS[busId]} ${label}`);
  knob.setAttribute('aria-valuemin', `${spec.min}`);
  knob.setAttribute('aria-valuemax', `${spec.max}`);
  knob.setAttribute('aria-valuenow', `${current}`);
  knob.setAttribute('aria-valuetext', format(current));
  let mapLed = null;
  if (modTarget) {
    mapLed = document.createElement('button');
    mapLed.type = 'button';
    mapLed.className = 'lfo-led mixer-map-led';
    setLFOLedState(mapLed, null);
    mapLed.addEventListener('click', (event) => {
      event.stopPropagation();
      setLFOLedState(mapLed, cycleLFOMap(modTarget.genIdx, modTarget.key));
    });
    mapLed.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openModSourceMenu(modTarget, mapLed, event.clientX, event.clientY);
    });
    knob.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openModSourceMenu(modTarget, mapLed, event.clientX, event.clientY);
    });
  }
  knob.addEventListener('keydown', (event) => {
    let direction = 0;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') direction = 1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') direction = -1;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    let next = current;
    if (event.key === 'Home') next = spec.min;
    else if (event.key === 'End') next = spec.max;
    else next = clamp(current + direction * spec.step * (event.shiftKey ? 0.1 : 1), spec.min, spec.max);
    const decimals = (spec.step.toString().split('.')[1] || '').length;
    next = Number(next.toFixed(decimals));
    knob.setValue(next);
    commit(next);
  });

  value.textContent = format(current);
  if (mapLed) {
    const heading = document.createElement('div');
    heading.className = 'mixer-control-heading';
    heading.append(title, mapLed);
    group.append(heading, knob, value);
  } else {
    group.append(title, knob, value);
  }
  return {
    el: group,
    setValue(next) {
      current = next;
      knob.setValue(next);
      value.textContent = format(next);
      knob.setAttribute('aria-valuenow', `${next}`);
      knob.setAttribute('aria-valuetext', format(next));
    },
    setMapLFO(sourceIdx) {
      if (mapLed) setLFOLedState(mapLed, sourceIdx);
    },
    setModValue(next) {
      knob.setModValue?.(next);
    },
  };
}

function buildMixerMeter() {
  const meter = document.createElement('div');
  meter.className = 'mixer-meter';
  const leftTrack = document.createElement('span');
  const rightTrack = document.createElement('span');
  leftTrack.className = 'mixer-meter-track';
  rightTrack.className = 'mixer-meter-track';
  leftTrack.setAttribute('aria-hidden', 'true');
  rightTrack.setAttribute('aria-hidden', 'true');
  const left = document.createElement('span');
  const right = document.createElement('span');
  left.className = 'mixer-meter-fill';
  right.className = 'mixer-meter-fill';
  const leftHold = document.createElement('span');
  const rightHold = document.createElement('span');
  leftHold.className = 'mixer-meter-hold';
  rightHold.className = 'mixer-meter-hold';
  leftHold.hidden = true;
  rightHold.hidden = true;
  const peak = document.createElement('button');
  peak.type = 'button';
  peak.className = 'mixer-meter-peak';
  peak.textContent = '−∞';
  peak.title = 'Maximum peak · click to reset';
  peak.setAttribute('aria-label', 'Maximum channel peak, click to reset');
  leftTrack.append(left, leftHold);
  rightTrack.append(right, rightHold);
  meter.append(leftTrack, rightTrack, peak);
  const result = {
    el: meter,
    left,
    right,
    leftHold,
    rightHold,
    peak,
    holdLeftDb: -60,
    holdRightDb: -60,
    holdLeftUntil: 0,
    holdRightUntil: 0,
    lastPaintAt: 0,
  };
  peak.addEventListener('click', () => {
    result.holdLeftDb = MIXER_METER_FLOOR_DB;
    result.holdRightDb = MIXER_METER_FLOOR_DB;
    result.holdLeftUntil = 0;
    result.holdRightUntil = 0;
    leftHold.hidden = true;
    rightHold.hidden = true;
    peak.textContent = '−∞';
    peak.classList.remove('over-zero');
    peak.title = 'Maximum peak · click to reset';
  });
  return result;
}

function buildMixerChannel(busId) {
  const mix = INSTRUMENT_MIX[busId];
  const strip = document.createElement('section');
  strip.className = `mixer-channel mixer-${busId}`;
  strip.dataset.bus = busId;

  const header = document.createElement('div');
  header.className = 'mixer-channel-header';
  const dot = document.createElement('span');
  dot.className = 'mixer-channel-dot';
  const name = document.createElement('span');
  name.className = 'mixer-channel-name';
  name.textContent = FX_BUS_LABELS[busId];
  header.append(dot, name);

  const switches = document.createElement('div');
  switches.className = 'mixer-channel-switches';
  const solo = document.createElement('button');
  solo.type = 'button';
  solo.className = 'instrument-mix-btn instrument-solo-btn';
  solo.textContent = 'S';
  solo.title = `Solo ${FX_BUS_LABELS[busId]}`;
  solo.setAttribute('aria-label', solo.title);
  solo.addEventListener('click', () => setInstrumentSolo(busId, !mix.solo));
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'instrument-mix-btn instrument-mute-btn';
  mute.textContent = 'M';
  mute.title = `Mute ${FX_BUS_LABELS[busId]}`;
  mute.setAttribute('aria-label', mute.title);
  mute.addEventListener('click', () => setInstrumentMuted(busId, !mix.muted));
  switches.append(solo, mute);
  header.appendChild(switches);

  const eq = document.createElement('div');
  eq.className = 'mixer-eq';
  const eqHeader = document.createElement('div');
  eqHeader.className = 'mixer-section-header';
  const eqLabel = document.createElement('span');
  eqLabel.textContent = 'Channel EQ';
  const eqToggle = document.createElement('button');
  eqToggle.type = 'button';
  eqToggle.className = 'mixer-eq-toggle';
  eqToggle.textContent = 'EQ';
  eqToggle.title = `Bypass ${FX_BUS_LABELS[busId]} channel EQ`;
  eqToggle.setAttribute('aria-label', eqToggle.title);
  eqToggle.addEventListener('click', () => {
    mix.eqEnabled = !mix.eqEnabled;
    applyInstrumentMixState();
    refreshMixerControls();
  });
  eqHeader.append(eqLabel, eqToggle);

  const eqControls = document.createElement('div');
  eqControls.className = 'mixer-eq-controls';
  const low = buildMixerKnob(
    busId,
    'eqLow',
    'Low · 100',
    { min: -18, max: 18, step: 0.5, resetValue: 0 },
    formatMixerDb,
  );
  low.el.title = 'Low shelf · 100 Hz';
  const lowMid = buildMixerKnob(
    busId,
    'eqLowMid',
    'Low Mid · 300',
    { min: -18, max: 18, step: 0.5, resetValue: 0 },
    formatMixerDb,
  );
  lowMid.el.title = 'Low-mid bell · 300 Hz';
  const mid = buildMixerKnob(
    busId,
    'eqMid',
    'Mid · 1k',
    { min: -18, max: 18, step: 0.5, resetValue: 0 },
    formatMixerDb,
  );
  mid.el.title = 'Mid bell · 1 kHz';
  const presence = buildMixerKnob(
    busId,
    'eqPresence',
    'Presence · 3.5k',
    { min: -18, max: 18, step: 0.5, resetValue: 0 },
    formatMixerDb,
  );
  presence.el.title = 'Presence bell · 3.5 kHz';
  const high = buildMixerKnob(
    busId,
    'eqHigh',
    'High · 10k',
    { min: -18, max: 18, step: 0.5, resetValue: 0 },
    formatMixerDb,
  );
  high.el.title = 'High shelf · 10 kHz';
  eqControls.append(low.el, lowMid.el, mid.el, presence.el, high.el);
  eq.append(eqHeader, eqControls);

  const lower = document.createElement('div');
  lower.className = 'mixer-channel-lower';
  const meter = buildMixerMeter();
  const faderGroup = document.createElement('label');
  faderGroup.className = 'mixer-fader-group';
  const faderLabel = document.createElement('span');
  faderLabel.className = 'mixer-control-label';
  faderLabel.textContent = 'Gain';
  const fader = document.createElement('input');
  fader.type = 'range';
  fader.className = 'mixer-fader';
  fader.min = '-60';
  fader.max = '6';
  fader.step = '0.5';
  fader.value = `${mix.gainDb}`;
  fader.setAttribute('aria-label', `${FX_BUS_LABELS[busId]} gain`);
  const faderValue = document.createElement('span');
  faderValue.className = 'mixer-control-value';
  faderValue.textContent = formatMixerDb(mix.gainDb);
  fader.addEventListener('input', () => {
    mix.gainDb = Number(fader.value);
    faderValue.textContent = formatMixerDb(mix.gainDb);
    applyInstrumentMixState();
  });
  fader.addEventListener('dblclick', () => {
    mix.gainDb = 0;
    fader.value = '0';
    faderValue.textContent = formatMixerDb(0);
    applyInstrumentMixState();
  });
  faderGroup.append(faderLabel, fader, faderValue);

  const right = document.createElement('div');
  right.className = 'mixer-channel-right';
  const pan = buildMixerKnob(
    busId,
    'pan',
    'Pan',
    { min: -1, max: 1, step: 0.01, resetValue: 0 },
    formatMixerPan,
    { genIdx: 5, key: `${busId}:pan`, label: `${FX_BUS_LABELS[busId]} Pan` },
  );
  const fxBtn = document.createElement('button');
  fxBtn.type = 'button';
  fxBtn.className = 'mixer-fx-btn';
  fxBtn.textContent = 'Open FX';
  fxBtn.title = `Open ${FX_BUS_LABELS[busId]} effects on the front panel`;
  fxBtn.addEventListener('click', () => {
    setActiveBus(busId);
    setPanelView('front');
  });
  right.append(pan.el, eq, fxBtn);
  lower.append(meter.el, faderGroup, right);
  strip.append(header, lower);

  MIXER.strips.set(busId, {
    el: strip,
    solo,
    mute,
    eq,
    eqToggle,
    low,
    lowMid,
    mid,
    presence,
    high,
    pan,
    fader,
    faderValue,
    meter,
  });
  return strip;
}

function buildMixerMasterChannel() {
  const strip = document.createElement('section');
  strip.className = 'mixer-channel mixer-master-channel';
  const header = document.createElement('div');
  header.className = 'mixer-channel-header';
  const dot = document.createElement('span');
  dot.className = 'mixer-channel-dot';
  const name = document.createElement('span');
  name.className = 'mixer-channel-name';
  name.textContent = 'Master';
  header.append(dot, name);

  const body = document.createElement('div');
  body.className = 'mixer-master-body';
  const meter = buildMixerMeter();
  meter.el.classList.add('mixer-master-meter');
  const outputGroup = document.createElement('label');
  outputGroup.className = 'mixer-knob-group mixer-master-output';
  const outputLabel = document.createElement('span');
  outputLabel.className = 'mixer-control-label';
  outputLabel.textContent = 'Output';
  const outputValue = document.createElement('span');
  outputValue.className = 'mixer-control-value';
  const commitOutput = (value) => {
    LIMITER.output = value;
    outputValue.textContent = formatMixerDb(20 * Math.log10(value));
    output.setAttribute('aria-valuenow', `${value}`);
    applyLimiter('output', value);
    limiterControls.get('output')?.setValue(value);
    refreshFxPresetSelection('limiter');
  };
  const output = makeKnob(
    { min: 0.5, max: 1.2, step: 0.01, resetValue: 0.96 },
    LIMITER.output,
    commitOutput,
  );
  output.setAttribute('tabindex', '0');
  output.setAttribute('role', 'slider');
  output.setAttribute('aria-label', 'Master output');
  output.setAttribute('aria-valuemin', '0.5');
  output.setAttribute('aria-valuemax', '1.2');
  output.setAttribute('aria-valuenow', `${LIMITER.output}`);
  outputValue.textContent = formatMixerDb(20 * Math.log10(LIMITER.output));
  outputGroup.append(outputLabel, output, outputValue);
  const reduction = document.createElement('div');
  reduction.className = 'mixer-limiter-reduction';
  reduction.innerHTML = '<span>Limiter</span><strong>0.0 dB</strong>';
  body.append(meter.el, outputGroup, reduction);
  strip.append(header, body);
  MIXER.master = { el: strip, meter, output, outputValue, reduction: reduction.querySelector('strong') };
  return strip;
}

function buildMixerPanel() {
  const panel = document.getElementById('mixerPanel');
  if (!panel || MIXER.built) return;
  MIXER.built = true;
  const intro = document.createElement('div');
  intro.className = 'mixer-heading';
  const title = document.createElement('div');
  title.className = 'mixer-title';
  title.textContent = 'Mixer';
  const note = document.createElement('div');
  note.className = 'mixer-note';
  note.textContent = 'Post-FX channel strips · double-click controls or click a peak value to reset';
  intro.append(title, note);
  const channels = document.createElement('div');
  channels.className = 'mixer-channels';
  FX_BUS_IDS.forEach((busId) => channels.appendChild(buildMixerChannel(busId)));
  channels.appendChild(buildMixerMasterChannel());
  panel.append(intro, channels);
  refreshMixerControls();
}

function refreshMixerControls() {
  if (!MIXER.built) return;
  FX_BUS_IDS.forEach((busId) => {
    const mix = INSTRUMENT_MIX[busId];
    const strip = MIXER.strips.get(busId);
    if (!strip) return;
    strip.low.setValue(mix.eqLow);
    strip.lowMid.setValue(mix.eqLowMid);
    strip.mid.setValue(mix.eqMid);
    strip.presence.setValue(mix.eqPresence);
    strip.high.setValue(mix.eqHigh);
    strip.pan.setValue(mix.pan);
    strip.fader.value = `${mix.gainDb}`;
    strip.faderValue.textContent = formatMixerDb(mix.gainDb);
    strip.eqToggle.classList.toggle('active', mix.eqEnabled);
    strip.eqToggle.setAttribute('aria-pressed', mix.eqEnabled ? 'true' : 'false');
    strip.eq.classList.toggle('mixer-eq-bypassed', !mix.eqEnabled);
  });
  if (MIXER.master) {
    MIXER.master.output.setValue(LIMITER.output);
    MIXER.master.output.setAttribute('aria-valuenow', `${LIMITER.output}`);
    MIXER.master.outputValue.textContent = formatMixerDb(20 * Math.log10(LIMITER.output));
  }
  refreshMixerMappingUI();
  refreshInstrumentMixUI();
}

function refreshMixerPanModulationVisuals() {
  if (!MIXER.built) return;
  FX_BUS_IDS.forEach((busId) => {
    const pan = MIXER.strips.get(busId)?.pan;
    if (!pan) return;
    const mapped = lfoMappings.has(`5:${busId}:pan`);
    pan.setModValue(mapped ? getEffectiveMixerPan(busId) : null);
  });
}

function refreshMixerMappingUI() {
  if (!MIXER.built) return;
  FX_BUS_IDS.forEach((busId) => {
    const pan = MIXER.strips.get(busId)?.pan;
    if (!pan) return;
    const mapping = lfoMappings.get(`5:${busId}:pan`);
    pan.setMapLFO(mapping?.sourceIdx ?? null);
  });
  refreshMixerPanModulationVisuals();
}

const MIXER_METER_FLOOR_DB = -60;
const MIXER_METER_CEILING_DB = 6;
const MIXER_METER_HOLD_MS = 1500;
const MIXER_METER_PEAK_FALL_DB_PER_SEC = 20;

function readMixerMeterDb(analyser) {
  if (!analyser) return MIXER_METER_FLOOR_DB;
  let data = MIXER.meterBuffers.get(analyser);
  if (!data || data.length !== analyser.fftSize) {
    data = new Float32Array(analyser.fftSize);
    MIXER.meterBuffers.set(analyser, data);
  }
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = Math.abs(data[i]);
    peak = Math.max(peak, sample);
  }
  // A peak meter needs full-scale samples to land exactly on the 0 dB
  // reference. Values above full scale occupy the visible red +6 dB zone.
  const level = peak;
  return 20 * Math.log10(Math.max(level, 0.001));
}

function mixerMeterLevel(db) {
  return clamp(
    (db - MIXER_METER_FLOOR_DB) / (MIXER_METER_CEILING_DB - MIXER_METER_FLOOR_DB),
    0,
    1,
  );
}

function updateMixerPeakHold(meter, side, currentDb, timestamp, elapsedSeconds) {
  const dbKey = side === 'left' ? 'holdLeftDb' : 'holdRightDb';
  const untilKey = side === 'left' ? 'holdLeftUntil' : 'holdRightUntil';
  if (currentDb >= meter[dbKey]) {
    meter[dbKey] = currentDb;
    meter[untilKey] = timestamp + MIXER_METER_HOLD_MS;
  } else if (timestamp > meter[untilKey]) {
    meter[dbKey] = Math.max(
      currentDb,
      meter[dbKey] - MIXER_METER_PEAK_FALL_DB_PER_SEC * elapsedSeconds,
    );
  }
}

function paintMixerMeter(meter, nodes, timestamp) {
  const leftDb = readMixerMeterDb(nodes?.left);
  const rightDb = readMixerMeterDb(nodes?.right);
  const left = mixerMeterLevel(leftDb);
  const right = mixerMeterLevel(rightDb);
  meter.left.style.clipPath = `inset(${(1 - left) * 100}% 0 0)`;
  meter.right.style.clipPath = `inset(${(1 - right) * 100}% 0 0)`;
  const elapsedSeconds = meter.lastPaintAt ? Math.max(0, (timestamp - meter.lastPaintAt) / 1000) : 0;
  meter.lastPaintAt = timestamp;
  updateMixerPeakHold(meter, 'left', leftDb, timestamp, elapsedSeconds);
  updateMixerPeakHold(meter, 'right', rightDb, timestamp, elapsedSeconds);

  [
    [meter.leftHold, meter.holdLeftDb],
    [meter.rightHold, meter.holdRightDb],
  ].forEach(([marker, db]) => {
    marker.hidden = db <= MIXER_METER_FLOOR_DB;
    marker.style.bottom = `${Math.min(99.4, mixerMeterLevel(db) * 100)}%`;
    marker.classList.toggle('over-zero', db >= 0);
  });

  const heldPeakDb = Math.max(meter.holdLeftDb, meter.holdRightDb);
  if (heldPeakDb <= MIXER_METER_FLOOR_DB) {
    meter.peak.textContent = '−∞';
    meter.peak.classList.remove('over-zero');
    meter.peak.title = 'Maximum peak · click to reset';
    return;
  }
  const label = `${heldPeakDb >= 0 ? '+' : ''}${heldPeakDb.toFixed(1)}`;
  meter.peak.textContent = label;
  meter.peak.classList.toggle('over-zero', heldPeakDb >= 0);
  meter.peak.title = `Held peak ${label} dBFS · click to reset`;
}

function mixerMeterFrame(timestamp) {
  if (UI_VIEW.mode !== 'mixer') {
    MIXER.raf = null;
    return;
  }
  FX_BUS_IDS.forEach((busId) => {
    const strip = MIXER.strips.get(busId);
    if (strip) paintMixerMeter(strip.meter, fxBuses[busId]?.mixer?.meter, timestamp);
  });
  if (MIXER.master) {
    paintMixerMeter(MIXER.master.meter, master?.meter, timestamp);
    const amount = Math.abs(master?.limiter?.comp?.reduction || 0);
    MIXER.master.reduction.textContent = `${amount.toFixed(1)} dB`;
  }
  MIXER.raf = requestAnimationFrame(mixerMeterFrame);
}

function startMixerMeters() {
  if (!MIXER.raf) MIXER.raf = requestAnimationFrame(mixerMeterFrame);
}

function stopMixerMeters() {
  if (MIXER.raf) cancelAnimationFrame(MIXER.raf);
  MIXER.raf = null;
}

// Default per-bus effect state (the limiter is global, not per-bus).
function makeDefaultFxState() {
  // enabled:false unplugs the unit from the bus chain entirely (zero CPU) —
  // unlike mix:0, which keeps every processor rendering behind the dry path.
  return {
    beatrepeat: {
      enabled: true,
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
    grainarp: {
      enabled: true,
      grid: 250, // free value in ms, like beatrepeat's grid
      gridSync: true,
      gridSyncIndex: 4, // 1/8
      pattern: 'oct',
      chance: 1,
      shape: 0.3,
      scatter: 0,
      reverse: 0,
      feedback: 0.25,
      hold: false, // performance latch — freezes the capture ring
      mix: 0,
    },
    delay: {
      enabled: true,
      time: 0.3,
      feedback: 0.35,
      mix: 0,
      sync: false,
      syncIndex: 4,
      hp: 20,
      mode: 'stereo',
    },
    filter: { enabled: true, mode: 'lowpass', cutoff: 2400, q: 0.7, mix: 0 },
    resonator: {
      enabled: true,
      freq: 220,
      noteMode: false,
      note: 57, // MIDI A3 = 220Hz
      decay: 0.85,
      damp: 4200,
      int2: 12, // chord voice 2, semitones from root (octave)
      int3: 7, // chord voice 3, semitones from root (fifth)
      harm2: 0.5,
      harm3: 0.3,
      mix: 0,
    },
    bitreduce: { enabled: true, bits: 8, rate: 1, mix: 0 },
    sat: { enabled: true, drive: 0.3, mix: 0 },
    reverb: { enabled: true, size: 2, decay: 3, predelay: 0.018, damping: 0.42, mix: 0 },
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
const DEFAULT_FX_ORDER = [
  'beatrepeat',
  'grainarp',
  'delay',
  'filter',
  'resonator',
  'bitreduce',
  'sat',
  'reverb',
];
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
const RESONATOR_FREQ_FREE_CONTROL = FX_DEFS.find((def) => def.id === 'resonator').params.find(
  (param) => param.key === 'freq',
);
// MIDI range whose frequencies stay inside the worklet's 40–2000Hz clamp.
const RESONATOR_NOTE_MIN = 28; // E1 ≈ 41.2Hz
const RESONATOR_NOTE_MAX = 95; // B6 ≈ 1975.5Hz
const RESONATOR_FREQ_NOTE_CONTROL = {
  key: 'freq',
  label: 'Note',
  min: RESONATOR_NOTE_MIN,
  max: RESONATOR_NOTE_MAX,
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
const GRAINARP_GRID_FREE_CONTROL = FX_DEFS.find((def) => def.id === 'grainarp').params.find(
  (param) => param.key === 'grid',
);
const GRAINARP_GRID_SYNC_CONTROL = {
  key: 'grid',
  label: 'Grid',
  min: 0,
  max: GRAIN_SYNC_STEPS.length - 1,
  step: 1,
  unit: '',
};
const GRAINARP_PATTERNS = [
  ['oct', 'OCT'],
  ['up', 'UP'],
  ['down', 'DOWN'],
  ['rand', 'RND'],
];
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
  sharedAcrossLoops: false,
  currentStep: 0,
  currentValue: 0,
  elapsed: 0,
};
let seqBars = [];
let seqSubdivisionSelect = null;
let seqStepBeatSelect = null;
let seqShareButton = null;
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
  if (seqSubdivisionSelect) seqSubdivisionSelect.value = `${STEP_SEQ.subdivision}`;
  if (seqStepBeatSelect) seqStepBeatSelect.value = `${STEP_SEQ.stepBeats}`;
  if (seqShareButton) {
    seqShareButton.classList.toggle('active', STEP_SEQ.sharedAcrossLoops);
    seqShareButton.setAttribute('aria-pressed', STEP_SEQ.sharedAcrossLoops ? 'true' : 'false');
    seqShareButton.textContent = STEP_SEQ.sharedAcrossLoops ? 'Shared' : 'Share';
    seqShareButton.title = STEP_SEQ.sharedAcrossLoops
      ? 'Shared across every loop and Song mode · click for per-loop sequences'
      : 'Use the current sequence across every loop and Song mode';
  }
}

function setSequencerStep(stepIdx, value) {
  // 12 levels each way — one level = one semitone on a pitch target.
  STEP_SEQ.steps[stepIdx] = clamp(Math.round(value * 12) / 12, -1, 1);
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

function shareSequencerAcrossLoops(source) {
  if (!source) return;
  LOOPS.list.forEach((loop) => {
    loop.seq.steps = source.steps;
    loop.seq.subdivision = source.subdivision;
    loop.seq.stepBeats = source.stepBeats;
  });
  STEP_SEQ.steps = source.steps;
  STEP_SEQ.subdivision = source.subdivision;
  STEP_SEQ.stepBeats = source.stepBeats;
}

function setSequencerSharedAcrossLoops(on, { announce = true } = {}) {
  const next = Boolean(on);
  if (next === STEP_SEQ.sharedAcrossLoops) {
    refreshSequencerUI();
    return;
  }
  const editLoop = getEditLoop();
  if (next) {
    STEP_SEQ.sharedAcrossLoops = true;
    shareSequencerAcrossLoops(editLoop?.seq);
  } else {
    // Shared mode aliases one steps array. Clone it for every loop when
    // leaving so subsequent edits are independent again.
    LOOPS.list.forEach((loop) => {
      loop.seq.steps = [...loop.seq.steps];
    });
    STEP_SEQ.sharedAcrossLoops = false;
    if (editLoop) STEP_SEQ.steps = editLoop.seq.steps;
  }
  STEP_SEQ.currentStep = Math.min(STEP_SEQ.currentStep, getSeqActiveStepCount() - 1);
  STEP_SEQ.currentValue = STEP_SEQ.steps[STEP_SEQ.currentStep] || 0;
  refreshSequencerUI();
  refreshBackPanelState();
  applyMappedModulationTargets();
  if (announce) {
    setStatus(next ? 'sequence shared across all loops' : 'sequence is now per loop');
  }
}

// ─── Loops & Song Arrangement ─────────────────────────────────────────────
//
// The instrument rack (generator/kit/FX/LFO settings, routings) is global and
// always live. What is *sequenced* — the drum grid, the chord the OSC row
// fires, and normally the mod-sequencer pattern — lives in a Loop. Seq 1 can
// optionally alias its pattern across every loop. Song mode arranges loops on
// a timeline of entries (loop × repeats).
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
  entries: [], // [{ id, loopId, repeats, prob, cond, variation, fill, jump }]
  loop: true, // cycle the arrangement when it reaches the end
  follow: true, // while a song plays, show the loop that is sounding
  // Scheduler position (runs ahead of audio). variation is the pattern pick
  // resolved for this visit (-1 = the loop's own); fillPattern caches the
  // auto-fill generated for the entry's final cycle; jump is the destination
  // entry id decided when the entry started (null = continue linear).
  cursor: { entryIdx: 0, repeat: 0, variation: -1, fillPattern: null, jump: null },
  audibleEntryIdx: -1, // entry actually sounding right now
  entryCounter: 0,
  runtime: new Map(), // entry id → { visits, jumpsTaken }, playback counters
  lastJump: null, // { from, to } entry ids of the latest jump taken (lane viz)
};

const SONG_REPEAT_CYCLE = [1, 2, 4, 8, 16];
// Song-level play conditions, counted per visit to the entry — same idea as
// step trig conditions, one level up: 1:2 plays the 1st of every 2 visits.
const SONG_CONDITIONS = [
  { id: 'always', label: '—' },
  { id: '1:2', label: '1:2', a: 1, b: 2 },
  { id: '2:2', label: '2:2', a: 2, b: 2 },
  { id: '1:4', label: '1:4', a: 1, b: 4 },
  { id: '4:4', label: '4:4', a: 4, b: 4 },
];
const SONG_JUMP_COUNTS = [0, 1, 2, 4, 8]; // 0 = unlimited
const songBlockEls = new Map(); // entry id → block element
let songPlayBtnEl = null;
let songAddBtnEl = null;
let songPlayheadRendered = { entryIdx: -2, repeat: -2, cursorIdx: -2 };

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
      condition: new Array(32).fill(0),
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
    if (Array.isArray(source.condition)) channel.condition = [...source.condition];
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
      condition: [...(channel.condition || [])],
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
        .forEach((value, si) => (channel.timing[si] = clamp(Math.round(value), -8, 8)));
    if (Array.isArray(saved.locks))
      saved.locks.slice(0, 32).forEach((values, si) => {
        if (!values || typeof values !== 'object') return;
        // OSC locks override gen3 synth params, not drum-channel paramDefs.
        const lockDefs = def.id === 'osc' ? GEN3_PARAM_DEFS : def.paramDefs;
        lockDefs.forEach((pd) => {
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
    if (Array.isArray(saved.condition))
      saved.condition
        .slice(0, 32)
        .forEach(
          (value, si) =>
            (channel.condition[si] = clamp(Math.round(value) || 0, 0, GEN4_TRIG_CONDITIONS.length - 1)),
        );
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

// Move a note to the next in-scale pitch in the given direction; stays put if
// none within a tritone or the note range.
function gen4NudgeNoteInScale(midi, dir) {
  for (let d = 1; d <= 6; d++) {
    const cand = midi + dir * d;
    if (cand < GEN4_NOTE_MIN || cand > GEN4_NOTE_MAX) break;
    if (isMidiInGen4Scale(cand)) return cand;
  }
  return midi;
}

// Variations vary step parameters except timing and stutter — microtime feel
// and ratchet subdivisions read as tempo changes, so B/C keep them verbatim.
function generateGen4Variation(source, intensity = 1) {
  const pattern = cloneGen4Pattern(source);
  pattern.channels.forEach((channel, ci) => {
    const def = GEN4_DEFS[ci];
    const laneInUse = channel.steps.slice(0, pattern.stepCount).some(Boolean);
    for (let si = 0; si < pattern.stepCount; si++) {
      if (!channel.steps[si]) {
        // Sparse added hits on lanes already in the groove; kick and osc keep
        // their programmed skeleton.
        if (
          laneInUse &&
          def.id !== 'kick' &&
          def.id !== 'osc' &&
          Math.random() < 0.05 * intensity
        ) {
          channel.steps[si] = true;
          channel.notes[si] = gen4FillNoteFor(channel, si, pattern.stepCount);
          channel.velocity[si] = clamp(0.5 + Math.random() * 0.35, 0.05, 1);
          channel.probability[si] = 1;
          channel.condition[si] = 0;
          // Full reset: a step toggled off in the past keeps its old timing,
          // stutter, and locks in the arrays — a generated hit must not
          // resurrect them.
          channel.timing[si] = 0;
          channel.stutter[si] = 1;
          channel.locks[si] = {};
        }
        continue;
      }
      // Rarely drop a hit so B/C breathe differently; the kick skeleton and
      // the downbeat stay.
      if (
        def.id !== 'kick' &&
        def.id !== 'osc' &&
        si !== 0 &&
        Math.random() < 0.05 * intensity
      ) {
        channel.steps[si] = false;
        continue;
      }
      channel.velocity[si] = clamp(
        channel.velocity[si] * (0.82 + Math.random() * 0.26),
        0.05,
        1,
      );
      if (Number.isFinite(channel.notes[si]) && Math.random() < 0.14 * intensity) {
        channel.notes[si] = gen4NudgeNoteInScale(
          channel.notes[si],
          Math.random() < 0.5 ? -1 : 1,
        );
      }
      if (Math.random() < 0.12 * intensity) channel.probability[si] = intensity > 1 ? 0.5 : 0.75;
      // Nudge existing param locks within their bounds for timbral movement.
      const lockDefs = def.id === 'osc' ? GEN3_PARAM_DEFS : def.paramDefs;
      Object.keys(channel.locks[si]).forEach((key) => {
        if (key === '_fxSend') return;
        const pd = lockDefs.find((p) => p.key === key);
        if (!pd || Math.random() >= 0.3 * intensity) return;
        const span = (pd.max - pd.min) * 0.08;
        const nudged = channel.locks[si][key] + (Math.random() * 2 - 1) * span;
        channel.locks[si][key] = clamp(
          Math.round(nudged / pd.step) * pd.step,
          pd.min,
          pd.max,
        );
      });
    }
  });
  return pattern;
}

// Nearest programmed note on the lane (searching backward first, wrapping),
// snapped to the shared scale, so added fill hits stay in key. A lane played
// without notes returns null and the hit uses the knob pitch as usual.
function gen4FillNoteFor(channel, si, stepCount) {
  for (let d = 1; d <= stepCount; d++) {
    for (const idx of [si - d, si + d]) {
      const wrapped = ((idx % stepCount) + stepCount) % stepCount;
      if (channel.steps[wrapped] && Number.isFinite(channel.notes[wrapped])) {
        return clamp(snapMidiToGen4Scale(channel.notes[wrapped]), GEN4_NOTE_MIN, GEN4_NOTE_MAX);
      }
    }
  }
  return null;
}

function generateGen4Fill(source) {
  const pattern = cloneGen4Pattern(source);
  const start = Math.max(0, pattern.stepCount - 4);
  pattern.channels.forEach((channel, ci) => {
    const id = GEN4_DEFS[ci].id;
    if (id === 'kick' || id === 'osc') return;
    // Only lanes the pattern already uses join the fill — a silent lane firing
    // at its raw knob defaults reads as noise from outside the groove.
    if (!channel.steps.slice(0, pattern.stepCount).some(Boolean)) return;
    for (let si = start; si < pattern.stepCount; si++) {
      // Programmed steps keep their velocity, timing, and feel untouched.
      if (channel.steps[si]) continue;
      // Density and velocity ramp toward the turnaround so it reads as a
      // build rather than a flat burst.
      const progress = (si - start + 1) / (pattern.stepCount - start);
      if (Math.random() >= 0.12 + progress * 0.35) continue;
      channel.steps[si] = true;
      channel.notes[si] = gen4FillNoteFor(channel, si, pattern.stepCount);
      channel.velocity[si] = clamp(0.35 + progress * 0.22 + Math.random() * 0.15, 0.05, 1);
      channel.probability[si] = 1;
      channel.condition[si] = 0;
      // Full reset: generated hits never inherit stale timing, stutter, or
      // locks left behind by a step that was toggled off — and timing is
      // never randomized by design.
      channel.timing[si] = 0;
      channel.stutter[si] = 1;
      channel.locks[si] = {};
      if (si >= pattern.stepCount - 2 && Math.random() < 0.25) {
        channel.stutter[si] = 2 + Math.floor(Math.random() * 2);
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
    gen3: { ...captureGen3LoopParams(), lockedMidis: new Set() },
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
          condition: ch.condition,
        })),
      },
      gen3: { ...captureGen3LoopParams(), lockedMidis: GEN3.lockedMidis },
      seq: {
        steps: STEP_SEQ.steps,
        subdivision: STEP_SEQ.subdivision,
        stepBeats: STEP_SEQ.stepBeats,
      },
    },
  ];
  ensureGen4Variations(LOOPS.list[0]);
  LOOPS.editIndex = 0;
  // A blank project is immediately playable in Song mode: the initial loop
  // already occupies the first timeline slot. Restored projects replace this
  // seed with their saved arrangement, including an intentionally empty one.
  SONG.entries = [createSongEntryData(LOOPS.list[0].id)];
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

// The variation a song entry asked for, generated on demand. null → the
// loop's live arrays (what the scheduler reads anyway).
function songVariationPattern(loop, v) {
  if (v == null || v < 0 || !loop?.gen4) return null;
  ensureGen4Variations(loop);
  if (v === loop.gen4.activeVariation) return null;
  if (!loop.gen4.variations[v]) {
    loop.gen4.variations[v] = generateGen4Variation(
      loop.gen4.variations[0],
      v === 1 ? 1 : 1.8,
    );
  }
  return loop.gen4.variations[v];
}

function getGen4PlaybackPattern(loop) {
  if (gen4FillState.active && gen4FillState.loopId === loop?.id && gen4FillState.pattern) {
    return gen4FillState.pattern;
  }
  if (PLAY.mode === 'song' && GEN4.playing) {
    const entry = SONG.entries[SONG.cursor.entryIdx];
    if (entry && entry.loopId === loop?.id) {
      const base = songVariationPattern(loop, SONG.cursor.variation) || loop.gen4;
      if (entry.fill && SONG.cursor.repeat >= Math.max(1, entry.repeats) - 1) {
        // Transition-aware: the fill announces a change. When the song stays
        // on the same loop (self-jump, or a neighbouring block of the same
        // loop), the last cycle plays straight. Song ending counts as change.
        const nextIdx = songExpectedNextIdx();
        const changes = nextIdx < 0 || SONG.entries[nextIdx]?.loopId !== entry.loopId;
        if (changes) {
          if (!SONG.cursor.fillPattern) SONG.cursor.fillPattern = generateGen4Fill(base);
          return SONG.cursor.fillPattern;
        }
      }
      return base;
    }
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
    gen3: {
      ...Object.fromEntries(GEN3_LOOP_PARAM_KEYS.map((key) => [key, loop.gen3[key]])),
      lockedMidis: [...loop.gen3.lockedMidis],
    },
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
  if (GEN3_OSC_TYPES.has(data?.gen3?.type)) loop.gen3.type = data.gen3.type;
  GEN3_PARAM_DEFS.forEach(({ key, min, max }) => {
    if (typeof data?.gen3?.[key] === 'number') {
      loop.gen3[key] = clamp(data.gen3[key], min, max);
    }
  });
  if (typeof data?.gen3?.sustainMode === 'boolean') {
    loop.gen3.sustainMode = data.gen3.sustainMode;
  }
  if (typeof data?.gen3?.arpEnabled === 'boolean') {
    loop.gen3.arpEnabled = data.gen3.arpEnabled;
  }
  if (
    typeof data?.gen3?.arpRateBeats === 'number' &&
    GEN3_ARP_RATE_OPTIONS.some(({ beats }) => Math.abs(beats - data.gen3.arpRateBeats) < 1e-6)
  ) {
    loop.gen3.arpRateBeats = data.gen3.arpRateBeats;
  }
  if (GEN3_ARP_DIRECTIONS.has(data?.gen3?.arpDirection)) {
    loop.gen3.arpDirection = data.gen3.arpDirection;
  }
  if (typeof data?.gen3?.arpOctaves === 'number') {
    loop.gen3.arpOctaves = clamp(Math.round(data.gen3.arpOctaves), 1, 3);
  }
  if (typeof data?.gen3?.arpGate === 'number') {
    loop.gen3.arpGate = clamp(data.gen3.arpGate, 0.1, 1);
  }
  if (loop.gen3.arpEnabled) loop.gen3.sustainMode = false;
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
    gen3: {
      ...captureGen3LoopParams(preset?.gen3 || GEN3),
      lockedMidis: preset?.gen3?.lockedMidis || [],
    },
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
    const source = getSourceState(gi);
    const waitingForFileAudio = source.mode === 'file' && !source.bufferData;
    setGeneratorParam(gi, 'positionSec', gens.positionSec, {
      send: false,
      deferMaxClamp: waitingForFileAudio,
    });
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
    // Patterns from older saves may predate trig conditions.
    if (!Array.isArray(pat.condition)) pat.condition = new Array(32).fill(0);
    ch.condition = pat.condition;
  });
  const gen3SoundShouldFollowEditLoop =
    !!GEN3.nodes &&
    (GEN4.playing || GEN3.activeNotes.size > 0) &&
    !(PLAY.mode === 'song' && GEN4.playing);
  const gen3ParamsChanged = applyGen3LoopParams(loop);
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
  refreshGen4LockEditor();

  if (gen3SoundShouldFollowEditLoop) {
    if (GEN3.sustainMode) {
      syncGen3SustainChord(GEN3.lockedMidis);
      if (gen3ParamsChanged && GEN3.activeNotes.size > 0) restartAllGen3Notes();
    } else if (GEN3.activeNotes.size > 0) {
      stopAllGen3Notes();
    }
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
  if (STEP_SEQ.sharedAcrossLoops && src) shareSequencerAcrossLoops(src.seq);
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
  // Jumps aimed at removed entries fall back to linear flow.
  const songEntryIds = new Set(SONG.entries.map((e) => e.id));
  SONG.entries.forEach((e) => {
    if (e.jump && !songEntryIds.has(e.jump.targetId)) e.jump = null;
  });
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

function songRuntime(entryId) {
  let rt = SONG.runtime.get(entryId);
  if (!rt) {
    rt = { visits: 0, jumpsTaken: 0 };
    SONG.runtime.set(entryId, rt);
  }
  return rt;
}

// Resolve the pattern-variation pick for this visit, clear the per-visit
// fill cache, and roll the entry's jump dice up front. Deciding the jump at
// entry (not at the end) lets the auto-fill react to where the song is headed
// and lets the lane preview the destination a full block early. All dice roll
// here, in the scheduler, so audio and display can never disagree.
function songEnterEntry(entry) {
  const rt = songRuntime(entry.id);
  let v = -1;
  if (entry.variation === 'rnd') v = Math.floor(Math.random() * 3);
  else if (entry.variation === 'cycle') v = (rt.visits - 1) % 3;
  else if (Number.isInteger(entry.variation) && entry.variation >= 0) v = entry.variation;
  SONG.cursor.variation = clamp(v, -1, 2);
  SONG.cursor.fillPattern = null;
  SONG.cursor.jump = null;
  const jump = entry.jump;
  if (jump?.targetId && SONG.entries.some((e) => e.id === jump.targetId)) {
    let cap = Math.max(0, Math.round(jump.count || 0)); // 0 = unlimited
    // A bounce must terminate — unlimited jumps render as 4 takes.
    if (cap === 0 && BOUNCE.active) cap = 4;
    if ((cap === 0 || rt.jumpsTaken < cap) && Math.random() < (jump.chance ?? 1)) {
      rt.jumpsTaken += 1;
      SONG.cursor.jump = jump.targetId;
    }
  }
}

// Where the song is headed after the current entry: the decided jump target,
// else the next block down the lane. -1 = the song ends here.
function songExpectedNextIdx() {
  if (SONG.cursor.jump) {
    const t = SONG.entries.findIndex((e) => e.id === SONG.cursor.jump);
    if (t >= 0) return t;
  }
  const next = SONG.cursor.entryIdx + 1;
  if (next < SONG.entries.length) return next;
  return SONG.loop && SONG.entries.length ? 0 : -1;
}

// Walk forward from nextIdx to the first entry whose condition and
// probability let it play this pass, wrapping when the song loops. If a full
// scan lands nothing, the first candidate plays anyway — a probabilistic
// arrangement should thin out, never stall mid-set.
function songLandOn(nextIdx) {
  let fallback = -1;
  for (let guard = 0; guard <= SONG.entries.length; guard++) {
    if (nextIdx >= SONG.entries.length) {
      if (!SONG.loop) return false;
      nextIdx = 0;
    }
    const cand = SONG.entries[nextIdx];
    if (!cand) return false;
    if (fallback < 0) fallback = nextIdx;
    const rt = songRuntime(cand.id);
    rt.visits += 1;
    const cond = SONG_CONDITIONS[cand.cond || 0];
    const condOk = !cond?.b || (rt.visits - 1) % cond.b === cond.a - 1;
    if (condOk && Math.random() < (cand.prob ?? 1)) {
      SONG.cursor.entryIdx = nextIdx;
      SONG.cursor.repeat = 0;
      songEnterEntry(cand);
      return true;
    }
    nextIdx += 1;
  }
  SONG.cursor.entryIdx = fallback;
  SONG.cursor.repeat = 0;
  songEnterEntry(SONG.entries[fallback]);
  return true;
}

function advanceSongCursor() {
  const entry = SONG.entries[SONG.cursor.entryIdx];
  if (!entry) return false;
  SONG.cursor.repeat += 1;
  if (SONG.cursor.repeat < Math.max(1, entry.repeats)) {
    // Re-arm so an auto-fill regenerates fresh when its cycle arrives.
    SONG.cursor.fillPattern = null;
    return true;
  }
  // Entry finished — take the jump decided at entry, else continue linear.
  let nextIdx = SONG.cursor.entryIdx + 1;
  if (SONG.cursor.jump) {
    const tIdx = SONG.entries.findIndex((e) => e.id === SONG.cursor.jump);
    if (tIdx >= 0) {
      SONG.lastJump = { from: entry.id, to: SONG.cursor.jump };
      nextIdx = tIdx;
    }
  }
  return songLandOn(nextIdx);
}

function resetSongPlayback() {
  SONG_MORPH.t = 0;
  SONG_MORPH.gens = null;
  SONG_MORPH.loop = null;
  SONG.runtime.clear();
  SONG.lastJump = null;
  SONG.cursor.entryIdx = 0;
  SONG.cursor.repeat = 0;
  SONG.cursor.variation = -1;
  SONG.cursor.fillPattern = null;
  SONG.cursor.jump = null;
  if (SONG.entries.length) songLandOn(0);
  SONG.audibleEntryIdx = -1;
  STEP_SEQ.currentStep = 0;
  STEP_SEQ.elapsed = 0;
  const seq = getSchedulerLoop()?.seq;
  STEP_SEQ.currentValue = seq ? seq.steps[0] || 0 : 0;
  refreshSequencerUI();
  renderSongPlayhead();
}

// Ramp SONG_MORPH 0→1 across the final `entry.morph` cycles of the audible
// block, aimed at the loop the song lands on next. The scheduler cursor runs
// ahead of the audio: once it has already advanced, its entry IS the
// destination, so the target can't flip during the ramp's last moments.
function updateSongMorph(audible) {
  const prev = SONG_MORPH.t;
  SONG_MORPH.t = 0;
  SONG_MORPH.gens = null;
  SONG_MORPH.loop = null;
  const entry = SONG.entries[audible.entryIdx];
  const span = Math.max(0, Math.round(entry?.morph || 0));
  if (entry && span > 0 && GEN4.playing && PLAY.mode === 'song') {
    const nextIdx =
      SONG.cursor.entryIdx === audible.entryIdx
        ? songExpectedNextIdx()
        : SONG.cursor.entryIdx;
    const nextLoop = getLoopById(SONG.entries[nextIdx]?.loopId);
    const loop = getLoopById(entry.loopId);
    if (loop && nextLoop && nextLoop !== loop) {
      const stepCount = Math.max(1, loop.gen4?.stepCount || 16);
      const secPerStep = 60 / TRANSPORT.bpm / 4;
      const stepFrac = audioCtx
        ? clamp((audioCtx.currentTime - audible.time) / secPerStep, 0, 1)
        : 0;
      const totalCycles = Math.max(1, entry.repeats);
      const cycles = Math.min(span, totalCycles);
      const pos =
        Math.max(0, audible.repeat) + clamp((audible.step + stepFrac) / stepCount, 0, 1);
      const t = (pos - (totalCycles - cycles)) / cycles;
      if (t > 0) {
        SONG_MORPH.t = clamp(t, 0, 1);
        SONG_MORPH.gens = nextLoop.gens;
        SONG_MORPH.loop = nextLoop;
      }
    }
  }
  if (SONG_MORPH.t !== prev) {
    sendParams(0);
    sendParams(1);
    // Gen3 rides the same ramp: the effective params resolve through
    // getGen3SoundState, so this pushes the blended gain/pitch to the synth
    // nodes and any sustained voices.
    applyGen3Modulation();
  }
}

// Called every display frame during song playback with the schedule entry
// that is currently audible.
function updateSongPlayhead(audible) {
  updateSongMorph(audible);
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
    if (audibleLoop) {
      applyGen3Modulation();
      if (audibleLoop.gen3.sustainMode) {
        syncGen3SustainChord(audibleLoop.gen3.lockedMidis);
        if (GEN3.activeNotes.size > 0) restartAllGen3Notes();
      } else if (GEN3.activeNotes.size > 0) {
        stopAllGen3Notes();
      }
    }
  }
  updateSongOrbitProgress(audible);
  renderSongPlayhead(audible.repeat);
}

function renderSongPlayhead(repeat = -1) {
  const entryIdx = SONG.audibleEntryIdx;
  // The scheduler cursor runs ahead of audio. When it has already moved on,
  // its block is what plays next; while it still matches the audible block,
  // the destination is known anyway — jump and landing dice roll at entry.
  const cursorIdx = GEN4.playing && PLAY.mode === 'song' ? SONG.cursor.entryIdx : -1;
  const previewIdx =
    cursorIdx < 0 ? -1 : cursorIdx !== entryIdx ? cursorIdx : songExpectedNextIdx();
  if (
    songPlayheadRendered.entryIdx === entryIdx &&
    songPlayheadRendered.repeat === repeat &&
    songPlayheadRendered.cursorIdx === previewIdx
  )
    return;
  songPlayheadRendered = { entryIdx, repeat, cursorIdx: previewIdx };
  SONG.entries.forEach((entry, idx) => {
    const el = songBlockEls.get(entry.id);
    if (!el) return;
    const playing = idx === entryIdx;
    const upnext = idx === previewIdx && previewIdx !== entryIdx;
    el.classList.toggle('playing', playing);
    el.classList.toggle('upnext', upnext);
    const card = songCardEls.get(entry.id);
    if (card) {
      card.classList.toggle('playing', playing);
      card.classList.toggle('upnext', upnext);
    }
    const orbitNode = songOrbitEls?.byId.get(entry.id);
    if (orbitNode) {
      orbitNode.g.classList.toggle('playing', playing);
      orbitNode.g.classList.toggle('upnext', upnext);
    }
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
  // Arc states, on the strip's overlay and the expanded editor's alike:
  // taken = the jump that just fired; armed = the current block's jump has
  // been decided and will fire when the block ends.
  const armedFrom = SONG.cursor.jump ? SONG.entries[cursorIdx]?.id : null;
  document.querySelectorAll('.song-jump-arcs').forEach((arcs) => {
    arcs.querySelectorAll('path[data-from]').forEach((p) => {
      p.classList.toggle('taken', p.dataset.from === SONG.lastJump?.from);
      p.classList.toggle('armed', p.dataset.from === armedFrom);
    });
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
async function stopTransport() {
  stopGen4Sequencer();
  stopAllGen3Notes();
  if (audioCtx && audioCtx.state === 'running') await audioCtx.suspend();
  refreshSongTransportUI();
}

async function stripPlayToggle() {
  if (isTransportOn()) {
    if (LINK.active && !LINK.applyingRemote && LINK.grid.playing) {
      LINK.grid.playing = false;
      linkBroadcastGrid();
    }
    await stopTransport();
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

// ── Tooltip toggle ── native title tooltips can't be disabled via CSS.
// When off, every title is stashed into data-saved-title, and a mutation
// observer keeps stripping titles the app re-sets (step repaints, UI
// refreshes) or adds on newly built elements.
const TOOLTIPS_STORAGE_KEY = 'grnsh-tooltips-v1';
const TOOLTIPS = { enabled: localStorage.getItem(TOOLTIPS_STORAGE_KEY) !== 'off' };

// ── Bounce render mode ── master-only wav (default) or master + per-bus stems.
const BOUNCE_RENDER_STORAGE_KEY = 'grnsh-bounce-stems-v1';
const BOUNCE_RENDER = { stems: localStorage.getItem(BOUNCE_RENDER_STORAGE_KEY) === 'on' };

function setBounceRenderStems(on) {
  BOUNCE_RENDER.stems = on;
  localStorage.setItem(BOUNCE_RENDER_STORAGE_KEY, on ? 'on' : 'off');
}

// ── Bounce length cap ── 'auto' = 4× the written song length; otherwise a
// hard cut in seconds. Jump cycles can hold a bounce forever without one.
const BOUNCE_CAP_STORAGE_KEY = 'grnsh-bounce-cap-v1';
const BOUNCE_CAP = { value: localStorage.getItem(BOUNCE_CAP_STORAGE_KEY) || 'auto' };

function setBounceCap(value) {
  BOUNCE_CAP.value = value;
  localStorage.setItem(BOUNCE_CAP_STORAGE_KEY, value);
}

// ── Solo mode ── additive (default): solos stack. Exclusive: soloing an
// instrument clears every other solo so it sounds alone.
const SOLO_MODE_STORAGE_KEY = 'grnsh-solo-additive-v1';
const SOLO_MODE = { additive: localStorage.getItem(SOLO_MODE_STORAGE_KEY) !== 'off' };

function setSoloAdditive(on) {
  SOLO_MODE.additive = on;
  localStorage.setItem(SOLO_MODE_STORAGE_KEY, on ? 'on' : 'off');
}

// ── LAN Link ── Ableton-Link-style tempo/phase sync with one other machine on
// the same network. A WebRTC data channel carries clock pings and the shared
// grid (PeerJS's public broker does signaling only — audio never leaves the
// machine). The host's performance clock is the shared timeline; the joiner
// measures its offset NTP-style (min-RTT filtered) and both machines schedule
// every step at an absolute grid time, so correction is continuous and
// drift can never accumulate.
const LINK = {
  peer: null,
  conn: null,
  role: null, // 'host' | 'join'
  active: false, // data channel open
  room: '',
  offset: 0, // join only: host clock − local clock, seconds
  rtt: 0,
  samples: [], // recent {offset, rtt} pairs; best (lowest rtt) wins
  pingTimer: null,
  grid: { bpm: 120, origin: 0, playing: false }, // origin = shared time of absolute step 0
  stepAbs: 0, // next absolute grid step this machine will schedule
  applyingRemote: false, // guards echo loops on remote-driven transport/bpm
};

const LINK_QUANTUM = 16; // machines join the grid on 16-step (one bar) boundaries
const LINK_PEER_PREFIX = 'grnsh-link-';

function linkLocalNow() {
  return performance.now() / 1000;
}

function linkNow() {
  return linkLocalNow() + (LINK.role === 'join' ? LINK.offset : 0);
}

function linkClockReady() {
  return LINK.role === 'host' || LINK.samples.length >= 3;
}

function linkSynced() {
  return LINK.active && LINK.grid.playing && linkClockReady();
}

function linkSecPerStep() {
  return 60 / LINK.grid.bpm / 4;
}

// Map a shared-timeline instant to this machine's audio clock, compensating
// the local output latency so the *sound* lines up, not just the schedule.
function linkSharedToAudioTime(ts) {
  const out = audioCtx.outputLatency || audioCtx.baseLatency || 0;
  return audioCtx.currentTime + (ts - linkNow()) - out;
}

function linkStepAudioTime(stepAbs) {
  return linkSharedToAudioTime(LINK.grid.origin + stepAbs * linkSecPerStep());
}

// First grid step at/after "now + guard", rounded up to the join quantum so
// both machines share a downbeat.
function linkJoinStep(guardSec = 0.06) {
  const k = Math.ceil((linkNow() + guardSec - LINK.grid.origin) / linkSecPerStep());
  return Math.max(0, Math.ceil(k / LINK_QUANTUM) * LINK_QUANTUM);
}

function linkSend(msg) {
  if (LINK.conn?.open) LINK.conn.send(msg);
}

function linkSetStatus(text) {
  const el = document.getElementById('linkStatus');
  if (el) el.textContent = text;
  const btn = document.getElementById('linkConnectBtn');
  if (btn) btn.textContent = LINK.peer ? 'Unlink' : 'Link';
}

function linkStatusLine() {
  if (!LINK.active) return LINK.role === 'host' ? 'hosting — waiting' : 'connecting…';
  if (LINK.role === 'host') return 'linked · host';
  const halfMs = Math.max(1, Math.round((LINK.rtt * 1000) / 2));
  return `linked · ±${halfMs}ms`;
}

function linkBroadcastGrid() {
  linkSend({ t: 'grid', bpm: LINK.grid.bpm, origin: LINK.grid.origin, playing: LINK.grid.playing });
}

async function linkRemoteStart() {
  LINK.applyingRemote = true;
  try {
    await ensureTransportEngine();
    if (!started) await start();
    startGen4Sequencer();
    setStatus('playing (link)');
  } finally {
    LINK.applyingRemote = false;
  }
  refreshSongTransportUI();
}

async function linkRemoteStop() {
  LINK.applyingRemote = true;
  try {
    await stopTransport();
    setStatus('stopped (link)');
  } finally {
    LINK.applyingRemote = false;
  }
}

function linkOnMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'ping') {
    linkSend({ t: 'pong', t0: msg.t0, t1: linkLocalNow() });
  } else if (msg.t === 'pong') {
    const t2 = linkLocalNow();
    const rtt = t2 - msg.t0;
    LINK.samples.push({ offset: msg.t1 + rtt / 2 - t2, rtt });
    if (LINK.samples.length > 12) LINK.samples.shift();
    const best = LINK.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    LINK.offset = best.offset;
    LINK.rtt = best.rtt;
    linkSetStatus(linkStatusLine());
  } else if (msg.t === 'grid') {
    // A bounce is locally clocked. Remote phase/tempo changes must not move
    // its scheduler while audio is being captured.
    if (BOUNCE.active) return;
    const wasPlaying = LINK.grid.playing;
    LINK.grid = {
      bpm: clamp(Number(msg.bpm) || 120, BPM_BOUNDS.min, BPM_BOUNDS.max),
      origin: Number(msg.origin) || 0,
      playing: msg.playing === true,
    };
    if (TRANSPORT.bpm !== LINK.grid.bpm) {
      LINK.applyingRemote = true;
      setTransportBpm(LINK.grid.bpm);
      LINK.applyingRemote = false;
    }
    if (LINK.grid.playing && !GEN4.playing) {
      linkRemoteStart();
    } else if (!LINK.grid.playing && isTransportOn()) {
      linkRemoteStop();
    } else if (LINK.grid.playing && GEN4.playing && wasPlaying) {
      // Live tempo/origin change: keep our absolute step counter, remap its time.
      GEN4.nextStepTime = linkStepAudioTime(LINK.stepAbs);
    }
  }
}

function linkWireConn(conn) {
  LINK.conn = conn;
  conn.on('open', () => {
    LINK.active = true;
    linkSetStatus(linkStatusLine());
    setStatus(`link: connected as ${LINK.role}`);
    if (LINK.role === 'host') linkBroadcastGrid();
    if (LINK.role === 'join') {
      clearInterval(LINK.pingTimer);
      LINK.pingTimer = setInterval(() => linkSend({ t: 'ping', t0: linkLocalNow() }), 1000);
      linkSend({ t: 'ping', t0: linkLocalNow() });
    }
  });
  conn.on('data', linkOnMessage);
  conn.on('close', () => {
    if (LINK.conn !== conn) return;
    LINK.active = false;
    LINK.conn = null;
    clearInterval(LINK.pingTimer);
    LINK.pingTimer = null;
    linkSetStatus(LINK.role === 'host' ? 'hosting — waiting' : 'peer left');
  });
  conn.on('error', () => linkSetStatus('link error'));
}

let peerJsPromise = null;
function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  if (!peerJsPromise) {
    peerJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = resolve;
      s.onerror = () => {
        peerJsPromise = null;
        reject(new Error('peerjs load failed'));
      };
      document.head.appendChild(s);
    });
  }
  return peerJsPromise;
}

async function linkConnect(room) {
  linkDisconnect();
  LINK.room = room;
  linkSetStatus('loading…');
  try {
    await loadPeerJs();
  } catch {
    linkSetStatus('script load failed — offline?');
    return;
  }
  const hostId = LINK_PEER_PREFIX + room;
  linkSetStatus('connecting…');
  // Deterministic pairing: the first machine claims the room id and hosts;
  // the second finds the id taken and joins it.
  const peer = new Peer(hostId);
  LINK.peer = peer;
  LINK.role = 'host';
  linkSetStatus(linkStatusLine());
  peer.on('open', () => {
    if (LINK.peer !== peer) return;
    linkSetStatus('hosting — waiting');
    peer.on('connection', (conn) => {
      LINK.conn?.close();
      linkWireConn(conn);
    });
  });
  peer.on('error', (err) => {
    if (LINK.peer !== peer) return;
    if (err.type === 'unavailable-id') {
      peer.destroy();
      const joiner = new Peer();
      LINK.peer = joiner;
      LINK.role = 'join';
      LINK.samples = [];
      linkSetStatus('connecting…');
      joiner.on('open', () => {
        if (LINK.peer !== joiner) return;
        linkWireConn(joiner.connect(hostId, { serialization: 'json' }));
      });
      joiner.on('error', (e2) => {
        if (LINK.peer === joiner) linkSetStatus(`link error: ${e2.type || 'unknown'}`);
      });
    } else {
      linkSetStatus(`link error: ${err.type || 'unknown'}`);
    }
  });
}

function linkDisconnect() {
  clearInterval(LINK.pingTimer);
  LINK.pingTimer = null;
  LINK.conn?.close();
  LINK.peer?.destroy();
  LINK.peer = null;
  LINK.conn = null;
  LINK.role = null;
  LINK.active = false;
  LINK.samples = [];
  linkSetStatus('off');
}

function stripTooltipTitle(el) {
  const t = el.getAttribute?.('title');
  if (!t) return;
  el.dataset.savedTitle = t;
  el.removeAttribute('title');
}

new MutationObserver((mutations) => {
  if (TOOLTIPS.enabled) return;
  mutations.forEach((m) => {
    if (m.type === 'attributes') {
      stripTooltipTitle(m.target);
      return;
    }
    m.addedNodes.forEach((n) => {
      if (n.nodeType !== 1) return;
      stripTooltipTitle(n);
      n.querySelectorAll?.('[title]').forEach(stripTooltipTitle);
    });
  });
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['title'],
});

function setTooltipsEnabled(on) {
  TOOLTIPS.enabled = on;
  localStorage.setItem(TOOLTIPS_STORAGE_KEY, on ? 'on' : 'off');
  if (on) {
    document.querySelectorAll('[data-saved-title]').forEach((el) => {
      el.setAttribute('title', el.dataset.savedTitle);
      delete el.dataset.savedTitle;
    });
  } else {
    document.querySelectorAll('[title]').forEach(stripTooltipTitle);
  }
}

function initSettingsMenu() {
  const modal = getSettingsModal();
  const btn = document.getElementById('settingsMenuBtn');
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.value = document.documentElement.dataset.theme || 'original';
    themeSelect.addEventListener('change', () => setAppTheme(themeSelect.value));
  }
  const tooltipsEnable = document.getElementById('tooltipsEnable');
  if (tooltipsEnable) {
    tooltipsEnable.checked = TOOLTIPS.enabled;
    tooltipsEnable.addEventListener('change', () => setTooltipsEnabled(tooltipsEnable.checked));
  }
  const bounceModeSelect = document.getElementById('bounceModeSelect');
  if (bounceModeSelect) {
    bounceModeSelect.value = BOUNCE_RENDER.stems ? 'stems' : 'master';
    bounceModeSelect.addEventListener('change', () =>
      setBounceRenderStems(bounceModeSelect.value === 'stems'),
    );
  }
  const bounceCapSelect = document.getElementById('bounceCapSelect');
  if (bounceCapSelect) {
    bounceCapSelect.value = [...bounceCapSelect.options].some(
      (o) => o.value === BOUNCE_CAP.value,
    )
      ? BOUNCE_CAP.value
      : 'auto';
    bounceCapSelect.addEventListener('change', () => setBounceCap(bounceCapSelect.value));
  }
  const soloAdditiveEnable = document.getElementById('soloAdditiveEnable');
  if (soloAdditiveEnable) {
    soloAdditiveEnable.checked = SOLO_MODE.additive;
    soloAdditiveEnable.addEventListener('change', () =>
      setSoloAdditive(soloAdditiveEnable.checked),
    );
  }
  const linkBtn = document.getElementById('linkConnectBtn');
  const linkRoom = document.getElementById('linkRoomInput');
  linkBtn?.addEventListener('click', () => {
    if (LINK.peer) {
      linkDisconnect();
      return;
    }
    const room =
      (linkRoom?.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'jam';
    if (linkRoom) linkRoom.value = room;
    linkConnect(room);
  });
  linkRoom?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      linkBtn?.click();
    }
  });
  // A stored "off" must strip the titles the UI build just created.
  if (!TOOLTIPS.enabled) setTooltipsEnabled(false);
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

function createSongEntryData(loopId) {
  do {
    SONG.entryCounter += 1;
  } while (SONG.entries.some((entry) => entry.id === `entry-${SONG.entryCounter}`));
  return {
    id: `entry-${SONG.entryCounter}`,
    loopId,
    repeats: 1,
    prob: 1,
    cond: 0,
    variation: -1,
    fill: false,
    morph: 0, // cycles at the block's end spent morphing gens into the next block
    jump: null,
  };
}

function addSongEntry(loopId = getEditLoop()?.id) {
  insertSongEntry(loopId, null);
}

// Insert before the given entry (null → append). A drop from the loops bar
// lands mid-arrangement without disturbing playback position.
function insertSongEntry(loopId, beforeEntryId = null) {
  const loop = getLoopById(loopId);
  if (!loop) return;
  const entry = createSongEntryData(loopId);
  const idx = beforeEntryId ? SONG.entries.findIndex((e) => e.id === beforeEntryId) : -1;
  if (idx >= 0) {
    SONG.entries.splice(idx, 0, entry);
    if (GEN4.playing && PLAY.mode === 'song' && idx <= SONG.cursor.entryIdx) {
      SONG.cursor.entryIdx += 1;
    }
  } else {
    SONG.entries.push(entry);
  }
  renderSongLane();
}

function removeSongEntry(entryId) {
  const idx = SONG.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return;
  SONG.entries.splice(idx, 1);
  SONG.entries.forEach((e) => {
    if (e.jump?.targetId === entryId) e.jump = null;
  });
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

// Shared per-entry controls (context menu + expanded editor). refresh(structural)
// re-renders dependents; slider drags pass structural=false so an open expanded
// panel is not rebuilt under the pointer mid-drag.
function appendSongEntryControls(container, entry, refresh) {
  const sect = (text) => {
    const t = document.createElement('div');
    t.className = 'song-block-menu-title';
    t.textContent = text;
    return t;
  };

  // Percent slider with its label + live value on their own line, so narrow
  // containers never wrap the caption against the track.
  const sliderRow = (labelText, getPct, setPct) => {
    const wrap = document.createElement('div');
    wrap.className = 'song-block-menu-slider';
    const top = document.createElement('div');
    top.className = 'song-block-menu-slider-top';
    const lab = document.createElement('span');
    lab.textContent = labelText;
    const val = document.createElement('span');
    val.className = 'song-block-menu-slider-val';
    val.textContent = `${getPct()}%`;
    top.append(lab, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '5';
    input.max = '100';
    input.step = '5';
    input.value = String(getPct());
    input.addEventListener('input', () => {
      setPct(Number(input.value));
      val.textContent = `${getPct()}%`;
      refresh(false);
    });
    // Release commits a structural refresh so the orbit/card readouts catch
    // up — mid-drag they are deliberately left alone.
    input.addEventListener('change', () => refresh(true));
    wrap.append(top, input);
    container.appendChild(wrap);
    return input;
  };

  // Probability — chance this entry plays on a given pass (else it skips).
  sliderRow(
    'probability',
    () => Math.round((entry.prob ?? 1) * 100),
    (n) => {
      entry.prob = n / 100;
    },
  );

  // Play condition, counted per visit (1:2 = 1st of every 2 visits).
  container.appendChild(sect('condition'));
  const condRow = document.createElement('div');
  condRow.className = 'song-block-menu-presets';
  const condBtns = SONG_CONDITIONS.map((c, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'song-block-menu-preset' + ((entry.cond || 0) === idx ? ' active' : '');
    b.textContent = c.label;
    b.title = idx === 0 ? 'Always plays' : `Plays visit ${c.a} of every ${c.b}`;
    b.addEventListener('click', () => {
      entry.cond = idx;
      condBtns.forEach((x, i) => x.classList.toggle('active', i === idx));
      refresh(true);
    });
    condRow.appendChild(b);
    return b;
  });
  container.appendChild(condRow);

  // Which pattern variation this entry plays.
  container.appendChild(sect('variation'));
  const varRow = document.createElement('div');
  varRow.className = 'song-block-menu-presets';
  const varDefs = [
    { v: -1, label: '·', title: "Loop's own variation" },
    { v: 0, label: 'A', title: 'Variation A' },
    { v: 1, label: 'B', title: 'Variation B' },
    { v: 2, label: 'C', title: 'Variation C' },
    { v: 'rnd', label: '?', title: 'Random variation each visit' },
    { v: 'cycle', label: '↻', title: 'Cycle A→B→C across visits' },
  ];
  const varBtns = varDefs.map((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className =
      'song-block-menu-preset' + ((entry.variation ?? -1) === d.v ? ' active' : '');
    b.textContent = d.label;
    b.title = d.title;
    b.addEventListener('click', () => {
      entry.variation = d.v;
      varBtns.forEach((x, i) => x.classList.toggle('active', varDefs[i].v === d.v));
      refresh(true);
    });
    varRow.appendChild(b);
    return b;
  });
  container.appendChild(varRow);

  const fillBtn = document.createElement('button');
  fillBtn.type = 'button';
  fillBtn.className = 'song-block-menu-fill' + (entry.fill ? ' active' : '');
  fillBtn.textContent = 'fill on change';
  fillBtn.title =
    'Auto-generate a drum fill on the final cycle — plays only when the song moves to a different loop';
  fillBtn.addEventListener('click', () => {
    entry.fill = !entry.fill;
    fillBtn.classList.toggle('active', entry.fill);
    refresh(true);
  });
  container.appendChild(fillBtn);

  // Morph: spend the block's last N cycles blending gen 1/2 sound into the
  // next block's. Patterns and the chord still switch at the boundary.
  container.appendChild(sect('morph into next'));
  const morphRow = document.createElement('div');
  morphRow.className = 'song-block-menu-presets';
  const morphDefs = [0, 1, 2, 4, 8];
  const morphBtns = morphDefs.map((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'song-block-menu-preset' + ((entry.morph || 0) === n ? ' active' : '');
    b.textContent = n === 0 ? 'off' : `×${n}`;
    b.title =
      n === 0
        ? 'Switch sound at the block boundary (no morph)'
        : `Blend the granular sound into the next block across this block's last ${n} cycle${n > 1 ? 's' : ''}`;
    b.addEventListener('click', () => {
      entry.morph = n;
      morphBtns.forEach((x, i) => x.classList.toggle('active', morphDefs[i] === n));
      refresh(true);
    });
    morphRow.appendChild(b);
    return b;
  });
  container.appendChild(morphRow);

  // Jump: after this entry ends, go to another block (with odds and a cap)
  // instead of the next one.
  container.appendChild(sect('jump after'));
  const jumpRow = document.createElement('div');
  jumpRow.className = 'song-block-menu-custom';
  const jumpLabel = document.createElement('span');
  jumpLabel.textContent = 'to';
  const jumpSel = document.createElement('select');
  jumpSel.appendChild(new Option('off', ''));
  SONG.entries.forEach((e, i) => {
    jumpSel.appendChild(new Option(`${i + 1} · ${getLoopById(e.loopId)?.name ?? '?'}`, e.id));
  });
  jumpSel.value = entry.jump?.targetId ?? '';
  jumpRow.append(jumpLabel, jumpSel);
  container.appendChild(jumpRow);

  const jumpChanceInput = sliderRow(
    'chance',
    () => Math.round((entry.jump?.chance ?? 1) * 100),
    (n) => {
      if (entry.jump) entry.jump.chance = n / 100;
    },
  );

  const jumpCountRow = document.createElement('div');
  jumpCountRow.className = 'song-block-menu-presets';
  const jumpCountBtns = SONG_JUMP_COUNTS.map((n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className =
      'song-block-menu-preset' + ((entry.jump?.count ?? 0) === n ? ' active' : '');
    b.textContent = n === 0 ? '∞' : `×${n}`;
    b.title =
      n === 0
        ? 'Jump every time the odds land'
        : `Take this jump at most ${n} time${n > 1 ? 's' : ''} per playback`;
    b.addEventListener('click', () => {
      if (!entry.jump) return;
      entry.jump.count = n;
      jumpCountBtns.forEach((x, i) => x.classList.toggle('active', SONG_JUMP_COUNTS[i] === n));
      refresh(true);
    });
    jumpCountRow.appendChild(b);
    return b;
  });
  container.appendChild(jumpCountRow);

  const refreshJumpDisabled = () => {
    const off = !entry.jump;
    jumpChanceInput.disabled = off;
    jumpCountBtns.forEach((b) => (b.disabled = off));
  };
  jumpSel.addEventListener('change', () => {
    if (!jumpSel.value) entry.jump = null;
    else {
      entry.jump = {
        targetId: jumpSel.value,
        chance: entry.jump?.chance ?? 1,
        count: entry.jump?.count ?? 0,
      };
    }
    refreshJumpDisabled();
    refresh(true);
  });
  jumpSel.addEventListener('keydown', (e) => e.stopPropagation());
  refreshJumpDisabled();
}

// ── Song block context menu (cycles / remove) ──

let songBlockMenuEl = null;

function closeSongBlockMenu() {
  if (!songBlockMenuEl) return;
  songBlockMenuEl.remove();
  songBlockMenuEl = null;
}

function openLoopChipMenu(loopId, x, y) {
  closeSongBlockMenu();
  const loop = getLoopById(loopId);
  if (!loop) return;

  const menu = document.createElement('div');
  menu.className = 'song-block-menu loop-chip-menu';
  songBlockMenuEl = menu;

  const title = document.createElement('div');
  title.className = 'song-block-menu-title';
  title.textContent = `Loop · ${loop.name}`;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'song-block-menu-remove';
  deleteBtn.textContent = 'delete loop';
  deleteBtn.disabled = LOOPS.list.length <= 1;
  deleteBtn.title = deleteBtn.disabled ? 'The last loop cannot be deleted' : `Delete loop ${loop.name}`;
  deleteBtn.addEventListener('click', () => {
    const index = LOOPS.list.findIndex((item) => item.id === loopId);
    closeSongBlockMenu();
    if (index >= 0) deleteLoop(index);
  });

  menu.append(title, deleteBtn);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
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

  appendSongEntryControls(menu, entry, () => renderSongLane());

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

function commitSongOrder(order) {
  const playingEntryId = SONG.entries[SONG.cursor.entryIdx]?.id ?? null;
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

function commitSongOrderFromDom() {
  const wrap = document.querySelector('.song-blocks');
  if (!wrap) return;
  commitSongOrder([...wrap.querySelectorAll('.song-block')].map((el) => el.dataset.entryId));
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
    // Chips drag into the song lane, which inserts an entry at the drop spot.
    chip.draggable = true;
    chip.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'copy';
      try {
        e.dataTransfer.setData('text/plain', `loop:${loop.id}`);
      } catch (_) {}
    });

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'loop-chip-name';
    nameBtn.textContent = loop.name;
    nameBtn.title = 'Click to edit · double-click to rename · right-click for actions';
    nameBtn.addEventListener('click', () => selectEditLoop(idx));
    nameBtn.addEventListener('dblclick', () => startLoopRename(chip, loop));
    chip.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLoopChipMenu(loop.id, event.clientX, event.clientY);
    });

    chip.appendChild(nameBtn);
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

// ── Expanded song editor ──
// A full-width overlay with one card per block: every song parameter editable
// inline, labeled jump arcs, drag reorder, and cue-next. State lives in SONG;
// this is only a bigger lens on it — the strip stays the compact view.

let songExpandedEl = null;
// Light edits (slider drags) from inside the panel refresh the strip but must
// not rebuild the panel under the pointer.
let songExpandedSyncMuted = false;
const songCardEls = new Map(); // entry id → card element

let songOrbitEls = null; // { byId: Map(entry id → {g, angle}), progress, dot, R, cx, cy }
let songOrbitSelectedId = null;

// The song editor is a first-class panel view (#songPanel), sibling to
// mixer/master — not an overlay. songExpandedEl points at the panel while the
// view is active, null otherwise; everything downstream keys off that.
function enterSongView() {
  songExpandedEl = document.getElementById('songPanel');
  renderSongExpanded();
}

function leaveSongView() {
  if (!songExpandedEl) return;
  songExpandedEl.innerHTML = '';
  songExpandedEl = null;
  songCardEls.clear();
  songOrbitEls = null;
}

function closeSongExpanded() {
  if (UI_VIEW.mode === 'song') setPanelView('front');
}

function syncSongExpanded() {
  if (songExpandedEl && !songExpandedSyncMuted) renderSongExpanded();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && UI_VIEW.mode === 'song') setPanelView('front');
});

// Cue a block to take over at the next pattern boundary, skipping the dice
// once. Only meaningful while the song is running.
function songCueEntry(idx) {
  const entry = SONG.entries[idx];
  if (!entry) return;
  if (!(GEN4.playing && PLAY.mode === 'song')) {
    setStatus('cue works while the song plays');
    return;
  }
  songRuntime(entry.id).visits += 1;
  SONG.cursor.entryIdx = idx;
  SONG.cursor.repeat = -1; // the boundary advance lands on repeat 0
  songEnterEntry(entry);
  songPlayheadRendered = { entryIdx: -2, repeat: -2, cursorIdx: -2 };
  renderSongPlayhead();
  setStatus(`cued ${getLoopById(entry.loopId)?.name ?? '?'}`);
}

// Swap an entry with its neighbor — the orbit's angle-per-index layout makes
// this the whole reorder story.
function moveSongEntry(entryId, dir) {
  const order = SONG.entries.map((e) => e.id);
  const i = order.indexOf(entryId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  commitSongOrder(order);
}

// Loop picker for the rim's "+" node. Appends and selects, so the center
// card is immediately editable.
function openSongAddMenu(x, y) {
  closeSongBlockMenu();
  const menu = document.createElement('div');
  menu.className = 'song-block-menu';
  songBlockMenuEl = menu;
  const title = document.createElement('div');
  title.className = 'song-block-menu-title';
  title.textContent = 'add loop';
  menu.appendChild(title);
  const row = document.createElement('div');
  row.className = 'song-block-menu-presets';
  LOOPS.list.forEach((l) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'song-block-menu-preset';
    b.textContent = l.name;
    b.title = `Append loop ${l.name} to the song`;
    b.addEventListener('click', () => {
      closeSongBlockMenu();
      addSongEntry(l.id);
      songOrbitSelectedId = SONG.entries[SONG.entries.length - 1]?.id ?? null;
      syncSongExpanded();
    });
    row.appendChild(b);
  });
  menu.appendChild(row);
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

// ── Orbit view ──
// The song as the state machine it is: blocks on a circle, linear flow runs
// clockwise around the rim, jumps cut across as chords. Layout is fully
// deterministic (angle = index), so nothing about it needs saving.

const SONG_ORBIT_SIZE = 400; // viewBox units, square
const SONG_ORBIT_R = 142;

function songOrbitPos(angle, radius = SONG_ORBIT_R) {
  // Angle 0 at 12 o'clock, increasing clockwise (matches SVG sweep=1).
  return {
    x: SONG_ORBIT_SIZE / 2 + radius * Math.sin(angle),
    y: SONG_ORBIT_SIZE / 2 - radius * Math.cos(angle),
  };
}

// Drag a node around the rim to reorder. A plain click (under the 6px
// threshold) falls through to the node's own click-to-select.
function beginOrbitNodeDrag(e, entryId, g) {
  if (e.button !== 0) return;
  const svg = g.ownerSVGElement;
  const n = SONG.entries.length;
  if (!svg || n < 2) return;
  const step = (Math.PI * 2) / n;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  const toAngle = (ev) => {
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(
      svg.getScreenCTM().inverse(),
    );
    return Math.atan2(pt.x - SONG_ORBIT_SIZE / 2, SONG_ORBIT_SIZE / 2 - pt.y);
  };
  const move = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      dragging = true;
      g.classList.add('dragging');
      // Capture so the release lands on the node even off the circle, and the
      // ensuing click doesn't hit the svg background (which would deselect).
      try {
        g.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    const p = songOrbitPos(toAngle(ev));
    g.setAttribute('transform', `translate(${p.x} ${p.y})`);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!dragging) return;
    g.dataset.dragged = '1'; // swallow the click that follows the release
    const norm = ((toAngle(ev) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const target = Math.round(norm / step) % n;
    const order = SONG.entries.map((x) => x.id);
    const from = order.indexOf(entryId);
    if (from < 0) return;
    order.splice(from, 1);
    order.splice(target, 0, entryId);
    // Re-renders the orbit either way, snapping the node onto its slot.
    commitSongOrder(order);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function renderSongOrbit(container) {
  const ns = 'http://www.w3.org/2000/svg';
  const stage = document.createElement('div');
  stage.className = 'song-orbit-stage';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SONG_ORBIT_SIZE} ${SONG_ORBIT_SIZE}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  stage.appendChild(svg);

  const n = SONG.entries.length;
  const step = (Math.PI * 2) / Math.max(1, n);
  const byId = new Map();

  const rim = document.createElementNS(ns, 'circle');
  rim.setAttribute('class', 'song-orbit-rim');
  rim.setAttribute('cx', String(SONG_ORBIT_SIZE / 2));
  rim.setAttribute('cy', String(SONG_ORBIT_SIZE / 2));
  rim.setAttribute('r', String(SONG_ORBIT_R));
  svg.appendChild(rim);

  // Direction ticks: one arrowhead mid-segment between consecutive blocks.
  // The wrap-around segment only exists while the song cycles.
  for (let i = 0; i < n; i++) {
    if (i === n - 1 && !SONG.loop) break;
    const mid = i * step + step / 2;
    const p = songOrbitPos(mid);
    const tip = songOrbitPos(mid + 0.035);
    const back1 = songOrbitPos(mid - 0.02, SONG_ORBIT_R + 5);
    const back2 = songOrbitPos(mid - 0.02, SONG_ORBIT_R - 5);
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('class', 'song-orbit-flow');
    arrow.setAttribute(
      'd',
      `M ${tip.x} ${tip.y} L ${back1.x} ${back1.y} L ${back2.x} ${back2.y} Z`,
    );
    svg.appendChild(arrow);
    if (n === 1) break;
  }

  // Jump chords, grouped under .song-jump-arcs so the shared armed/taken
  // playhead pass picks them up like every other arc layer.
  const chords = document.createElementNS(ns, 'g');
  chords.setAttribute('class', 'song-jump-arcs song-orbit-chords');
  SONG.entries.forEach((e, i) => {
    if (!e.jump?.targetId) return;
    const tIdx = SONG.entries.findIndex((x) => x.id === e.jump.targetId);
    if (tIdx < 0) return;
    const p1 = songOrbitPos(i * step, SONG_ORBIT_R - 18);
    const p2 = songOrbitPos(tIdx * step, SONG_ORBIT_R - 18);
    const cx = SONG_ORBIT_SIZE / 2;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    // Control point pulled toward the center — chords bow inward.
    const qx = cx + (mx - cx) * 0.35;
    const qy = cx + (my - cx) * 0.35;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${p1.x} ${p1.y} Q ${qx} ${qy} ${p2.x} ${p2.y}`);
    path.dataset.from = e.id;
    if (SONG.lastJump?.from === e.id) path.classList.add('taken');
    if ((e.jump.chance ?? 1) < 1) path.classList.add('dashed');
    chords.appendChild(path);
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(p2.x));
    dot.setAttribute('cy', String(p2.y));
    dot.setAttribute('r', '2.5');
    chords.appendChild(dot);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'song-arc-label');
    label.setAttribute('x', String((qx + mx) / 2));
    label.setAttribute('y', String((qy + my) / 2));
    label.setAttribute('text-anchor', 'middle');
    const cap = e.jump.count || 0;
    label.textContent = `${Math.round((e.jump.chance ?? 1) * 100)}%${cap ? ` ×${cap}` : ''}`;
    chords.appendChild(label);
  });
  svg.appendChild(chords);

  // Block-progress sweep + playhead dot, moved per display frame.
  const progress = document.createElementNS(ns, 'path');
  progress.setAttribute('class', 'song-orbit-progress');
  svg.appendChild(progress);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('class', 'song-orbit-dot');
  dot.setAttribute('r', '4');
  dot.setAttribute('opacity', '0');
  svg.appendChild(dot);

  SONG.entries.forEach((entry, i) => {
    const loop = getLoopById(entry.loopId);
    const angle = i * step;
    const p = songOrbitPos(angle);
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'song-orbit-node');
    if (entry.id === songOrbitSelectedId) g.classList.add('selected');
    g.setAttribute('transform', `translate(${p.x} ${p.y})`);
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('r', '15');
    g.appendChild(c);
    const name = document.createElementNS(ns, 'text');
    name.setAttribute('class', 'song-orbit-name');
    name.setAttribute('text-anchor', 'middle');
    name.setAttribute('dy', '3.5');
    name.textContent = loop?.name ?? '?';
    g.appendChild(name);
    const idxT = document.createElementNS(ns, 'text');
    idxT.setAttribute('class', 'song-orbit-idx');
    idxT.setAttribute('text-anchor', 'middle');
    idxT.setAttribute('dy', '-20');
    idxT.textContent = String(i + 1);
    g.appendChild(idxT);
    // Room to breathe here — options spell themselves out instead of the
    // strip's compressed chip codes.
    const opts = [];
    if (entry.repeats > 1) opts.push(`${entry.repeats} cycles`);
    if ((entry.prob ?? 1) < 1) opts.push(`prob ${Math.round(entry.prob * 100)}%`);
    if (entry.cond) {
      const c = SONG_CONDITIONS[entry.cond];
      if (c?.b) opts.push(`plays ${c.a} of ${c.b}`);
    }
    if (entry.variation === 'rnd') opts.push('var random');
    else if (entry.variation === 'cycle') opts.push('var cycle');
    else if (Number.isInteger(entry.variation) && entry.variation >= 0)
      opts.push(`var ${'ABC'[entry.variation]}`);
    if (entry.fill) opts.push('fill on change');
    if (entry.morph > 0) opts.push(`morph ×${entry.morph}`);
    opts.forEach((line, li) => {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('class', 'song-orbit-opt');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dy', String(30 + li * 11));
      t.textContent = line;
      g.appendChild(t);
    });
    g.addEventListener('pointerdown', (e) => beginOrbitNodeDrag(e, entry.id, g));
    g.addEventListener('click', () => {
      if (g.dataset.dragged) {
        delete g.dataset.dragged;
        return;
      }
      songOrbitSelectedId = entry.id;
      svg.querySelectorAll('.song-orbit-node').forEach((el) => el.classList.remove('selected'));
      g.classList.add('selected');
      renderSongOrbitDetail();
    });
    // Double-click: leave the song view and edit this block's loop (cueing
    // stays on the center card's ⇥ button). A fixed variation on the entry
    // opens the grid on that variation — the pattern that actually sounds.
    g.addEventListener('dblclick', () => {
      const li = LOOPS.list.findIndex((l) => l.id === entry.loopId);
      if (li < 0) return;
      selectEditLoop(li);
      if (Number.isInteger(entry.variation) && entry.variation >= 0) {
        setGen4Variation(entry.variation);
      }
      setPanelView('front');
    });
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openSongBlockMenu(entry.id, e.clientX, e.clientY);
    });
    svg.appendChild(g);
    byId.set(entry.id, { g, angle });
  });

  // Ghost "+" node on the rim, in the gap where the song wraps around —
  // adding a loop happens on the circle itself, not in a toolbar.
  const addPos = songOrbitPos(n ? (n - 0.5) * step : 0);
  const addG = document.createElementNS(ns, 'g');
  addG.setAttribute('class', 'song-orbit-add');
  addG.setAttribute('transform', `translate(${addPos.x} ${addPos.y})`);
  const addC = document.createElementNS(ns, 'circle');
  addC.setAttribute('r', '11');
  addG.appendChild(addC);
  const addT = document.createElementNS(ns, 'text');
  addT.setAttribute('text-anchor', 'middle');
  addT.setAttribute('dy', '3.5');
  addT.textContent = '+';
  addG.appendChild(addT);
  addG.addEventListener('click', (e) => openSongAddMenu(e.clientX, e.clientY));
  svg.appendChild(addG);

  // Clicking empty canvas drops the selection back to the song-level hint.
  svg.addEventListener('click', (e) => {
    if (e.target !== svg && e.target !== rim) return;
    songOrbitSelectedId = null;
    svg.querySelectorAll('.song-orbit-node').forEach((el) => el.classList.remove('selected'));
    renderSongOrbitDetail();
  });

  songOrbitEls = { byId, progress, dot };
  const center = document.createElement('div');
  center.className = 'song-orbit-center';
  stage.appendChild(center);
  container.appendChild(stage);
}

// Detail: the selected block's controls live in the circle's center — the
// orbit is the whole editor, nothing docks beside it.
function renderSongOrbitDetail() {
  const pane = songExpandedEl?.querySelector('.song-orbit-center');
  if (!pane) return;
  pane.innerHTML = '';
  const idx = SONG.entries.findIndex((e) => e.id === songOrbitSelectedId);
  if (idx < 0) {
    pane.classList.add('idle');
    const hint = document.createElement('span');
    hint.className = 'song-empty-hint';
    hint.textContent = SONG.entries.length
      ? 'click a block to edit · drag to reorder · double-click opens its loop'
      : 'empty — press + on the circle to add loops';
    pane.appendChild(hint);
    return;
  }
  pane.classList.remove('idle');
  pane.appendChild(buildSongCard(SONG.entries[idx], idx));
}

// Per display frame: sweep the rim between the playing block and its rim
// successor by block progress, and park the dot at the sweep's tip. One path
// + one transform — no layout work.
function updateSongOrbitProgress(audible) {
  if (!songOrbitEls || !songExpandedEl) return;
  const { progress, dot, byId } = songOrbitEls;
  const entry = SONG.entries[audible.entryIdx];
  const node = entry && byId.get(entry.id);
  if (!node) {
    progress.setAttribute('d', '');
    dot.setAttribute('opacity', '0');
    return;
  }
  const loop = getLoopById(entry.loopId);
  const stepCount = Math.max(1, loop?.gen4?.stepCount || 16);
  // Continuous motion: interpolate inside the current step from the audio
  // clock (the schedule entry carries its exact scheduled time) — stepping by
  // whole 16ths reads as lag.
  const secPerStep = 60 / TRANSPORT.bpm / 4;
  const stepFrac = audioCtx
    ? clamp((audioCtx.currentTime - audible.time) / secPerStep, 0, 1)
    : 0;
  const cycleFrac = clamp((audible.step + stepFrac) / stepCount, 0, 1);
  const frac = clamp(
    (Math.max(0, audible.repeat) + cycleFrac) / Math.max(1, entry.repeats),
    0,
    0.999,
  );
  const span = (Math.PI * 2) / Math.max(1, SONG.entries.length);
  const a0 = node.angle;
  const a = a0 + span * frac;
  const p0 = songOrbitPos(a0);
  const p = songOrbitPos(a);
  const large = a - a0 > Math.PI ? 1 : 0;
  progress.setAttribute(
    'd',
    `M ${p0.x} ${p0.y} A ${SONG_ORBIT_R} ${SONG_ORBIT_R} 0 ${large} 1 ${p.x} ${p.y}`,
  );
  dot.setAttribute('cx', String(p.x));
  dot.setAttribute('cy', String(p.y));
  dot.setAttribute('opacity', '1');
}

function buildSongCard(entry, idx) {
  const loop = getLoopById(entry.loopId);
  const card = document.createElement('div');
  card.className = 'song-card';
  card.dataset.entryId = entry.id;

  const head = document.createElement('div');
  head.className = 'song-card-head';
  const pos = document.createElement('span');
  pos.className = 'song-card-pos';
  pos.textContent = String(idx + 1);
  const name = document.createElement('span');
  name.className = 'song-card-name';
  name.textContent = loop?.name ?? '?';
  const repeats = document.createElement('button');
  repeats.type = 'button';
  repeats.className = 'song-card-repeats';
  repeats.textContent = `×${entry.repeats}`;
  repeats.title = 'Repeats — click to cycle, ⌥ scroll ±1';
  repeats.addEventListener('click', () => {
    const p = SONG_REPEAT_CYCLE.indexOf(entry.repeats);
    setSongEntryRepeats(
      entry.id,
      p >= 0 ? SONG_REPEAT_CYCLE[(p + 1) % SONG_REPEAT_CYCLE.length] : SONG_REPEAT_CYCLE[0],
    );
  });
  repeats.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    setSongEntryRepeats(entry.id, entry.repeats - Math.sign(e.deltaY));
  });
  const moveL = document.createElement('button');
  moveL.type = 'button';
  moveL.className = 'song-card-move';
  moveL.textContent = '◂';
  moveL.title = 'Move earlier in the song';
  moveL.disabled = idx === 0;
  moveL.addEventListener('click', () => moveSongEntry(entry.id, -1));
  const moveR = document.createElement('button');
  moveR.type = 'button';
  moveR.className = 'song-card-move';
  moveR.textContent = '▸';
  moveR.title = 'Move later in the song';
  moveR.disabled = idx === SONG.entries.length - 1;
  moveR.addEventListener('click', () => moveSongEntry(entry.id, 1));
  const cueBtn = document.createElement('button');
  cueBtn.type = 'button';
  cueBtn.className = 'song-card-cue';
  cueBtn.textContent = '⇥';
  cueBtn.title = 'Cue — play this block next (while the song runs)';
  cueBtn.addEventListener('click', () => songCueEntry(idx));
  const rmBtn = document.createElement('button');
  rmBtn.type = 'button';
  rmBtn.className = 'song-card-remove';
  rmBtn.textContent = '✕';
  rmBtn.title = 'Remove from song';
  rmBtn.addEventListener('click', () => removeSongEntry(entry.id));
  head.append(pos, name, moveL, moveR, repeats, cueBtn, rmBtn);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'song-card-body';
  appendSongEntryControls(body, entry, (structural) => {
    songExpandedSyncMuted = !structural;
    renderSongLane();
    songExpandedSyncMuted = false;
  });
  card.appendChild(body);

  songCardEls.set(entry.id, card);
  return card;
}

function renderSongExpanded() {
  const panel = songExpandedEl;
  if (!panel) return;
  panel.innerHTML = '';
  songCardEls.clear();

  const header = document.createElement('div');
  header.className = 'song-expanded-header';
  const title = document.createElement('span');
  title.className = 'song-expanded-title';
  title.textContent = 'SONG';
  header.appendChild(title);
  const spacer = document.createElement('div');
  spacer.className = 'song-expanded-spacer';
  if (SONG.entries.length) {
    const est = getSongLengthEstimate();
    const lengthEl = document.createElement('span');
    lengthEl.className = 'song-expanded-length';
    lengthEl.textContent = `≈ ${formatSongClock(est.expected)} · ${formatSongClock(est.written)} written${est.openEnded ? ' · jumps may extend' : ''}`;
    lengthEl.title =
      'Approximate bounce length at the current tempo: ≈ weighs each block by its probability and play condition; "written" is every block played in full. Jumps can run past both — the bounce cap (⚙ settings) cuts a runaway render.';
    spacer.appendChild(lengthEl);
  }
  header.appendChild(spacer);
  // The strip (with its own ⟳/follow) is hidden while this view is up — the
  // song options live here too, same state underneath.
  const optRow = document.createElement('div');
  optRow.className = 'song-expanded-views';
  const cycleBtn = document.createElement('button');
  cycleBtn.type = 'button';
  cycleBtn.className = 'song-opt-btn' + (SONG.loop ? ' active' : '');
  cycleBtn.textContent = '⟳';
  cycleBtn.title = 'Cycle the song when it reaches the end';
  cycleBtn.addEventListener('click', () => {
    SONG.loop = !SONG.loop;
    renderSongLane();
  });
  const followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.className = 'song-opt-btn' + (SONG.follow ? ' active' : '');
  followBtn.textContent = 'follow';
  followBtn.title = 'While the song plays, show the loop that is sounding';
  followBtn.addEventListener('click', () => {
    SONG.follow = !SONG.follow;
    renderSongLane();
  });
  optRow.append(cycleBtn, followBtn);
  header.appendChild(optRow);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'song-expanded-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Esc)';
  closeBtn.addEventListener('click', closeSongExpanded);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  songOrbitEls = null;
  const orbitWrap = document.createElement('div');
  orbitWrap.className = 'song-orbit';
  renderSongOrbit(orbitWrap);
  panel.appendChild(orbitWrap);
  // Only now can the detail find .song-orbit-center through songExpandedEl.
  renderSongOrbitDetail();

  songPlayheadRendered = { entryIdx: -2, repeat: -2, cursorIdx: -2 };
  renderSongPlayhead();
}

// Jump arcs — one SVG overlay inside the blocks strip, redrawn only when the
// lane re-renders (never per frame). Coordinates are offsets inside the
// scrolled content, so panning the strip keeps arcs glued to their blocks.
function drawSongJumpArcs(wrap) {
  if (!wrap || !wrap.isConnected) return;
  wrap.querySelector('.song-jump-arcs')?.remove();
  const jumps = SONG.entries.filter(
    (e) => e.jump?.targetId && songBlockEls.get(e.jump.targetId) && songBlockEls.get(e.id),
  );
  if (!jumps.length) return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'song-jump-arcs');
  const w = wrap.scrollWidth;
  const h = wrap.clientHeight || 30;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  jumps.forEach((e) => {
    const fromEl = songBlockEls.get(e.id);
    const toEl = songBlockEls.get(e.jump.targetId);
    const x1 = fromEl.offsetLeft + fromEl.offsetWidth - 5;
    const x2 = toEl.offsetLeft + 5;
    const y = h - 2;
    const lift = clamp(Math.abs(x2 - x1) * 0.18, h * 0.4, h - 3);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${x1} ${y} Q ${(x1 + x2) / 2} ${y - lift} ${x2} ${y}`);
    path.dataset.from = e.id;
    if (SONG.lastJump?.from === e.id) path.classList.add('taken');
    if ((e.jump.chance ?? 1) < 1) path.classList.add('dashed');
    svg.appendChild(path);
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(x2));
    dot.setAttribute('cy', String(y));
    dot.setAttribute('r', '2');
    svg.appendChild(dot);
  });
  wrap.appendChild(svg);
}

function renderSongLane() {
  const lane = document.getElementById('songLane');
  if (!lane) return;
  songBlockEls.clear();
  songPlayheadRendered = { entryIdx: -2, repeat: -2, cursorIdx: -2 };
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

    const mods = document.createElement('span');
    mods.className = 'song-block-mods';
    const chips = [];
    if ((entry.prob ?? 1) < 1) chips.push(`${Math.round((entry.prob ?? 1) * 100)}%`);
    if (entry.cond) chips.push(SONG_CONDITIONS[entry.cond]?.label ?? '');
    if (entry.variation === 'rnd') chips.push('V?');
    else if (entry.variation === 'cycle') chips.push('V↻');
    else if (Number.isInteger(entry.variation) && entry.variation >= 0)
      chips.push(`V${'ABC'[entry.variation]}`);
    if (entry.fill) chips.push('FIL');
    mods.textContent = chips.join(' ');
    mods.hidden = chips.length === 0;

    block.append(name, mods, badge);
    songBlockEls.set(entry.id, block);
    blocksWrap.appendChild(block);
  });

  blocksWrap.addEventListener('dragover', (e) => {
    const dragging = blocksWrap.querySelector('.song-block.dragging');
    if (dragging) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const after = getSongDragAfterElement(blocksWrap, e.clientX);
      if (after == null) blocksWrap.appendChild(dragging);
      else if (after !== dragging) blocksWrap.insertBefore(dragging, after);
      return;
    }
    // No block mid-drag → a loop chip is incoming (dragover can't read the
    // payload, so any external text drag is accepted; drop validates).
    if (e.dataTransfer?.types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  blocksWrap.addEventListener('drop', (e) => {
    const data = e.dataTransfer?.getData('text/plain') || '';
    if (!data.startsWith('loop:')) return;
    e.preventDefault();
    const after = getSongDragAfterElement(blocksWrap, e.clientX);
    insertSongEntry(data.slice(5), after?.dataset.entryId || null);
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

  // Arcs need laid-out block offsets — draw once layout settles.
  requestAnimationFrame(() => drawSongJumpArcs(blocksWrap));
  syncSongExpanded();
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
  if (TRIG_SC.envelope > 0) {
    TRIG_SC.envelope = Math.max(0, TRIG_SC.envelope - dt / Math.max(0.005, TRIG_SC.release));
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
  if (STEP_SEQ.sharedAcrossLoops) {
    LOOPS.list.forEach((loop) => (loop.seq.subdivision = STEP_SEQ.subdivision));
  } else if (editLoop) {
    editLoop.seq.subdivision = STEP_SEQ.subdivision;
  }
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
  if (STEP_SEQ.sharedAcrossLoops) {
    LOOPS.list.forEach((loop) => (loop.seq.stepBeats = STEP_SEQ.stepBeats));
  } else if (editLoop) {
    editLoop.seq.stepBeats = STEP_SEQ.stepBeats;
  }
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
  } else if (mapping.sourceIdx === 3) {
    mapping.sourceIdx = 4;
    nextSourceIdx = 4;
  } else {
    lfoMappings.delete(mapKey);
    nextSourceIdx = null;
  }
  if (genIdx === 2) applyGen3Modulation();
  else if (genIdx === 3) applyFxModulation();
  else if (genIdx === 4) applyGen4Modulation();
  else if (genIdx === 5) applyInstrumentMixState();
  else sendParams(genIdx);
  rebuildBackWireSVG();
  refreshBackPanelState();
  refreshMixerMappingUI();
  return nextSourceIdx;
}

function setLFOMapSource(genIdx, key, sourceIdx) {
  const mapKey = `${genIdx}:${key}`;
  if (sourceIdx === null) lfoMappings.delete(mapKey);
  else lfoMappings.set(mapKey, { genIdx, key, sourceIdx });
  if (genIdx === 2) applyGen3Modulation();
  else if (genIdx === 3) applyFxModulation();
  else if (genIdx === 4) applyGen4Modulation();
  else if (genIdx === 5) applyInstrumentMixState();
  else sendParams(genIdx);
  rebuildBackWireSVG();
  refreshBackPanelState();
  refreshModulationVisuals();
  refreshMixerMappingUI();
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
  if (genIdx === 2) {
    const editLoop = getEditLoop();
    let copied = 0;
    LOOPS.list.forEach((loop) => {
      if (loop === editLoop || !loop.gen3 || !GEN3_LOOP_PARAM_KEYS.includes(key)) return;
      // SUS/ARP are one mode group — copy both flags so the target lands in
      // exactly the state on screen, never a half-copied combination.
      if (key === 'arpEnabled' || key === 'sustainMode') {
        loop.gen3.sustainMode = GEN3.sustainMode;
        loop.gen3.arpEnabled = GEN3.arpEnabled;
      } else {
        loop.gen3[key] = GEN3[key];
      }
      copied += 1;
    });
    // A copy can flip the mode of the loop that is sounding right now —
    // apply the same cleanup a block boundary would.
    if (PLAY.mode === 'song' && GEN4.playing && (key === 'arpEnabled' || key === 'sustainMode')) {
      const sound = getGen3SoundState();
      if (sound.sustainMode) {
        syncGen3SustainChord(getAudibleLoop()?.gen3?.lockedMidis || GEN3.lockedMidis);
      } else if (GEN3.activeNotes.size > 0) {
        stopAllGen3Notes();
      }
    }
    setStatus(
      copied > 0
        ? `copied to ${copied} other loop${copied === 1 ? '' : 's'}`
        : 'no other loops',
    );
    return;
  }

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
    { idx: 4, label: 'Trig SC', ledClass: 'lfo-trig' },
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
    dot.textContent =
      opt.idx === null
        ? ''
        : opt.idx === 2
          ? 'S'
          : opt.idx === 3
            ? 'K'
            : opt.idx === 4
              ? 'T'
              : `${opt.idx + 1}`;

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

function refreshGrainArpGridUI() {
  const control = fxControlBindings.get('grainarp:grid');
  if (!control) return;
  const isSync = !!FX.grainarp.gridSync;
  control.setConfig(
    isSync
      ? { ...GRAINARP_GRID_SYNC_CONTROL, resetValue: FX.grainarp.gridSyncIndex }
      : { ...GRAINARP_GRID_FREE_CONTROL, resetValue: FX.grainarp.grid },
  );
  control.setFormatter(isSync ? (v) => getGrainSyncStep(Math.round(v)).label : null);
  control.setValue(isSync ? FX.grainarp.gridSyncIndex : FX.grainarp.grid);
  grainArpGridSyncModeControl?.setMode(isSync ? 'sync' : 'free');
}

function refreshGrainArpPatternUI() {
  grainArpPatternButtons.forEach((btn, mode) =>
    btn.classList.toggle('active', FX.grainarp.pattern === mode),
  );
}

function refreshGrainArpHoldUI() {
  grainArpHoldButton?.classList.toggle('active', !!FX.grainarp.hold);
}

function refreshResonatorFreqUI() {
  const control = fxControlBindings.get('resonator:freq');
  if (!control) return;
  const isNote = !!FX.resonator.noteMode;
  control.setConfig(
    isNote
      ? { ...RESONATOR_FREQ_NOTE_CONTROL, resetValue: FX.resonator.note }
      : { ...RESONATOR_FREQ_FREE_CONTROL, resetValue: FX.resonator.freq },
  );
  control.setFormatter(
    isNote
      ? (v) =>
          `${formatResonatorNote(v)} • ${formatNumericValue(midiToFreqHz(Math.round(v)), 0)}Hz`
      : null,
  );
  control.setValue(isNote ? FX.resonator.note : FX.resonator.freq);
  resonatorNoteModeControl?.setMode(isNote ? 'note' : 'free');
  refreshResonatorIntervalUI();
}

// The chord-voice readouts resolve against the current root: note names in
// note mode, absolute Hz in free mode. Re-set the formatter to re-render
// whenever the root or the mode moves.
function formatResonatorInterval(v) {
  const st = Math.round(v);
  const sign = st >= 0 ? '+' : '';
  if (FX.resonator.noteMode) return `${sign}${st} • ${formatResonatorNote(FX.resonator.note + st)}`;
  return `${sign}${st} • ${formatNumericValue(getResonatorFreqHz() * Math.pow(2, st / 12), 0)}Hz`;
}

function refreshResonatorIntervalUI() {
  ['int2', 'int3'].forEach((key) =>
    fxControlBindings.get(`resonator:${key}`)?.setFormatter(formatResonatorInterval),
  );
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
  if (LINK.active && !LINK.applyingRemote && LINK.grid.bpm !== TRANSPORT.bpm) {
    if (LINK.grid.playing) {
      // Re-anchor the shared grid so the current phase carries into the new
      // tempo; the peer remaps its own next step from the same numbers.
      const stepFloat = (linkNow() - LINK.grid.origin) / linkSecPerStep();
      LINK.grid.bpm = TRANSPORT.bpm;
      LINK.grid.origin = linkNow() - stepFloat * linkSecPerStep();
      if (GEN4.playing) GEN4.nextStepTime = linkStepAudioTime(LINK.stepAbs);
    } else {
      LINK.grid.bpm = TRANSPORT.bpm;
    }
    linkBroadcastGrid();
  }
  if (!refresh) return;
  // Every bus has its own sync-locked delay/beat-repeat times — retune them all.
  FX_BUS_IDS.forEach((busId) => {
    const st = fxStates[busId];
    if (st.delay.sync) applyFx('delay', 'time', getBaseFxValue('delay', 'time', busId), busId);
    if (st.beatrepeat.sync)
      applyFx('beatrepeat', 'interval', getBaseFxValue('beatrepeat', 'interval', busId), busId);
    if (st.beatrepeat.gridSync)
      applyFx('beatrepeat', 'grid', getBaseFxValue('beatrepeat', 'grid', busId), busId);
    if (st.grainarp.gridSync)
      applyFx('grainarp', 'grid', getBaseFxValue('grainarp', 'grid', busId), busId);
  });
  refreshDelayTimeUI();
  refreshBeatRepeatIntervalUI();
  refreshBeatRepeatGridUI();
  refreshGrainArpGridUI();
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
  if (group === '5' && b === 'pan' && FX_BUS_IDS.includes(a)) {
    return formatMixerPan(getEffectiveMixerPan(a));
  }
  return 'n/a';
}

function parseBackRouteKey(routeKey) {
  const [group, a, b] = routeKey.split(':');
  const genIdx = Number(group);
  if (!Number.isFinite(genIdx)) return null;
  if (genIdx === 3 || genIdx === 4 || genIdx === 5) {
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
  else if (genIdx === 5) applyInstrumentMixState();
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

  // Trig SC source module (sourceIdx = 4) — like Kick SC, but any drum lane
  // can drive the envelope and INV flips it into a boost-on-hit gate.
  (() => {
    const module = document.createElement('div');
    module.className = 'back-module back-source-module back-sc-module';
    const titleEl = document.createElement('div');
    titleEl.className = 'back-module-title';
    titleEl.textContent = 'Trig SC';
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
    fill.className = 'back-source-fill src-4';
    meter.appendChild(fill);

    const srcRow = document.createElement('div');
    srcRow.className = 'back-sc-src-row';
    // Uniform 3-char labels — the full lane names don't fit seven abreast.
    const TRIG_SRC_LABELS = { kick: 'KCK', snare: 'SNR', hat: 'HAT', perc: 'PRC' };
    trigScSourceBtns.clear();
    GEN4_DEFS.forEach((def) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'back-sc-src-btn';
      btn.textContent = TRIG_SRC_LABELS[def.id] || def.label;
      btn.title = `Trigger the envelope from the ${def.label} lane`;
      btn.addEventListener('click', () => {
        TRIG_SC.source = def.id;
        refreshTrigScUI();
        refreshBackPanelState();
      });
      trigScSourceBtns.set(def.id, btn);
      srcRow.appendChild(btn);
    });

    const invRow = document.createElement('div');
    invRow.className = 'back-sc-src-row';
    trigScInvBtn = document.createElement('button');
    trigScInvBtn.type = 'button';
    trigScInvBtn.className = 'back-sc-src-btn back-sc-inv-btn';
    trigScInvBtn.textContent = 'INV';
    trigScInvBtn.title = 'Invert — each hit pushes the mapped param up instead of ducking it';
    trigScInvBtn.addEventListener('click', () => {
      TRIG_SC.invert = !TRIG_SC.invert;
      refreshTrigScUI();
      refreshBackPanelState();
    });
    invRow.appendChild(trigScInvBtn);

    const buildTrigCtrl = (label, min, max, step, initial, unit, onChange) => {
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
      slider.dataset.trigScParam = label;
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

    const [amtRow, amtSliderRow] = buildTrigCtrl('amount', 0, 1, 0.01, TRIG_SC.amount, '', (v) => {
      TRIG_SC.amount = v;
    });
    const [relRow, relSliderRow] = buildTrigCtrl(
      'release',
      0.01,
      1,
      0.01,
      TRIG_SC.release,
      's',
      (v) => {
        TRIG_SC.release = v;
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
      setBackPatchSelection(4);
    });
    jackRow.append(jackLabel, jack);

    body.append(
      readout,
      meter,
      srcRow,
      invRow,
      amtRow,
      amtSliderRow,
      relRow,
      relSliderRow,
      jackRow,
    );
    module.append(titleEl, subtitleEl, body);
    sourceColumn.appendChild(module);
    BACK_PANEL.sourceJacks.set(4, jack);
    BACK_PANEL.sourceMeters.set(4, fill);
    BACK_PANEL.sourceMeta.set(4, { subtitleEl, valueEl, module });
    refreshTrigScUI();
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
      title: 'Mix Pan',
      subtitle: 'Channel placement',
      params: FX_BUS_IDS.map((busId) => ({
        routeKey: `5:${busId}:pan`,
        label: FX_BUS_LABELS[busId],
      })),
    },
    {
      title: 'Beat Rpt',
      subtitle: 'Stutter engine',
      params: ['gate', 'pitch', 'decay', 'chance', 'mix'].map((key) => ({
        routeKey: `3:beatrepeat:${key}`,
        label: getFxParamDef('beatrepeat', key)?.label || key,
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
              : def.id === 'smp'
                ? 'Sampler'
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
    queueBackPanelConnections();
  });
  patchfield.addEventListener('pointerleave', () => {
    if (BACK_PANEL.selectedSourceIdx === null) return;
    BACK_PANEL.pointerX = null;
    BACK_PANEL.pointerY = null;
    queueBackPanelConnections();
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

// Single-flight gate for the back-panel connection loop. Several code paths
// want it running (view entry, pointer moves, every state refresh) — queueing
// unconditionally stacks extra self-requeuing rAF loops, one more per frame,
// until the main thread starves and the sequencer's lookahead is missed.
function queueBackPanelConnections() {
  if (UI_VIEW.mode !== 'back' || BACK_PANEL.connFrame) return;
  BACK_PANEL.connFrame = requestAnimationFrame(renderBackPanelConnections);
}

function renderBackPanelConnections() {
  BACK_PANEL.connFrame = null;
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

  queueBackPanelConnections();
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
      meta.subtitleEl.textContent = `${getSeqActiveStepCount()} steps • ${formatSequencerStepBeats(STEP_SEQ.stepBeats)}b/step${STEP_SEQ.sharedAcrossLoops ? ' • shared' : ''} • step ${STEP_SEQ.currentStep + 1} • ${routeCount} route${routeCount === 1 ? '' : 's'}`;
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
  BACK_PANEL.sourceMeta.get(4) &&
    (() => {
      const meta = BACK_PANEL.sourceMeta.get(4);
      const routeCount = [...lfoMappings.values()].filter(
        (mapping) => mapping.sourceIdx === 4,
      ).length;
      const laneLabel = GEN4_DEFS.find((def) => def.id === TRIG_SC.source)?.label || '—';
      meta.subtitleEl.textContent = `${laneLabel}${TRIG_SC.invert ? ' • inverted' : ''} • ${formatNumericValue(TRIG_SC.release, 2)}s release • ${routeCount} route${routeCount === 1 ? '' : 's'}`;
      meta.valueEl.textContent = formatNumericValue(TRIG_SC.envelope, 2);
      meta.module.classList.toggle('active', TRIG_SC.envelope > 0.01);
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
  (() => {
    const fill = BACK_PANEL.sourceMeters.get(4);
    if (!fill) return;
    fill.style.setProperty('--source-level', `${TRIG_SC.envelope}`);
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
  BACK_PANEL.audioModules.get('grainarp') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('grainarp');
      module.subtitleEl.textContent = `${FX.grainarp.hold ? 'HOLD • ' : ''}${FX.grainarp.pattern.toUpperCase()} • ${formatBackValue(getFxParamDef('grainarp', 'mix'), FX.grainarp.mix)} wet`;
      module.el.classList.toggle('active', FX.grainarp.mix > 0.001);
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
  BACK_PANEL.audioModules.get('resonator') &&
    (() => {
      const module = BACK_PANEL.audioModules.get('resonator');
      module.subtitleEl.textContent = `${FX.resonator.noteMode ? formatResonatorNote(FX.resonator.note) : `${formatNumericValue(FX.resonator.freq, 0)}Hz`} • ${formatBackValue(getFxParamDef('resonator', 'mix'), FX.resonator.mix)} wet`;
      module.el.classList.toggle('active', FX.resonator.mix > 0.001);
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

  queueBackPanelConnections();
}

// ── Mastering view ── a lazy panel that polishes rendered audio
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
    lowType: 'peak', // 'peak' bell · 'cut' 12 dB/oct high-pass (gain/dyn unused)
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
    subTune: 80,
    subAmount: 0,
    subMix: 0,
    levelerGain: 0, // input trim — always the first thing the signal meets
    width: 1,
    widthBassFreq: 0, // 0 = full-range; raise it to keep lows mono when widening
    enabled: { eq: true, opto: true, comp: true, ott: true, tape: true, sub: true, exciter: true, width: true, limit: true },
    drive: 0,
    ceiling: -1,
    outGain: 0,
    order: ['eq', 'opto', 'comp', 'ott', 'tape', 'sub', 'exciter', 'width', 'limit'],
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
  queueAutosaveAudio();
}

function clearMasteringSource() {
  if (!MASTERING.source) return;
  if (MASTERING.built) stopMasteringPreview({ preservePosition: false });
  MASTERING.source = null;
  MASTERING.previewBuffer = null;
  MASTERING.renderedPeaks = null;
  MASTERING.playheadSec = 0;
  MASTERING.loopMode = 'off';
  MASTERING.loopSelection = null;
  if (MASTERING.built) refreshMasteringSourceUI();
}

const MASTERING_MODULE_IDS = ['eq', 'opto', 'comp', 'ott', 'tape', 'sub', 'exciter', 'width', 'limit'];

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

  // Sub enhancer: parallel low band → saturation → the boosted fundamental is
  // stripped back out, leaving only generated upper harmonics to mix in — so
  // bass reads on small speakers without adding mud.
  const subIn = ctx.createGain();
  const subSum = ctx.createGain();
  const subLp = ctx.createBiquadFilter();
  subLp.type = 'lowpass';
  subLp.Q.value = 0.7071;
  const subDrive = ctx.createGain();
  const subShaper = ctx.createWaveShaper();
  subShaper.oversample = '4x';
  subShaper.curve = getMasteringTanhCurve();
  const subHp = ctx.createBiquadFilter();
  subHp.type = 'highpass';
  subHp.Q.value = 0.7071;
  const subCap = ctx.createBiquadFilter();
  subCap.type = 'lowpass';
  subCap.frequency.value = 1000;
  subCap.Q.value = 0.7071;
  const subMix = ctx.createGain();
  subIn.connect(subSum); // dry
  subIn.connect(subLp);
  subLp.connect(subDrive);
  subDrive.connect(subShaper);
  subShaper.connect(subHp);
  subHp.connect(subCap);
  subCap.connect(subMix);
  subMix.connect(subSum);

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
    sub: { input: subIn, output: subSum },
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
      subLp,
      subDrive,
      subHp,
      subMix,
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
      bands: MASTERING_EQ_BANDS.map((band, bi) => ({
        type: bi === 0 && p.lowType === 'cut' ? 'cut' : 'peak',
        freq: p[band.freqKey],
        gain: p[band.gainKey],
        q: p[band.qKey],
        thresh: p[band.threshKey],
        range: p[band.rangeKey],
      })),
    });
  } else if (n.low) {
    n.low.type = p.lowType === 'cut' ? 'highpass' : 'peaking';
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
  if (n.subLp) {
    n.subLp.frequency.value = p.subTune;
    // Strip the saturated fundamental a bit above the crossover, keeping the
    // generated 2nd/3rd harmonics.
    n.subHp.frequency.value = p.subTune * 1.5;
    n.subDrive.gain.value = dbToLin(p.subAmount);
    n.subMix.gain.value = p.subMix / 100;
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
  if (MASTERING.els.previewBtn) MASTERING.els.previewBtn.textContent = '▶';
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
  if (MASTERING.els.previewBtn) MASTERING.els.previewBtn.textContent = '■';
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
    info.title = info.textContent; // full text survives the ellipsis
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
    id: 'sub',
    section: 'Sub',
    controls: [
      { key: 'subTune', label: 'Tune', min: 40, max: 160, step: 1, unit: 'Hz' },
      { key: 'subAmount', label: 'Amount', min: 0, max: 24, step: 0.5, unit: 'dB' },
      { key: 'subMix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%' },
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

function rbjHighpass(sr, f0, q) {
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
  const cosw = Math.cos(w0);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

// The low band doubles as a low-cut: same freq/Q handles, gain and dynamics
// dormant while cut.
function masteringLowIsCut() {
  return MASTERING.params.lowType === 'cut';
}

function masteringBandDisplayCoefs(band, bi, gainDb) {
  return bi === 0 && masteringLowIsCut()
    ? rbjHighpass(EQ_DISPLAY_SR, MASTERING.params[band.freqKey], MASTERING.params[band.qKey])
    : rbjPeaking(EQ_DISPLAY_SR, MASTERING.params[band.freqKey], gainDb, MASTERING.params[band.qKey]);
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
  const cut = band === MASTERING_EQ_BANDS[0] && masteringLowIsCut();
  el.textContent = cut
    ? `${band.label} ${fLabel} Hz CUT · Q ${q.toFixed(2)}`
    : `${band.label} ${fLabel} Hz ${dB >= 0 ? '+' : ''}${dB.toFixed(1)} dB · Q ${q.toFixed(2)}`;
}

// ── Mastering persistence ── params ride inside the preset (autosave, named
// projects, file export, undo history). No mastering data → reset to defaults
// so an old project never inherits the previous project's chain.

const MASTERING_DEFAULT_PARAMS = JSON.parse(JSON.stringify(MASTERING.params));

// Built-in mastering chains. Keep these as complete parameter snapshots so
// adding a module later falls back safely through applyMasteringPreset().
const MASTERING_FACTORY_PRESETS = [
  {
    id: 'preset-1',
    name: 'Preset 1',
    params: {
      ...MASTERING_DEFAULT_PARAMS,
      levelerGain: -3.5,
      lowGain: -9,
      lowFreq: 20,
      lowQ: 0.7,
      lowMidGain: -0.5,
      lowMidFreq: 90,
      lowMidQ: 1,
      midGain: 0,
      midFreq: 900,
      midQ: 0.7,
      highMidGain: 0,
      highMidFreq: 2900,
      highMidQ: 1,
      highGain: -1,
      highFreq: 10000,
      highQ: 0.7,
      highDynThresh: -18,
      highDynRange: 3.5,
      optoReduction: 3.5,
      optoMakeup: 2.5,
      optoMode: '2a',
      compThreshold: -18,
      compRatio: 2,
      compAttack: 0.03,
      compRelease: 0.25,
      compMakeup: 1,
      ottDepth: 15,
      ottTime: 0.95,
      ottIn: 1.5,
      ottOut: 1.5,
      ottLow: 2.5,
      ottMid: 3.5,
      ottHigh: 0,
      tapeDrive: 1,
      tapeBump: 0.5,
      tapeRolloff: 20,
      tapeLevel: 0.5,
      subTune: 40,
      subAmount: 8.5,
      subMix: 8,
      excTune: 5000,
      excHarmonics: 14,
      excMix: 9,
      width: 1.6,
      widthBassFreq: 300,
      drive: 0,
      ceiling: -1,
      outGain: 0,
      enabled: { ...MASTERING_DEFAULT_PARAMS.enabled },
      order: [...MASTERING_DEFAULT_PARAMS.order],
    },
  },
  {
    id: 'preset-2',
    name: 'Preset 2',
    params: {
      ...MASTERING_DEFAULT_PARAMS,
      levelerGain: -5.5,
      lowGain: -8.5,
      lowFreq: 20,
      lowQ: 0.7,
      lowMidGain: 1,
      lowMidFreq: 80,
      lowMidQ: 1,
      midGain: -2.5,
      midFreq: 200,
      midQ: 0.7,
      highMidGain: 1.5,
      highMidFreq: 3000,
      highMidQ: 1,
      highGain: 0,
      highFreq: 10000,
      highQ: 0.7,
      highDynThresh: -18,
      highDynRange: 4,
      optoReduction: 7.5,
      optoMakeup: 4.5,
      optoMode: '2a',
      compThreshold: -16.5,
      compRatio: 3,
      compAttack: 0.03,
      compRelease: 0.25,
      compMakeup: 2,
      ottDepth: 29,
      ottTime: 0.95,
      ottIn: 1.5,
      ottOut: 1.5,
      ottLow: 1,
      ottMid: 5.5,
      ottHigh: -4,
      tapeDrive: 1.5,
      tapeBump: 1,
      tapeRolloff: 16,
      tapeLevel: 1.5,
      subTune: 50,
      subAmount: 6.5,
      subMix: 11,
      excTune: 3400,
      excHarmonics: 16.5,
      excMix: 11,
      width: 1.8,
      widthBassFreq: 270,
      drive: 1,
      ceiling: -0.5,
      outGain: 0,
      enabled: { ...MASTERING_DEFAULT_PARAMS.enabled },
      order: [...MASTERING_DEFAULT_PARAMS.order],
    },
  },
  {
    id: 'preset-3',
    name: 'Preset 3',
    params: {
      ...MASTERING_DEFAULT_PARAMS,
      levelerGain: -2,
      lowType: 'cut',
      lowGain: 0,
      lowFreq: 35,
      lowQ: 0.7,
      lowMidGain: 1,
      lowMidFreq: 80,
      lowMidQ: 1,
      midGain: 0.5,
      midFreq: 250,
      midQ: 0.7,
      highMidGain: 1.5,
      highMidFreq: 3000,
      highMidQ: 1,
      highGain: -1,
      highFreq: 13640,
      highQ: 0.7,
      highDynThresh: -22,
      highDynRange: 5.9,
      optoReduction: 6,
      optoMakeup: 3,
      optoMode: '3a',
      compThreshold: -27,
      compRatio: 3,
      compAttack: 0.019,
      compRelease: 0.2,
      compMakeup: 1.5,
      ottDepth: 23,
      ottTime: 0.95,
      ottIn: 1.5,
      ottOut: 1.5,
      ottLow: 1,
      ottMid: 0.5,
      ottHigh: 2.5,
      tapeDrive: 1,
      tapeBump: 0.5,
      tapeRolloff: 20,
      tapeLevel: 1,
      subTune: 50,
      subAmount: 2,
      subMix: 7,
      excTune: 3400,
      excHarmonics: 16.5,
      excMix: 11,
      width: 1.4,
      widthBassFreq: 230,
      drive: 1,
      ceiling: -1,
      outGain: 0,
      enabled: { ...MASTERING_DEFAULT_PARAMS.enabled },
      order: ['sub', 'eq', 'ott', 'width', 'opto', 'comp', 'tape', 'exciter', 'limit'],
    },
  },
  {
    id: 'preset-4',
    name: 'Preset 4',
    params: {
      ...MASTERING_DEFAULT_PARAMS,
      levelerGain: -9,
      lowType: 'cut',
      lowGain: 0,
      lowFreq: 36,
      lowQ: 0.7,
      lowMidGain: 2.5,
      lowMidFreq: 100,
      lowMidQ: 1,
      midGain: -3.5,
      midFreq: 200,
      midQ: 0.7,
      highMidGain: 1.5,
      highMidFreq: 1250,
      highMidQ: 1,
      highGain: -2.5,
      highFreq: 8980,
      highQ: 0.5,
      highDynThresh: -31,
      highDynRange: 4,
      optoReduction: 8,
      optoMakeup: 8,
      optoMode: '3a',
      compThreshold: -15,
      compRatio: 3,
      compAttack: 0.019,
      compRelease: 0.2,
      compMakeup: 1.5,
      ottDepth: 23,
      ottTime: 0.95,
      ottIn: 1.5,
      ottOut: 1.5,
      ottLow: 3,
      ottMid: 0.5,
      ottHigh: -1,
      tapeDrive: 1,
      tapeBump: 0.5,
      tapeRolloff: 20,
      tapeLevel: 1,
      subTune: 55,
      subAmount: 3,
      subMix: 18,
      excTune: 8000,
      excHarmonics: 20.5,
      excMix: 11,
      width: 1.6,
      widthBassFreq: 260,
      drive: 1.5,
      ceiling: -1,
      outGain: 0,
      enabled: { ...MASTERING_DEFAULT_PARAMS.enabled },
      order: ['sub', 'eq', 'tape', 'ott', 'width', 'opto', 'comp', 'exciter', 'limit'],
    },
  },
];

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

function buildMasteringPresetGroup() {
  const group = document.createElement('div');
  group.className = 'master-preset-group';
  const label = document.createElement('span');
  label.textContent = 'Presets';
  group.appendChild(label);
  MASTERING_FACTORY_PRESETS.forEach((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'master-preset-btn';
    button.textContent = preset.name.replace(/^Preset\s*/i, 'P');
    button.title = `Load ${preset.name}`;
    button.addEventListener('click', () => {
      applyMasteringPreset(preset.params);
      setStatus(`mastering: loaded ${preset.name}`);
    });
    group.appendChild(button);
  });
  return group;
}

// Loaded params can change knob values, chain order, and bypass states at
// once — rebuilding the (cheap, static) panel DOM is simpler and safer than
// patching every control in place. A running preview keeps playing and gets
// the new chain swapped in behind it.
function rebuildMasterPanelUI() {
  if (!MASTERING.built) return;
  // The toolbar may currently live in the header slot — remove it explicitly
  // so a rebuild can't leave a duplicate there.
  MASTERING.els.toolbar?.remove();
  const panel = document.getElementById('masterPanel');
  if (panel) panel.innerHTML = '';
  MASTERING.built = false;
  MASTERING.els = {};
  buildMasterPanel();
  syncMasteringToolbarPlacement();
  if (MASTERING.preview) {
    rebuildMasteringPreviewChain();
    if (MASTERING.els.previewBtn) {
      MASTERING.els.previewBtn.classList.add('active');
      MASTERING.els.previewBtn.textContent = '■';
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
    'Drag: ↔ frequency, ↕ gain (shift = fine) · alt-click / double-click: reset band · type exact values below';
  MASTERING.els.eqCanvas = canvas;
  box.appendChild(canvas);

  // Pro-Q-style band strip: colored chips select a band, the value boxes
  // below edit it by typing (Enter commits, Esc reverts, ↑↓ nudge).
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
  const cutBtn = document.createElement('button');
  cutBtn.type = 'button';
  cutBtn.className = 'master-eq-solo master-eq-cut';
  cutBtn.textContent = 'CUT';
  cutBtn.title =
    'Low band: bell ↔ low-cut (12 dB/oct high-pass) — gain and dynamics sit out while cut; freq and Q still apply';
  MASTERING.els.eqCutBtn = cutBtn;
  cutBtn.addEventListener('click', () => {
    MASTERING.params.lowType = MASTERING.params.lowType === 'cut' ? 'peak' : 'cut';
    selectBand(MASTERING_EQ_BANDS[0]);
    bandChanged(MASTERING_EQ_BANDS[0]);
  });
  chipRow.append(...chips, cutBtn, soloBtn);
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
      title: 'Band Q — drag ↕, double-click to type',
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
    MASTERING_EQ_BANDS.forEach((band, bi) => {
      const x = eqFreqToX(MASTERING.params[band.freqKey], w);
      // Mirror the drawn handle: a cut low band sits on the 0 dB line.
      const y = eqDbToY(
        bi === 0 && masteringLowIsCut() ? 0 : MASTERING.params[band.gainKey],
        h,
      );
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
    if (band === MASTERING_EQ_BANDS[0]) p.lowType = 'peak';
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
    // A cut low band has no gain — vertical motion is ignored, not stored.
    if (!(activeBand === MASTERING_EQ_BANDS[0] && masteringLowIsCut())) {
      p[activeBand.gainKey] = dB;
    }
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
  MASTERING.els.toolbar = toolbar;

  const sourceInfo = document.createElement('span');
  sourceInfo.className = 'master-source-info';
  MASTERING.els.sourceInfo = sourceInfo;

  const presetGroup = buildMasteringPresetGroup();

  const bounceBtn = document.createElement('button');
  bounceBtn.type = 'button';
  bounceBtn.className = 'master-tool-btn';
  bounceBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.7"/><path d="M6 3.5v4.2M4.3 6 6 7.7 7.7 6"/></svg>';
  bounceBtn.title = 'Bounce song → here — silent one-pass render of the arrangement, fed straight into mastering';
  bounceBtn.addEventListener('click', (e) => bounceSong({ invert: e.shiftKey }));

  const bounceProgressWrap = document.createElement('div');
  bounceProgressWrap.className = 'bounce-progress';
  bounceProgressWrap.setAttribute('role', 'progressbar');
  bounceProgressWrap.setAttribute('aria-label', 'Bounce progress');
  bounceProgressWrap.hidden = true;
  bounceProgressWrap.innerHTML =
    '<span class="bounce-progress-fill"></span><span class="bounce-progress-label">0%</span>';
  MASTERING.els.bounceProgress = bounceProgressWrap;

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
  loadBtn.className = 'master-tool-btn';
  loadBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.2 9.8V2.8h3.4l1 1.4h5.2v5.6z"/></svg>';
  loadBtn.title = 'Load a WAV file into mastering';
  loadBtn.addEventListener('click', () => loadInput.click());

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'master-tool-btn';
  previewBtn.textContent = '▶';
  previewBtn.title = 'Preview — play the source through the mastering chain';
  previewBtn.addEventListener('click', toggleMasteringPreview);
  MASTERING.els.previewBtn = previewBtn;

  const bypassBtn = document.createElement('button');
  bypassBtn.type = 'button';
  bypassBtn.className = 'master-bypass-btn master-tool-btn';
  bypassBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.4v4.2"/><path d="M3.4 3.2a4.3 4.3 0 1 0 5.2 0"/></svg>';
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
  loopSectionBtn.className = 'master-loop-btn master-tool-btn';
  loopSectionBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 4.6A3.6 3.6 0 1 0 9.8 6.7"/><path d="M9.8 2.6v2h-2"/><path d="M3.5 11h5"/></svg>';
  loopSectionBtn.title = 'Loop selection — drag across the waveform, then loop that section';
  loopSectionBtn.addEventListener('click', () => {
    setMasteringLoopMode(MASTERING.loopMode === 'section' ? 'off' : 'section');
  });
  MASTERING.els.loopSectionBtn = loopSectionBtn;

  const loopAllBtn = document.createElement('button');
  loopAllBtn.type = 'button';
  loopAllBtn.className = 'master-loop-btn master-tool-btn';
  loopAllBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 4.6A3.6 3.6 0 1 0 9.8 6.7"/><path d="M9.8 2.6v2h-2"/></svg>';
  loopAllBtn.title = 'Loop all — loop the complete song during preview';
  loopAllBtn.addEventListener('click', () => {
    setMasteringLoopMode(MASTERING.loopMode === 'all' ? 'off' : 'all');
  });
  MASTERING.els.loopAllBtn = loopAllBtn;

  const renderBtn = document.createElement('button');
  renderBtn.type = 'button';
  renderBtn.className = 'master-tool-btn';
  renderBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.5v6M3.5 5 6 7.5 8.5 5"/><path d="M1.5 10.5h9"/></svg>';
  renderBtn.title = 'Render & export WAV — offline render through the chain, measures LUFS/peak, downloads the wav';
  renderBtn.addEventListener('click', renderMastering);

  const meters = document.createElement('span');
  meters.className = 'master-meters';
  meters.title = 'Integrated loudness (BS.1770) and sample peak of the last render — aim near −14 LUFS for streaming';
  MASTERING.els.meters = meters;

  toolbar.append(
    sourceInfo,
    presetGroup,
    bounceBtn,
    bounceProgressWrap,
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

// In master view the mastering toolbar lives in the app header (the transport
// controls there are hidden via body.view-master); everywhere else it sits at
// the top of the panel. A DOM move keeps every listener alive.
function syncMasteringToolbarPlacement() {
  const toolbar = MASTERING.els.toolbar;
  const slot = document.getElementById('masterHeaderSlot');
  const panel = document.getElementById('masterPanel');
  if (!toolbar || !slot || !panel) return;
  if (UI_VIEW.mode === 'master') {
    slot.appendChild(toolbar);
    slot.hidden = false;
  } else {
    slot.hidden = true;
    panel.insertBefore(toolbar, panel.firstChild);
  }
}

function enterMasteringView() {
  // Mastering monitors its own preview chain — stop the loop/song transport
  // on entry so the two never play over each other.
  if (isTransportOn()) {
    stopTransport();
    setStatus('loop/song playback stopped — mastering view');
  }
  buildMasterPanel();
  syncMasteringToolbarPlacement();
  refreshMasteringSourceUI();
  drawMasteringEq(); // re-entry redraw: theme or window size may have changed
  if (!MASTERING.preview) drawMasteringMetersIdle();
}

function leaveMasteringView() {
  if (!MASTERING.built) return;
  syncMasteringToolbarPlacement();
  stopMasteringPreview();
  // Suspend (not close) so re-entry is instant; a suspended context costs
  // nothing per-frame.
  MASTERING.ctx?.suspend?.();
}

const PANEL_VIEWS = ['front', 'back', 'mixer', 'song', 'visual', 'master'];
const TAB_PANEL_VIEWS = ['front', 'back', 'mixer', 'song'];

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
  document.getElementById('modeToggle')?.classList.toggle('hidden-panel', mode !== 'front');
  getFrontWorkspace()?.classList.toggle('hidden-panel', mode !== 'front');
  getBackPanel()?.classList.toggle('hidden-panel', mode !== 'back');
  document.getElementById('visualPanel')?.classList.toggle('hidden-panel', mode !== 'visual');
  document.getElementById('mixerPanel')?.classList.toggle('hidden-panel', mode !== 'mixer');
  document.getElementById('songPanel')?.classList.toggle('hidden-panel', mode !== 'song');
  document.getElementById('masterPanel')?.classList.toggle('hidden-panel', mode !== 'master');
  // Master view swaps the header's transport for the mastering toolbar
  // (settings gear stays) — see body.view-master CSS.
  document.body.classList.toggle('view-master', mode === 'master');
  getViewButtons().forEach((btn) => btn.classList.toggle('active', btn.dataset.view === mode));
  if (mode === 'master') enterMasteringView();
  else leaveMasteringView();
  // Song view keeps the transport alive — it is a performance surface, not a
  // render tool like mastering.
  if (mode === 'song') enterSongView();
  else leaveSongView();
  // Self-heal the audible state: entering mastering suspends the main
  // context, which can freeze bus/channel gain ramps mid-flight — re-assert
  // the mix on every view change so nothing stays stuck half-silent.
  if (audioCtx) {
    applyInstrumentMixState();
    GEN4.channels.forEach((ch, ci) => gen4SetChannelMuted(ci, ch.muted));
  }
  if (mode === 'back') {
    if (!BACK_PANEL.built) buildBackPanel();
    refreshBackPanelState();
    rebuildBackWireSVG();
    queueBackPanelConnections();
  }
  // Mod visuals are skipped per-frame while the front view is hidden; refresh
  // once on entry so the FX/gen controls show the current mapping state.
  if (mode === 'front') refreshModulationVisuals();
  if (mode === 'mixer') {
    buildMixerPanel();
    refreshMixerControls();
    startMixerMeters();
  } else {
    stopMixerMeters();
  }
  if (mode === 'visual') startViz(); else stopViz();
}

function initViewToggle() {
  getViewButtons().forEach((btn) => {
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
  const settingsRow = document.createElement('div');
  settingsRow.className = 'seq-compact-row';

  const subdivisionControl = document.createElement('label');
  subdivisionControl.className = 'seq-compact-control';
  const subdivisionLabel = document.createElement('span');
  subdivisionLabel.className = 'seq-row-label';
  subdivisionLabel.textContent = 'Steps';
  seqSubdivisionSelect = document.createElement('select');
  seqSubdivisionSelect.className = 'seq-compact-select';
  seqSubdivisionSelect.title = 'Number of active sequence steps';
  [
    [4, '4'],
    [5, '5'],
    [8, '8'],
    [12, '12'],
    [16, '16'],
  ].forEach(([subdivision, label]) => {
    const option = document.createElement('option');
    option.value = `${subdivision}`;
    option.textContent = label;
    seqSubdivisionSelect.appendChild(option);
  });
  seqSubdivisionSelect.addEventListener('change', () => {
    setSequencerSubdivision(Number(seqSubdivisionSelect.value));
  });
  subdivisionControl.append(subdivisionLabel, seqSubdivisionSelect);

  const stepBeatControl = document.createElement('label');
  stepBeatControl.className = 'seq-compact-control';
  const stepBeatLabel = document.createElement('span');
  stepBeatLabel.className = 'seq-row-label';
  stepBeatLabel.textContent = 'Step rate';
  seqStepBeatSelect = document.createElement('select');
  seqStepBeatSelect.className = 'seq-compact-select';
  seqStepBeatSelect.title = 'Beat duration of each sequence step';
  STEP_SEQ_STEP_BEAT_OPTIONS.forEach(({ label, beats }) => {
    const option = document.createElement('option');
    option.value = `${beats}`;
    option.textContent = `${label} beat${beats === 1 ? '' : 's'}`;
    seqStepBeatSelect.appendChild(option);
  });
  seqStepBeatSelect.addEventListener('change', () => {
    setSequencerStepBeats(Number(seqStepBeatSelect.value));
  });
  stepBeatControl.append(stepBeatLabel, seqStepBeatSelect);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'fx-mode-btn seq-action-btn';
  clearBtn.textContent = 'Clear';
  clearBtn.title = 'Clear every sequence step';
  clearBtn.addEventListener('click', () => {
    clearSequencerSteps();
  });
  seqShareButton = document.createElement('button');
  seqShareButton.type = 'button';
  seqShareButton.className = 'fx-mode-btn seq-action-btn';
  seqShareButton.textContent = 'Share';
  seqShareButton.setAttribute('aria-pressed', 'false');
  seqShareButton.addEventListener('click', () => {
    setSequencerSharedAcrossLoops(!STEP_SEQ.sharedAcrossLoops);
  });
  settingsRow.append(subdivisionControl, stepBeatControl, clearBtn, seqShareButton);
  content.appendChild(settingsRow);
  refreshSequencerUI();

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

    // Live readout while dragging: the step's level in ±12 (semitones when
    // the seq drives a pitch param).
    const showStepTip = () => {
      const level = Math.round((STEP_SEQ.steps[stepIdx] || 0) * 12);
      const tip = ensureUiTip();
      tip.textContent = `${level > 0 ? '+' : ''}${level} st`;
      tip.hidden = false;
      const r = step.getBoundingClientRect();
      tip.style.left = '0px';
      const tw = tip.offsetWidth;
      tip.style.left = `${clamp(r.left + r.width / 2 - tw / 2, 4, window.innerWidth - tw - 4)}px`;
      tip.style.top = `${Math.max(4, r.top - tip.offsetHeight - 6)}px`;
    };

    const updateStep = (event) => {
      setSequencerStep(stepIdx, valueFromPointer(event, step));
      showStepTip();
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
      hideUiTip();
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

function applyGrainArpPattern(busId = activeBus) {
  const bus = fxBuses[busId];
  if (!bus?.grainarp?.node) return;
  const idx = GRAINARP_PATTERNS.findIndex(([id]) => id === fxStates[busId].grainarp.pattern);
  bus.grainarp.node.parameters
    .get('pattern')
    ?.setValueAtTime(Math.max(0, idx), audioCtx.currentTime);
}

function applyGrainArpHold(busId = activeBus) {
  const bus = fxBuses[busId];
  if (!bus?.grainarp?.node) return;
  bus.grainarp.node.parameters
    .get('hold')
    ?.setValueAtTime(fxStates[busId].grainarp.hold ? 1 : 0, audioCtx.currentTime);
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
  const meterSplit = ac.createChannelSplitter(2);
  const meterL = ac.createAnalyser();
  const meterR = ac.createAnalyser();
  const meterMerge = ac.createChannelMerger(2);
  [meterL, meterR].forEach((analyser) => {
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
  });
  masterOut.gain.setValueAtTime(LIMITER.output, ac.currentTime);
  sum.connect(limiter);
  limiter.connect(masterOut);
  masterOut.connect(meterSplit);
  meterSplit.connect(meterL, 0);
  meterSplit.connect(meterR, 1);
  meterL.connect(meterMerge, 0, 0);
  meterR.connect(meterMerge, 0, 1);
  master = {
    sum,
    limiter: { comp: limiter, output: masterOut },
    output: meterMerge,
    meter: { split: meterSplit, left: meterL, right: meterR, merge: meterMerge },
  };
  return master;
}

// Build one instrument's independent effect chain. Its output sums into the
// shared master tail. The effect order between input and output is rewired
// live by reconnectFxChain(busId).
function buildBusFx(busId) {
  const ac = audioCtx;
  const st = fxStates[busId];

  // Stable entry/exit nodes: the generator connects to `input` once, movable
  // effects end at `mixerIn`, then channel EQ → pan → gain feeds the master.
  const chainIn = ac.createGain();
  const mixerIn = ac.createGain();
  const mixLow = ac.createBiquadFilter();
  mixLow.type = 'lowshelf';
  mixLow.frequency.setValueAtTime(100, ac.currentTime);
  const mixLowMid = ac.createBiquadFilter();
  mixLowMid.type = 'peaking';
  mixLowMid.frequency.setValueAtTime(300, ac.currentTime);
  mixLowMid.Q.setValueAtTime(0.8, ac.currentTime);
  const mixMid = ac.createBiquadFilter();
  mixMid.type = 'peaking';
  mixMid.frequency.setValueAtTime(1000, ac.currentTime);
  mixMid.Q.setValueAtTime(0.8, ac.currentTime);
  const mixPresence = ac.createBiquadFilter();
  mixPresence.type = 'peaking';
  mixPresence.frequency.setValueAtTime(3500, ac.currentTime);
  mixPresence.Q.setValueAtTime(0.8, ac.currentTime);
  const mixHigh = ac.createBiquadFilter();
  mixHigh.type = 'highshelf';
  mixHigh.frequency.setValueAtTime(10000, ac.currentTime);
  const mixPan = ac.createStereoPanner();
  const busOut = ac.createGain();
  const meterSplit = ac.createChannelSplitter(2);
  const meterL = ac.createAnalyser();
  const meterR = ac.createAnalyser();
  const meterMerge = ac.createChannelMerger(2);
  [meterL, meterR].forEach((analyser) => {
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
  });

  mixLow.connect(mixLowMid);
  mixLowMid.connect(mixMid);
  mixMid.connect(mixPresence);
  mixPresence.connect(mixHigh);
  if (INSTRUMENT_MIX[busId].eqEnabled) {
    mixerIn.connect(mixLow);
    mixHigh.connect(mixPan);
  } else {
    mixerIn.connect(mixPan);
  }
  mixPan.connect(busOut);
  busOut.connect(meterSplit);
  meterSplit.connect(meterL, 0);
  meterSplit.connect(meterR, 1);
  meterL.connect(meterMerge, 0, 0);
  meterR.connect(meterMerge, 0, 1);

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

  // ─ Grain Arp (Microcosm-style pitched slice arpeggiator) ─
  const arpIn = ac.createGain();
  const arpDry = ac.createGain();
  const arpWet = ac.createGain();
  const arpNode = new AudioWorkletNode(ac, 'grain-arp-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: {
      grid: getGrainArpGridSeconds(busId),
      pattern: Math.max(
        0,
        GRAINARP_PATTERNS.findIndex(([id]) => id === st.grainarp.pattern),
      ),
      chance: st.grainarp.chance,
      shape: st.grainarp.shape,
      scatter: st.grainarp.scatter,
      reverse: st.grainarp.reverse,
      feedback: st.grainarp.feedback,
      hold: st.grainarp.hold ? 1 : 0,
    },
  });
  const arpOut = ac.createGain();

  arpIn.connect(arpDry);
  arpIn.connect(arpNode);
  arpNode.connect(arpWet);
  arpDry.connect(arpOut);
  arpWet.connect(arpOut);

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

  // ─ Resonator (comb + 2 harmonic partials, tuned in the worklet) ─
  const resIn = ac.createGain();
  const resDry = ac.createGain();
  const resWet = ac.createGain();
  const resNode = new AudioWorkletNode(ac, 'resonator-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: {
      freq: getResonatorFreqHz(busId),
      decay: st.resonator.decay,
      damp: st.resonator.damp,
      int2: st.resonator.int2,
      int3: st.resonator.int3,
      harm2: st.resonator.harm2,
      harm3: st.resonator.harm3,
    },
  });
  const resOut = ac.createGain();

  resIn.connect(resDry);
  resIn.connect(resNode);
  resNode.connect(resWet);
  resDry.connect(resOut);
  resWet.connect(resOut);

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
    mixerIn,
    output: busOut,
    mixer: {
      input: mixerIn,
      low: mixLow,
      lowMid: mixLowMid,
      mid: mixMid,
      presence: mixPresence,
      high: mixHigh,
      pan: mixPan,
      eqEnabled: INSTRUMENT_MIX[busId].eqEnabled,
      meter: { split: meterSplit, left: meterL, right: meterR, merge: meterMerge },
    },
    beatrepeat: { node: brNode, dry: brDry, wet: brWet, in: brIn, out: brOut },
    grainarp: { node: arpNode, dry: arpDry, wet: arpWet, in: arpIn, out: arpOut },
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
    resonator: { node: resNode, dry: resDry, wet: resWet, in: resIn, out: resOut },
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
  meterMerge.connect(master.sum);

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
// pair, so we fully disconnect the movable links and rebuild them. Disabled
// units are left out of the chain: with no path to the destination the browser
// skips their whole subgraph (worklets, convolver, oversampled shaper).
// Stateless units that are safe to silently unplug while inaudible: nothing
// in them accumulates material a player would expect to still be there when
// the mix comes back up. Beat repeat, grain arp and delay stay plugged — their
// capture rings / tail must keep filling while mix sits at 0 so a performance
// gesture grabs the audio that just played.
const FX_IDLE_BYPASS = new Set(['filter', 'resonator', 'bitreduce', 'sat', 'reverb']);

// What reconnectFxChain actually spliced in, per bus — lets a mix change
// detect whether the chain needs a re-splice without rebuilding every time.
const fxPlugged = { gen0: new Set(), gen1: new Set(), gen3: new Set(), gen4: new Set() };

function fxUnitIdle(busId, id) {
  if (!FX_IDLE_BYPASS.has(id)) return false;
  if ((fxStates[busId][id]?.mix ?? 0) > 0) return false;
  if (lfoMappings.has(`3:${id}:mix`)) return false;
  return true;
}

function syncFxIdleSplice(id, busId = activeBus) {
  if (!FX_IDLE_BYPASS.has(id) || !fxBuses[busId]) return;
  const should = fxStates[busId][id]?.enabled !== false && !fxUnitIdle(busId, id);
  if (should !== fxPlugged[busId].has(id)) reconnectFxChain(busId);
}

function reconcileFxIdleSplices() {
  FX_BUS_IDS.forEach((busId) => {
    FX_IDLE_BYPASS.forEach((id) => syncFxIdleSplice(id, busId));
  });
}

function reconnectFxChain(busId = activeBus) {
  const bus = fxBuses[busId];
  if (!bus) return;
  bus.input.disconnect();
  fxOrders[busId].forEach((id) => bus[id]?.out.disconnect());
  fxPlugged[busId].clear();
  let prev = bus.input;
  fxOrders[busId].forEach((id) => {
    const eff = bus[id];
    // Powered-off units are left out, and so are stateless units whose mix is
    // 0 with no modulation on it — their whole subgraph then costs nothing.
    if (!eff || fxStates[busId][id]?.enabled === false || fxUnitIdle(busId, id)) return;
    fxPlugged[busId].add(id);
    prev.connect(eff.in);
    prev = eff.out;
  });
  prev.connect(bus.mixerIn);
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
  } else if (id === 'grainarp') {
    const setParam = (name, value) =>
      fx.grainarp.node.parameters.get(name)?.setValueAtTime(value, audioCtx.currentTime);
    if (key === 'grid') setParam('grid', clamp(val, 0.005, 1));
    if (key === 'chance') setParam('chance', clamp(val, 0, 1));
    if (key === 'shape') setParam('shape', clamp(val, 0, 1));
    if (key === 'scatter') setParam('scatter', clamp(val, 0, 1));
    if (key === 'reverse') setParam('reverse', clamp(val, 0, 1));
    if (key === 'feedback') setParam('feedback', clamp(val, 0, 0.85));
    if (key === 'mix') {
      fx.grainarp.wet.gain.value = val;
      fx.grainarp.dry.gain.value = 1 - val;
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
  } else if (id === 'resonator') {
    const setParam = (name, value) =>
      fx.resonator.node.parameters.get(name)?.setTargetAtTime(value, audioCtx.currentTime, 0.02);
    if (key === 'freq') setParam('freq', clamp(val, 40, 2000));
    if (key === 'decay') setParam('decay', clamp(val, 0, 0.98));
    if (key === 'damp') setParam('damp', clamp(val, 200, 12000));
    if (key === 'int2') setParam('int2', clamp(val, -24, 24));
    if (key === 'int3') setParam('int3', clamp(val, -24, 24));
    if (key === 'harm2') setParam('harm2', clamp(val, 0, 1));
    if (key === 'harm3') setParam('harm3', clamp(val, 0, 1));
    if (key === 'mix') {
      fx.resonator.wet.gain.value = val;
      fx.resonator.dry.gain.value = 1 - val;
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
  // A mix crossing 0 can change whether a stateless unit belongs in the chain.
  if (key === 'mix') syncFxIdleSplice(id, busId);
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
  applyGrainArpPattern(busId);
  applyGrainArpHold(busId);
}

function refreshGen3UI() {
  ['gain', 'pitch', 'detune', 'attack', 'decay', 'sustain', 'release'].forEach((key) => {
    gen3ControlBindings.get(key)?.setValue(GEN3[key]);
  });
  gen3ShapeButtons.forEach((btn, type) => btn.classList.toggle('active', GEN3.type === type));
  if (gen3SusBtnEl) gen3SusBtnEl.classList.toggle('active', GEN3.sustainMode);
  if (gen3ArpBtnEl) gen3ArpBtnEl.classList.toggle('active', GEN3.arpEnabled);
  if (gen3ArpBarEl) gen3ArpBarEl.hidden = !GEN3.arpEnabled;
  if (gen3ArpRateSelect) gen3ArpRateSelect.value = String(GEN3.arpRateBeats);
  if (gen3ArpDirectionSelect) gen3ArpDirectionSelect.value = GEN3.arpDirection;
  if (gen3ArpOctaveSelect) gen3ArpOctaveSelect.value = String(GEN3.arpOctaves);
  if (gen3ArpGateSelect) gen3ArpGateSelect.value = String(GEN3.arpGate);
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
    sourceModes: GRANULAR_SOURCES.map((source) => source.mode),
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
      arpEnabled: GEN3.arpEnabled,
      arpRateBeats: GEN3.arpRateBeats,
      arpDirection: GEN3.arpDirection,
      arpOctaves: GEN3.arpOctaves,
      arpGate: GEN3.arpGate,
    },
    loops: LOOPS.list.map(serializeLoop),
    activeLoopIndex: LOOPS.editIndex,
    sequencer: { sharedAcrossLoops: STEP_SEQ.sharedAcrossLoops },
    song: {
      // Jump targets are stored by entry index — ids regenerate on load.
      entries: SONG.entries.map(({ loopId, repeats, prob, cond, variation, fill, morph, jump }) => ({
        loopId,
        repeats,
        prob: prob ?? 1,
        cond: cond || 0,
        variation: variation ?? -1,
        fill: !!fill,
        morph: morph || 0,
        jump: jump?.targetId
          ? {
              target: SONG.entries.findIndex((e) => e.id === jump.targetId),
              chance: jump.chance ?? 1,
              count: jump.count || 0,
            }
          : null,
      })),
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
    trigSc: {
      release: TRIG_SC.release,
      amount: TRIG_SC.amount,
      source: TRIG_SC.source,
      invert: TRIG_SC.invert,
    },
    scale: { root: GEN4_SCALE.root, scale: GEN4_SCALE.scale },
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
  if (resetSources) {
    resetGranularSources();
    // Honor the saved source modes so a project that never used the mic
    // doesn't reopen in mic mode (file data is layered back on by the
    // scope's clip restore). Legacy presets lack the field → mic default.
    if (Array.isArray(preset.sourceModes)) {
      preset.sourceModes.slice(0, 2).forEach((mode, genIdx) => {
        if (mode !== 'file' && mode !== 'mic') return;
        getSourceState(genIdx).mode = mode;
        refreshSourceModeUI(genIdx);
        if (node) syncGranularSourceState(genIdx);
      });
      if (!anyMicSourceSelected()) disconnectGranularInput({ stopTracks: true });
    }
  }

  if (preset.gen3) {
    // The chord (lockedMidis) is loop data now — legacy presets carry it here
    // and legacyLoopData() migrates it; bindEditLoop() below restores the Set.
    const { lockedMidis: _legacyChord, ...gen3Params } = preset.gen3;
    Object.assign(
      GEN3,
      {
        arpEnabled: false,
        arpRateBeats: 0.25,
        arpDirection: 'up',
        arpOctaves: 1,
        arpGate: 0.75,
      },
      gen3Params,
    );
    if (GEN3.arpEnabled) GEN3.sustainMode = false;
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
        // Legacy saves predate the power switch — default back to on so a
        // stale flag from the previous project can't linger.
        fxStates[busId][id].enabled = true;
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
    // Re-splice each chain so loaded power switches take effect.
    FX_BUS_IDS.forEach((busId) => reconnectFxChain(busId));
    applyFxModulation();
  }

  FX_BUS_IDS.forEach((busId) => {
    const saved = preset.instrumentMix?.[busId];
    const next = makeDefaultInstrumentMixState();
    if (saved) {
      next.muted = saved.muted === true;
      next.solo = saved.solo === true;
      if (typeof saved.gainDb === 'number') next.gainDb = clamp(saved.gainDb, -60, 6);
      if (typeof saved.pan === 'number') next.pan = clamp(saved.pan, -1, 1);
      if (typeof saved.eqEnabled === 'boolean') next.eqEnabled = saved.eqEnabled;
      if (typeof saved.eqLow === 'number') next.eqLow = clamp(saved.eqLow, -18, 18);
      if (typeof saved.eqLowMid === 'number') next.eqLowMid = clamp(saved.eqLowMid, -18, 18);
      if (typeof saved.eqMid === 'number') next.eqMid = clamp(saved.eqMid, -18, 18);
      if (typeof saved.eqPresence === 'number')
        next.eqPresence = clamp(saved.eqPresence, -18, 18);
      if (typeof saved.eqHigh === 'number') next.eqHigh = clamp(saved.eqHigh, -18, 18);
    }
    Object.assign(INSTRUMENT_MIX[busId], next);
  });
  applyInstrumentMixState();
  refreshMixerControls();

  if (preset.limiter) {
    Object.assign(LIMITER, preset.limiter);
    applyLimiterAll();
    limiterControls.forEach((control, key) => control.setValue(LIMITER[key]));
    refreshFxPresetSelection('limiter');
    refreshMixerControls();
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
  STEP_SEQ.sharedAcrossLoops = preset.sequencer?.sharedAcrossLoops === true;
  if (STEP_SEQ.sharedAcrossLoops) {
    shareSequencerAcrossLoops(LOOPS.list[LOOPS.editIndex]?.seq);
  }
  SONG.entries = [];
  SONG.entryCounter = 0;
  const savedSongEntries = preset.song?.entries || [];
  // Saved index → rebuilt entry (null when its loop is gone), so jump targets
  // stored by index survive entries that fail to load.
  const rebuiltByIdx = savedSongEntries.map((e) => {
    if (!getLoopById(e?.loopId)) return null;
    SONG.entryCounter += 1;
    const variation =
      e.variation === 'rnd' || e.variation === 'cycle'
        ? e.variation
        : clamp(Math.round(e.variation ?? -1), -1, 2);
    const entry = {
      id: `entry-${SONG.entryCounter}`,
      loopId: e.loopId,
      repeats: clamp(Math.round(e.repeats) || 1, 1, 64),
      prob: clamp(Number.isFinite(e.prob) ? e.prob : 1, 0.05, 1),
      cond: clamp(Math.round(e.cond) || 0, 0, SONG_CONDITIONS.length - 1),
      variation,
      fill: !!e.fill,
      morph: clamp(Math.round(e.morph) || 0, 0, 16),
      jump: null,
    };
    SONG.entries.push(entry);
    return entry;
  });
  savedSongEntries.forEach((e, i) => {
    const built = rebuiltByIdx[i];
    const target = e?.jump ? rebuiltByIdx[e.jump.target] : null;
    if (!built || !target) return;
    built.jump = {
      targetId: target.id,
      chance: clamp(Number.isFinite(e.jump.chance) ? e.jump.chance : 1, 0.05, 1),
      count: clamp(Math.round(e.jump.count) || 0, 0, 64),
    };
  });
  // Empty arrangements from older saves predate the default Loop A song
  // block. Seed them on restore too, so Song Play has something to launch
  // and persisted Gen 3 sustain chords retrigger without another edit.
  if (SONG.entries.length === 0 && LOOPS.list[0]) {
    SONG.entries.push(createSongEntryData(LOOPS.list[0].id));
  }
  SONG.loop = preset.song?.loop !== false;
  SONG.follow = preset.song?.follow !== false;
  SONG.runtime.clear();
  SONG.lastJump = null;
  SONG.cursor.entryIdx = 0;
  SONG.cursor.repeat = 0;
  SONG.cursor.variation = -1;
  SONG.cursor.fillPattern = null;
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

  // State first, DOM second: the back panel may not be built yet (it's lazy),
  // and its sliders read KICK_SC when they are built, so nothing is lost.
  KICK_SC.amount = clamp(
    typeof preset.kickSc?.amount === 'number' ? preset.kickSc.amount : 1.0,
    0,
    1,
  );
  KICK_SC.release = clamp(
    typeof preset.kickSc?.release === 'number' ? preset.kickSc.release : 0.2,
    0.01,
    1,
  );
  document.querySelectorAll('[data-sc-param]').forEach((slider) => {
    const param = slider.dataset.scParam;
    if (param === 'amount') slider.value = `${KICK_SC.amount}`;
    else if (param === 'release') slider.value = `${KICK_SC.release}`;
    slider.dispatchEvent(new Event('input'));
  });

  // Trig SC: legacy saves lack the field — reset to defaults so a previous
  // project's inverted boost can't linger into this one.
  TRIG_SC.amount = clamp(
    typeof preset.trigSc?.amount === 'number' ? preset.trigSc.amount : 1.0,
    0,
    1,
  );
  TRIG_SC.release = clamp(
    typeof preset.trigSc?.release === 'number' ? preset.trigSc.release : 0.2,
    0.01,
    1,
  );
  TRIG_SC.source = GEN4_DEFS.some((def) => def.id === preset.trigSc?.source)
    ? preset.trigSc.source
    : 'fm';
  TRIG_SC.invert = preset.trigSc?.invert === true;
  document.querySelectorAll('[data-trig-sc-param]').forEach((slider) => {
    const param = slider.dataset.trigScParam;
    if (param === 'amount') slider.value = `${TRIG_SC.amount}`;
    else if (param === 'release') slider.value = `${TRIG_SC.release}`;
    slider.dispatchEvent(new Event('input'));
  });
  refreshTrigScUI();

  // Shared musical scale (drum roll + gen3 keys). Legacy saves lack it → reset
  // to "no scale" so the previous project's choice can't bleed through.
  GEN4_SCALE.root = clamp(Math.round(preset.scale?.root) || 0, 0, 11);
  GEN4_SCALE.scale = GEN4_SCALES.some(([id]) => id === preset.scale?.scale)
    ? preset.scale.scale
    : 'off';
  onGlobalScaleChanged();

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
    const isMixerPan =
      genIdx === 5 &&
      (() => {
        const [busId, paramKey] = typeof key === 'string' ? key.split(':') : [];
        return FX_BUS_IDS.includes(busId) && paramKey === 'pan';
      })();
    const modSourceIdx = typeof sourceIdx === 'number' ? sourceIdx : lfoIdx;
    if (
      (isGranularParam || isGen3Param || isFxParam || isGen4Param || isMixerPan) &&
      modSourceIdx >= 0 &&
      modSourceIdx <= 4
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
  applyInstrumentMixState();
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

// ── Project file export/import ── version 2 is a compact binary container:
// a small JSON manifest followed by raw Float32 audio blocks. Unlike the old
// base64-in-JSON format, it never creates several enormous temporary strings
// for a long mastering track. Import still accepts version-1 .grnsh.json.

const PROJECT_FILE_MAGIC = 'GRNSH2\r\n'; // exactly 8 UTF-8 bytes

function base64ToFloats(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Same conditions as persistAudioForScope, but audio samples become direct
// Blob parts. Descriptors use offsets relative to the binary audio payload.
function captureExportAudioBinary() {
  const audio = {};
  const parts = [];
  let byteOffset = 0;
  const addSamples = (samples) => {
    const descriptor = { offset: byteOffset, length: samples.length };
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    parts.push(bytes);
    byteOffset += bytes.byteLength;
    return descriptor;
  };
  for (let genIdx = 0; genIdx < 2; genIdx++) {
    const source = getSourceState(genIdx);
    if (source.mode === 'file' && source.bufferData) {
      audio[`gen${genIdx}`] = {
        mode: 'file',
        samples: addSamples(source.bufferData),
        sampleRate: audioCtx?.sampleRate || 48000,
        durationSec: source.durationSec,
        fileName: source.fileName,
      };
    } else if (source.mode === 'mic' && source.frozenData && state[genIdx].freeze) {
      audio[`gen${genIdx}`] = {
        mode: 'frozen',
        samples: addSamples(source.frozenData.samples),
        frozenAt: source.frozenData.frozenAt,
        sampleRate: source.frozenData.sampleRate,
      };
    }
  }
  const ms = MASTERING.source;
  if (ms?.left?.length) {
    audio.master = {
      mode: 'master',
      left: addSamples(ms.left),
      right: addSamples(ms.right),
      sampleRate: ms.sampleRate,
      name: ms.name,
    };
  }
  return { audio, parts };
}

async function writeProjectFileStream(suggestedName, headerParts, audioParts) {
  if (typeof window.showSaveFilePicker !== 'function') return false;
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: 'grnsh project',
          accept: { 'application/octet-stream': ['.grnsh'] },
        },
      ],
    });
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    return false;
  }
  const writable = await handle.createWritable();
  try {
    for (const part of headerParts) await writable.write(part);
    const chunkBytes = 8 * 1024 * 1024;
    for (const part of audioParts) {
      for (let offset = 0; offset < part.byteLength; offset += chunkBytes) {
        await writable.write(part.subarray(offset, Math.min(offset + chunkBytes, part.byteLength)));
      }
    }
    await writable.close();
    return true;
  } catch (error) {
    try {
      await writable.abort();
    } catch (e) {}
    throw error;
  }
}

async function exportProjectFile() {
  const name = currentProjectName || getProjectNameInput()?.value.trim() || 'grnsh-project';
  const { audio, parts } = captureExportAudioBinary();
  const payload = {
    format: 'grnsh-project',
    version: 2,
    audioEncoding: 'float32-binary',
    name,
    savedAt: Date.now(),
    data: capturePreset(),
    audio,
  };
  const encoder = new TextEncoder();
  const magic = encoder.encode(PROJECT_FILE_MAGIC);
  const manifest = encoder.encode(JSON.stringify(payload));
  const manifestSize = new ArrayBuffer(4);
  new DataView(manifestSize).setUint32(0, manifest.byteLength, true);
  const fileName = `${name.replace(/[^\w.-]+/g, '_')}.grnsh`;
  setStatus(`exporting "${name}"…`);
  try {
    const streamed = await writeProjectFileStream(
      fileName,
      [magic, manifestSize, manifest],
      parts,
    );
    if (streamed === null) {
      setStatus('export cancelled');
      return;
    }
    if (streamed) {
      setStatus(`exported "${name}"`);
      return;
    }
  } catch (error) {
    setStatus(`export failed: ${error.message}`);
    return;
  }
  try {
    const blob = new Blob([magic, manifestSize, manifest, ...parts], {
      type: 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`exported "${name}"`);
  } catch (error) {
    setStatus(`export failed: ${error.message}`);
  }
}

async function readProjectFile(file) {
  const prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const magic = new TextDecoder().decode(prefix.subarray(0, 8));
  if (magic !== PROJECT_FILE_MAGIC) {
    return { payload: JSON.parse(await file.text()), readFloats: null };
  }
  if (prefix.byteLength < 12) throw new Error('truncated project header');
  const manifestLength = new DataView(
    prefix.buffer,
    prefix.byteOffset + 8,
    4,
  ).getUint32(0, true);
  const manifestStart = 12;
  const audioStart = manifestStart + manifestLength;
  if (manifestLength <= 0 || audioStart > file.size) throw new Error('invalid project header');
  const payload = JSON.parse(await file.slice(manifestStart, audioStart).text());
  const readFloats = async (descriptor) => {
    if (
      !descriptor ||
      !Number.isSafeInteger(descriptor.offset) ||
      !Number.isSafeInteger(descriptor.length) ||
      descriptor.offset < 0 ||
      descriptor.length < 0
    ) {
      throw new Error('invalid audio block');
    }
    const start = audioStart + descriptor.offset;
    const end = start + descriptor.length * Float32Array.BYTES_PER_ELEMENT;
    if (end > file.size) throw new Error('truncated audio block');
    return new Float32Array(await file.slice(start, end).arrayBuffer());
  };
  return { payload, readFloats };
}

async function importProjectFile(file) {
  let payload;
  let readFloats;
  try {
    ({ payload, readFloats } = await readProjectFile(file));
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
      const samples = readFloats
        ? await readFloats(clip.samples)
        : base64ToFloats(clip.samples);
      await applyRestoredClip(genIdx, { ...clip, samples });
    } catch (e) {}
  }
  const masterClip = payload.audio?.master;
  if (masterClip?.left && masterClip.right) {
    try {
      const left = readFloats
        ? await readFloats(masterClip.left)
        : base64ToFloats(masterClip.left);
      const right = readFloats
        ? await readFloats(masterClip.right)
        : base64ToFloats(masterClip.right);
      setMasteringSource(
        left,
        right,
        masterClip.sampleRate || 48000,
        masterClip.name,
      );
    } catch (e) {}
  } else {
    clearMasteringSource();
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

// ECO: one gesture that powers off every FX unit currently doing nothing —
// mix at 0, no modulation on the mix — across all four buses. Unlike the
// automatic idle bypass (stateless units only), this also unplugs the
// capture-style units (beat repeat, grain arp, delay), trading their warm
// rings for CPU; the power switches show exactly what it turned off.
function ecoizeFx() {
  let count = 0;
  FX_BUS_IDS.forEach((busId) => {
    DEFAULT_FX_ORDER.forEach((id) => {
      const st = fxStates[busId][id];
      if (!st || st.enabled === false) return;
      if ((st.mix ?? 0) > 0 || lfoMappings.has(`3:${id}:mix`)) return;
      if (id === 'grainarp' && st.hold) return; // latched — actively in use
      st.enabled = false;
      count++;
    });
  });
  if (!count) {
    setStatus('eco: nothing idle to power off');
    return;
  }
  FX_BUS_IDS.forEach((busId) => reconnectFxChain(busId));
  renderActiveBusFx();
  refreshBackPanelState();
  historyCaptureNow();
  setStatus(`eco: powered off ${count} idle FX unit${count === 1 ? '' : 's'}`);
}

function buildFxUI() {
  const container = document.getElementById('fx-chain');

  // Column header — names the instrument whose chain is shown/edited.
  const header = document.createElement('div');
  header.className = 'col-header';
  header.innerHTML =
    '<span class="col-title"><span class="col-dot"></span>FX — <span id="fxActiveLabel"></span></span>';
  const ecoBtn = document.createElement('button');
  ecoBtn.type = 'button';
  ecoBtn.id = 'fxEcoBtn';
  ecoBtn.className = 'fx-eco-btn';
  ecoBtn.textContent = 'ECO';
  ecoBtn.title =
    'Power off every inaudible FX unit (mix at 0, unmodulated) on all instruments — frees CPU';
  ecoBtn.addEventListener('click', ecoizeFx);
  header.appendChild(ecoBtn);
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
  grainArpPatternButtons.clear();
  DEFAULT_FX_ORDER.forEach((effectId) => fxPresetSelects.delete(effectId));

  const fxDefById = new Map(FX_DEFS.map((def) => [def.id, def]));
  fxOrders[activeBus].forEach((fxId) => {
    const def = fxDefById.get(fxId);
    if (!def) return;
    const { section, header, content, toggle } = createFxSection(def.label);
    const presetSelect = buildFxPresetSelect(def.id);
    if (presetSelect) header.insertBefore(presetSelect, toggle);

    // Power switch: off unplugs the unit from this bus's chain (zero CPU).
    const powerBtn = document.createElement('button');
    powerBtn.type = 'button';
    powerBtn.className = 'fx-power';
    powerBtn.title = 'On/off — off unplugs the unit from the chain (saves CPU)';
    const syncPower = () => {
      const on = FX[def.id].enabled !== false;
      powerBtn.classList.toggle('active', on);
      section.classList.toggle('fx-off', !on);
      powerBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    powerBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      FX[def.id].enabled = FX[def.id].enabled === false;
      syncPower();
      reconnectFxChain(activeBus);
    });
    header.insertBefore(powerBtn, header.firstChild);
    syncPower();

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

    if (def.id === 'grainarp') {
      const modeRow = document.createElement('div');
      modeRow.className = 'fx-mode-row';
      GRAINARP_PATTERNS.forEach(([mode, label]) => {
        const btn = document.createElement('button');
        btn.className = 'fx-mode-btn' + (FX.grainarp.pattern === mode ? ' active' : '');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          markFxPresetCustom(def.id);
          FX.grainarp.pattern = mode;
          applyGrainArpPattern();
          refreshGrainArpPatternUI();
          refreshBackPanelState();
        });
        grainArpPatternButtons.set(mode, btn);
        modeRow.appendChild(btn);
      });
      content.appendChild(modeRow);

      // HOLD latch — freezes the capture ring so the arp loops the latched
      // material. A performance gesture, so it never marks the preset custom.
      const holdRow = document.createElement('div');
      holdRow.className = 'fx-mode-row';
      grainArpHoldButton = document.createElement('button');
      grainArpHoldButton.type = 'button';
      grainArpHoldButton.className = 'fx-mode-btn' + (FX.grainarp.hold ? ' active' : '');
      grainArpHoldButton.textContent = 'HOLD';
      grainArpHoldButton.title = 'Freeze the capture ring — the arp keeps looping what it holds';
      grainArpHoldButton.addEventListener('click', () => {
        FX.grainarp.hold = !FX.grainarp.hold;
        applyGrainArpHold();
        refreshGrainArpHoldUI();
        refreshBackPanelState();
      });
      holdRow.appendChild(grainArpHoldButton);
      content.appendChild(holdRow);
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
          if (def.id === 'grainarp' && p.key === 'grid') {
            if (FX.grainarp.gridSync) {
              FX.grainarp.gridSyncIndex = Math.round(v);
            } else {
              FX.grainarp.grid = v;
            }
            applyFx('grainarp', 'grid', getBaseFxValue('grainarp', 'grid'));
            refreshModulationVisuals();
            refreshBackPanelState();
            return;
          }
          if (def.id === 'resonator' && p.key === 'freq') {
            if (FX.resonator.noteMode) {
              FX.resonator.note = Math.round(v);
            } else {
              FX.resonator.freq = v;
            }
            if (isMappable) applyFxModulation();
            else applyFx('resonator', 'freq', getBaseFxValue('resonator', 'freq'));
            refreshResonatorIntervalUI();
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

      if (def.id === 'grainarp' && p.key === 'grid') {
        grainArpGridSyncModeControl = buildSyncModeRow(FX.grainarp.gridSync, (mode) => {
          markFxPresetCustom(def.id);
          FX.grainarp.gridSync = mode === 'sync';
          refreshGrainArpGridUI();
          applyFx('grainarp', 'grid', getBaseFxValue('grainarp', 'grid'));
          refreshModulationVisuals();
          refreshBackPanelState();
        });
        content.appendChild(grainArpGridSyncModeControl);
      }

      if (def.id === 'resonator' && p.key === 'freq') {
        resonatorNoteModeControl = buildSyncModeRow(
          FX.resonator.noteMode,
          (mode) => {
            markFxPresetCustom(def.id);
            FX.resonator.noteMode = mode === 'note';
            refreshResonatorFreqUI();
            if (isMappable) applyFxModulation();
            else applyFx('resonator', 'freq', getBaseFxValue('resonator', 'freq'));
            refreshModulationVisuals();
            refreshBackPanelState();
          },
          [
            ['free', 'Free'],
            ['note', 'Note'],
          ],
        );
        content.appendChild(resonatorNoteModeControl);
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
  refreshGrainArpGridUI();
  refreshGrainArpPatternUI();
  refreshGrainArpHoldUI();
  refreshResonatorFreqUI();
  // Freshly built controls start with unlit map LEDs — re-apply the active
  // mappings so a bus switch/reorder/preset never hides live modulation.
  refreshLFOMappingUI();
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
  if (source.mode === 'file') {
    // No data yet → a silent stub, so the worklet never falls back to the
    // live input while the generator claims to be a file source.
    const workletBuffer = source.bufferData ? source.bufferData.slice() : new Float32Array(2048);
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
    // Switch even with nothing loaded — an empty file source is silent
    // instead of trapping the generator in mic mode.
    source.mode = 'file';
    setSourceDurationSec(genIdx, source.bufferData ? source.durationSec : LIVE_SOURCE_SECONDS);
    refreshSourceModeUI(genIdx);
    if (!source.bufferData) setStatus('file source — drop a .wav on the panel');
    if (source.bufferData || node) {
      await ensureGranularEngine();
      await syncGranularSourceState(genIdx);
    }
    // The mic stream dies once no generator listens to it.
    if (!anyMicSourceSelected()) disconnectGranularInput({ stopTracks: true });
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
  resonatorModulePromise = null;
  grainArpModulePromise = null;
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

document
  .getElementById('bounceBtn')
  ?.addEventListener('click', (e) => bounceSong({ invert: e.shiftKey }));

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
// The back panel (hundreds of DOM nodes) is built lazily on first entry to
// the back view — see setUIView. State restores don't need its DOM anymore.
buildVisualPanel();
buildMixerPanel();
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
// Autosave serializes the whole workspace — run it in idle time so the write
// never lands in the middle of a frame the sequencer needs.
setInterval(() => {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => writeAutosave(), { timeout: 4000 });
  } else {
    writeAutosave();
  }
}, AUTOSAVE_INTERVAL_MS);
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
    clearGen4LockSelection();
  }
  if (event.key === 'Tab' && !event.target.closest('input, textarea, select')) {
    event.preventDefault();
    const currentIndex = TAB_PANEL_VIEWS.indexOf(UI_VIEW.mode);
    if (currentIndex < 0) {
      setPanelView('front');
    } else {
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex =
        (currentIndex + direction + TAB_PANEL_VIEWS.length) % TAB_PANEL_VIEWS.length;
      setPanelView(TAB_PANEL_VIEWS[nextIndex]);
    }
  }
  if (event.code === 'Space' && !event.target.closest('input, textarea, select')) {
    // preventDefault also swallows the "space clicks the focused button"
    // default, so a focused ▶ doesn't toggle twice.
    event.preventDefault();
    // Master view owns the transport: Space plays/pauses the mastering
    // preview there, the loop/song transport everywhere else.
    if (UI_VIEW.mode === 'master') toggleMasteringPreview();
    else stripPlayToggle();
  }
});

// Capture phase: inputs that stopPropagation (rename fields, fx headers)
// must never let ⌘S fall through to the browser's save-page dialog.
window.addEventListener(
  'keydown',
  (event) => {
    // Before the dialog-open guard so it also closes an open settings menu.
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault();
      document.getElementById('settingsMenuBtn')?.click();
      return;
    }
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
