#pragma once
// simple-touch-web: what a firmware adds for the browser build.
//
// On the Seed, main() runs setup and then loops forever. A browser can't
// block in a loop, so the virtual board calls the two halves itself: setup
// once, then one pass of the loop at a time, between audio blocks. Split
// main() into the two and register them:
//
//   static void Setup() { ...main() up to the loop... }
//   static void Loop()  { ...one pass of the loop... }
//
//   #ifdef SIMPLE_TOUCH_WEB
//   #include "simple_touch_web.h"
//   ST_WEB_FIRMWARE(Setup, Loop)
//   #else
//   int main() {
//       Setup();
//       while (true) Loop();
//   }
//   #endif
//
// The next pass starts 1 ms after the last one began, or later if the pass
// called System::Delay() for longer (a loop ending in Delay(5) runs at
// 200 Hz, as on the Seed). SIMPLE_TOUCH_WEB is defined for every file of the
// browser build, so firmware code can also leave out what has no browser
// equivalent (flash writes, bootloader jumps) with it.

#define ST_WEB_FIRMWARE(setup, loop)                  \
    extern "C" void st_firmware_setup() { setup(); } \
    extern "C" void st_firmware_loop() { loop(); }
