#pragma once
// The chips on the Simple Touch's I2C1 bus, emulated at register level so
// the firmware's own drivers run unchanged: the MPR121 touch controller
// (0x5A) behind the pads, and the optional SSD1306 OLED (0x3C).

#include "board.h"

namespace stweb
{
class Mpr121 : public I2cDevice
{
  public:
    static constexpr int kElectrodes = 12;

    Mpr121() { Reset(); }

    bool Write(const uint8_t* data, size_t size) override;
    bool Read(uint8_t* data, size_t size) override;

    // From the page: a finger on electrode i, pressing with force 0..1.
    void SetPad(int i, bool touched, float force);

  private:
    void    Reset();
    void    WriteReg(uint8_t r, uint8_t v);
    uint8_t ReadReg(uint8_t r, uint16_t touched) const;
    int     Delta(int i, uint16_t touched) const;

    uint8_t  reg_[0x81];
    uint8_t  ptr_ = 0;
    uint16_t touch_   = 0;
    // A touch stays reported until the firmware has read the status once,
    // so a tap shorter than one main loop pass still reaches it.
    uint16_t latched_ = 0;
    float    force_[kElectrodes] = {};
};

class Ssd1306 : public I2cDevice
{
  public:
    static constexpr int kWidth = 128;
    static constexpr int kPages = 8;

    bool Write(const uint8_t* data, size_t size) override;
    bool Read(uint8_t* data, size_t size) override;

    // Display RAM, page-major: byte [page * 128 + x], bit n = row page * 8 + n.
    const uint8_t* Ram() const { return &ram_[0][0]; }
    // bit 0 on, 1 inverted, 2 mirrored left-right, 3 mirrored top-bottom,
    // 4 all pixels on, 8..15 rows (multiplex ratio + 1), 16..23 contrast.
    uint32_t Info() const;
    // Changes with every write to the RAM or the settings.
    uint32_t Seq() const { return seq_; }

  private:
    void Command(uint8_t b);
    void Execute();
    void Data(uint8_t b);

    uint8_t  ram_[kPages][kWidth] = {};
    uint32_t seq_ = 0;

    uint8_t args_[8] = {};
    int     argc_ = 0, need_ = 0;

    int  mode_ = 2;  // 0 horizontal, 1 vertical, 2 page addressing
    int  col_ = 0, page_ = 0;
    int  col_start_ = 0, col_end_ = kWidth - 1;
    int  page_start_ = 0, page_end_ = kPages - 1;
    bool on_ = false, invert_ = false, all_on_ = false;
    bool seg_remap_ = false, com_reverse_ = false;
    int  mux_ = 63, contrast_ = 0x7F;
};

} // namespace stweb
