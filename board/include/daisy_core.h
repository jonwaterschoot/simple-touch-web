#pragma once
// simple-touch-web: libDaisy's daisy_core.h, with its memory sections taken
// out. On the Seed they place buffers in particular RAM banks; a WebAssembly
// module has one linear memory, and a named data section there would be
// written into the binary instead of zero-filled.
#include_next "daisy_core.h"

#undef DMA_BUFFER_MEM_SECTION
#define DMA_BUFFER_MEM_SECTION
#undef DTCM_MEM_SECTION
#define DTCM_MEM_SECTION
