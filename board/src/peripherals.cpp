// libDaisy's peripheral classes on the virtual board. The declarations are
// libDaisy's own headers; these are the implementations the Seed gets from
// the STM32 HAL, rewired to board.cpp.

#include "board.h"
#include "daisy.h"
#include <algorithm>
#include <cstdio>
#include <cstring>

using namespace daisy;

// ============================================================ GPIO
void GPIO::Init()
{
    if(cfg_.mode == Mode::OUTPUT || cfg_.mode == Mode::OPEN_DRAIN)
        stweb::PinWrite(cfg_.pin, false);
}

void GPIO::Init(const Config& cfg)
{
    cfg_ = cfg;
    Init();
}

void GPIO::Init(Pin p, const Config& cfg)
{
    cfg_     = cfg;
    cfg_.pin = p;
    Init();
}

void GPIO::Init(Pin p, Mode m, Pull pu, Speed sp)
{
    cfg_.pin   = p;
    cfg_.mode  = m;
    cfg_.pull  = pu;
    cfg_.speed = sp;
    Init();
}

void GPIO::DeInit() {}

bool GPIO::Read() { return stweb::PinRead(cfg_.pin, cfg_.pull == Pull::PULLUP); }

void GPIO::Write(bool state) { stweb::PinWrite(cfg_.pin, state); }

void GPIO::Toggle() { stweb::PinWrite(cfg_.pin, !stweb::PinOutput(cfg_.pin)); }

// ============================================================ ADC
// One ADC (the Seed's). Each channel reads the page's value for its pin,
// refreshed before every audio block and main loop pass, so GetPtr()
// pointers (AnalogControl keeps one) see it change too.

namespace
{
Pin      adc_pin[DSY_ADC_MAX_CHANNELS];
size_t   adc_count = 0;
uint16_t adc_raw[DSY_ADC_MAX_CHANNELS][8];  // [channel][mux input]
} // namespace

void stweb::AdcRefresh()
{
    for(size_t ch = 0; ch < adc_count; ch++)
    {
        const float    v   = AnalogValue(AnalogIndex(adc_pin[ch]));
        const uint16_t raw = uint16_t(v * 65535.f + 0.5f);
        std::fill(adc_raw[ch], adc_raw[ch] + 8, raw);
    }
}

void AdcChannelConfig::InitSingle(Pin pin, ConversionSpeed speed)
{
    pin_.Init(pin, GPIO::Mode::ANALOG);
    mux_channels_ = 0;
    speed_        = speed;
}

void AdcChannelConfig::InitMux(Pin             adc_pin,
                               size_t          mux_channels,
                               Pin             mux_0,
                               Pin             mux_1,
                               Pin             mux_2,
                               ConversionSpeed speed)
{
    // A multiplexer's inputs all read the pin's one value.
    pin_.Init(adc_pin, GPIO::Mode::ANALOG);
    mux_pin_[0].Init(mux_0, GPIO::Mode::OUTPUT);
    mux_pin_[1].Init(mux_1, GPIO::Mode::OUTPUT);
    mux_pin_[2].Init(mux_2, GPIO::Mode::OUTPUT);
    mux_channels_ = uint8_t(std::min<size_t>(mux_channels, 8));
    speed_        = speed;
}

void AdcHandle::Init(AdcChannelConfig* cfg, size_t num_channels, OverSampling ovs)
{
    num_channels_ = std::min<size_t>(num_channels, DSY_ADC_MAX_CHANNELS);
    oversampling_ = ovs;
    adc_count     = num_channels_;
    for(size_t i = 0; i < num_channels_; i++)
        adc_pin[i] = cfg[i].pin_.GetConfig().pin;
    stweb::AdcRefresh();
}

void AdcHandle::Start() { stweb::AdcRefresh(); }
void AdcHandle::Stop() {}

uint16_t  AdcHandle::Get(uint8_t chn) const { return adc_raw[chn % DSY_ADC_MAX_CHANNELS][0]; }
uint16_t* AdcHandle::GetPtr(uint8_t chn) const { return &adc_raw[chn % DSY_ADC_MAX_CHANNELS][0]; }
float     AdcHandle::GetFloat(uint8_t chn) const { return Get(chn) / 65535.f; }

