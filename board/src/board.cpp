// The virtual Simple Touch: its clock, pins, audio blocks, the main loop's
// passes, the chips on I2C1, and the functions the page calls (st_*, see
// web/simple-touch-processor.js for the other side).
//
// Timing. The page asks for audio in quanta (128 frames in today's
// browsers). The board cuts them into the firmware's own blocks (its
// SetAudioBlockSize) and calls the audio callback once per block, one block
// ahead, so the output runs one block late, as on the Seed. Before each
// block it runs the main loop passes that have come due: one every 1 ms, or
// later when a pass called System::Delay() for longer. The clock is the
// audio's: samples rendered, plus however long setup "waited".
//
// Setup runs once, from st_init, with time standing still except for its
// own Delay() calls. Whatever it shows on the OLED and the LED along the way
// (a boot animation) is kept as the boot film, with times, for the page to
// play back.

#include "board.h"
#include "devices.h"
#include "daisy_seed.h"
#include <algorithm>
#include <cstring>

extern "C" void st_firmware_setup();
extern "C" void st_firmware_loop();

#define ST_EXPORT(name) extern "C" __attribute__((export_name(#name)))

using daisy::Pin;

namespace stweb
{
namespace
{
// ------------------------------------------------------------ clock
enum class Phase
{
    Boot,   // before st_init
    Setup,  // st_firmware_setup()
    Run,
};
Phase phase = Phase::Boot;

uint32_t sample_rate   = 48000;
uint64_t samples       = 0;  // rendered since setup ended
uint64_t base_us       = 0;  // the clock when setup ended
uint64_t setup_us      = 0;
bool     in_pass       = false;
uint64_t pass_start_us = 0, pass_delay_us = 0, next_pass_us = 0;

constexpr uint64_t kPassUs          = 1000;
constexpr int      kMaxPassesPerBlock = 8;

uint64_t AudioClockUs() { return base_us + samples * 1000000ull / sample_rate; }

// ------------------------------------------------------------ pins
constexpr int kPinSlots = 11 * 16;  // PORTA..PORTK, 16 pins each
int8_t forced[kPinSlots];           // -1: the page leaves the pin alone
bool   out_level[kPinSlots];
bool   is_output[kPinSlots];
float  analog[kNumAnalog];

struct PinsInit
{
    PinsInit() { std::memset(forced, -1, sizeof(forced)); }
} pins_init;

int Slot(Pin p) { return p.port < daisy::PORTX && p.pin < 16 ? p.port * 16 + p.pin : -1; }

constexpr Pin kLedPin = Pin(daisy::PORTC, 7);

// ------------------------------------------------------------ the LED as shown
// A main loop pass runs in one go, ahead of the audio, and its Delay() calls
// only move its own clock. A blink made inside one pass (on, wait, off)
// would reach the page as its last state. So each change of the LED is
// queued with the clock at that moment, and st_led() shows it when the
// audio gets there.
struct LedEdge
{
    uint64_t us;
    bool     on;
};
constexpr int kLedEdges = 64;
LedEdge       led_edges[kLedEdges];
int           led_first = 0, led_count = 0;
bool          led_shown = false;

void QueueLed(bool on)
{
    const bool last
        = led_count ? led_edges[(led_first + led_count - 1) % kLedEdges].on : led_shown;
    if(on == last)
        return;
    if(led_count == kLedEdges)  // full: the oldest change shows now
    {
        led_shown = led_edges[led_first].on;
        led_first = (led_first + 1) % kLedEdges;
        led_count--;
    }
    led_edges[(led_first + led_count) % kLedEdges] = {NowUs(), on};
    led_count++;
}

// ------------------------------------------------------------ audio
constexpr size_t kMaxFrames = 1024;  // per st_process call
constexpr size_t kMaxBlock  = 1024;

float in_l[kMaxFrames], in_r[kMaxFrames], out_l[kMaxFrames], out_r[kMaxFrames];
float blk_in[2][kMaxBlock], blk_out[2][kMaxBlock];
float blk_in_il[2 * kMaxBlock], blk_out_il[2 * kMaxBlock];
size_t block = 48, pos = 0;

AudioCallback       audio_cb = nullptr;
InterleavedCallback il_cb    = nullptr;

// ------------------------------------------------------------ devices
Mpr121  pads;
Ssd1306 oled;
bool    oled_fitted = true;

// ------------------------------------------------------------ USB MIDI
MidiRxCallback midi_cb  = nullptr;
void*          midi_ctx = nullptr;
uint8_t        midi_in_stage[256];
uint8_t        midi_in[2048];
size_t         midi_in_len = 0;
uint8_t        midi_rx[2048];
uint8_t        midi_out[8192];
size_t         midi_out_len = 0;

// ------------------------------------------------------------ boot film
struct BootFrame
{
    uint32_t ms;
    uint32_t info;
    uint8_t  led;
    uint8_t  ram[Ssd1306::kPages * Ssd1306::kWidth];
};
constexpr int kMaxBootFrames = 120;
BootFrame     boot[kMaxBootFrames];
int           boot_count = 0;
uint32_t      boot_seq   = 0;
bool          boot_led   = false;

void CaptureBootFrame()
{
    const bool led = Led();
    if(boot_count > 0 && oled.Seq() == boot_seq && led == boot_led)
        return;
    if(boot_count == kMaxBootFrames)
        return;
    BootFrame& f = boot[boot_count++];
    f.ms         = uint32_t(setup_us / 1000);
    f.info       = oled_fitted ? oled.Info() : 0;
    f.led        = led;
    std::memcpy(f.ram, oled.Ram(), sizeof(f.ram));
    boot_seq = oled.Seq();
    boot_led = led;
}

// ------------------------------------------------------------ main loop
void DeliverMidi()
{
    if(midi_in_len == 0)
        return;
    const size_t n = midi_in_len;
    std::memcpy(midi_rx, midi_in, n);
    midi_in_len = 0;
    if(midi_cb)
        midi_cb(midi_rx, n, midi_ctx);
}

void RunPass()
{
    DeliverMidi();
    in_pass       = true;
    pass_start_us = AudioClockUs();
    pass_delay_us = 0;
    st_firmware_loop();
    in_pass      = false;
    next_pass_us = pass_start_us + std::max(pass_delay_us, kPassUs);
}

void RunBlock()
{
    int passes = 0;
    while(next_pass_us <= AudioClockUs() && passes < kMaxPassesPerBlock)
    {
        RunPass();
        passes++;
    }
    if(next_pass_us <= AudioClockUs())  // fell behind: skip, don't catch up
        next_pass_us = AudioClockUs() + kPassUs;

    AdcRefresh();
    if(audio_cb)
    {
        const float* in[2]  = {blk_in[0], blk_in[1]};
        float*       out[2] = {blk_out[0], blk_out[1]};
        audio_cb(in, out, block);
    }
    else if(il_cb)
    {
        for(size_t i = 0; i < block; i++)
        {
            blk_in_il[2 * i]     = blk_in[0][i];
            blk_in_il[2 * i + 1] = blk_in[1][i];
        }
        il_cb(blk_in_il, blk_out_il, 2 * block);  // libDaisy: size counts both channels
        for(size_t i = 0; i < block; i++)
        {
            blk_out[0][i] = blk_out_il[2 * i];
            blk_out[1][i] = blk_out_il[2 * i + 1];
        }
    }
    else
    {
        std::memset(blk_out, 0, sizeof(blk_out));
    }
}

} // namespace

// ============================================================ board.h
uint64_t NowUs()
{
    if(phase != Phase::Run)
        return setup_us;
    return in_pass ? pass_start_us + pass_delay_us : AudioClockUs();
}

void DelayUs(uint64_t us)
{
    if(phase == Phase::Setup)
    {
        CaptureBootFrame();
        setup_us += us;
    }
    else if(in_pass)
    {
        pass_delay_us += us;
    }
    // In the audio callback a delay would only stall the block: ignored.
}

int AnalogIndex(Pin p)
{
    static constexpr Pin kAnalogPins[kNumAnalog]
        = {daisy::seed::A0, daisy::seed::A1, daisy::seed::A2,  daisy::seed::A3,  daisy::seed::A4,
           daisy::seed::A5, daisy::seed::A6, daisy::seed::A7,  daisy::seed::A8,  daisy::seed::A9,
           daisy::seed::A10, daisy::seed::A11, daisy::seed::A12, daisy::seed::A13};
    for(int a = 0; a < kNumAnalog; a++)
        if(kAnalogPins[a] == p)
            return a;
    return -1;
}

float AnalogValue(int a) { return a >= 0 && a < kNumAnalog ? analog[a] : 0.f; }

bool PinRead(Pin p, bool pullup)
{
    const int s = Slot(p);
    if(s < 0)
        return false;
    if(forced[s] >= 0)
        return forced[s];
    if(is_output[s])
        return out_level[s];
    return pullup;
}

void PinWrite(Pin p, bool level)
{
    const int s = Slot(p);
    if(s < 0)
        return;
    is_output[s] = true;
    out_level[s] = level;
    if(s == Slot(kLedPin) && phase == Phase::Run)
        QueueLed(level);
}

bool PinOutput(Pin p)
{
    const int s = Slot(p);
    return s >= 0 && out_level[s];
}

bool Led() { return PinOutput(kLedPin); }

void SetAudioCallback(AudioCallback cb)
{
    audio_cb = cb;
    il_cb    = nullptr;
}

void SetInterleavedCallback(InterleavedCallback cb)
{
    il_cb    = cb;
    audio_cb = nullptr;
}

void StopAudio()
{
    audio_cb = nullptr;
    il_cb    = nullptr;
}

void SetBlockSize(size_t size)
{
    block = std::clamp<size_t>(size, 1, kMaxBlock);
    pos   = 0;
}

size_t BlockSize() { return block; }
float  SampleRate() { return float(sample_rate); }

I2cDevice* I2cFind(int periph, uint16_t address)
{
    if(periph != 0)  // I2C1 is the Simple Touch's bus
        return nullptr;
    if(address == 0x5A)
        return &pads;
    if(address == 0x3C && oled_fitted)
        return &oled;
    return nullptr;
}

void MidiUsbListen(MidiRxCallback cb, void* context)
{
    midi_cb  = cb;
    midi_ctx = context;
}

void MidiUsbSend(const uint8_t* data, size_t size)
{
    if(midi_out_len + size > sizeof(midi_out))
        return;  // the page isn't reading: drop, never block
    std::memcpy(midi_out + midi_out_len, data, size);
    midi_out_len += size;
}

} // namespace stweb

