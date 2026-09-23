#!/usr/bin/env bash
# What this machine is, measured.
#
# Three numbers, none of them chosen. Everything a skin picks -- spacing, chip
# height, type, the colour roles -- lives in skins/<name>.sh instead, and the
# split is the point: a fact you get wrong by guessing, and a choice you get
# wrong by copying someone else's.
#
# `sysprobe screen` asks AppKit and reports:
#
#   width=1728 height=1117 bar=32 notch=185
#
# The bar height is the screen's safe-area top inset, which on a notched
# display is the depth of the notch, exactly. It is also precisely what macOS
# subtracts from `frame` to get `visibleFrame` -- so a bar of this height fills
# the strip the system has already set aside, and no window loses a single
# point to it.
#
# Guessing cost both ways here. The first version of this file said 38,
# reasoned from the menu bar looking about 37 tall, and six points of bar hung
# below the notch with a visible seam running the width of the display. And the
# notch is 185 wide, not the 200 sketchybar reserves by default, which threw
# away 15 points of usable bar for nothing.
_probe="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/sysprobe"
_screen="$("$_probe" screen 2>/dev/null)"

for _kv in $_screen; do
  case "$_kv" in
    width=*) SCREEN_WIDTH="${_kv#*=}" ;;
    bar=*)   BAR_HEIGHT="${_kv#*=}"   ;;
    notch=*) NOTCH_WIDTH="${_kv#*=}"  ;;
  esac
done

# Fallbacks for the case where the probe has not been built yet -- the numbers
# this machine actually reports, so a first run before install.sh still draws
# something sane rather than a zero-height bar.
export SCREEN_WIDTH="${SCREEN_WIDTH:-1728}"
export BAR_HEIGHT="${BAR_HEIGHT:-32}"
export NOTCH_WIDTH="${NOTCH_WIDTH:-185}"