uint16_t AdcHandle::GetMux(uint8_t chn, uint8_t idx) const
{
    return adc_raw[chn % DSY_ADC_MAX_CHANNELS][idx & 7];
}
uint16_t* AdcHandle::GetMuxPtr(uint8_t chn, uint8_t idx) const
{
    return &adc_raw[chn % DSY_ADC_MAX_CHANNELS][idx & 7];
}
float AdcHandle::GetMuxFloat(uint8_t chn, uint8_t idx) const
{
    return GetMux(chn, idx) / 65535.f;
}

// ============================================================ I2C
// Transactions go to the chip at that address on the board (board.cpp
// I2cFind); nothing there is a NACK, as with no screen fitted. Addresses are
// 7-bit, as libDaisy takes them. DMA transfers complete at once.

class I2CHandle::Impl
{
  public:
    Config config;
};

namespace
{
I2CHandle::Impl i2c_impl[4];

stweb::I2cDevice* FindDevice(const I2CHandle::Impl* impl, uint16_t address)
{
    return impl ? stweb::I2cFind(int(impl->config.periph), address) : nullptr;
}
} // namespace

I2CHandle::Result I2CHandle::Init(const Config& config)
{
    pimpl_         = &i2c_impl[int(config.periph) & 3];
    pimpl_->config = config;
    return Result::OK;
}

const I2CHandle::Config& I2CHandle::GetConfig() const { return pimpl_->config; }

I2CHandle::Result I2CHandle::TransmitBlocking(uint16_t address, uint8_t* data, uint16_t size, uint32_t)
{
    stweb::I2cDevice* dev = FindDevice(pimpl_, address);
    return dev && dev->Write(data, size) ? Result::OK : Result::ERR;
}

I2CHandle::Result I2CHandle::ReceiveBlocking(uint16_t address, uint8_t* data, uint16_t size, uint32_t)
{
    stweb::I2cDevice* dev = FindDevice(pimpl_, address);
    return dev && dev->Read(data, size) ? Result::OK : Result::ERR;
}

I2CHandle::Result I2CHandle::TransmitDma(uint16_t            address,
                                         uint8_t*            data,
                                         uint16_t            size,
                                         CallbackFunctionPtr callback,
                                         void*               callback_context)
{
    const Result r = TransmitBlocking(address, data, size, 0);
    if(callback)
        callback(callback_context, r);
    return r;
}

I2CHandle::Result I2CHandle::ReceiveDma(uint16_t            address,
                                        uint8_t*            data,
                                        uint16_t            size,
                                        CallbackFunctionPtr callback,
                                        void*               callback_context)
{
    const Result r = ReceiveBlocking(address, data, size, 0);
    if(callback)
        callback(callback_context, r);
    return r;
}

I2CHandle::Result I2CHandle::ReadDataAtAddress(uint16_t address,
                                               uint16_t mem_address,
                                               uint16_t mem_address_size,
                                               uint8_t* data,
                                               uint16_t data_size,
                                               uint32_t)
{
    stweb::I2cDevice* dev = FindDevice(pimpl_, address);
    if(!dev)
        return Result::ERR;
    uint8_t reg[2] = {uint8_t(mem_address >> 8), uint8_t(mem_address)};
    const bool wide = mem_address_size > 1;
    if(!dev->Write(wide ? reg : reg + 1, wide ? 2 : 1))
        return Result::ERR;
    return dev->Read(data, data_size) ? Result::OK : Result::ERR;
}

I2CHandle::Result I2CHandle::WriteDataAtAddress(uint16_t address,
                                                uint16_t mem_address,
                                                uint16_t mem_address_size,
                                                uint8_t* data,
                                                uint16_t data_size,
                                                uint32_t)
{
    stweb::I2cDevice* dev = FindDevice(pimpl_, address);
    uint8_t           buf[2 + 256];
    if(!dev || data_size > 256)
        return Result::ERR;
    size_t n = 0;
    if(mem_address_size > 1)
        buf[n++] = uint8_t(mem_address >> 8);
    buf[n++] = uint8_t(mem_address);
    std::memcpy(buf + n, data, data_size);
    return dev->Write(buf, n + data_size) ? Result::OK : Result::ERR;
}

