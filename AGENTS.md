# Repository Instructions

## Validation

Run `node tools/check.mjs` after editing any file under `src/` or `worklets/`,
and before committing. It is dependency-free and takes about a second. It
checks that every file parses, that every import resolves to a name the target
module actually exports, that nothing is declared twice at the top level of a
file, that no module references a name only `app.js` declares without importing
it, and that every worklet `workletUrl()` asks for exists. `serve.py` is parsed
too, since it re-execs itself when edited.

This is the one check that catches a file being *malformed* rather than
misbehaving. It was added after a mechanical rename turned an object shorthand
(`activeBus,`) into a member expression (`BUS.active,`) — valid-looking, and
invisible to a content-level diff, but it broke parsing of the whole file and
shipped. Prefer adding a case to that script over doing the check by eye.

Do not run any **other** validation unless explicitly asked. That includes:

- automated test suites
- linting beyond `tools/check.mjs`
- build verification
- browser previews or manual verification passes

The user tests behaviour manually and will report follow-up fixes. So the
split is: static checks that the code is well-formed are yours to run; checks
that it *does the right thing* are the user's.

## Layout

Sources are native ES modules under `src/`, loaded by `index.html` as
`<script type="module" src="src/app.js">`. There is no bundler and no npm
dependency. Audio worklet processors live in `worklets/` and are loaded at
runtime through `workletUrl()`, which resolves against the document root.
`style.css` is a list of `@import`s into `styles/*.css`; import order is
cascade order.

`REFACTOR.md` tracks the ongoing split of `src/app.js` into feature modules,
including what is done, what is left, and why.
