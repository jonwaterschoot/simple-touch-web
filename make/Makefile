# simple-touch-web: stands in for libDaisy's core/Makefile, so a firmware's
# own Makefile can tell scripts/build.mjs what it builds.
#
# A libDaisy firmware's Makefile ends with
#   SYSTEM_FILES_DIR = $(LIBDAISY_DIR)/core
#   include $(SYSTEM_FILES_DIR)/Makefile
# A SYSTEM_FILES_DIR on make's command line wins over that assignment, so
#   make -C <firmware> SYSTEM_FILES_DIR=<simple-touch-web>/make stw-vars
# includes this file instead and prints the sources, include paths, defines
# and options as the firmware's Makefile leaves them.

OPT ?= -O2
CPP_STANDARD ?= -std=gnu++14
BUILD_DIR = build-web

.PHONY: stw-vars
stw-vars:
	$(info STW TARGET=$(TARGET))
	$(info STW CPP_SOURCES=$(CPP_SOURCES))
	$(info STW C_SOURCES=$(C_SOURCES))
	$(info STW C_INCLUDES=$(C_INCLUDES))
	$(info STW C_DEFS=$(C_DEFS))
	$(info STW CFLAGS=$(CFLAGS))
	$(info STW CPPFLAGS=$(CPPFLAGS))
	$(info STW OPT=$(OPT))
	$(info STW CPP_STANDARD=$(CPP_STANDARD))
	$(info STW LIBDAISY_DIR=$(LIBDAISY_DIR))
	$(info STW DAISYSP_DIR=$(DAISYSP_DIR))
	$(info STW USE_DAISYSP_LGPL=$(USE_DAISYSP_LGPL))