// ============================================================ exports
using namespace stweb;

ST_EXPORT(st_abi) int st_abi() { return 1; }

// Before st_init. bit 0: an OLED is fitted (default).
ST_EXPORT(st_configure) void st_configure(int flags) { oled_fitted = flags & 1; }

ST_EXPORT(st_init) void st_init(float rate)
{
    sample_rate = uint32_t(rate + 0.5f);
    phase       = Phase::Setup;
    st_firmware_setup();
    CaptureBootFrame();
    phase        = Phase::Run;
    base_us      = setup_us;
    samples      = 0;
    next_pass_us = base_us;
    led_shown    = Led();
}

ST_EXPORT(st_max_frames) int st_max_frames() { return int(kMaxFrames); }
ST_EXPORT(st_in_l) float* st_in_l() { return in_l; }
ST_EXPORT(st_in_r) float* st_in_r() { return in_r; }
ST_EXPORT(st_out_l) float* st_out_l() { return out_l; }
ST_EXPORT(st_out_r) float* st_out_r() { return out_r; }
ST_EXPORT(st_block_size) int st_block_size() { return int(block); }
ST_EXPORT(st_now_ms) double st_now_ms() { return double(NowUs()) / 1000.0; }

ST_EXPORT(st_process) void st_process(int frames)
{
    if(phase != Phase::Run)
        return;
    frames = std::clamp(frames, 0, int(kMaxFrames));
    for(int i = 0; i < frames; i++)
    {
        if(pos == 0)
            RunBlock();
        out_l[i]         = blk_out[0][pos];
        out_r[i]         = blk_out[1][pos];
        blk_in[0][pos]   = in_l[i];
        blk_in[1][pos]   = in_r[i];
        samples++;
        if(++pos >= block)
            pos = 0;
    }
}

