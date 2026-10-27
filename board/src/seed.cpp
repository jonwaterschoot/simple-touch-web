// DaisySeed and AudioHandle on the virtual board. The page sets the sample
// rate (its AudioContext's, 48 kHz where the browser allows); a firmware's
// SetAudioSampleRate() is kept but can't change it, so AudioSampleRate()
// always tells the truth.

#include "board.h"
#include "daisy_seed.h"

using namespace daisy;

// ============================================================ AudioHandle

class AudioHandle::Impl
{
  public:
    Config config;
};

namespace
{
AudioHandle::Impl audio_impl;  // one codec: every AudioHandle shares it
}

AudioHandle::Result AudioHandle::Init(const Config& config, SaiHandle)
{
    pimpl_             = &audio_impl;
    audio_impl.config = config;
    stweb::SetBlockSize(config.blocksize);
    return Result::OK;
}

AudioHandle::Result AudioHandle::Init(const Config& config, SaiHandle sai1, SaiHandle)
{
    return Init(config, sai1);
}

AudioHandle::Result AudioHandle::DeInit() { return Stop(); }

const AudioHandle::Config& AudioHandle::GetConfig() const { return audio_impl.config; }
size_t                     AudioHandle::GetChannels() const { return 2; }
float                      AudioHandle::GetSampleRate() { return stweb::SampleRate(); }

AudioHandle::Result AudioHandle::SetSampleRate(SaiHandle::Config::SampleRate samplerate)
{
    audio_impl.config.samplerate = samplerate;
    return Result::OK;
}

AudioHandle::Result AudioHandle::SetBlockSize(size_t size)
{
    audio_impl.config.blocksize = size;
    stweb::SetBlockSize(size);
    return Result::OK;
}

AudioHandle::Result AudioHandle::SetPostGain(float val)
{
    audio_impl.config.postgain = val;
    return Result::OK;
}

AudioHandle::Result AudioHandle::SetOutputCompensation(float val)
{
    audio_impl.config.output_compensation = val;
    return Result::OK;
}

AudioHandle::Result AudioHandle::Start(AudioCallback callback)
{
    stweb::SetAudioCallback(reinterpret_cast<stweb::AudioCallback>(callback));
    return Result::OK;
}

AudioHandle::Result AudioHandle::Start(InterleavingAudioCallback callback)
{
    stweb::SetInterleavedCallback(reinterpret_cast<stweb::InterleavedCallback>(callback));
    return Result::OK;
}

AudioHandle::Result AudioHandle::Stop()
{
    stweb::StopAudio();
    return Result::OK;
}

AudioHandle::Result AudioHandle::ChangeCallback(AudioCallback callback) { return Start(callback); }
AudioHandle::Result AudioHandle::ChangeCallback(InterleavingAudioCallback callback) { return Start(callback); }

// ============================================================ DaisySeed

namespace
{
constexpr Pin kPins[] = {
    seed::D0,  seed::D1,  seed::D2,  seed::D3,  seed::D4,  seed::D5,  seed::D6,
    seed::D7,  seed::D8,  seed::D9,  seed::D10, seed::D11, seed::D12, seed::D13,
    seed::D14, seed::D15, seed::D16, seed::D17, seed::D18, seed::D19, seed::D20,
    seed::D21, seed::D22, seed::D23, seed::D24, seed::D25, seed::D26, seed::D27,
    seed::D28, seed::D29, seed::D30, seed::D31, seed::D32,
};
constexpr Pin kLedPin       = Pin(PORTC, 7);
constexpr Pin kTestPointPin = Pin(PORTG, 14);
} // namespace

void DaisySeed::Configure() {}

void DaisySeed::Init(bool)
{
    led.Init(kLedPin, GPIO::Mode::OUTPUT);
    testpoint.Init(kTestPointPin, GPIO::Mode::OUTPUT);
    AudioHandle::Config cfg;
    cfg.blocksize  = 48;
    cfg.samplerate = SaiHandle::Config::SampleRate::SAI_48KHZ;
    audio_handle.Init(cfg, SaiHandle());
}

void DaisySeed::DeInit() {}
void DaisySeed::DelayMs(size_t del) { System::Delay(uint32_t(del)); }

Pin DaisySeed::GetPin(uint8_t pin_idx)
{
    return pin_idx < sizeof(kPins) / sizeof(kPins[0]) ? kPins[pin_idx] : Pin();
}

void DaisySeed::StartAudio(AudioHandle::InterleavingAudioCallback cb) { audio_handle.Start(cb); }
void DaisySeed::StartAudio(AudioHandle::AudioCallback cb) { audio_handle.Start(cb); }
void DaisySeed::ChangeAudioCallback(AudioHandle::InterleavingAudioCallback cb) { audio_handle.ChangeCallback(cb); }
void DaisySeed::ChangeAudioCallback(AudioHandle::AudioCallback cb) { audio_handle.ChangeCallback(cb); }
void DaisySeed::StopAudio() { audio_handle.Stop(); }

void DaisySeed::SetAudioSampleRate(SaiHandle::Config::SampleRate samplerate)
{
    audio_handle.SetSampleRate(samplerate);
}

float  DaisySeed::AudioSampleRate() { return audio_handle.GetSampleRate(); }
void   DaisySeed::SetAudioBlockSize(size_t blocksize) { audio_handle.SetBlockSize(blocksize); }
size_t DaisySeed::AudioBlockSize() { return stweb::BlockSize(); }
float  DaisySeed::AudioCallbackRate() const { return stweb::SampleRate() / float(stweb::BlockSize()); }

void DaisySeed::SetLed(bool state) { stweb::PinWrite(kLedPin, state); }
void DaisySeed::SetTestPoint(bool state) { stweb::PinWrite(kTestPointPin, state); }