// ============================================================ UART
// No serial port: TRS MIDI and the like stay silent. Transmits succeed and
// go nowhere; receives never complete.

class UartHandler::Impl
{
  public:
    Config config;
    bool   listening = false;
};

namespace
{
UartHandler::Impl uart_impl[16];
}

UartHandler::Result UartHandler::Init(const Config& config)
{
    pimpl_         = &uart_impl[int(config.periph) & 15];
    pimpl_->config = config;
    return Result::OK;
}

const UartHandler::Config& UartHandler::GetConfig() const { return pimpl_->config; }

UartHandler::Result UartHandler::BlockingTransmit(uint8_t*, size_t, uint32_t) { return Result::OK; }
UartHandler::Result UartHandler::BlockingReceive(uint8_t*, uint16_t, uint32_t) { return Result::ERR; }

UartHandler::Result UartHandler::DmaTransmit(uint8_t*,
                                             size_t,
                                             StartCallbackFunctionPtr start_callback,
                                             EndCallbackFunctionPtr   end_callback,
                                             void*                    callback_context)
{
    if(start_callback)
        start_callback(callback_context);
    if(end_callback)
        end_callback(callback_context, Result::OK);
    return Result::OK;
}

UartHandler::Result UartHandler::DmaReceive(uint8_t*, size_t, StartCallbackFunctionPtr, EndCallbackFunctionPtr, void*)
{
    return Result::OK;
}

UartHandler::Result UartHandler::DmaListenStart(uint8_t*, size_t, CircularRxCallbackFunctionPtr, void*)
{
    if(pimpl_)
        pimpl_->listening = true;
    return Result::OK;
}

UartHandler::Result UartHandler::DmaListenStop()
{
    if(pimpl_)
        pimpl_->listening = false;
    return Result::OK;
}

bool UartHandler::IsListening() const { return pimpl_ && pimpl_->listening; }
int  UartHandler::CheckError() { return 0; }
int  UartHandler::PollReceive(uint8_t*, size_t, uint32_t) { return -1; }
UartHandler::Result UartHandler::PollTx(uint8_t*, size_t) { return Result::OK; }

// ============================================================ USB
// The USB serial port (CDC) prints to the page's log; nothing comes back.

void UsbHandle::Init(UsbPeriph) {}
void UsbHandle::DeInit(UsbPeriph) {}

UsbHandle::Result UsbHandle::TransmitInternal(uint8_t* buff, size_t size)
{
    fwrite(buff, 1, size, stdout);
    fflush(stdout);
    return Result::OK;
}

UsbHandle::Result UsbHandle::TransmitExternal(uint8_t* buff, size_t size)
{
    return TransmitInternal(buff, size);
}

void UsbHandle::SetReceiveCallback(ReceiveCallback, UsbPeriph) {}

// ============================================================ USB MIDI
// The page's MIDI connection: what it sends arrives before the next main
// loop pass; what the firmware sends (notes, CCs, SysEx) goes to the page.

class MidiUsbTransport::Impl
{
};

namespace
{
MidiUsbTransport::Impl usb_midi_impl;
}

void MidiUsbTransport::Init(Config) { pimpl_ = &usb_midi_impl; }
void MidiUsbTransport::StartRx(MidiRxParseCallback callback, void* context)
{
    stweb::MidiUsbListen(callback, context);
}
bool MidiUsbTransport::RxActive() { return true; }
void MidiUsbTransport::FlushRx() {}
void MidiUsbTransport::Tx(uint8_t* buffer, size_t size) { stweb::MidiUsbSend(buffer, size); }

