// Gen 4 note-editor UI state: which editor is showing, which lane and step
// are selected, and the elements the roll draws into. Grouped in one object
// because these are reassigned as the panel is built and torn down, which a
// module import cannot express.

import { GEN4_DEFS } from './defs.js';

export const gen4Ui = {
  editorMode: 'grid', // 'grid' | 'note'
  selectedNoteChannel: Math.max(
    0,
    GEN4_DEFS.findIndex((def) => def.id === 'fm'),
  ),
  gridEl: null,
  hintsEl: null,
  noteEditorEl: null,
  noteRollEl: null,
  noteStepNumberEls: [], // roll header numbers — double as lock-step selectors
  notePencilEnabled: true,
  noteCellEls: Array.from({ length: 32 }, () => new Map()),
  notePlayheadStep: -1,
  lockSelection: null,
  lockClearBtn: null,
};

// Live bindings from the built panel back to its controls and elements.
export const gen4ControlBindings = GEN4_DEFS.map(() => new Map());

export const gen4EditorModeButtons = new Map();

export const gen4NoteLaneButtons = new Map();

export const gen4FxSendBtns = [];

export const gen4ParamSections = new Map();

export const gen4PresetSelects = new Map();

export const gen4StepEls = GEN4_DEFS.map(() => new Array(32).fill(null));

export const gen4NoteDrawState = {
  active: false,
  action: 'draw',
  pointerId: null,
  visited: new Set(),
};

export const gen4FillState = { active: false, loopId: null, pattern: null };
