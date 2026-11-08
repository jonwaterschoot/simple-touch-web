// simple-touch-web: the "Connect to Simple Touch" mode of the test bench and the
// Simple Touch library. The page runs no firmware and reads and writes a real board over
// Web MIDI. See the README, "Settings and presets".
//
//   const link = mountDeviceLink(box, device, {
//     onMidi: (bytes) => panel.midi(bytes),
//     onChange: () => { panel.reset(); panel.ask(); },  // another board, or the same one back
//   });
//   link.connect();          // on the switch to this mode
//   link.send(bytes);        // false: no port to send to
//   link.close();            // on the switch back
//
// With a `live` section in the device block, pass `live: { pads, levers, knob,
// oled }` to follow the board, and use link.knob(ref, value) and
// link.pad(index, down, force) to move it.

export const canLink = () => !!globalThis.navigator?.requestMIDIAccess;

// Windows can list the two halves as 'MIDIIN2 (Board)' and 'MIDIOUT2 (Board)',
// other systems as 'Board In' and 'Board Out'.
function deviceName(port) {
  const raw = (port.name || port.id || '').toLowerCase();
  const name = raw.replace(/\b(?:midi\s*)?(?:input|output|in|out)\s*\d*\b/g, '').replace(/[\s()]+/g, ' ').trim();
  return name || raw;
}

export const sameDevice = (a, b) => !!a && !!b && deviceName(a) === deviceName(b);

const dataBytes = (s) => (s < 0xc0 ? 2 : s < 0xe0 ? 1 : s < 0xf0 ? 2 : s === 0xf2 ? 2 : s === 0xf1 || s === 0xf3 ? 1 : 0);

// A firmware's output arrives as the bytes it wrote per audio block, running
// status included. Web MIDI's send() takes one whole message.
export function midiSplitter() {
  let running = 0;
  return (b) => {
    const out = [];
    let i = 0;
    while (i < b.length) {
      const x = b[i];
      if (x === 0xf0) {
        let j = i + 1;
        while (j < b.length && b[j] !== 0xf7) j++;
        out.push(b.slice(i, j + 1));
        i = j + 1;
      } else if (x >= 0xf8) {
        out.push(b.slice(i, i + 1));
        i++;
      } else {
        let status = running;
        if (x & 0x80) { status = x; i++; running = x < 0xf0 ? x : 0; }
        if (!status) { i++; continue; }
        const n = dataBytes(status);
        if (i + n > b.length) break;
        out.push(Uint8Array.of(status, ...b.slice(i, i + n)));
        i += n;
      }
    }
    return out;
  };
}

const KNOBS = ['S30', 'S31', 'S32', 'S33', 'S34', 'S35', 'S36', 'S37'];
// Live frame values 0, 1, 2: Switch3 reads POS_UP on its first pin, Init(D7, D6) and Init(D9, D8) here.
const LEVERS = [['S09_S10', ['right', 'centre', 'left']], ['S07_S08', ['up', 'centre', 'down']]];
const LIVE = [0x7d, 0x53, 0x54, 0x01], OLED = [0x7d, 0x53, 0x4f, 0x01];
const BEAT_MS = 500, ASK_BEATS = 6;     // the board's frames stop 10 s after a request
const TOUCH_MS = 30, ECHO_MS = 400;     // a knob's reports are ignored this long after moving it here

const startsWith = (d, body) => body.every((b, i) => d[1 + i] === b);

const live = (ports) => [...ports.values()].filter((p) => p.state !== 'disconnected');
const usesSysex = (device) => device.request?.[0] === 0xf0 || device.presets.some((p) => p.messages.some((m) => m[0] === 0xf0));

