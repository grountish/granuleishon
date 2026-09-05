// Loop and song arrangement state.
//
// The edited loop's pattern arrays are bound by reference into GEN4.channels,
// GEN3.lockedMidis and STEP_SEQ, so the editing UI mutates the loop directly.
// Playback instead resolves patterns through getSchedulerLoop(), which in
// song mode follows the arrangement cursor.

export const PLAY = { mode: 'loop' }; // 'loop' | 'song'

export const LOOPS = {
  list: [],
  editIndex: 0,
  counter: 0,
};

export const SONG = {
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
  // Free-floating annotations on the song view: [{ x, y, text }], x/y as
  // fractions of the orbit stage so they keep their spot at any size.
  notes: [],
};

export const SONG_REPEAT_CYCLE = [1, 2, 4, 8, 16];
// Song-level play conditions, counted per visit to the entry — same idea as
// step trig conditions, one level up: 1:2 plays the 1st of every 2 visits.
export const SONG_CONDITIONS = [
  { id: 'always', label: '—' },
  { id: '1:2', label: '1:2', a: 1, b: 2 },
  { id: '2:2', label: '2:2', a: 2, b: 2 },
  { id: '1:4', label: '1:4', a: 1, b: 4 },
  { id: '4:4', label: '4:4', a: 4, b: 4 },
];
export const SONG_JUMP_COUNTS = [0, 1, 2, 4, 8]; // 0 = unlimited

// ── Song morph ── while an entry with `morph ×N` runs its final N cycles,
// the worklet hears a blend between this block's gens and the next block's,
// ramped by playback position. Numeric params interpolate; anything else
// snaps at the midpoint; freeze stays engine state. updateSongMorph drives t
// per display frame; the blend lives inside sendParams so a knob tweak
// mid-morph re-sends blended values, never raw ones.
export const SONG_MORPH = { t: 0, gens: null, loop: null };
