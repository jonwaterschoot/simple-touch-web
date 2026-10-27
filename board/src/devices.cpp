#include "devices.h"
#include <algorithm>
#include <cstring>

namespace stweb
{
// ============================================================ MPR121
// Registers: 0x00-0x01 touch status, 0x04-0x1D electrode filtered data
// (10 bit, LSB first), 0x1E-0x2A baselines (>> 2), 0x41 + 2i / 0x42 + 2i
// touch / release thresholds, 0x5C-0x5D CONFIG1-2, 0x5E ECR, 0x80 reset.
//
// A finger lowers an electrode's filtered value below its baseline; the
// difference (the delta) grows with contact area, so with how hard you
// press. Firmware like TouchVink reads pressure from it.

namespace
{
constexpr int kBaseline = 720;  // a multiple of 4: the baseline registers drop 2 bits
constexpr int kMaxDelta = 400;  // a firm press on a large pad
} // namespace

void Mpr121::Reset()
{
    std::memset(reg_, 0, sizeof(reg_));
    reg_[0x5C] = 0x10;  // CONFIG1 and CONFIG2 power-on values: drivers check
    reg_[0x5D] = 0x24;  // CONFIG2 after a soft reset to find the chip
    ptr_ = 0;
}

void Mpr121::WriteReg(uint8_t r, uint8_t v)
{
    if(r == 0x80)
    {
        if(v == 0x63)
            Reset();
        return;
    }
    if(r < sizeof(reg_))
        reg_[r] = v;
}

void Mpr121::SetPad(int i, bool touched, float force)
{
    if(i < 0 || i >= kElectrodes)
        return;
    const uint16_t m = 1u << i;
    force_[i] = std::clamp(force, 0.f, 1.f);
    if(touched)
    {
        touch_ |= m;
        latched_ |= m;
    }
    else
    {
        touch_ &= ~m;
    }
}

int Mpr121::Delta(int i, uint16_t touched) const
{
    if(!(touched & (1u << i)))
        return 0;
    // Always past the touch threshold the firmware set, then up with force.
    const int lo = std::max(2 * int(reg_[0x41 + 2 * i]), 16);
    return lo + int(force_[i] * float(kMaxDelta - lo) + 0.5f);
}

uint8_t Mpr121::ReadReg(uint8_t r, uint16_t touched) const
{
    const int enabled = reg_[0x5E] & 0x0F;  // ECR: electrodes 0..n-1 run
    if(r <= 0x01)
    {
        uint16_t status = 0;
        for(int i = 0; i < kElectrodes && i < enabled; i++)
            if(Delta(i, touched) > reg_[0x41 + 2 * i])
                status |= 1u << i;
        return r == 0 ? status & 0xFF : status >> 8;
    }
    if(r >= 0x04 && r <= 0x1D)
    {
        const int i    = (r - 0x04) / 2;
        const int filt = i < kElectrodes ? kBaseline - Delta(i, touched) : kBaseline;
        return (r - 0x04) % 2 == 0 ? filt & 0xFF : (filt >> 8) & 0x03;
    }
    if(r >= 0x1E && r <= 0x2A)
        return kBaseline >> 2;
    return r < sizeof(reg_) ? reg_[r] : 0;
}

bool Mpr121::Write(const uint8_t* data, size_t size)
{
    if(size == 0)
        return true;
    ptr_ = data[0];
    for(size_t i = 1; i < size; i++)
        WriteReg(ptr_++, data[i]);
    return true;
}

bool Mpr121::Read(uint8_t* data, size_t size)
{
    // One snapshot per transaction, as the chip latches a burst read.
    const uint16_t touched = touch_ | latched_;
    bool           status  = false;
    for(size_t i = 0; i < size; i++)
    {
        if(ptr_ <= 0x01)
            status = true;
        data[i] = ReadReg(ptr_++, touched);
    }
    if(status)
        latched_ = 0;
    return true;
}

// ============================================================ SSD1306
// The I2C stream starts with a control byte: 0x00 = commands follow,
// 0x40 = display data follows; with bit 7 set (Co) only the next byte is
// that kind and another control byte comes after it.

namespace
{
int ArgCount(uint8_t c)
{
    switch(c)
    {
        case 0x20:  // memory addressing mode
        case 0x81:  // contrast
        case 0x8D:  // charge pump
        case 0xA8:  // multiplex ratio
        case 0xAD:  // (SH1106) DC-DC
        case 0xD3:  // display offset
        case 0xD5:  // clock divide
        case 0xD6:  // zoom
        case 0xD9:  // pre-charge
        case 0xDA:  // COM pins
        case 0xDB:  // VCOMH
            return 1;
        case 0x21:  // column address range
        case 0x22:  // page address range
        case 0xA3:  // vertical scroll area
            return 2;
        case 0x29:
        case 0x2A: return 5;  // vertical + horizontal scroll
        case 0x26:
        case 0x27: return 6;  // horizontal scroll
        default: return 0;
    }
}
} // namespace

bool Ssd1306::Write(const uint8_t* data, size_t size)
{
    size_t i = 0;
    while(i < size)
    {
        const uint8_t ctrl = data[i++];
        const bool    dc   = ctrl & 0x40;
        if(ctrl & 0x80)
        {
            if(i < size)
                dc ? Data(data[i++]) : Command(data[i++]);
            continue;
        }
        for(; i < size; i++)
            dc ? Data(data[i]) : Command(data[i]);
    }
    return true;
}

bool Ssd1306::Read(uint8_t* data, size_t size)
{
    // Status byte: bit 6 = display off.
    for(size_t i = 0; i < size; i++)
        data[i] = on_ ? 0x00 : 0x40;
    return true;
}

void Ssd1306::Command(uint8_t b)
{
    if(need_ > 0)
    {
        args_[argc_++] = b;
        if(argc_ > need_)
        {
            Execute();
            need_ = argc_ = 0;
        }
        return;
    }
    args_[0] = b;
    argc_    = 1;
    need_    = ArgCount(b);
    if(need_ == 0)
    {
        Execute();
        argc_ = 0;
    }
}

void Ssd1306::Execute()
{
    const uint8_t c = args_[0];
    if(c <= 0x0F)
        col_ = (col_ & 0xF0) | c;
    else if(c <= 0x1F)
        col_ = ((c & 0x0F) << 4) | (col_ & 0x0F);
    else if(c >= 0xB0 && c <= 0xB7)
        page_ = c & 0x07;
    else
        switch(c)
        {
            case 0x20: mode_ = args_[1] & 0x03; break;
            case 0x21:
                col_start_ = args_[1] & 0x7F;
                col_end_   = args_[2] & 0x7F;
                col_       = col_start_;
                break;
            case 0x22:
                page_start_ = args_[1] & 0x07;
                page_end_   = args_[2] & 0x07;
                page_       = page_start_;
                break;
            case 0x81: contrast_ = args_[1]; break;
            case 0xA0: seg_remap_ = false; break;
            case 0xA1: seg_remap_ = true; break;
            case 0xA4: all_on_ = false; break;
            case 0xA5: all_on_ = true; break;
            case 0xA6: invert_ = false; break;
            case 0xA7: invert_ = true; break;
            case 0xA8: mux_ = args_[1] & 0x3F; break;
            case 0xAE: on_ = false; break;
            case 0xAF: on_ = true; break;
            case 0xC0: com_reverse_ = false; break;
            case 0xC8: com_reverse_ = true; break;
            default: return;  // timing and analog settings: nothing to show
        }
    seq_++;
}

void Ssd1306::Data(uint8_t b)
{
    ram_[page_ & 7][col_ & 0x7F] = b;
    seq_++;
    switch(mode_)
    {
        case 0:  // horizontal: across the column range, then the next page
            if(++col_ > col_end_)
            {
                col_ = col_start_;
                if(++page_ > page_end_)
                    page_ = page_start_;
            }
            break;
        case 1:  // vertical: down the page range, then the next column
            if(++page_ > page_end_)
            {
                page_ = page_start_;
                if(++col_ > col_end_)
                    col_ = col_start_;
            }
            break;
        default:  // page: along the page, wrapping within it
            col_ = (col_ + 1) & 0x7F;
            break;
    }
}

uint32_t Ssd1306::Info() const
{
    // libDaisy's init sends 0xA1 and 0xC8 for a panel mounted the right way
    // up, so mirroring is reported relative to that.
    return (on_ ? 1u : 0u) | (invert_ ? 2u : 0u) | (seg_remap_ ? 0u : 4u)
           | (com_reverse_ ? 0u : 8u) | (all_on_ ? 16u : 0u)
           | (uint32_t(mux_ + 1) << 8) | (uint32_t(contrast_) << 16);
}

} // namespace stweb