export function mountDeviceLink(box, device, { onMidi, onChange, live: follow }) {
  const doc = box.ownerDocument;
  const list = doc.createElement('select');
  list.setAttribute('aria-label', 'MIDI port');
  const status = doc.createElement('span');
  status.className = 'device-now';
  const title = doc.createElement('span');
  title.className = 'device-label';
  title.textContent = 'MIDI port';
  const row = doc.createElement('div');
  row.className = 'device-row';
  row.append(title, list, status);
  box.replaceChildren(row);

  let access = null, input = null, output = null, active = false, chosen = '', denied = false;

  const ram = new Uint8Array(1024);     // as oled.js draws it: 8 pages of 128 bytes
  const knobCc = new Array(8).fill(-1), knobAt = new Array(8).fill(0), knobNow = new Array(8).fill(-1);
  const forces = new Array(12).fill(0);
  let beat = null, beats = 0, touchTimer = null;

  function frame(d) {
    if (!follow || !device.live || d[0] !== 0xf0) return;
    const { knobs, oled } = device.live;
    if (startsWith(d, LIVE) && d.length >= 10) {
      const pos = {};
      LEVERS.forEach(([ref, names], i) => { pos[ref] = names[d[5 + i]] ?? 'centre'; });
      follow.levers?.(pos);
      follow.pads?.(d[7] | (d[8] << 7));
    } else if (oled && startsWith(d, OLED)) {
      let at = d[5] * 128 + d[6], i = 7;
      const end = d.length - 1;
      while (i < end) {
        const top = d[i++];
        for (let j = 0; j < 7 && i < end; j++) {
          if (at < ram.length) ram[at] = d[i] | (((top >> j) & 1) << 7);
          at++; i++;
        }
      }
      follow.oled?.(ram, 1 | (oled.rows << 8));
    } else if (knobs && startsWith(d, knobs.state)) {
      const first = 1 + knobs.state.length, now = performance.now();
      KNOBS.forEach((ref, i) => {
        const v = d[first + i];
        if (v === undefined || v >= 0x80 || v === knobNow[i] || now - knobAt[i] < ECHO_MS) return;
        knobNow[i] = knobCc[i] = v;
        follow.knob?.(ref, v / 127);
      });
    }
  }

  const put = (bytes) => { try { output?.send(bytes); } catch { /* the port just went away */ } };
  const sendTouch = () => { if (device.live?.touch) put([0xf0, ...device.live.touch, ...forces, 0xf7]); };

  function tick() {
    if (forces.some((f) => f > 0)) sendTouch();     // the board lets go of a pad not refreshed for 2 s
    if (++beats >= ASK_BEATS) {
      beats = 0;
      if (device.request) put(device.request);
    }
  }

  function knob(ref, value) {
    const i = KNOBS.indexOf(ref), k = device.live?.knobs;
    if (i < 0 || !k || !active) return;
    const v = Math.round(Math.min(1, Math.max(0, value)) * 127);
    knobAt[i] = performance.now();
    if (v === knobCc[i]) return;
    knobCc[i] = knobNow[i] = v;
    put([0xb0, k.cc + i, v]);
  }

  function pad(i, down, force = 0.5) {
    if (i < 0 || i >= 12 || !device.live?.touch || !active) return;
    const was = forces[i] > 0;
    forces[i] = down ? Math.max(1, Math.round(force * 127)) : 0;
    if (was !== down) { clearTimeout(touchTimer); touchTimer = null; sendTouch(); }
    else touchTimer ??= setTimeout(() => { touchTimer = null; sendTouch(); }, TOUCH_MS);
  }

  function detach() {
    if (input) { input.onmidimessage = null; input.close?.(); }
    if (forces.some((f) => f > 0)) { forces.fill(0); sendTouch(); }
    output?.close?.();
    input = output = null;
  }

  function show() {
    const options = !access
      ? [['', 'Off'], ['connect', 'Connect…']]
      : [['', 'Choose…'], ...live(access.inputs).map((p) => [p.id, p.name || p.id])];
    list.replaceChildren(...options.map(([value, text]) => {
      const o = doc.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    }));
    list.value = input?.id ?? '';
    status.textContent = denied ? 'No MIDI access. Allow MIDI for this page in the browser\'s site settings.'
      : !active ? ''
      : !access ? 'Asking for MIDI access.'
      : input && output ? `Connected to ${input.name || input.id}.`
      : input ? `${input.name || input.id} has no MIDI out, so nothing can be sent.`
      : device.port ? `${device.port} not found. Plug it in over USB and close other apps that use it.`
      : 'Choose the board from the list.';
  }

  function pick() {
    const inputs = live(access.inputs);
    const name = device.port?.toLowerCase();
    const next = inputs.find((p) => p.id === chosen)
      ?? (!chosen && name ? inputs.find((p) => (p.name || '').toLowerCase().includes(name)) : undefined)
      ?? null;
    const nextOut = next ? live(access.outputs).find((p) => sameDevice(next, p)) ?? null : null;
    if (next !== input || nextOut !== output) {
      if (input && input !== next) { input.onmidimessage = null; input.close?.(); }
      input = next;
      output = nextOut;
      if (input) input.onmidimessage = (e) => { onMidi(e.data); frame(e.data); };
      knobNow.fill(-1);
      show();
      onChange?.();
    } else {
      show();
    }
  }

  async function connect() {
    active = true;
    denied = false;
    show();
    try {
      access ??= await navigator.requestMIDIAccess({ sysex: usesSysex(device) });
    } catch {
      active = false;
      denied = true;
      show();
      return false;
    }
    if (!active) return false;  // switched back while the browser was asking
    access.onstatechange = () => { if (active) pick(); };
    pick();
    if (device.live) { clearInterval(beat); beats = 0; beat = setInterval(tick, BEAT_MS); }
    return true;
  }

  function close() {
    active = false;
    denied = false;
    clearInterval(beat);
    clearTimeout(touchTimer);
    touchTimer = null;
    if (access) access.onstatechange = null;
    detach();
    ram.fill(0);
    show();
  }

  function send(bytes) {
    if (!active || !output) return false;
    try { output.send(bytes); return true; } catch { return false; }
  }

  list.addEventListener('change', () => {
    if (list.value === 'connect') { connect(); return; }
    chosen = list.value;
    if (access && active) pick();
  });

  show();
  return { connect, close, send, knob, pad, follows: !!(follow && device.live) };
}
