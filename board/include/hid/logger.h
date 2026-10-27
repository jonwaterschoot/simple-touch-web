#pragma once
// simple-touch-web: libDaisy's hid/logger.h. There is no USB serial port: the
// log goes to stdout, which the page receives (web/simple-touch-processor.js
// posts it as 'log' messages) and prints to the console.
#ifndef __DSY_LOGGER_H__
#define __DSY_LOGGER_H__
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>

#define LOGGER_NEWLINE "\r\n"
#define LOGGER_BUFFER 128

#define PPCAT_NX(A, B) A##B
#define PPCAT(A, B) PPCAT_NX(A, B)
#define STRINGIZE_NX(A) #A
#define STRINGIZE(A) STRINGIZE_NX(A)

// clang-format off
#define FLT_FMT(_n) STRINGIZE(PPCAT(PPCAT(%c%d.%0, _n), d))
// clang-format on
#define FLT_VAR(_n, _x)                   \
    (_x < 0 ? '-' : ' '), (int)(abs(_x)), \
        (int)(((abs(_x)) - (int)(abs(_x))) * pow(10, (_n)))
#define FLT_FMT3 FLT_FMT(3)
#define FLT_VAR3(_x) FLT_VAR(3, _x)

namespace daisy
{
enum LoggerDestination
{
    LOGGER_NONE,
    LOGGER_INTERNAL,
    LOGGER_EXTERNAL,
    LOGGER_SEMIHOST,
};

template <LoggerDestination dest>
class Logger
{
  public:
    static void Print(const char* format, ...)
    {
        va_list va;
        va_start(va, format);
        vprintf(format, va);
        va_end(va);
        fflush(stdout);
    }
    static void PrintLine(const char* format, ...)
    {
        va_list va;
        va_start(va, format);
        vprintf(format, va);
        va_end(va);
        putchar('\n');
        fflush(stdout);
    }
    static void StartLog(bool wait_for_pc = false) { (void)wait_for_pc; }
    static void PrintV(const char* format, va_list va) { vprintf(format, va); }
};

} // namespace daisy
#endif
