#!/usr/bin/env node
// Builds a libDaisy firmware for the browser: the firmware's own sources
// (read from its Makefile, see make/Makefile), board/ in place of libDaisy's
// hardware layer, the hardware-free parts of libDaisy, and DaisySP, compiled
// with wasi-sdk into one WebAssembly module for web/simple-touch.js.
//
//   node scripts/build.mjs <firmware dir> [--out file.wasm] [--wasi-sdk dir]
//                          [--info build.json] [--jobs n] [--make make]
//
// Needs GNU make and wasi-sdk (--wasi-sdk, $WASI_SDK_PATH, or the newest in
// ~/.wasi-sdk). Objects go to
// <firmware>/build-web and are rebuilt only when a source, a header it
// includes, or the flags change. Prints the "emulator" block for the
// firmware's simple-touch-labels.json.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ABI = 'simple-touch-web/1';

// The libDaisy files that run unchanged: no hardware in them, or only
// hardware board/ provides.
const LIBDAISY_SOURCES = [
  'hid/midi.cpp', 'hid/midi_parser.cpp', 'hid/switch.cpp', 'hid/ctrl.cpp', 'hid/encoder.cpp',
  'hid/gatein.cpp', 'hid/parameter.cpp', 'hid/led.cpp', 'util/MappedValue.cpp', 'util/oled_fonts.c',
];

// ------------------------------------------------------------ arguments
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const outArg = option('--out');
const infoArg = option('--info');
const sdk = findSdk(option('--wasi-sdk', process.env.WASI_SDK_PATH));
const jobs = Math.max(1, Number(option('--jobs', os.cpus().length)));
const makeCmd = option('--make', process.env.MAKE || 'make');
const fw = path.resolve(args[0] || '.');

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

