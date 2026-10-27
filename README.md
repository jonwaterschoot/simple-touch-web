# simple-touch-web

Run a Synthux Simple Touch firmware in the browser: the firmware's own C++ (libDaisy, DaisySP), compiled to WebAssembly and played on a virtual Simple Touch, with its knobs, faders, levers, pressure-sensing pads, LED, optional OLED, audio in and USB MIDI.

It doesn't model the instrument in JavaScript. The firmware runs as it is, against a stand-in for the Daisy Seed's hardware. Its pad code reads an emulated MPR121 over an emulated I2C bus, and its screen code drives an emulated SSD1306. What the browser plays is what the firmware does.

## How it works

```
firmware .cpp ──┐
libDaisy (pure) ├─ wasi-sdk ─→ firmware.wasm ─→ AudioWorklet (web/simple-touch-processor.js)
DaisySP         │                                   │  st_* calls
board/ ─────────┘                                   ▼
                                       page (web/simple-touch.js): S30..S37, levers, pads,
                                       MIDI in/out, LED, OLED frames, log
```

- **board/include** puts the real libDaisy headers in front of an empty HAL. The peripheral classes keep libDaisy's declarations. `daisy.h` and `daisy_seed.h` are cut down to what the board supports.
- **board/src** implements those classes on the virtual board: GPIO, ADC, I2C, UART, USB serial and MIDI, timers, `System`, `AudioHandle` and `DaisySeed`. It also emulates the MPR121 (pads, with pressure) and the SSD1306 (OLED) at register level, and exports the `st_*` functions the page calls.
- **Timing.** The worklet asks for 128-frame quanta. The board cuts them into the firmware's own audio blocks, one block ahead as on the Seed. Before each block it runs the main-loop passes that have come due: one every 1 ms, or later when a pass called `System::Delay()` for longer. Everything runs on the audio thread, against a virtual clock driven by the samples rendered.
- **Boot film.** Setup runs once, when the page starts the module. Whatever it shows on the OLED and LED along the way (a boot animation) is recorded with its timing, and the page plays it back.

## Building a firmware

You need GNU make (the Daisy Toolchain has it), Node 18 or later, and [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) 34 or later: clang with a C/C++ library for WebAssembly. To install wasi-sdk, unpack its release into `~/.wasi-sdk`, where the build script looks for it:

```sh
mkdir -p ~/.wasi-sdk && cd ~/.wasi-sdk
# Windows (Git Bash); on Linux use x86_64-linux, on Apple silicon arm64-macos
curl -LO https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-windows.tar.gz
tar -xzf wasi-sdk-34.0-x86_64-windows.tar.gz && rm wasi-sdk-34.0-x86_64-windows.tar.gz
```

Elsewhere, set `WASI_SDK_PATH` to the unpacked folder, or pass `--wasi-sdk <dir>`.

```sh
node scripts/build.mjs ../TouchVink
# → ../TouchVink/build-web/TouchVink.wasm, plus the "emulator" block to publish
```

The script asks the firmware's own Makefile what it builds. It sets `SYSTEM_FILES_DIR` to `make/`, so `include $(SYSTEM_FILES_DIR)/Makefile` reads [make/Makefile](make/Makefile) instead of libDaisy's, and that file prints `CPP_SOURCES`, `C_INCLUDES`, `C_DEFS`, `OPT` and the rest. Any firmware with the usual libDaisy Makefile works without changes to the Makefile.

### The one change in the firmware

On the Seed, `main()` sets up and then loops forever. A browser can't block in a loop, so split it in two and register both halves:

```cpp
static void Setup() { /* main() up to the loop */ }
static void Loop()  { /* one pass of the loop */ }

#ifdef SIMPLE_TOUCH_WEB
#include "simple_touch_web.h"
ST_WEB_FIRMWARE(Setup, Loop)
#else
int main() {
    Setup();
    while (true) Loop();
}
#endif
```

`SIMPLE_TOUCH_WEB` is defined for every file of the browser build. Use it to leave out anything with no browser equivalent, such as flash writes or bootloader jumps.

## Checking a build

[test/smoke.mjs](test/smoke.mjs) runs a build headless in Node, through the same worklet processor the page uses. It boots the firmware, plays the pads, and prints the levels, the OLED (as text), the LED and MIDI activity and the render speed. It also writes the audio to a WAV next to the build:

```sh
node test/smoke.mjs ../TouchVink/build-web/TouchVink.wasm 0,4,5,6   # P0, then P4, P5, P6
```

## Playing it

