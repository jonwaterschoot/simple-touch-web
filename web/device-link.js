// simple-touch-web: the Device source of the test bench and the Simple Touch
// library. The page runs no firmware and reads and writes a real board over
// Web MIDI. See the README, "Settings and presets".
//
//   const link = mountDeviceLink(box, device, {
//     onMidi: (bytes) => panel.midi(bytes),
//     onChange: () => { panel.reset(); panel.ask(); },  // another board, or the same one back
//   });
//   link.connect();          // on the switch to Device
//   link.send(bytes);        // false: no port to send to
//   link.close();            // on the switch back

export const canLink = () => !!globalThis.navigator?.requestMIDIAccess;

// Windows can list the two halves as 'MIDIIN2 (Board)' and 'MIDIOUT2 (Board)',
// other systems as 'Board In' and 'Board Out'.
function deviceName(port) {
  const raw = (port.name || port.id || '').toLowerCase();
  const name = raw.replace(/\b(?:midi\s*)?(?:input|output|in|out)\s*\d*\b/g, '').replace(/[\s()]+/g, ' ').trim();
  return name || raw;
}

export const sameDevice = (a, b) => !!a && !!b && deviceName(a) === deviceName(b);

const live = (ports) => [...ports.values()].filter((p) => p.state !== 'disconnected');
const usesSysex = (device) => device.request?.[0] === 0xf0 || device.presets.some((p) => p.messages.some((m) => m[0] === 0xf0));

export function mountDeviceLink(box, device, { onMidi, onChange }) {
  const doc = box.ownerDocument;
  const list = doc.createElement('select');
  list.setAttribute('aria-label', 'Device');
  const status = doc.createElement('span');
  status.className = 'device-now';
  const title = doc.createElement('span');
  title.className = 'device-label';
  title.textContent = 'Device';
  const row = doc.createElement('div');
  row.className = 'device-row';
  row.append(title, list, status);
  box.replaceChildren(row);

  let access = null, input = null, output = null, active = false, chosen = '', denied = false;

  function detach() {
    if (input) { input.onmidimessage = null; input.close?.(); }
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
      if (input) input.onmidimessage = (e) => onMidi(e.data);
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
    return true;
  }

  function close() {
    active = false;
    denied = false;
    if (access) access.onstatechange = null;
    detach();
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
  return { connect, close, send };
}
