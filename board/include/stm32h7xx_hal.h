#pragma once
// simple-touch-web: stands in for the STM32 HAL and CMSIS headers.
//
// The browser build has no MCU. libDaisy headers that include the HAL only
// need it for a few declarations, and firmware code that touches the core
// directly (IRQ-off sections, cache maintenance, barriers) gets no-ops: the
// virtual board runs the audio callback and the main loop on one thread, so
// there is nothing to guard against.

#include <stddef.h>
#include <stdint.h>

#ifndef __IO
#define __IO volatile
#endif
#ifndef __I
#define __I volatile const
#endif
#ifndef __O
#define __O volatile
#endif
#ifndef __STATIC_INLINE
#define __STATIC_INLINE static inline
#endif
#ifndef __STATIC_FORCEINLINE
#define __STATIC_FORCEINLINE static inline
#endif
#ifndef __ALIGNED
#define __ALIGNED(x) __attribute__((aligned(x)))
#endif
#ifndef __RAM_FUNC
#define __RAM_FUNC
#endif

#ifdef __cplusplus
extern "C" {
#endif

static inline void __disable_irq(void) {}
static inline void __enable_irq(void) {}
static inline uint32_t __get_PRIMASK(void) { return 0; }
static inline void __set_PRIMASK(uint32_t primask) { (void)primask; }
static inline void __DSB(void) {}
static inline void __ISB(void) {}
static inline void __DMB(void) {}
static inline void __NOP(void) {}
static inline void __WFI(void) {}
static inline void __WFE(void) {}
static inline void __SEV(void) {}
static inline void __BKPT(int value) { (void)value; }

static inline void SCB_EnableICache(void) {}
static inline void SCB_DisableICache(void) {}
static inline void SCB_InvalidateICache(void) {}
static inline void SCB_EnableDCache(void) {}
static inline void SCB_DisableDCache(void) {}
static inline void SCB_CleanDCache(void) {}
static inline void SCB_InvalidateDCache(void) {}
static inline void SCB_CleanInvalidateDCache(void) {}
static inline void SCB_CleanDCache_by_Addr(void* addr, int32_t size) { (void)addr; (void)size; }
static inline void SCB_InvalidateDCache_by_Addr(void* addr, int32_t size) { (void)addr; (void)size; }
static inline void SCB_CleanInvalidateDCache_by_Addr(void* addr, int32_t size) { (void)addr; (void)size; }

// The virtual clock (board/src/system.cpp).
uint32_t HAL_GetTick(void);
void HAL_Delay(uint32_t ms);

#ifdef __cplusplus
}
#endif
