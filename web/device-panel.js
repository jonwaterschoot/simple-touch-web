// simple-touch-web: settings and presets a firmware declares in the optional
// `device` block of its simple-touch-labels.json. The test bench and the
// Simple Touch library both draw them with this file. See the README,
// "Settings and presets".
//
//   const device = parseDevice(labels.device);
//   const panel = mountDevicePanel(box, device, {
//     send: (bytes) => { st.sendMidi(bytes); return true; },  // false: nothing is connected
//   });
//   st.on('midi', (m) => panel.midi(m.bytes));
//   await st.ready; panel.ask();
//
// A label file comes from any repository, so only plain values pass and all
// its text goes in as text. A control shows what the firmware reports, so the
// firmware stays the one source of truth.

const LIMIT = { settings: 32, options: 128, presets: 32, messages: 32, bytes: 256, label: 40 };

const label = (v) => (typeof v === 'string' ? v.trim().slice(0, LIMIT.label) : '');
const isData = (v) => Number.isInteger(v) && v >= 0 && v <= 127;
const dataBytes = (s) => (s < 0xc0 ? 2 : s < 0xe0 ? 1 : s < 0xf0 ? 2 : s === 0xf2 ? 2 : s === 0xf1 || s === 0xf3 ? 1 : 0);

// 'B0 14 02' or 'F0 7D 01 F7' to bytes. One whole message, else null.
export function parseHex(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length > LIMIT.bytes || !parts.every((p) => /^[0-9a-f]{2}$/i.test(p))) return null;
  const b = parts.map((p) => parseInt(p, 16));
  if (b[0] < 0x80) return null;
  if (b[0] === 0xf0) {
    const end = b.length - 1;
    return end > 0 && b[end] === 0xf7 && b.slice(1, end).every((x) => x < 0x80) ? b : null;
  }
  return b.length === 1 + dataBytes(b[0]) && b.slice(1).every((x) => x < 0x80) ? b : null;
}

const ccMessage = (s, value) => [0xb0 | (s.channel - 1), s.cc, value];

function parseSetting(s) {
  if (!s || typeof s !== 'object') return null;
  const channel = s.channel ?? 1;
  const id = label(s.id), name = label(s.label);
  if (!id || !name || !isData(s.cc) || !Number.isInteger(channel) || channel < 1 || channel > 16) return null;
  if (s.widget !== 'buttons' && s.widget !== 'select') return null;
  if (!Array.isArray(s.options)) return null;
  const options = [];
  for (const [i, o] of s.options.slice(0, LIMIT.options).entries()) {
    const opt = typeof o === 'string' ? { label: o, value: i } : o;
    if (opt && label(opt.label) && isData(opt.value)) options.push({ label: label(opt.label), value: opt.value });
  }
  return options.length ? { id, label: name, widget: s.widget, cc: s.cc, channel, options } : null;
}

function parsePreset(p, settings) {
  if (!p || typeof p !== 'object' || !label(p.label)) return null;
  const messages = [];
  for (const [id, value] of Object.entries(p.set && typeof p.set === 'object' ? p.set : {})) {
    const s = settings.find((x) => x.id === id);
    if (!s || !isData(value)) return null;
    messages.push(ccMessage(s, value));
  }
  for (const hex of Array.isArray(p.midi) ? p.midi : []) {
    const bytes = parseHex(hex);
    if (!bytes) return null;
    messages.push(bytes);
  }
  return messages.length && messages.length <= LIMIT.messages ? { label: label(p.label), messages } : null;
}

