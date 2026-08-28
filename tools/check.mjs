// Static checks for the grnsh sources. No dependencies, no build step.
//
//   node tools/check.mjs
//
// Exists because a mechanical rename once turned an object shorthand
// (`activeBus,`) into a member expression (`BUS.active,`), which is invalid in
// an object literal and broke the whole file. Diffing the rename could not see
// that — only a parser can. Everything here is cheap enough to run after every
// edit.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRS = ['src', 'worklets'];

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(rel)));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

const problems = [];
const note = (file, message) => problems.push({ file, message });

// ── 1. Every file parses ────────────────────────────────────────────────────
// node treats a bare .js as CommonJS, where `import` is a syntax error, so the
// files are copied to .mjs first. Worklets have no imports and parse either way.
async function checkSyntax(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'grnsh-check-'));
  try {
    for (const file of files) {
      const copy = path.join(dir, file.replaceAll(path.sep, '_') + '.mjs');
      await writeFile(copy, await readFile(path.join(ROOT, file)));
      try {
        await run(process.execPath, ['--check', copy]);
      } catch (err) {
        const detail = String(err.stderr || err.message)
          .split('\n')
          .filter((l) => l.trim() && !l.includes(copy) && !l.startsWith('    at '))
          .slice(0, 3)
          .join(' ');
        const line = String(err.stderr || '').match(/\.mjs:(\d+)/)?.[1];
        note(line ? `${file}:${line}` : file, `does not parse — ${detail}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 2. Every import resolves to a real export ───────────────────────────────
const NAMED = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gs;
const DEFAULT_IMPORT = /import\s+(\w+)\s+from\s+'([^']+)'/g;
const exportOf = (src, name) =>
  new RegExp(`^export\\s+(?:const|let|function|async function|class)\\s+${name}\\b`, 'm').test(src);

async function checkImports(files) {
  const sources = new Map();
  for (const f of files) sources.set(f, await readFile(path.join(ROOT, f), 'utf8'));

  for (const [file, src] of sources) {
    const resolve = (spec) => path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), spec));
    for (const [, names, spec] of src.matchAll(NAMED)) {
      const target = resolve(spec);
      if (!existsSync(path.join(ROOT, target))) {
        note(file, `imports from missing file ${spec}`);
        continue;
      }
      const mod = sources.get(target) ?? (await readFile(path.join(ROOT, target), 'utf8'));
      for (const raw of names.split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (name && !exportOf(mod, name)) note(file, `imports ${name}, not exported by ${spec}`);
      }
    }
    for (const [, , spec] of src.matchAll(DEFAULT_IMPORT)) {
      const target = resolve(spec);
      if (!existsSync(path.join(ROOT, target))) note(file, `imports from missing file ${spec}`);
      else if (!(sources.get(target) ?? '').includes('export default'))
        note(file, `imports a default from ${spec}, which has none`);
    }
  }
}

// ── 3. No name declared twice at the top level of one file ──────────────────
async function checkDuplicates(files) {
  for (const file of files) {
    const src = await readFile(path.join(ROOT, file), 'utf8');
    const seen = new Map();
    for (const [, name] of src.matchAll(
      /^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    for (const [name, count] of seen) {
      if (count > 1) note(file, `${name} is declared ${count} times at the top level`);
    }
  }
}

// ── 4. Every worklet workletUrl() asks for actually exists ──────────────────
async function checkWorklets(files) {
  for (const file of files) {
    const src = await readFile(path.join(ROOT, file), 'utf8');
    for (const [, name] of src.matchAll(/workletUrl\('([^']+)'\)/g)) {
      if (!existsSync(path.join(ROOT, 'worklets', name))) note(file, `worklets/${name} does not exist`);
    }
  }
}

// Blank out comments and string bodies so a scan sees only code. Replacing
// with spaces rather than deleting keeps offsets, and so keeps line numbers.
function codeOnly(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      out += c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += src[i] ?? ''; i++;
    } else { out += c; i++; }
  }
  return out;
}

// ── 5. Every name a file uses is local, imported, or a known global ────────
// The gap a parser leaves: a moved function that left a dependency behind
// compiles fine and throws ReferenceError the first time it runs. Real scope
// analysis is out of scope here, so this reports only names it can be
// confident about — ones another module exports, or ones only app.js declares.
// A local coincidentally sharing such a name is a false positive, and worth a
// look anyway.
const GLOBALS = new Set([
  // language
  'globalThis','undefined','NaN','Infinity','Object','Array','String','Number','Boolean','Symbol',
  'BigInt','Math','JSON','Date','RegExp','Error','TypeError','RangeError','SyntaxError','Promise',
  'Map','Set','WeakMap','WeakSet','Proxy','Reflect','Intl','parseInt','parseFloat','isNaN',
  'isFinite','encodeURIComponent','decodeURIComponent','structuredClone','queueMicrotask',
  'ArrayBuffer','DataView','Uint8Array','Uint16Array','Uint32Array','Int8Array','Int16Array',
  'Int32Array','Float32Array','Float64Array','Uint8ClampedArray','console','Function','arguments',
  // browser
  'window','document','navigator','location','history','localStorage','sessionStorage','fetch',
  'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','alert',
  'cancelAnimationFrame','requestIdleCallback','performance','Blob','File','FileReader','URL',
  'URLSearchParams','FormData','Headers','Request','Response','Image','Audio','Worker','Event',
  'CustomEvent','EventTarget','MutationObserver','ResizeObserver','IntersectionObserver',
  'getComputedStyle','matchMedia','devicePixelRatio','indexedDB','IDBKeyRange','crypto','screen',
  'HTMLElement','Element','Node','SVGElement','DOMParser','XMLHttpRequest','AbortController',
  'TextEncoder','TextDecoder','CSS','KeyboardEvent','MouseEvent','PointerEvent','DragEvent',
  // web audio + worklets
  'AudioContext','webkitAudioContext','OfflineAudioContext','AudioWorkletNode','AudioBuffer',
  'AudioWorkletProcessor','registerProcessor','sampleRate','currentTime','currentFrame',
  'MediaRecorder','GainNode','AnalyserNode','BiquadFilterNode',
]);

const DECLARED = new RegExp(
  String.raw`^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)`,
  'gm',
);

// Names bound anywhere in a file: declarations at any nesting, function and
// arrow parameters, destructuring patterns, catch bindings.
function boundNames(code) {
  const names = new Set();
  const add = (n) => n && /^[A-Za-z_$][\w$]*$/.test(n) && names.add(n);
  for (const [, n] of code.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(n);
  for (const [, n] of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(n);
  // parameter lists: function f(...), (...) =>, and method shorthand
  for (const [, params] of code.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*|\b[A-Za-z_$][\w$]*\s*)\(([^()]*)\)\s*(?:=>|\{)/g))
    for (const piece of params.split(',')) {
      // Strip destructuring punctuation first: `{ state }` must yield `state`,
      // not the brace.
      const bare = piece.replace(/[{}[\].]/g, ' ').trim();
      add(bare.includes(':') ? bare.split(':').pop().trim().split(/\s/)[0] : bare.split(/[=\s]/)[0]);
    }
  for (const [, p] of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(p);
  // destructuring targets: const { a, b: c } = / const [a, b] =
  for (const [, inner] of code.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g))
    for (const piece of inner.split(',')) {
      const t = piece.includes(':') ? piece.split(':')[1] : piece;
      add(t.trim().replace(/^\.\.\./, '').split(/[=\s]/)[0]);
    }
  return names;
}

async function checkReferences(files) {
  const sources = new Map();
  for (const f of files) sources.set(f, await readFile(path.join(ROOT, f), 'utf8'));

  const APP = path.join('src', 'app.js');
  const exportedBy = new Map(); // name -> module that exports it
  for (const [file, src] of sources) {
    if (file === APP) continue;
    for (const [, n] of src.matchAll(DECLARED)) if (/^export/.test(src.slice(src.indexOf(n) - 40, src.indexOf(n)))) exportedBy.set(n, file);
    for (const [, n] of src.matchAll(/^export\s+(?:const|let|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm))
      exportedBy.set(n, file);
  }
  const appOnly = new Set([...(sources.get(APP) ?? '').matchAll(DECLARED)].map((m) => m[1]));

  for (const [file, src] of sources) {
    const code = codeOnly(src);
    const known = new Set([...GLOBALS, ...boundNames(code)]);
    for (const [, names] of src.matchAll(NAMED))
      for (const raw of names.split(',')) known.add(raw.trim().split(/\s+as\s+/).pop());
    for (const [, n] of src.matchAll(DEFAULT_IMPORT)) known.add(n);

    const body = code.replace(/^import[^;]+;$/gm, '');
    const used = new Set(
      [...body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?=\(|\.[A-Za-z_$]|[,;)\]}])/g)].map((m) => m[1]),
    );
    for (const name of used) {
      if (known.has(name)) continue;
      if (exportedBy.has(name) && exportedBy.get(name) !== file)
        note(file, `uses ${name} without importing it — exported by ${exportedBy.get(name)}`);
      else if (file !== APP && appOnly.has(name))
        note(file, `references ${name}, which only app.js declares — left behind by a move?`);
    }
  }
}

// ── 6. serve.py parses ──────────────────────────────────────────────────────
// It re-execs itself when edited, so a syntax error there kills the dev server
// mid-session rather than at a moment you are looking at it.
async function checkServer() {
  try {
    await run('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())',
      path.join(ROOT, 'serve.py')]);
  } catch (err) {
    const detail = String(err.stderr || err.message).trim().split('\n').slice(-2).join(' ');
    note('serve.py', `does not parse — ${detail}`);
  }
}

const files = (await Promise.all(SOURCE_DIRS.map(jsFiles))).flat();
await checkSyntax(files);
await checkServer();
await checkImports(files);
await checkDuplicates(files);
await checkWorklets(files);
await checkReferences(files);

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} files\n`);
  for (const { file, message } of problems) console.error(`  ${file}\n    ${message}`);
  process.exit(1);
}
console.log(
  `✓ ${files.length} files + serve.py: parse, imports resolve, nothing declared twice,` +
    ` no module reaching back into app.js`,
);
