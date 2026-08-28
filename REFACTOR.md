# grnsh refactor plan — split `main.js`, abstract the repeated shapes

## Status

- [x] **Phase 1 — ES modules.** `main.js` → `src/app.js` with `type="module"`;
      processors → `worklets/`; `serve.py` watches subdirectories. (`b57979b`)
- [~] **Phase 2 — leaf modules.** `core/{util,theory,tempo,storage,dsp,input,events,engine}`,
      `render/{wav,state}`, `ui/{status,view,popover}`, `visual/{vizgl,state}`,
      `master/{specs,state,eq-plot}`, `mixer/state`, `link/state`,
      `modulation/state`, `sequencing/state`, `instruments/*`.
      **Not moved:** the knob widget and control row — see below.
- [x] **Phase 3 — own the globals.** Two different problems, two solutions.
      A `const` container that is *mutated but never reassigned* crosses a
      module boundary under its own name, so ~20 of them moved with **no
      rename at all**. Only genuinely reassigned bindings needed renaming:
      `audioCtx`/`node`/`master`/`started`/`micStream`/`granularInputSource`
      became fields on `engine` (`core/engine.js`), and `activeBus`/`FX`
      became `BUS.active`/`BUS.fx` (`fx/state.js`).
- [x] **Phase 4 — FX unit registry.** Each effect declares itself in one file
      under `src/fx/units/` — data, `build`, `apply`, `applyAll` — and
      `fx/registry.js` derives every table plus the wet/dry scaffold.
      `buildBusFx` went 389 → 87 lines and names no effect.
      **Still in app.js:** `extraUI` and the back-panel `subtitle` lines.
- [ ] **Phase 5 — feature folders.** Barely started, and it is now the bulk of
      what is left. See "What remains" below.
- [~] **Phase 6 — shared abstractions.** Done: **E** the event bus
      (`core/events.js`, 65 `refreshBackPanelState()` calls → `emit('state')`),
      **D** floating-menu positioning (`ui/popover.js`, 6 copies → 1),
      **C** tempo-synced params (`fx/tempo-sync.js`, 10 consts and 5 refresh
      functions → one table). **Not done: A** (`bindParamControls` across the
      five param families) and **B** (per-module `serialize`/`restore`).
- [x] **Phase 7 — CSS.** `style.css` is now 12 `@import`s into `styles/*.css`,
      verified byte-identical in import order so no rule changed precedence.

`src/app.js`: **21,273 → 18,044 lines**, with 41 JS modules and 12 stylesheets
split out.

## What remains

`src/app.js` is **21,273 → 17,297 lines**, with 44 JS modules and 12
stylesheets split out.

Phase 5 is the long tail, and a dependency-closure analysis changed what I
think it is worth. For each section, take its functions and follow every call
transitively: most sections pull in **150–450 further functions**, which is to
say half the file. `app.js` is one densely mutually-recursive call graph, not a
set of features that happen to share a file.

Only one cluster came back separable, and it has been extracted: gen 4 note
editing, 35 functions that plenty of code calls into and that call nothing
back out (`instruments/gen4/note-editor.js`). The measurement is worth
re-running before attempting more:

    functions in a section, and how many more its call closure drags in

    Trig conditions        21 own  +1     ← extracted
    Note generators        12 own  +13    ← extracted
    Visualizer             58 own  +135
    Mastering view         17 own  +164
    LFO                    12 own  +166
    Metering               22 own  +170
    Gen 3: Oscillator      32 own  +183
    Song entry ops          6 own  +400
    Project file I/O       25 own  +448

So further splitting is not a matter of finding the right seams — there are no
more clean seams. It needs the graph broken deliberately: invert calls through
the event bus (`core/events.js`), or move a whole feature and its closure at
once. Both are per-call judgement rather than mechanical moves, and neither is
verifiable by construction the way everything so far has been.

The deferred phase-6 items are the riskier two: **A** (`bindParamControls`
across the five param families) touches every control in the app, and **B**
(per-module `serialize`/`restore`) touches preset serialization, where a
mistake silently corrupts saved projects rather than breaking loudly.

