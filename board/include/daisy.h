#pragma once
// simple-touch-web: libDaisy's daisy.h, cut down to what the virtual board
// supports. Everything here is the real libDaisy header; the hardware behind
// it (GPIO, ADC, I2C, audio, USB MIDI, the clock) is board/src.
//
// A firmware that includes a libDaisy header not listed here still finds it
// on the include path; if it needs hardware the board doesn't have, the
// build stops there (missing HAL header) or at link time (missing method).
#ifndef DSY_LIBDAISY_H
#define DSY_LIBDAISY_H

#include <stdint.h>
#include "daisy_core.h"

#include "sys/system.h"
#include "sys/dma.h"
#include "per/gpio.h"
#include "per/tim.h"
#include "per/adc.h"
#include "per/i2c.h"
#include "per/spi.h"
#include "per/uart.h"
#include "per/sai.h"
#include "dev/sdram.h"
#include "dev/mpr121.h"
#include "hid/audio.h"
#include "hid/midi.h"
#include "hid/usb.h"
#include "hid/logger.h"
#include "hid/switch.h"
#include "hid/switch3.h"
#include "hid/encoder.h"
#include "hid/ctrl.h"
#include "hid/gatein.h"
#include "hid/parameter.h"
#include "hid/led.h"
#include "hid/disp/graphics_common.h"
#include "hid/disp/display.h"
#include "hid/disp/oled_display.h"
#include "util/scopedirqblocker.h"
#include "util/CpuLoadMeter.h"
#include "util/FIFO.h"
#include "util/FixedCapStr.h"
#include "util/MappedValue.h"
#include "util/ringbuffer.h"
#include "util/Stack.h"

#endif