// ============================================================ DMA
extern "C"
{
    void dsy_dma_init(void) {}
    void dsy_dma_deinit(void) {}
    void dsy_dma_clear_cache_for_buffer(uint8_t*, size_t) {}
    void dsy_dma_invalidate_cache_for_buffer(uint8_t*, size_t) {}
}

// ============================================================ timers
// Free-running counters on the virtual clock at 200 MHz, as TIM2 runs on
// the Seed. Period interrupts (SetCallback) are not emulated.

namespace
{
constexpr uint32_t kTickHz = 200000000;
uint32_t           Ticks() { return uint32_t(stweb::NowUs() * (kTickHz / 1000000)); }
} // namespace

class TimerHandle::Impl
{
  public:
    Config config;
};

namespace
{
TimerHandle::Impl tim_impl[4];
}

TimerHandle::Result TimerHandle::Init(const Config& config)
{
    pimpl_         = &tim_impl[int(config.periph) & 3];
    pimpl_->config = config;
    return Result::OK;
}

TimerHandle::Result        TimerHandle::DeInit() { return Result::OK; }
const TimerHandle::Config& TimerHandle::GetConfig() const { return pimpl_->config; }

TimerHandle::Result TimerHandle::SetPeriod(uint32_t ticks)
{
    if(pimpl_)
        pimpl_->config.period = ticks;
    return Result::OK;
}

TimerHandle::Result TimerHandle::SetPrescaler(uint32_t) { return Result::OK; }
TimerHandle::Result TimerHandle::Start() { return Result::OK; }
TimerHandle::Result TimerHandle::Stop() { return Result::OK; }

uint32_t TimerHandle::GetFreq() { return kTickHz; }
uint32_t TimerHandle::GetTick() { return Ticks(); }
uint32_t TimerHandle::GetMs() { return uint32_t(stweb::NowUs() / 1000); }
uint32_t TimerHandle::GetUs() { return uint32_t(stweb::NowUs()); }

void TimerHandle::DelayTick(uint32_t del) { stweb::DelayUs(del / (kTickHz / 1000000)); }
void TimerHandle::DelayMs(uint32_t del) { stweb::DelayUs(uint64_t(del) * 1000); }
void TimerHandle::DelayUs(uint32_t del) { stweb::DelayUs(del); }
void TimerHandle::SetCallback(PeriodElapsedCallback, void*) {}

// ============================================================ System

namespace daisy
{
volatile System::BootInfo boot_info = {};
TimerHandle               System::tim_;
} // namespace daisy

void System::Init() { cfg_.Defaults(); }
void System::Init(const Config& config) { cfg_ = config; }
void System::DeInit() {}
void System::JumpToQspi() {}

uint32_t System::GetNow() { return uint32_t(stweb::NowUs() / 1000); }
uint32_t System::GetUs() { return uint32_t(stweb::NowUs()); }
uint32_t System::GetTick() { return Ticks(); }

void System::Delay(uint32_t delay_ms) { stweb::DelayUs(uint64_t(delay_ms) * 1000); }
void System::DelayUs(uint32_t delay_us) { stweb::DelayUs(delay_us); }
void System::DelayTicks(uint32_t delay_ticks) { stweb::DelayUs(delay_ticks / (kTickHz / 1000000)); }

void System::ResetToBootloader(BootloaderMode) {}
void System::InitBackupSram() {}
System::BootInfo::Version System::GetBootloaderVersion() { return BootInfo::Version::NONE; }

uint32_t System::GetTickFreq() { return kTickHz; }
uint32_t System::GetSysClkFreq() { return 480000000; }
uint32_t System::GetHClkFreq() { return 240000000; }
uint32_t System::GetPClk1Freq() { return 120000000; }
uint32_t System::GetPClk2Freq() { return 120000000; }

System::MemoryRegion System::GetProgramMemoryRegion() { return INTERNAL_FLASH; }
System::MemoryRegion System::GetMemoryRegion(uint32_t) { return INVALID_ADDRESS; }

extern "C"
{
    uint32_t HAL_GetTick(void) { return System::GetNow(); }
    void     HAL_Delay(uint32_t ms) { System::Delay(ms); }
}