The knob widget and control row are still in `app.js` for the same reason they
were at the start: they reach into modulation visuals and the knob context
menu, so they want their feature cluster moved with them.

## Checking your work

`node tools/check.mjs` — parses every source, resolves every import against
the target's actual exports, rejects duplicate top-level declarations, and
rejects any module referencing a name only `app.js` declares. That last one is
the check a parser cannot do for you: a moved function that left a dependency
behind compiles fine and throws `ReferenceError` when it runs.

Two verification habits earned their keep and are worth continuing:

- **Diff a rename against the previous revision** and confirm every changed
  line differs *only* by the intended substitution. This caught a corrupted
  `INPUT_GATE` property key mid-rename.
- **Diff a move and confirm it contains only deletions plus new imports**, no
  changed lines. That is what makes a "pure move" claim checkable.

Neither replaces running the app. A rename that is correct in content can
still be invalid in position — that is exactly how `activeBus,` became
`BUS.active,` and broke the build.

## Where we are

| Fact | Number |
| --- | --- |
| `main.js` | 21,273 lines, one classic `<script>`, one shared scope |
| top-level functions | ~648 |
| top-level `const` / `let` | ~300, of which **88 mutable `let` globals** |
| `getElementById` call sites | 80 |
| `refreshBackPanelState()` call sites | 66 |
| `buildBusFx` / `applyPreset` / `refreshBackPanelState` | 389 / 319 / 220 lines each |
| `style.css` | 5,947 lines |
| worklets | 9 files, already isolated (good boundary, keep) |
| tooling | none — `serve.py` static, no bundler, no tests |

Biggest regions (approx., by section comments): gen4 drums ~3,700 lines,
mastering ~3,000, FX chain (defs + node build + apply + UI + reorder)
~2,500, loops/song/orbit ~2,700, modulation + back panel ~1,400,
visualizer + WebGL ~1,600, persistence (autosave/history/projects/file
codec/audio db) ~1,600.

What already works in our favour: 46 `// ── Section ──` headers mark natural
seams; `capturePreset`/`applyPreset` is the single serialization hub;
`fxStates` is the single FX source of truth; every param family already
uses the same `{ key, label, min, max, step, value, unit }` def shape.

Module-switch hazards checked: **0** inline `onclick` handlers in
`index.html`, **0** `window.x =` assignments, **0** `var`. Flipping to ES
modules is low-risk.

## Goals

1. Any feature lives in one folder; a new FX unit is **one file**, not six
   touch points (today: `FX_DEFS`, `makeDefaultFxState`, `DEFAULT_FX_ORDER`,
   `buildBusFx`, `applyFx`, `renderActiveBusFx`, `BACK_AUDIO_CHAIN`,
   `refreshBackPanelState`, `FX_IDLE_BYPASS`, `FX_PRESETS`).
2. No bundler, no framework. Native ES modules served by `serve.py`.
3. App works and is committable after **every** step. Preset / autosave /
   `.grnsh` file shape stays byte-identical throughout (only internal
   organisation moves).
4. Mutable globals become owned state objects; cross-feature refreshes go
   through one tiny event bus instead of 66 direct calls.

## Target layout

