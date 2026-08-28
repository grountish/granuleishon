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