[demo/index.html](demo/index.html) is a test bench, online at [jonwaterschoot.github.io/simple-touch-web/demo](https://jonwaterschoot.github.io/simple-touch-web/demo/?wasm=). It has:

- the controls laid out as on the panel, and the pads with force
- the OLED and LED
- audio in: the mic, a loop from [demo/loops](demo/loops/loops.json), or a file of your own
- Web MIDI as MIDI input
- the firmware's log

Add `?wasm=<url>` to play a published build. For a local build, serve a folder that holds both repositories:

```sh
cd ~/GitHub && python -m http.server
# http://localhost:8000/simple-touch-web/demo/?wasm=/TouchVink/build-web/TouchVink.wasm
```

In a page of your own:

```js
import { SimpleTouch } from './web/simple-touch.js';
import { drawOled } from './web/oled.js';

const ctx = new AudioContext({ sampleRate: 48000 });
const st = await SimpleTouch.load(ctx, 'TouchVink.wasm', { sha256: '…' });
st.node.connect(ctx.destination);
st.on('oled', ({ ram, info }) => drawOled(canvas, ram, info));
st.on('led', ({ on }) => led.classList.toggle('on', on));
await st.ready;

st.setControl('S30', 0.7);          // knobs and faders S30..S37, 0..1
st.setSwitch('S09_S10', 'right');   // left | centre | right;  S07_S08: up | centre | down
st.setPad(3, true, 0.6);            // pad P3 down, force 0.6
st.sendMidi([0x90, 60, 100]);       // into the firmware's USB MIDI
```

Put a limiter after the node before the speakers, as the demo does. A feedback patch can get loud.

## Publishing a build

A firmware repository builds and publishes itself with one small workflow, `.github/workflows/browser-build.yml`:

```yaml
name: Browser build
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  browser:
    uses: jonwaterschoot/simple-touch-web/.github/workflows/build-firmware.yml@v1
    permissions:
      contents: write
```

On every push, the shared workflow ([build-firmware.yml](.github/workflows/build-firmware.yml)) does four things:

1. Checks out the firmware with its submodules, then builds it with `scripts/build.mjs`.
2. Runs `test/smoke.mjs` on the build, so a build that doesn't boot is never published.
3. Adds the build to the repository's `simple-touch-web` branch. Builds are named by their hash (`TouchVink-474a3c9633c7.wasm`), so a new build never replaces an approved one, and the branch keeps the newest 20.
4. Writes a run summary with a link that plays the build on the [test bench](https://jonwaterschoot.github.io/simple-touch-web/demo/), and the `emulator` block for that build.

The workflow takes these inputs: `firmware-dir` (where the Makefile is), `branch`, `keep` and `simple-touch-web-ref`.

### Approving a build

The author decides whether others may play their firmware, and which build. Approving one means pasting its `emulator` block into the firmware's `simple-touch-labels.json`:

```json
"emulator": {
  "wasm": "https://raw.githubusercontent.com/<owner>/<repo>/simple-touch-web/TouchVink-474a3c9633c7.wasm",
  "abi": "simple-touch-web/1",
  "sha256": "474a3c9633c7…",
  "embed": "allowed"
}
```

- `embed: "allowed"` lets the Simple Touch library play the build in its own page. `"link-only"`, or no block, means the library only links to the author's page (add `"url"`).
- `sha256` pins the approved build: the loader refuses any other. A build is reproducible, so the same sources and toolchain give the same hash.
- `raw.githubusercontent.com` and GitHub Pages send the CORS header that a page on another site needs. GitHub release downloads may not.

## What the board has, and doesn't

| Has | Doesn't (yet) |
| --- | --- |
| Knobs and faders S30..S37 (ADC, also `GetPtr` for `AnalogControl`) | DAC, QSPI flash, SD card, `PersistentStorage` |
| Both levers (`Switch3` on D6..D9), any GPIO input the page drives | Timer interrupts (`TimerHandle::SetCallback`) |
| MPR121 on I2C1 (0x5A), with pressure from the electrode data | TRS MIDI (UART): stays silent |
| SSD1306 128×32 / 128×64 on I2C1 (0x3C), optional | SPI displays |
| Stereo audio in and out at the page's rate (48 kHz where it can) | Other sample rates on request: the firmware gets the page's |
| USB MIDI in and out (notes, CCs, SysEx), USB serial to the log | |

A firmware that uses something the board lacks fails to build (a missing HAL header or method) instead of misbehaving.

## Licenses

simple-touch-web is MIT. A build also contains libDaisy (MIT), DaisySP (MIT) and, when the firmware uses it, DaisySP-LGPL (LGPL 2.1). If you publish a build with LGPL code, keep the firmware's source public and credit it.