```
index.html
style.css                 → later: @import per-feature sheets (optional)
worklets/                 *-processor.js (move; update workletUrl paths)
src/
  app.js                  bootstrap only: build UI, init order, start()
  core/
    engine.js             audioCtx / node / master / started + worklet loading
    events.js             on(evt, fn) / emit(evt, payload) — nothing else
    theory.js             midi↔hz, NOTE_NAMES, scales, snap helpers, harmonizer math
    tempo.js              TRANSPORT, TEMPO_SYNC_STEPS, beatsToSeconds, sync helpers
    format.js             formatNumericValue & friends
    storage.js            localStorage keys, IndexedDB audio db
    params.js             ParamDef type + bindParamControls() (see abstraction A)
  ui/
    knob.js               Knob widget (2857–3222 today)
    control-row.js        makeControlRow, sync-mode row
    popover.js            createPopover (abstraction D)
    confirm.js            appConfirm dialog
    tooltip.js
    views.js              PANEL_VIEWS, setPanelView, view toggle
    header.js             project menu, undo buttons, harmonizer dropdown
  fx/
    registry.js           FxUnit contract, bus build / reconnect / applyAll / idle splice
    presets.js
    panel.js              renderActiveBusFx + drag-reorder
    units/                one file per effect:
      filter.js sat.js bitreduce.js pitchtrem.js autotune.js delay.js
      beatrepeat.js grainarp.js resonator.js reverb.js limiter.js
  instruments/
    granular/  params.js sources.js ui.js viz.js
    gen3/      state.js synth.js arp.js ui.js
    gen4/      state.js defs.js kits.js grid-ui.js note-editor.js locks.js
               generators.js transforms.js trig-conditions.js scheduler.js
  sequencing/
    scheduler.js          transport-locked events
    loops.js              LOOPS, create/serialize/deserialize/switch
    song.js               SONG entries, jumps, morph, cursor/playback
    song-ui/              loops-bar.js lane.js editor.js orbit.js block-menu.js
  modulation/
    lfo.js mappings.js step-seq.js back-panel.js
  mixer/     state.js ui.js
  master/    state.js dsp.js metering.js eq-plot.js presets.js ui.js
  render/    bounce.js stems.js record.js wav.js
  persistence/
    preset.js             capturePreset / applyPreset — composes per-module serialize/restore
    autosave.js history.js projects.js project-file.js
  link/      link.js
  visual/    viz.js vizgl.js
```

Dependency direction (enforced by convention, checked by eye in review):

```
core  ←  ui  ←  fx / instruments / sequencing / modulation / mixer / master / render / visual / link
                                 ↑
                    persistence (imports everyone's serialize/restore)
                                 ↑
                              app.js
```

Rule: a module exports **functions and state objects**; it never runs code at
top level that calls another feature module. Only `app.js` runs init order.
This is what keeps circular imports from blowing up as TDZ errors.

## Phases

Each phase is independently shippable. One commit per bullet is fine; one per
phase is the minimum.

### Phase 0 — safety net (½ day)

- Export three real projects as `.grnsh` fixtures (`fixtures/*.grnsh`, gitignored
  audio if large). They are the regression oracle: after every phase, import each,
  `capturePreset()`, and diff against the pre-refactor capture. Manual run per
  `AGENTS.md` — the plan just gives you the button to press.
- Add `src/dev/snapshot-check.js` (dev-only, not loaded by `index.html`): logs
  a stable JSON hash of `capturePreset()` so the diff is a one-liner in the console.

### Phase 1 — flip to ES modules, move nothing (½ day)

- `index.html`: `<script type="module" src="src/app.js">`; `app.js` is the
  renamed `main.js` for now.
- Module scripts are deferred and strict. Verified above that nothing depends on
  sloppy mode or globals, so this should be a one-line change plus a smoke run.
- Move worklets to `worklets/`, update `workletUrl()`.

### Phase 2 — carve out leaf modules (1 day)

Pure functions and self-contained widgets with no shared mutable state. Cut,
paste, add `export`, add `import` at the top of `app.js`. Zero logic edits.

- `core/theory.js` — `midiToFreqHz`, `freqHzToMidi`, `midiNoteToFrequency`
  (dedupe with the former), `NOTE_NAMES` + `GEN4_ROOT_NAMES` (same array twice
  today), `GEN4_SCALES`, `snapMidiToGen4Scale`, harmonizer snap helpers,
  `computeAutotuneMask`.
- `core/tempo.js`, `core/format.js`, `core/storage.js` (IndexedDB audio db +
  every `*_STORAGE_KEY`).
- `render/wav.js` (encoder), `persistence/project-file.js` (binary container
  v2 codec — pure bytes in/out).
