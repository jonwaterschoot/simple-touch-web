// Plays a firmware built with simple-touch-web: loads its wasm, runs it in
// an AudioWorklet (simple-touch-processor.js) on the virtual Simple Touch,
// and lets the page talk Simple Touch to it: knobs and faders by S-number,
// the levers by position, the pads by number.
//
//   const st = await SimpleTouch.load(audioContext, 'touchvink.wasm', { sha256 });
//   st.node.connect(audioContext.destination);
//   st.on('oled', ({ ram, info }) => drawOled(canvas, ram, info));
//   st.setControl('S30', 0.7);
//   st.setSwitch('S09_S10', 'right');
//   st.setPad(3, true, 0.6);
//
// Events (st.on(type, fn), fn gets the message): ready, error, led, oled,
// midi, log, meter. See simple-touch-processor.js for what each carries.

// How the Simple Touch is wired to the Seed (the pin table in
// simple-touch-labels' core.js, libDaisy names).
export const BOARD = {
  // S30..S37: Seed A0..A7. S36 and S37 are the faders.
  analog: { S30: 0, S31: 1, S32: 2, S33: 3, S34: 4, S35: 5, S36: 6, S37: 7 },
  // Each lever closes one of its two contacts to ground, or neither in the
  // centre. Seed D-pins, by lever position.
  switches: {
    S09_S10: { left: 8, right: 9 },
    S07_S08: { up: 7, down: 6 },
  },
  pads: 12,
};

const PROCESSOR_URL = new URL('./simple-touch-processor.js', import.meta.url);

function switchPins(ref, position) {
  const contacts = BOARD.switches[ref];
  if (!contacts) throw new Error(`no switch ${ref}`);
  const pins = {};
  for (const [pos, d] of Object.entries(contacts)) pins[d] = pos === position ? 0 : -1;
  return pins;
}

async function fetchBytes(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  if (!onProgress || !r.body) return r.arrayBuffer();
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    onProgress(n);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class SimpleTouch extends EventTarget {
  // source: a URL, or the module's bytes (an ArrayBuffer, e.g. a dropped file).
  // Options:
  //   sha256     the build the author approved; anything else is refused
  //   oled       an OLED is fitted (default true)
  //   controls   starting positions, { S30: 0.5, ... } (default 0.5 each)
  //   switches   starting lever positions, { S09_S10: 'centre', ... }
  //   onProgress bytes loaded so far
  static async load(context, source, opts = {}) {
    const { sha256, oled = true, controls = {}, switches = {}, onProgress } = opts;
    const [bytes] = await Promise.all([
      typeof source === 'string' || source instanceof URL ? fetchBytes(source, onProgress) : source,
      context.audioWorklet.addModule(opts.processorUrl ?? PROCESSOR_URL),
    ]);
    if (sha256) {
      const got = await sha256Hex(bytes);
      if (got !== sha256.toLowerCase()) {
        throw new Error(`this build (sha256 ${got.slice(0, 12)}…) is not the one the author approved`);
      }
    }

    const adc = new Array(14).fill(0);
    for (const [ref, a] of Object.entries(BOARD.analog)) adc[a] = controls[ref] ?? 0.5;
    const pins = {};
    for (const [ref, pos] of Object.entries(switches)) Object.assign(pins, switchPins(ref, pos));

    const node = new AudioWorkletNode(context, 'simple-touch', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm: bytes, adc, pins, flags: oled ? 1 : 0 },
    });
    return new SimpleTouch(node);
  }

  constructor(node) {
    super();
    this.node = node;
    this.sampleRate = null;
    this.boot = [];
    this.ready = new Promise((resolve, reject) => {
      this.addEventListener('ready', (e) => resolve(e.detail), { once: true });
      this.addEventListener('error', (e) => reject(new Error(e.detail.message)), { once: true });
    });
    this.ready.catch(() => {});
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        this.sampleRate = m.sampleRate;
        this.boot = m.boot;
      }
      this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
    };
  }

  on(type, fn) {
    const listener = (e) => fn(e.detail);
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  // A knob or fader, 'S30'..'S37', 0..1 (clockwise / up = 1).
  setControl(ref, value) {
    const index = BOARD.analog[ref];
    if (index === undefined) throw new Error(`no control ${ref}`);
    this.node.port.postMessage({ type: 'adc', index, value });
  }

  // 'S09_S10': 'left' | 'centre' | 'right'; 'S07_S08': 'up' | 'centre' | 'down'.
  setSwitch(ref, position) {
    for (const [index, level] of Object.entries(switchPins(ref, position))) {
      this.node.port.postMessage({ type: 'pin', index: Number(index), level });
    }
  }

  // Pad 0..11 (P0..P11); force 0..1 is how hard it is pressed.
  setPad(index, down, force = 0.5) {
    this.node.port.postMessage({ type: 'pad', index, down, force });
  }

  // Raw MIDI bytes into the firmware's USB MIDI input.
  sendMidi(bytes) {
    this.node.port.postMessage({ type: 'midi', bytes: Uint8Array.from(bytes) });
  }

  disconnect() {
    this.node.disconnect();
    this.node.port.onmessage = null;
  }
}
