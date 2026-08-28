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

// ── 5. No module reaches back into a name that only app.js declares ────────
// The gap a parser leaves: a function moved into a module still referencing
// something left behind compiles fine, then throws ReferenceError when run.
// Rather than attempt real scope analysis, this asks one precise question —
// does a module name something that only app.js declares and it did not
// import? A module's own local with a colliding name would be a false
// positive, and is worth a look anyway.
const DECLARED = new RegExp(
  String.raw`^(?:export\s+)?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)`,
  'gm',
);
async function checkNoReachBack(files) {
  const appSrc = await readFile(path.join(ROOT, 'src/app.js'), 'utf8');
  const appOnly = new Set([...appSrc.matchAll(DECLARED)].map((m) => m[1]));
  for (const file of files) {
    if (file === path.join('src', 'app.js')) continue;
    const src = await readFile(path.join(ROOT, file), 'utf8');
    // Locals count as declared too, at any nesting — otherwise a function
    // with its own `let start` looks like it is reaching into app.js.
    const own = new Set(
      [...src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    );
    for (const [, params] of src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g))
      for (const p of params.split(',')) {
        const n = p.trim().split(/[=:\s]/)[0].replace(/[{}[\].]/g, '');
        if (n) own.add(n);
      }
    for (const [, names] of src.matchAll(NAMED))
      for (const raw of names.split(',')) own.add(raw.trim().split(/\s+as\s+/).pop());
    for (const [, n] of src.matchAll(DEFAULT_IMPORT)) own.add(n);
    const body = codeOnly(src).replace(/^import[^;]+;$/gm, '');
    for (const name of appOnly) {
      if (own.has(name)) continue;
      if (new RegExp(String.raw`(?<![.\w$])${name}\s*(?=\(|\.[A-Za-z_$]|[,;)\]}])`).test(body))
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
await checkNoReachBack(files);

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} files\n`);
  for (const { file, message } of problems) console.error(`  ${file}\n    ${message}`);
  process.exit(1);
}
console.log(
  `✓ ${files.length} files + serve.py: parse, imports resolve, nothing declared twice,` +
    ` no module reaching back into app.js`,
);