- `ui/knob.js`, `ui/confirm.js`, `ui/tooltip.js`, `fx/presets.js`,
  `master/presets.js`, `instruments/gen4/kits.js` (genre kit tables).
- `link/link.js` (PeerJS tempo sync — already self-contained).

### Phase 3 — own the globals (1 day)

Replace the 88 bare `let`s with state objects so they can cross module
boundaries by reference.

- `core/engine.js`: `export const engine = { ctx: null, node: null, master: null,
  started: false, micStream: null, modules: {} }`. Every `audioCtx` read becomes
  `engine.ctx`. `ensureAudioEngine`, `ensureFxModules`, `ensureGranularModule`,
  teardown/rebuild live here.
- `fx/registry.js`: `export const BUS = { active: 'gen0' }`; `FX` (the alias
  for `fxStates[activeBus]`) becomes `getFX()` — it is reassigned in 3 places
  today, a getter removes the reassignment hazard entirely.
- DOM element refs (`gen3ArpBtnEl`, `gen4GridEl`, `songExpandedEl`, …) move into
  a private `els` object inside the feature module that builds them. They stop
  being globals for free once the module exists.
- Timers and frame handles (`genVizFrame`, `gen4DisplayFrame`, `statusToastTimer`,
  …) same treatment.

### Phase 4 — the FX unit registry (2 days, highest payoff)

Today adding autotune touched 16 places across 6 concerns. Collapse to one
descriptor per effect:

```js
// src/fx/units/autotune.js
export default {
  id: 'autotune',
  label: 'Autotune',
  params: [ /* ParamDef[] */ ],
  defaults: () => ({ enabled: true, root: 0, scale: 'major', speed: 40, amount: 1, mix: 0 }),
  presets: [ /* … */ ],
  idleBypass: true,                 // unplug at mix 0
  build(ac, state) {                // returns { in, out, dry, wet, node? , … }
  },
  apply(nodes, key, value, state, ac) { … },   // one param → node
  applyAll(nodes, state, ac) { … },            // non-param state (mask, shape, mode)
  extraUI(content, state, ctx) { … },          // root/scale selects, mode buttons
  subtitle(state) { return `${…} wet`; },      // back-panel line
};
```

`registry.js` then owns the loops that today are hand-written per effect:
`buildBusFx` → `units.map(u => u.build())`, `applyFx` → `unit.apply()`,
`applyAllFx` → `unit.applyAll()`, `renderActiveBusFx` → generic knobs +
`unit.extraUI()`, back-panel subtitles → `unit.subtitle()`, `FX_IDLE_BYPASS`
→ `unit.idleBypass`, `DEFAULT_FX_ORDER` → registration order,
`makeDefaultFxState` → `Object.fromEntries(units.map(u => [u.id, u.defaults()]))`.

Migration: introduce the registry with the wrapper loops reading from unit
files, port effects one at a time (start with `sat` — smallest — end with
`delay` — most special cases), delete the if-chain branches as they go.
Tempo-synced params (abstraction C) land here too, since five of the six
sync-mode controls are FX params.

### Phase 5 — feature folders, largest first (3–4 days)

Order chosen so each cut removes the most lines from `app.js` early:

1. **mastering** (`master/`): state + dsp curves + metering tap + EQ plot +
   presets + panel. Already a “lazy panel”; it only needs `engine` and
   `persistence` hooks.
2. **gen4** (`instruments/gen4/`): split along the existing headers — grid UI,
   note editor, locks, kits, generators, transforms, trig conditions,
   scheduler. `GEN4` state + `GEN4_DEFS` in `state.js`/`defs.js`.
3. **loops & song** (`sequencing/`): state and ops first, then the four UIs
   (bar, lane, expanded editor, orbit) — the orbit view alone is ~800 lines.
4. **modulation** (`modulation/`): LFOs, mappings, step-seq, back panel.
5. **visual**, **render** (bounce/stems/record), **gen3**, **granular**,
   **mixer**, **persistence** (autosave/history/projects), **header/views**.

While moving, replace direct cross-feature refresh calls with events
(abstraction E). The 66 `refreshBackPanelState()` calls become
`emit('state')` and the back panel subscribes once.

