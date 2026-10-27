#!/usr/bin/env node
// Runs a build headless in Node, through the same worklet processor the page
// uses: boots it, plays the pads one after another, and reports what came
// out (levels, the OLED as text, LED, MIDI, log, speed). Writes the audio to
// a WAV next to the build, so a build can be checked without a browser.
//
//   node test/smoke.mjs <firmware.wasm> [pads, e.g. 0,4,5,6; default all]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error('usage: node test/smoke.mjs <firmware.wasm>');
  process.exit(1);
}

// ------------------------------------------------------------ a worklet scope
const RATE = 48000;
const QUANTUM = 128;
const messages = [];
globalThis.sampleRate = RATE;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage: (m) => messages.push(m), onmessage: null };
  }
};
let Processor = null;
globalThis.registerProcessor = (name, cls) => { Processor = cls; };
await import(pathToFileURL(path.join(STW, 'web', 'simple-touch-processor.js')).href);

// ------------------------------------------------------------ boot
const wasm = fs.readFileSync(wasmPath);
const t0 = performance.now();
const p = new Processor({
  processorOptions: { wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length), adc: new Array(8).fill(0.5), flags: 1 },
});
const bootMs = performance.now() - t0;
const error = messages.find((m) => m.type === 'error');
if (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
const ready = messages.find((m) => m.type === 'ready');
console.log(`ready: ${ready.sampleRate} Hz, block ${ready.blockSize}, boot film ${ready.boot.length} frames ` +
  `(${ready.boot.at(-1)?.ms ?? 0} ms of setup), constructed in ${bootMs.toFixed(0)} ms`);

const send = (m) => p.port.onmessage({ data: m });

// ------------------------------------------------------------ render
const left = [], right = [];
let renderMs = 0;
function render(seconds) {
  const n = Math.round((seconds * RATE) / QUANTUM);
  for (let q = 0; q < n; q++) {
    const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    const t = performance.now();
    const alive = p.process([[]], [out]);
    renderMs += performance.now() - t;
    if (!alive) {
      console.error(`stopped: ${messages.findLast((m) => m.type === 'error')?.message}`);
      process.exit(1);
    }
    left.push(out[0]);
    right.push(out[1]);
    globalThis.currentTime += QUANTUM / RATE;
  }
}

function level(from) {
  let peak = 0, sum = 0, n = 0;
  for (let i = from; i < left.length; i++) {
    for (let j = 0; j < QUANTUM; j++) {
      const a = Math.max(Math.abs(left[i][j]), Math.abs(right[i][j]));
      peak = Math.max(peak, a);
      sum += a * a;
      n++;
    }
  }
  const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
  return `peak ${db(peak)} dBFS, rms ${db(Math.sqrt(sum / Math.max(1, n)))} dBFS`;
}

function oledText(m) {
  if (!m) return '(no frame)';
  const rows = (m.info >> 8) & 0xff || 32;
  if (!(m.info & 1)) return '(display off)';
  const lines = [];
  for (let y = 0; y < rows; y += 2) {
    let s = '';
    for (let x = 0; x < 128; x++) {
      const top = (m.ram[(y >> 3) * 128 + x] >> (y & 7)) & 1;
      const bot = (m.ram[((y + 1) >> 3) * 128 + x] >> ((y + 1) & 7)) & 1;
      s += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(`|${s}|`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ play
render(1);
console.log(`idle 1 s: ${level(0)}`);

const order = process.argv[3] ? process.argv[3].split(',').map(Number) : [...Array(12).keys()];
for (const pad of order) {
  const from = left.length;
  messages.length = 0;
  send({ type: 'pad', index: pad, down: true, force: 0.7 });
  render(0.4);
  const during = messages.filter((m) => m.type === 'oled').at(-1);
  send({ type: 'pad', index: pad, down: false });
  render(0.6);
  const midi = messages.filter((m) => m.type === 'midi').reduce((n, m) => n + m.bytes.length, 0);
  const leds = messages.filter((m) => m.type === 'led').length;
  console.log(`P${pad}: ${level(from)}, ${midi} MIDI bytes out, ${leds} LED changes`);
  if (pad === order[Math.min(4, order.length - 1)]) console.log(oledText(during));
}

const log = messages.filter((m) => m.type === 'log').map((m) => m.text).join('');
if (log) console.log(`log:\n${log}`);

const seconds = (left.length * QUANTUM) / RATE;
console.log(`rendered ${seconds.toFixed(1)} s of audio in ${renderMs.toFixed(0)} ms (${(seconds * 1000 / renderMs).toFixed(1)}x real time)`);

// ------------------------------------------------------------ WAV
const frames = left.length * QUANTUM;
const wav = Buffer.alloc(44 + frames * 4);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + frames * 4, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(frames * 4, 40);
let at = 44;
for (let i = 0; i < left.length; i++) {
  for (let j = 0; j < QUANTUM; j++) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i][j])) * 32767), at);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i][j])) * 32767), at + 2);
    at += 4;
  }
}
const wavPath = wasmPath.replace(/\.wasm$/, '') + '-smoke.wav';
fs.writeFileSync(wavPath, wav);
console.log(`wrote ${wavPath}`);
