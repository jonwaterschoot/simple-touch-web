#pragma once
// simple-touch-web: libDaisy's dev/sdram.h. The Seed's 64 MB SDRAM is plain
// memory here, so DSY_SDRAM_BSS / DSY_SDRAM_DATA place nothing anywhere: the
// buffers land in linear memory with everything else.
#ifndef RAM_AS4C16M16SA_H
#define RAM_AS4C16M16SA_H
#include <stdint.h>
#include "daisy_core.h"

#define DSY_SDRAM_DATA
#define DSY_SDRAM_BSS

class SdramHandle
{
  public:
    enum class Result
    {
        OK,
        ERR,
    };
    Result Init() { return Result::OK; }
    Result DeInit() { return Result::OK; }
};

#endif
