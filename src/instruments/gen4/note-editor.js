// Gen 4 note editing: the piano-roll cells, per-step parameter locks, trig
// conditions, and the generators that fill a lane (euclidean, arp, bass,
// melody, polyrhythm).
//
// This is the one part of app.js a dependency closure shows is separable —
// plenty of code calls in, none of it calls back out.

import { clamp } from '../../core/util.js';
import {
  GEN4_SCALE,
  formatMidiNote,
  freqHzToMidi,
  getGen4ScaleIntervals,
  isMidiInGen4Scale,
  snapMidiToGen4Scale,
} from '../../core/theory.js';
import { setStatus } from '../../ui/status.js';
import { PLAY, SONG } from '../../sequencing/state.js';
import { state } from '../granular/state.js';
import { GEN3, GEN3_PARAM_DEFS, gen3ControlBindings } from '../gen3/state.js';
import { GEN4 } from './state.js';
import {
  GEN4_DEFS,
  GEN4_NOTE_MIN,
  GEN4_NOTE_MAX,
  GEN4_PROB_CYCLE,
  GEN4_TRIG_CONDITIONS,
} from './defs.js';
import {
  gen4Ui,
  gen4ControlBindings,
  gen4EditorModeButtons,
  gen4NoteLaneButtons,
  gen4ParamSections,
  gen4PresetSelects,
  gen4NoteDrawState,
  gen4FillState,
  gen4StepEls,
} from './editor-state.js';

