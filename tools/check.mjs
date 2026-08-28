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

const files = (await Promise.all(SOURCE_DIRS.map(jsFiles))).flat();
await checkSyntax(files);
await checkImports(files);
await checkDuplicates(files);
await checkWorklets(files);

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} files\n`);
  for (const { file, message } of problems) console.error(`  ${file}\n    ${message}`);
  process.exit(1);
}
console.log(`✓ ${files.length} files: parse, imports resolve, no duplicate declarations`);