// Seed A0..A13, 0..1. Simple Touch: S30..S37 = A0..A7.
ST_EXPORT(st_set_adc) void st_set_adc(int a, float value)
{
    if(a >= 0 && a < kNumAnalog)
        analog[a] = std::clamp(value, 0.f, 1.f);
}

// Seed D0..D32: -1 lets go of the pin, 0 / 1 holds it low / high (a switch
// contact closed to ground is 0).
ST_EXPORT(st_set_pin) void st_set_pin(int d, int level)
{
    const int s = Slot(daisy::DaisySeed::GetPin(uint8_t(d)));
    if(s >= 0)
        forced[s] = int8_t(level < 0 ? -1 : level ? 1 : 0);
}

// MPR121 electrode i (Simple Touch pad Pi), force 0..1.
ST_EXPORT(st_set_pad) void st_set_pad(int i, int touched, float force)
{
    pads.SetPad(i, touched != 0, force);
}

// The page writes up to 256 bytes into st_midi_in_buf(), then st_midi_in(n)
// queues them for the firmware's USB MIDI input.
ST_EXPORT(st_midi_in_buf) uint8_t* st_midi_in_buf() { return midi_in_stage; }
ST_EXPORT(st_midi_in) void st_midi_in(int n)
{
    n = std::clamp(n, 0, int(sizeof(midi_in_stage)));
    if(midi_in_len + n > sizeof(midi_in))
        return;
    std::memcpy(midi_in + midi_in_len, midi_in_stage, n);
    midi_in_len += n;
}