// The given folder, else the newest wasi-sdk-* in ~/.wasi-sdk. A Git Bash
// path (/c/Users/...) is turned into one Windows' Node understands.
function findSdk(given) {
  if (given) {
    const m = process.platform === 'win32' && /^\/([a-z])(\/.*)?$/i.exec(given);
    return m ? `${m[1]}:${m[2] ?? '/'}` : given;
  }
  const home = path.join(os.homedir(), '.wasi-sdk');
  const found = fs.existsSync(home)
    ? fs.readdirSync(home).filter((d) => d.startsWith('wasi-sdk-')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    : [];
  return found.length ? path.join(home, found.at(-1)) : null;
}
if (!sdk) fail('no wasi-sdk: unpack one into ~/.wasi-sdk (see README), set WASI_SDK_PATH, or pass --wasi-sdk <dir>');
const exe = process.platform === 'win32' ? '.exe' : '';
const CC = path.join(sdk, 'bin', `clang${exe}`);
const CXX = path.join(sdk, 'bin', `clang++${exe}`);
if (!fs.existsSync(CXX)) fail(`no clang++ in ${sdk}/bin`);

// ------------------------------------------------------------ the firmware's Makefile
const posix = (p) => p.replaceAll('\\', '/');

function makeVars(dir, makeArgs) {
  let text;
  try {
    text = execFileSync(makeCmd, ['-s', '--no-print-directory', '-C', dir, ...makeArgs], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    fail(`make could not read ${dir}/Makefile`);
  }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^STW (\w+)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

function readVars() {
  const vars = makeVars(fw, [`SYSTEM_FILES_DIR=${posix(path.join(STW, 'make'))}`, 'stw-vars']);
  if (!('CPP_SOURCES' in vars)) {
    fail('the Makefile did not include $(SYSTEM_FILES_DIR)/Makefile: see README, "Building"');
  }
  return vars;
}

// A library's own source list and include paths (DaisySP and DaisySP-LGPL
// each build a curated set of modules), relative to its folder.
function libraryVars(dir) {
  const vars = makeVars(dir, [
    '--eval', 'stw-lib: ; $(info STW CPP_SOURCES=$(CPP_SOURCES)) $(info STW C_INCLUDES=$(C_INCLUDES))',
    'stw-lib',
  ]);
  // Most entries come without their folder (the Makefile finds them with
  // vpath): look those up by name in the library's Source tree.
  const byName = new Map(sourcesUnder(path.join(dir, 'Source')).map((f) => [path.basename(f), f]));
  return {
    sources: words(vars.CPP_SOURCES).map((s) => {
      const f = path.resolve(dir, s);
      return fs.existsSync(f) ? f : byName.get(path.basename(s)) ?? fail(`${dir}: no ${s}`);
    }),
    includes: words(vars.C_INCLUDES).map((f) => (f.startsWith('-I') ? `-I${path.resolve(dir, f.slice(2))}` : f)),
  };
}

// Splits a make variable into words the way the shell would for a recipe.
function words(s = '') {
  const out = [];
  let cur = null, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur ??= '';
    } else if (c === '\\' && i + 1 < s.length) {
      cur = (cur ?? '') + s[++i];
    } else if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else {
      cur = (cur ?? '') + c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

function sourcesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .filter((f) => /\.(c|cpp)$/.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

// ------------------------------------------------------------ what to build
const vars = readVars();
const target = vars.TARGET || path.basename(fw);
const libdaisy = path.resolve(fw, vars.LIBDAISY_DIR || 'libDaisy');
const daisysp = vars.DAISYSP_DIR ? path.resolve(fw, vars.DAISYSP_DIR) : null;
const lgpl = daisysp && vars.USE_DAISYSP_LGPL === '1';
const buildDir = path.join(fw, 'build-web');
const out = path.resolve(outArg || path.join(buildDir, `${target}.wasm`));

if (!fs.existsSync(path.join(libdaisy, 'src', 'per', 'gpio.h'))) {
  fail(`no libDaisy at ${libdaisy} (LIBDAISY_DIR); are the submodules checked out?`);
}

// Each group compiles with the include paths of its own build: libDaisy's
// core Makefile for the firmware, DaisySP's Makefiles for DaisySP. board/
// comes first everywhere, so its stand-ins win over libDaisy's headers.
const boardInclude = `-I${path.join(STW, 'board', 'include')}`;
const libdaisyIncludes = [`-I${libdaisy}`, `-I${path.join(libdaisy, 'src')}`, `-I${path.join(libdaisy, 'src', 'sys')}`];
const dsp = daisysp ? libraryVars(daisysp) : null;
const dspLgpl = lgpl ? libraryVars(path.join(daisysp, 'DaisySP-LGPL')) : null;

// Firmware additions to CFLAGS / CPPFLAGS that matter off the MCU.
const extraFlags = [...words(vars.CFLAGS), ...words(vars.CPPFLAGS)]
  .filter((f) => /^-(D|U|I|include$|std=)/.test(f));

const firmwareFlags = [
  boardInclude, ...words(vars.C_INCLUDES), ...libdaisyIncludes,
  ...(daisysp ? [`-I${path.join(daisysp, 'Source')}`] : []),
  ...(lgpl ? [`-I${path.join(daisysp, 'DaisySP-LGPL', 'Source')}`] : []),
  ...words(vars.C_DEFS), ...extraFlags,
];

const units = [];
const add = (group, base, files, flags, own) => {
  for (const src of files) {
    const rel = path.relative(base, src).replaceAll('..', '__');
    units.push({ src, obj: path.join(buildDir, group, rel.replace(/\.(c|cpp)$/, '.o')), flags, own });
  }
};
add('firmware', fw, [...words(vars.CPP_SOURCES), ...words(vars.C_SOURCES)].map((s) => path.resolve(fw, s)), firmwareFlags, true);
add('board', path.join(STW, 'board', 'src'), sourcesUnder(path.join(STW, 'board', 'src')), [boardInclude, ...libdaisyIncludes], true);
add('libdaisy', path.join(libdaisy, 'src'), LIBDAISY_SOURCES.map((s) => path.join(libdaisy, 'src', s)), [boardInclude, ...libdaisyIncludes], false);
if (dsp) add('daisysp', daisysp, dsp.sources, dsp.includes, false);
if (dspLgpl) add('daisysp', daisysp, dspLgpl.sources, dspLgpl.includes, false);

// <stdlib.h> comes in through the ARM toolchain's headers on the Seed, and
// DaisySP's dsp.h relies on that for RAND_MAX.
const common = [
  '--target=wasm32-wasip1', '-msimd128', ...words(vars.OPT || '-O2'),
  '-ffunction-sections', '-fdata-sections', '-include', 'stdlib.h', '-Wno-non-c-typedef-for-linkage',
  '-DSIMPLE_TOUCH_WEB', ...(lgpl ? ['-DUSE_DAISYSP_LGPL'] : []),
];
const cxxFlags = [...common, ...words(vars.CPP_STANDARD || '-std=gnu++14'), '-fno-exceptions', '-fno-rtti', '-Wno-register'];
const cFlags = [...common, '-std=gnu11'];

// ------------------------------------------------------------ compile
fs.mkdirSync(buildDir, { recursive: true });
const flagsFile = path.join(buildDir, 'flags.txt');
const flagsText = JSON.stringify({ CXX, cxxFlags, cFlags, units: units.map((u) => [u.src, u.flags]) });
const flagsChanged = !fs.existsSync(flagsFile) || fs.readFileSync(flagsFile, 'utf8') !== flagsText;

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return -1; } };

function upToDate(unit) {
  if (flagsChanged) return false;
  const t = mtime(unit.obj);
  if (t < 0) return false;
  let deps;
  try {
    deps = fs.readFileSync(`${unit.obj}.d`, 'utf8');
  } catch {
    return false;
  }
  // "obj: dep dep \<newline> dep", spaces in paths escaped as "\ "
  const body = deps.slice(deps.indexOf(': ') + 2).replace(/\\\r?\n/g, ' ');
  const files = body.split(/(?<!\\)\s+/).filter(Boolean).map((f) => f.replace(/\\ /g, ' '));
  // Relative entries are relative to where clang ran: the firmware folder.
  return files.every((f) => { const m = mtime(path.resolve(fw, f)); return m >= 0 && m <= t; });
}

function compile(unit) {
  const isC = unit.src.endsWith('.c');
  const argv = [
    ...(isC ? cFlags : cxxFlags),
    ...unit.flags,
    ...(unit.own ? ['-Wall'] : ['-w']),
    '-MMD', '-MF', `${unit.obj}.d`,
    '-c', unit.src, '-o', unit.obj,
  ];
  fs.mkdirSync(path.dirname(unit.obj), { recursive: true });
  return new Promise((resolve) => {
    const p = spawn(isC ? CC : CXX, argv, { cwd: fw });
    let log = '';
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('error', (e) => resolve({ ok: false, log: String(e) }));
    p.on('close', (code) => resolve({ ok: code === 0, log }));
  });
}

const todo = units.filter((u) => !upToDate(u));
console.log(`build: ${target}: ${units.length} files, ${todo.length} to compile`);
let failed = false;
let next = 0;
async function worker() {
  while (!failed && next < todo.length) {
    const unit = todo[next++];
    const { ok, log } = await compile(unit);
    if (log.trim()) process.stderr.write(`${path.relative(fw, unit.src)}\n${log}`);
    if (!ok) failed = true;
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
if (failed) fail('compile failed');
fs.writeFileSync(flagsFile, flagsText);

// ------------------------------------------------------------ link
// A reactor: no main(); the page calls _initialize, then the st_* exports.
// The linker names the module after its output file, so it always links to
// <target>.wasm in the build folder and copies from there: the same sources
// give the same bytes (and sha256) wherever --out points.
const rsp = path.join(buildDir, 'link.rsp');
const linked = path.join(buildDir, 'link', `${target}.wasm`);
fs.writeFileSync(rsp, units.map((u) => `"${posix(u.obj)}"`).join('\n'));
fs.mkdirSync(path.dirname(linked), { recursive: true });
try {
  execFileSync(CXX, [
    '--target=wasm32-wasip1', '-mexec-model=reactor', ...words(vars.OPT || '-O2'),
    '-Wl,--gc-sections', '-Wl,-z,stack-size=1048576', '-Wl,--strip-debug',
    `@${rsp}`, '-o', linked,
  ], { stdio: 'inherit' });
} catch {
  fail('link failed (an undefined st_firmware_setup / st_firmware_loop means the firmware has no ST_WEB_FIRMWARE line: see README)');
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(linked, out);

const bytes = fs.readFileSync(out);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(`build: ${path.relative(process.cwd(), out)} (${(bytes.length / 1024).toFixed(0)} KB)`);
if (infoArg) {
  fs.writeFileSync(infoArg, JSON.stringify({ target, file: path.basename(out), abi: ABI, sha256, bytes: bytes.length }, null, 2));
}
console.log(JSON.stringify({
  emulator: {
    wasm: `<where you publish ${path.basename(out)}>`,
    abi: ABI,
    sha256,
    embed: 'allowed',
  },
}, null, 2));
