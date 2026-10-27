#pragma once
// The virtual Simple Touch: the state behind libDaisy's peripherals, shared
// by the stand-ins (peripherals.cpp, seed.cpp) and the chips on the I2C bus
// (mpr121.cpp, ssd1306.cpp). board.cpp owns it and exports it to the page.

#include <cstddef>
#include <cstdint>
#include "daisy_core.h"

namespace stweb
{
// ------------------------------------------------------------ time
// Microseconds since boot, on the virtual clock. Audio advances it; a main
// loop pass sees it stand still apart from its own Delay() calls.
uint64_t NowUs();
void     DelayUs(uint64_t us);

// ------------------------------------------------------------ pins
constexpr int kNumAnalog = 14;  // Seed A0..A13. Simple Touch: S30..S37 = A0..A7.

int  AnalogIndex(daisy::Pin p);  // A-number of a Seed pin, -1 if it has none
float AnalogValue(int a);        // 0..1
void AdcRefresh();               // copies the page's values into the ADC's results
// What an input pin reads: the page's level if it set one (a switch closed
// to ground), else what the pin drives as an output, else its pull.
bool PinRead(daisy::Pin p, bool pullup);
void PinWrite(daisy::Pin p, bool level);
bool PinOutput(daisy::Pin p);
bool Led();

// ------------------------------------------------------------ audio
using AudioCallback = void (*)(const float* const* in, float** out, size_t size);
using InterleavedCallback = void (*)(const float* in, float* out, size_t size);

void   SetAudioCallback(AudioCallback cb);
void   SetInterleavedCallback(InterleavedCallback cb);
void   StopAudio();
void   SetBlockSize(size_t size);
size_t BlockSize();
float  SampleRate();

// ------------------------------------------------------------ I2C
class I2cDevice
{
  public:
    virtual ~I2cDevice() {}
    // One transaction each; false = no ACK.
    virtual bool Write(const uint8_t* data, size_t size) = 0;
    virtual bool Read(uint8_t* data, size_t size) = 0;
};
I2cDevice* I2cFind(int periph, uint16_t address);

// ------------------------------------------------------------ USB MIDI
using MidiRxCallback = void (*)(uint8_t* data, size_t size, void* context);
void MidiUsbListen(MidiRxCallback cb, void* context);
void MidiUsbSend(const uint8_t* data, size_t size);

} // namespace stweb