// What the firmware sent on USB MIDI since the last st_midi_out_clear().
ST_EXPORT(st_midi_out_buf) uint8_t* st_midi_out_buf() { return midi_out; }
ST_EXPORT(st_midi_out_len) int st_midi_out_len() { return int(midi_out_len); }
ST_EXPORT(st_midi_out_clear) void st_midi_out_clear() { midi_out_len = 0; }

ST_EXPORT(st_led) int st_led()
{
    const uint64_t now = AudioClockUs();
    while(led_count && led_edges[led_first].us <= now)
    {
        led_shown = led_edges[led_first].on;
        led_first = (led_first + 1) % kLedEdges;
        led_count--;
    }
    return led_shown;
}

ST_EXPORT(st_oled_ram) const uint8_t* st_oled_ram() { return oled.Ram(); }
ST_EXPORT(st_oled_info) uint32_t st_oled_info() { return oled_fitted ? oled.Info() : 0; }
ST_EXPORT(st_oled_seq) uint32_t st_oled_seq() { return oled.Seq(); }

ST_EXPORT(st_boot_frames) int st_boot_frames() { return boot_count; }
ST_EXPORT(st_boot_ms) uint32_t st_boot_ms(int i) { return boot[i].ms; }
ST_EXPORT(st_boot_info) uint32_t st_boot_info(int i) { return boot[i].info; }
ST_EXPORT(st_boot_led) int st_boot_led(int i) { return boot[i].led; }
ST_EXPORT(st_boot_ram) const uint8_t* st_boot_ram(int i) { return boot[i].ram; }