### Phase 6 — shared abstractions (2 days, interleave with phase 5)

**A. `ParamDef` + `bindParamControls`.** Five param families share one def
shape (`PARAMS`, `GEN3_PARAM_DEFS`, `GEN4_DEFS[].paramDefs`, `FX_DEFS[].params`,
`MASTERING_CONTROL_SPECS`). One helper:
`bindParamControls(defs, state, { onChange, mapKey }) → { bindings: Map, refresh() }`.
Kills `refreshGen3UI`, `refreshFilterUI`, per-family binding maps, and the
copy-pasted `(v) => { state[key] = v; apply(); refreshModulationVisuals(); refreshBackPanelState(); }` closures.

**B. `serialize()` / `restore(data)` per module.** `capturePreset` becomes
`Object.assign({}, ...modules.map(m => m.serialize()))` and `applyPreset`
walks the same list. Preset **shape does not change** — each module returns
exactly the keys it owns today (`gen3`, `loops`, `fxByBus`, `mastering`, …).
Add `PRESET_VERSION` alongside for future migrations.

**C. `TempoSyncedParam`.** Six hand-rolled `{ sync, syncIndex, freeValue }`
triples (`delay.time`, `pitchtrem.rate`, `beatrepeat.interval`,
`beatrepeat.grid`, `grainarp.grid`, `resonator.freq/note`) each with its own
`*_SYNC_CONTROL` const and `refresh*UI`. One helper that owns the control
swap, the effective-value getter (`getBaseFxValue` special cases disappear)
and the sync-mode row.

**D. `createPopover(anchor, panel)`.** Six bespoke open/close/outside-click
menus (project, harmonizer, song block, knob context, mod source, variation).
One helper with `open/close/toggle`, outside-click and Escape.

**E. `events.js`.** ~20 lines: `on`, `off`, `emit`. Events: `state`
(anything changed → back panel / mod visuals), `bus` (active bus switched),
`transport`, `loop` (edit loop switched), `preset` (after restore). This is
the tool that breaks fx ↔ back-panel ↔ modulation cycles.

### Phase 7 — CSS (optional, ½ day)

`style.css` → `styles/{base,header,knob,fx,gen3,gen4,song,mixer,master,visual}.css`
pulled in via `@import` from `style.css`. Same cascade order as today's file
order. Worth doing after the JS split so folder names line up.

## Guardrails

- **TDZ / cycles.** Only `app.js` runs top-level code that touches other
  modules. A `const X = [...OTHER_MODULE_CONST]` at top level is fine only if
  the import is not part of a cycle; when in doubt make it a function.
- **Preset compatibility.** The phase-0 fixtures are the contract. No phase
  changes a key name; renames go through an explicit migration in
  `persistence/preset.js` with a version bump.
- **Autosave during refactor.** Autosave writes on an interval — keep the
  `restoreAutosave()` path working from step 1 or a broken build eats the
  user's session.
- **Cache.** `serve.py` disables caching and `workletUrl()` cache-busts; ES
  module imports get the same no-cache headers. Nothing extra needed.
- **Validation.** Per `AGENTS.md`, nothing runs automatically. After each
  phase the manual check is: load, start mic, play a loop, switch views,
  import a fixture, compare snapshot hash, undo/redo once.

## Estimated effort

| Phase | Days | Unlocks |
| --- | --- | --- |
| 0 safety net | 0.5 | regression oracle |
| 1 ES modules | 0.5 | everything else |
| 2 leaf modules | 1 | ~2,500 lines out of `app.js` |
| 3 own the globals | 1 | modules can share state |
| 4 FX registry | 2 | new FX = one file |
| 5 feature folders | 3–4 | `app.js` < 1,000 lines |
| 6 abstractions | 2 | param/sync/popover/event dedupe |
| 7 CSS | 0.5 | optional |

Roughly 10–12 focused days end to end; phases 1–4 alone (4 days) already
give the biggest day-to-day win.
