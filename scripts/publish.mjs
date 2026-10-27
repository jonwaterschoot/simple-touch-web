#!/usr/bin/env node
// Adds a build to a checkout of a firmware repository's publish branch
// (simple-touch-web by default), for .github/workflows/build-firmware.yml.
//
//   node scripts/publish.mjs <branch checkout> <build.wasm> <build.json>
//        --repo owner/name --commit <sha> [--branch simple-touch-web] [--keep 20]
//
// Builds are named by their hash (TouchVink-474a3c9633c7.wasm), so a new
// build never replaces one an author has approved in simple-touch-labels.json.
// Each has a .json beside it (hash, size, source commit); latest.json names
// the newest; only the newest --keep builds stay. Prints the build's name, or
// nothing when this exact build is already there.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}
const repo = option('--repo');
const commit = option('--commit', '');
const branch = option('--branch', 'simple-touch-web');
const keep = Number(option('--keep', 20));
const [dir, wasmPath, infoPath] = args;
if (!dir || !wasmPath || !infoPath || !repo) {
  console.error('usage: publish.mjs <checkout> <build.wasm> <build.json> --repo owner/name --commit <sha>');
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
const name = `${info.target}-${info.sha256.slice(0, 12)}`;
const wasmFile = `${name}.wasm`;
if (fs.existsSync(path.join(dir, wasmFile))) process.exit(0);

const raw = (file) => `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
const record = {
  ...info,
  file: wasmFile,
  url: raw(wasmFile),
  source: { repository: repo, commit },
  built: new Date().toISOString(),
};
fs.copyFileSync(wasmPath, path.join(dir, wasmFile));
fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(record, null, 2)}\n`);

// Newest first; drop what is past --keep.
const builds = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'latest.json')
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .filter((b) => b.file && b.built)
  .sort((a, b) => b.built.localeCompare(a.built));
for (const old of builds.slice(keep)) {
  fs.rmSync(path.join(dir, old.file), { force: true });
  fs.rmSync(path.join(dir, old.file.replace(/\.wasm$/, '.json')), { force: true });
}

const bench = (b) => `https://jonwaterschoot.github.io/simple-touch-web/demo/?wasm=${b.url}`;
const rows = builds.slice(0, keep)
  .map((b) => `| [${b.file}](${b.file}) | ${b.built.slice(0, 16).replace('T', ' ')} | ${b.source.commit.slice(0, 7)} | [play](${bench(b)}) |`)
  .join('\n');
fs.writeFileSync(path.join(dir, 'README.md'), `# Browser builds

Builds of this firmware for the browser, made with [simple-touch-web](https://github.com/jonwaterschoot/simple-touch-web) by \`.github/workflows\` on every push. Each is named by its hash. To let the [Simple Touch library](https://jonwaterschoot.github.io/simple-touch-labels/) play one, add its \`emulator\` block to \`simple-touch-labels.json\` (the workflow run's summary has it).

| Build | Built (UTC) | From | Test bench |
| --- | --- | --- | --- |
${rows}
`);

console.log(name);