export function gen4ApplyStepBtn(ci, si) {
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

export function gen4CycleCondition(ci, si) {
  const ch = GEN4.channels[ci];
  ch.condition[si] = ((ch.condition[si] || 0) + 1) % GEN4_TRIG_CONDITIONS.length;
  gen4ApplyStepBtn(ci, si);
}

export function gen4StepConditionMet(pat, ci, step) {
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

export function gen4CycleProbability(ci, si) {
  const ch = GEN4.channels[ci];
  const idx = GEN4_PROB_CYCLE.indexOf(ch.probability[si]);
  ch.probability[si] = GEN4_PROB_CYCLE[(idx + 1) % GEN4_PROB_CYCLE.length];
  gen4ApplyStepBtn(ci, si);
}

export function frequencyToMidi(frequency) {
  return Math.round(freqHzToMidi(frequency));
}

// The midi window a lane can actually play: its tune/tone param range mapped
// to midi. Generators clamp into this so a hat never gets a C2 it can't voice
// (and the roll never hides a generated note).
export function getGen4LaneMidiRange(ci) {
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

export function getGen4BaseMidi(ci) {
  const ch = GEN4.channels[ci];
  if (ch.id === 'osc') return [...GEN3.lockedMidis][0] ?? 60;
  if (ch.id === 'smp') return clamp(Math.round(60 + ch.params.pitch), GEN4_NOTE_MIN, GEN4_NOTE_MAX);
  const key = ch.id === 'hat' ? 'tone' : 'tune';
  return frequencyToMidi(ch.params[key] || 261.63);
}

export function getGen4NoteFocusMidi(ci) {
  const ch = GEN4.channels[ci];
  const assigned = ch.notes.find((midi, si) => ch.steps[si] && Number.isFinite(midi));
  return Number.isFinite(assigned) ? assigned : getGen4BaseMidi(ci);
}

export function refreshGen4NoteStep(stepIdx) {
  const ch = GEN4.channels[gen4Ui.selectedNoteChannel];
  const selectedMidi = ch.steps[stepIdx] ? ch.notes[stepIdx] : null;
  const inheritedMidi =
    ch.steps[stepIdx] && !Number.isFinite(selectedMidi)
      ? clamp(getGen4BaseMidi(gen4Ui.selectedNoteChannel), GEN4_NOTE_MIN, GEN4_NOTE_MAX)
      : null;
  gen4Ui.noteCellEls[stepIdx].forEach((cell, midi) => {
    cell.classList.toggle('on', midi === selectedMidi);
    cell.classList.toggle('inherited', midi === inheritedMidi);
    cell.classList.toggle('step-inactive', stepIdx >= GEN4.stepCount);
  });
}

export function editGen4NoteCell(stepIdx, midi, action) {
  if (stepIdx >= GEN4.stepCount) return;
  const ch = GEN4.channels[gen4Ui.selectedNoteChannel];
  const currentMidi = Number.isFinite(ch.notes[stepIdx])
    ? ch.notes[stepIdx]
    : clamp(getGen4BaseMidi(gen4Ui.selectedNoteChannel), GEN4_NOTE_MIN, GEN4_NOTE_MAX);

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

  gen4ApplyStepBtn(gen4Ui.selectedNoteChannel, stepIdx);
  refreshGen4NoteStep(stepIdx);
}

export function editGen4NoteCellFromElement(cell) {
  if (!(cell instanceof HTMLElement) || !cell.classList.contains('drum-note-cell')) return;
  if (cell.classList.contains('step-inactive')) return;
  const stepIdx = Number(cell.dataset.step);
  const midi = Number(cell.dataset.midi);
  const visitKey = `${stepIdx}:${midi}`;
  if (gen4NoteDrawState.visited.has(visitKey)) return;
  gen4NoteDrawState.visited.add(visitKey);
  editGen4NoteCell(stepIdx, midi, gen4NoteDrawState.action);
}

export function refreshGen4NotePlayhead() {
  gen4Ui.noteCellEls[gen4Ui.notePlayheadStep]?.forEach((cell) => cell.classList.remove('current'));
  gen4Ui.notePlayheadStep =
    GEN4.displayStep >= 0 && GEN4.displayStep < GEN4.stepCount ? GEN4.displayStep : -1;
  gen4Ui.noteCellEls[gen4Ui.notePlayheadStep]?.forEach((cell) => cell.classList.add('current'));
}

export function refreshGen4NoteEditor() {
  gen4EditorModeButtons.forEach((btn, mode) => {
    btn.classList.toggle('active', mode === gen4Ui.editorMode);
  });
  gen4NoteLaneButtons.forEach((btn, ci) => {
    btn.classList.toggle('active', ci === gen4Ui.selectedNoteChannel);
  });
  if (gen4Ui.gridEl) gen4Ui.gridEl.hidden = gen4Ui.editorMode === 'notes';
  if (gen4Ui.hintsEl) gen4Ui.hintsEl.hidden = gen4Ui.editorMode === 'notes';
  if (gen4Ui.noteEditorEl) gen4Ui.noteEditorEl.hidden = gen4Ui.editorMode !== 'notes';
  if (gen4Ui.editorMode === 'notes') {
    for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
    refreshGen4NotePlayhead();
  }
}

export function hasGen4StepLocks(ci, si) {
  return Object.keys(GEN4.channels[ci]?.locks?.[si] || {}).length > 0;
}

// The OSC channel has no drum-panel knobs — its locks are edited through the
// gen3 panel itself. Non-null while lock mode has an OSC step selected.
export function getGen3StepLockTarget() {
  if (!gen4Ui.lockSelection) return null;
  if (GEN4_DEFS[gen4Ui.lockSelection.ci]?.id !== 'osc') return null;
  return GEN4.channels[gen4Ui.lockSelection.ci].locks[gen4Ui.lockSelection.si] || null;
}

export function refreshGen4LockEditor() {
  GEN4_DEFS.forEach((def, ci) => {
    for (let si = 0; si < 32; si++) {
      gen4StepEls[ci][si]?.classList.toggle(
        'lock-selected',
        gen4Ui.lockSelection?.ci === ci && gen4Ui.lockSelection?.si === si,
      );
    }
    const selected = gen4Ui.lockSelection?.ci === ci;
    const locks = selected ? GEN4.channels[ci].locks[gen4Ui.lockSelection.si] : null;
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
  gen4Ui.noteStepNumberEls.forEach((el, si) => {
    el?.classList.toggle(
      'lock-selected',
      gen4Ui.lockSelection?.ci === gen4Ui.selectedNoteChannel && gen4Ui.lockSelection?.si === si,
    );
  });
  gen4Ui.noteCellEls.forEach((cells, si) => {
    const on = gen4Ui.lockSelection?.ci === gen4Ui.selectedNoteChannel && gen4Ui.lockSelection?.si === si;
    cells.forEach((cell) => cell.classList.toggle('lock-selected', on));
  });
  if (gen4Ui.lockClearBtn) {
    gen4Ui.lockClearBtn.hidden = !gen4Ui.lockSelection;
    gen4Ui.lockClearBtn.disabled =
      !gen4Ui.lockSelection || !hasGen4StepLocks(gen4Ui.lockSelection.ci, gen4Ui.lockSelection.si);
  }
}

export function selectGen4LockStep(ci, si) {
  if (!GEN4.channels[ci]?.steps[si]) return;
  gen4Ui.lockSelection = { ci, si };
  gen4ParamSections.get(ci)?.setCollapsed(false);
  refreshGen4LockEditor();
}

// Same-step select again → deselect. The single entry point for both the
// grid's alt+click and the roll header's click.
export function toggleGen4LockStep(ci, si) {
  if (gen4Ui.lockSelection?.ci === ci && gen4Ui.lockSelection?.si === si) {
    gen4Ui.lockSelection = null;
    refreshGen4LockEditor();
    return;
  }
  selectGen4LockStep(ci, si);
}

// Notes-roll slot selection (pencil off): works on empty slots too — the
// clicked row is remembered, and the first param tweak materializes that
// note (see ensureGen4LockStepActive). Clicking the selected slot again
// deselects; clicking a different row of an empty selected slot re-aims it.
export function selectGen4NoteSlot(si, midi = null) {
  const ci = gen4Ui.selectedNoteChannel;
  const active = GEN4.channels[ci]?.steps[si];
  const sameSlot = gen4Ui.lockSelection?.ci === ci && gen4Ui.lockSelection?.si === si;
  if (sameSlot && (active || (gen4Ui.lockSelection.pendingMidi ?? null) === midi)) {
    clearGen4LockSelection();
    return;
  }
  gen4Ui.lockSelection = { ci, si, pendingMidi: midi };
  gen4ParamSections.get(ci)?.setCollapsed(false);
  refreshGen4LockEditor();
}

// A lock write on an empty selected slot creates the note first — at the
// clicked row, else inheriting the lane's base note. Returns the slot's
// locks object.
export function ensureGen4LockStepActive() {
  if (!gen4Ui.lockSelection) return null;
  const { ci, si, pendingMidi } = gen4Ui.lockSelection;
  const ch = GEN4.channels[ci];
  if (!ch) return null;
  if (!ch.steps[si]) {
    ch.steps[si] = true;
    ch.notes[si] = Number.isFinite(pendingMidi) ? pendingMidi : null;
    gen4ApplyStepBtn(ci, si);
    if (ci === gen4Ui.selectedNoteChannel) refreshGen4NoteStep(si);
  }
  return ch.locks[si];
}

export function clearGen4LockSelection() {
  if (!gen4Ui.lockSelection) return;
  gen4Ui.lockSelection = null;
  refreshGen4LockEditor();
}

export function clearSelectedGen4Locks() {
  if (!gen4Ui.lockSelection) return;
  const { ci, si } = gen4Ui.lockSelection;
  GEN4.channels[ci].locks[si] = {};
  gen4ApplyStepBtn(ci, si);
  refreshGen4LockEditor();
}

export function euclideanPattern(pulses, steps, rotation = 0) {
  const out = new Array(steps).fill(false);
  if (pulses <= 0) return out;
  for (let i = 0; i < steps; i++) {
    const j = (((i - rotation) % steps) + steps) % steps;
    out[i] = (j * pulses) % steps < pulses;
  }
  return out;
}

export function clearGen4Step(ch, si) {
  ch.steps[si] = false;
  ch.notes[si] = null;
  ch.timing[si] = 0;
  ch.locks[si] = {};
  ch.stutter[si] = 1;
  ch.probability[si] = 1;
  ch.condition[si] = 0;
}

export function repaintGen4NoteLane(ci) {
  for (let si = 0; si < 32; si++) gen4ApplyStepBtn(ci, si);
  renderGen4NoteRoll();
}

export function generateGen4Euclid(pulses, rotation) {
  const ci = gen4Ui.selectedNoteChannel;
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
export function generateGen4Polyrhythm(hits, rotation) {
  const ci = gen4Ui.selectedNoteChannel;
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
export function getGen4ArpChord() {
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
export function buildGen4ArpSequence(pool, played, mode) {
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

export function gen4ArpVelocity(shape, si, stepCount, cycleHit, seqLen) {
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

export function generateGen4Arp({ mode, octaves, everyN, repeat, velShape, chance, ratchet = 'off' }) {
  const ci = gen4Ui.selectedNoteChannel;
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
export function generateGen4Melody(contour, density) {
  const ci = gen4Ui.selectedNoteChannel;
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
export function getGen4BassRoot(range) {
  const locked = [...GEN3.lockedMidis];
  const root = locked.length ? Math.min(...locked) : 36 + GEN4_SCALE.root;
  // Prefer the bass register, but never fall below the lane's playable window.
  const hi = Math.min(60, range.max) < range.min ? range.max : Math.min(60, range.max);
  return clamp(root, range.min, hi);
}

export function generateGen4Bass(style) {
  const ci = gen4Ui.selectedNoteChannel;
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

export function renderGen4NoteRoll() {
  if (!gen4Ui.noteRollEl) return;
  gen4Ui.noteRollEl.textContent = '';
  gen4Ui.noteCellEls = Array.from({ length: 32 }, () => new Map());
  gen4Ui.notePlayheadStep = -1;
  const def = GEN4_DEFS[gen4Ui.selectedNoteChannel];
  const ch = GEN4.channels[gen4Ui.selectedNoteChannel];
  const laneRange = getGen4LaneMidiRange(gen4Ui.selectedNoteChannel);
  gen4Ui.noteEditorEl?.style.setProperty('--ch-color', def.color);
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
  gen4Ui.noteStepNumberEls = new Array(32).fill(null);
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
    gen4Ui.noteStepNumberEls[si] = number;
    stepHeader.appendChild(number);
  }
  gen4Ui.noteRollEl.appendChild(stepHeader);
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
        if (gen4Ui.notePencilEnabled) return;
        if (si >= GEN4.stepCount) return;
        // Pencil off = select mode: pick the slot for param editing; a knob
        // tweak on an empty slot creates this row's note with that value.
        selectGen4NoteSlot(si, midi);
      });
      gen4Ui.noteCellEls[si].set(midi, cell);
      row.appendChild(cell);
    }
    gen4Ui.noteRollEl.appendChild(row);
  });

  const requestedFocusMidi = getGen4NoteFocusMidi(gen4Ui.selectedNoteChannel);
  const focusMidi = visibleMidis.reduce(
    (closest, midi) =>
      Math.abs(midi - requestedFocusMidi) < Math.abs(closest - requestedFocusMidi) ? midi : closest,
    visibleMidis[0],
  );
  requestAnimationFrame(() => {
    const rowHeight = gen4Ui.noteRollEl.firstElementChild?.getBoundingClientRect().height || 18;
    const targetY = (visibleMidis.indexOf(focusMidi) + 1) * rowHeight;
    gen4Ui.noteRollEl.scrollTop = Math.max(0, targetY - gen4Ui.noteRollEl.clientHeight * 0.45);
  });
  for (let si = 0; si < 32; si++) refreshGen4NoteStep(si);
  refreshGen4NotePlayhead();
}
