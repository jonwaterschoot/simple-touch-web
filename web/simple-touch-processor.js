// AudioWorklet processor: runs a firmware built with simple-touch-web
// (scripts/build.mjs) on the browser's audio thread, on the virtual Simple
// Touch board (board/src/board.cpp has the other side of every st_* call).
//
// The page sends the wasm bytes once, in processorOptions, with the starting
// controls; then plain messages (no SharedArrayBuffer, so the page needs no
// cross-origin isolation):
//   { type: 'adc', index, value }          Seed A0..A13, 0..1 (S30..S37 = A0..A7)
//   { type: 'pin', index, level }          Seed D0..D32: -1 let go, 0 low, 1 high
//   { type: 'pad', index, down, force }    P0..P11, force 0..1
//   { type: 'midi', bytes }                into the firmware's USB MIDI input
// It posts back:
//   { type: 'ready', sampleRate, blockSize, boot }   boot: the setup's OLED/LED frames
//   { type: 'led', on }                    on change
//   { type: 'oled', ram, info }            at most 60 times a second, on change
//   { type: 'midi', bytes }                what the firmware sent on USB MIDI
//   { type: 'log', text }                  its stdout (printf, hw.PrintLine)
//   { type: 'meter', peak, rms }           about 30 times a second
//   { type: 'error', message }

const ABI = 1;
const OLED_BYTES = 8 * 128;

class SimpleTouchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasm, adc = [], pins = {}, flags = 1 } = options.processorOptions;
    this.log = '';
    this.alive = true;
    try {
      const module = new WebAssembly.Module(wasm);
      this.instance = new WebAssembly.Instance(module, this.imports(module));
      const x = (this.x = this.instance.exports);
      x._initialize?.();
      if (x.st_abi() !== ABI) throw new Error(`built for board ABI ${x.st_abi()}, this page runs ${ABI}`);
      x.st_configure(flags);
      adc.forEach((v, i) => x.st_set_adc(i, v));
      for (const [d, level] of Object.entries(pins)) x.st_set_pin(Number(d), level);
      x.st_init(sampleRate);
    } catch (e) {
      this.alive = false;
      this.port.postMessage({ type: 'error', message: String(e?.message ?? e) });
      return;
    }
    const x = this.x;
    this.views();
    this.max = x.st_max_frames();
    this.hadInput = false;
    this.led = -1;
    this.oledSeq = -1;
    this.oledInfo = -1;
    this.oledAt = -1;
    this.peak = 0;
    this.sum = 0;
    this.count = 0;
    this.meterEvery = Math.max(1, Math.round(sampleRate / 128 / 30));
    this.quanta = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
    this.port.postMessage({ type: 'ready', sampleRate, blockSize: x.st_block_size(), boot: this.bootFilm() });
    this.flushLog();
  }

  // WASI, as far as wasi-libc needs it: stdout and stderr go to the page's
  // log, randomness is seeded (a render is the same every time), the clock
  // is the board's. Anything else answers ENOSYS.
  imports(module) {
    const ENOSYS = 52;
    let seed = 0x9e3779b9;
    const mem = () => this.instance.exports.memory.buffer;
    const wasi = {
      fd_write: (fd, iovs, iovsLen, nwritten) => {
        const dv = new DataView(mem());
        let n = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          if (fd === 1 || fd === 2) this.log += decodeLatin1(new Uint8Array(mem(), ptr, len));
          n += len;
        }
        dv.setUint32(nwritten, n, true);
        return 0;
      },
      fd_fdstat_get: (fd, stat) => {
        // A character device without seek rights: stdout is a tty, so it
        // is line-buffered and each PrintLine arrives when it ends.
        const dv = new DataView(mem());
        for (let i = 0; i < 24; i++) dv.setUint8(stat + i, 0);
        dv.setUint8(stat, 2);
        return fd <= 2 ? 0 : 8;
      },
      random_get: (ptr, len) => {
        const bytes = new Uint8Array(mem(), ptr, len);
        for (let i = 0; i < len; i++) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          bytes[i] = seed & 0xff;
        }
        return 0;
      },
      clock_time_get: (id, precision, out) => {
        const ms = this.x?.st_now_ms ? this.x.st_now_ms() : 0;
        new DataView(mem()).setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
        return 0;
      },
      environ_sizes_get: (count, size) => {
        const dv = new DataView(mem());
        dv.setUint32(count, 0, true);
        dv.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      args_sizes_get: (count, size) => {
        const dv = new DataView(mem());
        dv.setUint32(count, 0, true);
        dv.setUint32(size, 0, true);
        return 0;
      },
      args_get: () => 0,
      proc_exit: (code) => {
        throw new Error(`firmware exited (${code})`);
      },
    };
    const imports = {};
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.kind !== 'function') continue;
      const fn = imp.module === 'wasi_snapshot_preview1' && wasi[imp.name];
      (imports[imp.module] ??= {})[imp.name] = fn || (() => ENOSYS);
    }
    return imports;
  }

  // Views into the module's memory, made again if it grows (a firmware that
  // allocates after setup).
  views() {
    const x = this.x;
    this.mem = x.memory.buffer;
    const max = x.st_max_frames();
    this.inL = new Float32Array(this.mem, x.st_in_l(), max);
    this.inR = new Float32Array(this.mem, x.st_in_r(), max);
    this.outL = new Float32Array(this.mem, x.st_out_l(), max);
    this.outR = new Float32Array(this.mem, x.st_out_r(), max);
  }

  bootFilm() {
    const x = this.x;
    const frames = [];
    for (let i = 0; i < x.st_boot_frames(); i++) {
      frames.push({
        ms: x.st_boot_ms(i),
        info: x.st_boot_info(i),
        led: x.st_boot_led(i),
        ram: new Uint8Array(this.x.memory.buffer, x.st_boot_ram(i), OLED_BYTES).slice(),
      });
    }
    return frames;
  }

  onMessage(m) {
    if (!this.alive) return;
    const x = this.x;
    switch (m.type) {
      case 'adc':
        x.st_set_adc(m.index, m.value);
        break;
      case 'pin':
        x.st_set_pin(m.index, m.level);
        break;
      case 'pad':
        x.st_set_pad(m.index, m.down ? 1 : 0, m.force ?? 0.5);
        break;
      case 'midi': {
        const bytes = m.bytes;
        for (let at = 0; at < bytes.length; at += 256) {
          const chunk = bytes.subarray(at, at + 256);
          new Uint8Array(x.memory.buffer, x.st_midi_in_buf(), chunk.length).set(chunk);
          x.st_midi_in(chunk.length);
        }
        break;
      }
    }
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const x = this.x;
    const out = outputs[0];
    const n = Math.min(out[0].length, this.max);
    if (this.mem !== x.memory.buffer) this.views();

    const input = inputs[0];
    if (input && input.length) {
      this.inL.set(input[0].subarray(0, n));
      this.inR.set((input[1] || input[0]).subarray(0, n));
      this.hadInput = true;
    } else if (this.hadInput) {
      this.inL.fill(0);
      this.inR.fill(0);
      this.hadInput = false;
    }

    try {
      x.st_process(n);
    } catch (e) {
      this.alive = false;
      this.port.postMessage({ type: 'error', message: `firmware stopped: ${e?.message ?? e}` });
      return false;
    }
    if (this.mem !== x.memory.buffer) this.views();

    out[0].set(this.outL.subarray(0, n));
    if (out[1]) out[1].set(this.outR.subarray(0, n));
    this.report(n);
    return true;
  }

  report(n) {
    const x = this.x;

    const led = x.st_led();
    if (led !== this.led) {
      this.led = led;
      this.port.postMessage({ type: 'led', on: !!led });
    }

    const seq = x.st_oled_seq();
    const info = x.st_oled_info();
    if ((seq !== this.oledSeq || info !== this.oledInfo) && currentTime - this.oledAt >= 1 / 60) {
      this.oledSeq = seq;
      this.oledInfo = info;
      this.oledAt = currentTime;
      const ram = new Uint8Array(x.memory.buffer, x.st_oled_ram(), OLED_BYTES).slice();
      this.port.postMessage({ type: 'oled', ram, info }, [ram.buffer]);
    }

    const midiLen = x.st_midi_out_len();
    if (midiLen > 0) {
      const bytes = new Uint8Array(x.memory.buffer, x.st_midi_out_buf(), midiLen).slice();
      x.st_midi_out_clear();
      this.port.postMessage({ type: 'midi', bytes }, [bytes.buffer]);
    }

    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(this.outL[i]), Math.abs(this.outR[i]));
      if (a > this.peak) this.peak = a;
      this.sum += a * a;
    }
    this.count += n;
    if (++this.quanta >= this.meterEvery) {
      this.port.postMessage({ type: 'meter', peak: this.peak, rms: Math.sqrt(this.sum / this.count) });
      this.peak = this.sum = this.count = this.quanta = 0;
    }

    this.flushLog();
  }

  flushLog() {
    if (!this.log) return;
    this.port.postMessage({ type: 'log', text: this.log });
    this.log = '';
  }
}

function decodeLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

registerProcessor('simple-touch', SimpleTouchProcessor);