// Hex bytes after F0, without a value or F7: the start of a frame.
function parseBody(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length > 16 || !parts.every((p) => /^[0-7][0-9a-f]$/i.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

function parseLive(b) {
  if (!b || typeof b !== 'object') return null;
  const state = parseBody(b.knobs?.state);
  return {
    knobs: state && isData(b.knobs.cc) && b.knobs.cc + 7 <= 127 ? { state, cc: b.knobs.cc } : null,
    touch: parseBody(b.touch),
    hits: parseBody(b.hits),
    oled: b.oled?.rows === 32 || b.oled?.rows === 64 ? { rows: b.oled.rows } : null,
  };
}

// A malformed setting or preset is left out and the rest still work. Null when
// nothing usable is left.
export function parseDevice(block) {
  if (!block || typeof block !== 'object') return null;
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const settings = list(block.settings, LIMIT.settings).map(parseSetting).filter(Boolean);
  const presets = list(block.presets, LIMIT.presets).map((p) => parsePreset(p, settings)).filter(Boolean);
  if (!settings.length && !presets.length) return null;
  return { port: label(block.port), request: parseHex(block.request), live: parseLive(block.live), settings, presets };
}

export function mountDevicePanel(box, device, { send, idle = 'Not sent: nothing is connected.' }) {
  const doc = box.ownerDocument;
  const el = (tag, className, text) => {
    const e = doc.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const note = el('p', 'device-note');
  note.setAttribute('role', 'status');
  const post = (messages) => {
    const ok = messages.map((m) => send(m) !== false).every(Boolean);
    note.textContent = ok ? '' : typeof idle === 'function' ? idle() : idle;
    return ok;
  };
  const button = (text, onClick) => {
    const b = el('button', '', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const reports = new Map();  // 'channel:cc' -> show the value the firmware reported

  function buttons(s, row) {
    const group = el('div', 'device-choices');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', s.label);
    const items = s.options.map((o) => {
      const b = button(o.label, () => post([ccMessage(s, o.value)]));
      b.setAttribute('aria-pressed', 'false');
      group.append(b);
      return [o.value, b];
    });
    row.append(group);
    return (v) => items.forEach(([value, b]) => b.setAttribute('aria-pressed', String(value === v)));
  }

  // The firmware may report the value again while someone is choosing, so a
  // choice not sent yet stays in the list. The current value is shown beside it.
  function select(s, row) {
    const list = el('select');
    list.setAttribute('aria-label', s.label);
    for (const o of s.options) {
      const opt = el('option', '', o.label);
      opt.value = String(o.value);
      list.append(opt);
    }
    let current = null, choosing = false;
    list.addEventListener('change', () => { choosing = list.value !== String(current); });
    const go = button('Send', () => { if (post([ccMessage(s, Number(list.value))])) choosing = false; });
    const now = el('span', 'device-now');
    row.append(list, go, now);
    return (v) => {
      if (v === null) { current = null; choosing = false; now.textContent = ''; return; }
      const o = s.options.find((x) => x.value === v);
      if (!o) return;
      current = v;
      now.textContent = o.label;
      if (!choosing) list.value = String(v);
    };
  }

  box.replaceChildren();
  for (const s of device.settings) {
    const row = el('div', 'device-row');
    row.append(el('span', 'device-label', s.label));
    reports.set(`${s.channel}:${s.cc}`, s.widget === 'buttons' ? buttons(s, row) : select(s, row));
    box.append(row);
  }
  if (device.presets.length) {
    const row = el('div', 'device-row');
    const group = el('div', 'device-choices');
    row.append(el('span', 'device-label', 'Presets'), group);
    for (const p of device.presets) group.append(button(p.label, () => post(p.messages)));
    box.append(row);
  }
  box.append(note);

  // Bytes from the firmware or a port: whole messages or the raw stream.
  let status = 0, cc = -1, sysex = false, heard = false;
  function midi(bytes) {
    for (const b of bytes) {
      if (b >= 0xf8) continue;
      if (b >= 0x80) {
        sysex = b === 0xf0;
        status = b < 0xf0 ? b : 0;
        cc = -1;
      } else if (!sysex && (status & 0xf0) === 0xb0) {
        if (cc < 0) { cc = b; continue; }
        const show = reports.get(`${(status & 15) + 1}:${cc}`);
        if (show) { heard = true; show(b); }
        cc = -1;
      }
    }
  }

  // Asks the firmware for its current values, once something is connected. A
  // firmware that is still booting drops the request, so it repeats until a
  // value comes back.
  let again = null;
  function ask() {
    clearTimeout(again);
    if (!device.request) return;
    heard = false;
    let tries = 5;
    const go = () => {
      if (heard || send(device.request) === false || --tries === 0) return;
      again = setTimeout(go, 400);
    };
    go();
  }

  // Forgets the reported values when the page talks to something else.
  function reset() {
    clearTimeout(again);
    status = 0; cc = -1; sysex = false; heard = false;
    note.textContent = '';
    for (const show of reports.values()) show(null);
  }
  return { midi, ask, reset };
}
