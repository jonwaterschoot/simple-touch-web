#pragma once
// simple-touch-web: libDaisy's util/hal_map.h maps Pins to STM32 HAL ports.
// The peripheral headers include it but declare nothing with it, so an empty
// stand-in lets the real headers compile without the HAL.
#ifndef DSY_HAL_MAP_H
#define DSY_HAL_MAP_H
#include "daisy_core.h"
#endif
