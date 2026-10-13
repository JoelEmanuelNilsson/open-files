#!/usr/bin/env bash
# Which room is lit.
#
# Two callers need this and they must not each have their own copy:
# bin/bridge-aerospace, on every workspace change, and plugins/appearance, on
# every appearance flip -- because a flip changes the cell's colour, and the
# cell's colour cannot be set without also saying whether the cell is drawn.
#
# THE RULE THIS FILE EXISTS TO KEEP. In sketchybar, setting any
# `background.<anything>` implicitly turns `background.drawing` **on**, and the
# properties of one --set clause are applied left to right. Both measured:
#
#   --set space.1 background.drawing=off                        -> off
#   --set space.1 background.color=0x0                          -> ON again
#   --set space.1 background.drawing=off background.color=0x0   -> ON
#   --set space.1 background.color=0x0 background.drawing=off   -> off
#
# And `--animate` turns it on regardless of order, which it has to: a colour
# cannot be interpolated on a background that is not being drawn. It never puts
# the flag back.
#
#   --animate tanh 10 --set space.1 background.color=0x0 background.drawing=off
#                                                               -> ON
#
# So a blanket repaint of colours is also a blanket "draw everything". The
# first version of plugins/appearance did exactly that and lit all three rooms
# at once, plus every spacer on the bar, each with a border, which turned nine
# gaps into nine chips. Nothing warns you: the bar simply looks wrong in a way
# that reads as a layout bug.
#
# TWO RULES FALL OUT OF THAT.
#
# 1. Set the colour first and background.drawing last, in the same clause.
#    Anything that only ever wants its background drawn -- every chip, every
#    graph -- is then correct by construction, and a caller never has to
#    remember which properties have a side effect. plugins/appearance and
#    items/left.sh both keep this.
#
# 2. A cell's lit/unlit state is its **colour**, never its drawing flag.
#    Below, all three rooms are drawn all the time and an unlit one is
#    CHROME_NONE. That is not a workaround for rule 1: toggling `drawing`
#    cannot fade, so the animation was always a pop with a fade bolted to the
#    side of it. Fading to transparent is the thing that was wanted.
#
# THE COLOURS ARE RESOLVED ON EVERY CALL, not inherited from the caller.
# bin/bridge-aerospace is resident: it used to paint with whatever lib/skin.sh
# said when it started, so after a `theme apply` or a dark/light flip it went
# on painting the lit room in the old cell colour -- under a glyph that
# plugins/appearance had already recoloured for the new one. When the two
# matched, the focused room vanished. Re-sourcing costs about 13ms, once per
# workspace change, and makes a stale palette impossible rather than
# something each caller has to remember to refresh.
_ROOMS_LIB="${BASH_SOURCE[0]%/*}"
#
# The path to sketchybar is claimed here rather than expected from the caller,
# and that is not tidiness. It was expected, and plugins/appearance spells it
# SB while bin/bridge-aerospace spells it SKETCHYBAR, so every appearance flip
# ran `"" --animate ...` and lost the error down the redirect below. The bar
# looked right anyway: the bridge repaints on every workspace change, so the
# wrong colour survived only until you switched rooms. A shared function that
# reads a variable its callers merely happen to set has this failure in it by
# construction.
: "${SKETCHYBAR:=/opt/homebrew/bin/sketchybar}"

# The active room's cell is filled rather than underlined. There is no room for
# an underline: the glyphs are ~28 points inside a 29-point chip, so a rule
# under one either touches the chip's border or sits on the glyph's feet. A
# fill needs no vertical room, and where it meets the chip's edge it reads as a
# segmented control rather than as a line that escaped its box.
#
# The glyph inverts onto its own cell with icon.highlight rather than
# icon.color, because plugins/appearance repaints every item's icon.color with
# one blanket regex on each flip and would stomp a direct set. It leaves
# highlight alone, which is what highlight is for.
#
# One batched call for all three rooms, with an animation prefix so the row
# changes as a single object instead of three icons changing at slightly
# different times -- and the outgoing cell fades out as the incoming one fades
# in, because both are colour changes on backgrounds that stay drawn.
# `tanh` over 10 frames is about a sixth of a second -- fast
# enough that it never delays the answer to "where am I", slow enough that the
# eye follows the change rather than being startled by it.
paint_workspace() {
  local focused="$1" i sid args=()
  source "$_ROOMS_LIB/skin.sh"
  for i in 0 1 2; do
    sid=$((i + 1))
    if [ "$sid" = "$focused" ]; then
      args+=(--set "space.$sid" background.color="$CHROME_CELL" \
                                background.drawing=on \
                                icon.highlight_color="$CHROME_ON_CELL" \
                                icon.highlight=on)
    else
      args+=(--set "space.$sid" background.color="$CHROME_NONE" \
                                background.drawing=on \
                                icon.highlight=off)
    fi
  done
  # stdout only. sketchybar reports a regex that matched nothing on stdout and
  # still exits 0, so that has to go; anything on stderr is this script being
  # wrong and must be allowed to reach a log.
  "$SKETCHYBAR" --animate tanh 10 "${args[@]}" >/dev/null
}
