#!/usr/bin/env bash
# Left of the notch: which room you are in, whether the keyboard belongs to
# AeroSpace, how hard the machine is working, and what is playing.
#
# The left side used to hold three icons and 700 points of nothing while the
# right side carried ten items. That is not balance, it is a list that happens
# to be right-aligned. The two meters and the now-playing title moved over
# here: they are the widest things on the bar and the left is where the width
# is, and it puts what the machine is doing next to where you are doing it.
#
# Each group is a chip: a bracket named chip.<group>, painted by the skin's
# CHROME_CHIP and CHROME_BORDER. Whether a chip is visible is the skin's
# call -- islands fills each one with glass, glass paints them transparent and
# lets the bar be the one surface, flat outlines them. chip() is in
# sketchybarrc, and plugins/appearance repaints every chip.* on a flip.

# ── The agent light ─────────────────────────────────────────────────────────
#
# One item that draws nothing. The light itself is every glyph on the bar --
# plugins/agent-light paints their colours for one three-second burst per
# agent_done -- so what is added here is only the listener. The burst is a
# self-terminating animation chain, so nothing is armed, ticked, or put out.
sketchybar --add item agent.wake left \
           --set agent.wake drawing=off \
                            updates=on \
                            script="$CONFIG_DIR/plugins/agent-light" \
           --subscribe agent.wake agent_done

# ── The three rooms ─────────────────────────────────────────────────────────
#
# Persistent workspaces 1-3, matching aerospace.toml's `persistent-workspaces`,
# so the bar always has exactly three slots rather than a list that changes
# shape as windows come and go.
#
# The active room's cell is filled, so the row reads as one control with one
# member lit rather than three unrelated glyphs.
#
# This was a two-point underline until the glyphs grew to 22 points. At that
# size there is no vertical room left inside a 26-point chip for a rule that is
# neither touching the chip's border nor sitting on the glyph's feet. A fill
# needs no room, and it cannot be inset horizontally either way: an item's
# background is exactly the item's width, and `background.padding_left` moves
# it rather than shrinking it. Where the fill meets the chip's edge it reads as
# a segmented control, which is what this is.
#
# It survives being inside a bracket because a bracket draws behind its members
# -- the chip and the cell are two backgrounds at two depths, not a fight over
# one.
add_workspace() {
  local sid="$1" icon="$2" pt="$3" pad="$4"
  sketchybar --add item "space.$sid" left \
             --set "space.$sid" \
                   icon="$icon" \
                   icon.font="$(icon_font "$pt")" \
                   icon.padding_left="$pad" \
                   label.drawing=off \
                   background.color="$CHROME_NONE" \
                   background.border_width=0 \
                   background.height="$CELL_HEIGHT" \
                   background.corner_radius="$CELL_RADIUS" \
                   background.y_offset="$BOX_LIFT" \
                   background.drawing=on \
                   click_script="/opt/homebrew/bin/aerospace workspace $sid"
}

# ── the apple ───────────────────────────────────────────────────────────────
# The mark at the far left where the Apple menu used to be, in a chip of its
# own: it is not a room, and inside the rooms chip it read as a fourth one.
#
# It is the power menu. The Apple menu is gone (see sketchybarrc), and with it
# Sleep, Restart and Shut Down; click the apple and they open as a popup under
# it, where they used to be. Click an entry to run it, or move the pointer off
# the bar to close it. The popup is the confirmation: nothing on the bar turns
# the machine off in one click.
#
# The last entry turns off the bar itself and brings the macOS menu bar back.
# It cannot have an "on" twin here -- see plugins/bar-power for the way back.
#
# Lifted 2 points. Every other glyph here is drawn centred on the font's line
# and its ink lands within half a point of the chip's middle; this one's ink
# box sits 0.75pt low, and its weight -- a heavy body under a thin leaf -- 2pt
# low, which is what the eye reads. At +2 the weight measured 32.1px against
# the chip's 32. Horizontally PAD_APPLE already puts the weight within 0.4pt
# of the middle, the nearest whole point there is.
sketchybar --add item apple left \
           --set apple icon="$ICON_APPLE" \
                       icon.font="$(icon_font "$PT_APPLE")" \
                       icon.padding_left="$PAD_APPLE" \
                       icon.y_offset="$((BOX_LIFT + 2))" \
                       label.drawing=off \
                       popup.align=left \
                       popup.background.drawing=on \
                       popup.background.color="$CHROME_POPUP" \
                       popup.background.border_color="$CHROME_POPUP_BORDER" \
                       popup.background.border_width="$CHIP_BORDER" \
                       popup.background.corner_radius="$CHIP_RADIUS" \
                       script="$CONFIG_DIR/plugins/power-menu" \
                       click_script="/opt/homebrew/bin/sketchybar --set apple popup.drawing=toggle" \
                       updates=on \
           --subscribe apple mouse.exited.global

power_entry() {  # name, glyph, size, pad, label
  sketchybar --add item "power.$1" popup.apple \
             --set "power.$1" icon="$2" \
                              icon.font="$(icon_font "$3")" \
                              icon.padding_left="$4" \
                              label="$5" \
                              label.padding_right="$PAD_IN" \
                              padding_right="$PAD_IN" \
                              click_script="$CONFIG_DIR/plugins/power-menu $1"
}
power_entry sleep    "$ICON_SLEEP"    "$PT_SLEEP"    "$PAD_SLEEP"    "Sleep"
power_entry restart  "$ICON_RESTART"  "$PT_RESTART"  "$PAD_RESTART"  "Restart"
power_entry shutdown "$ICON_SHUTDOWN" "$PT_SHUTDOWN" "$PAD_SHUTDOWN" "Shut Down"
power_entry logout   "$ICON_LOGOUT"   "$PT_LOGOUT"   "$PAD_LOGOUT"   "Log Out"
power_entry bar      "$ICON_BAR_OFF"  "$PT_BAR_OFF"  "$PAD_BAR_OFF"  "Turn Off Bar"
chip apple apple
spacer sp.apple left

# A narrow spacer at each end of the rooms, inside the chip, so the lit cell
# stands CELL_INSET clear of the chip's edge on the sides as well as top and
# bottom. background.padding_left looks like the answer and is not: it
# translates the background rather than shrinking it, measured.
spacer sp.rooms.a left "$CELL_INSET"
add_workspace 1 "$ICON_WS1" "$PT_WS1" "$PAD_WS1"   # Ghostty. Its own logo.
add_workspace 2 "$ICON_WS2" "$PT_WS2" "$PAD_WS2"   # Chrome.
add_workspace 3 "$ICON_WS3" "$PT_WS3" "$PAD_WS3"   # Finder, TextEdit.
spacer sp.rooms.b left "$CELL_INSET"
chip rooms sp.rooms.a space.1 space.2 space.3 sp.rooms.b

spacer sp.rooms left

# ── now playing ─────────────────────────────────────────────────────────────
# One item, not two, and that is not a shortcut: macOS itself tracks exactly
# one now-playing session, so with Spotify and a YouTube tab both loaded there
# is only ever one answer. The icon says which app is holding it.
#
# Click toggles play/pause, right-click skips.
#
# Truncated at 28 characters rather than scrolled. sketchybar will happily
# marquee a long title, and it looks good for about a day -- after that it is a
# permanently moving object in the corner of your eye, and it redraws the bar
# continuously to do it. A status bar should be still. The icon already tells
# you which app is playing, and the first 28 characters tell you which track.
#
# Its chip is its own background, not a bracket, and that is so the gap after
# it can be its own padding: a standalone item's background stops at its
# content, so padding_right lands outside the chip and disappears with the
# item when nothing is playing. A bracket would swallow it, and a spacer would
# stay behind as a double gap. So media is the one chip plugins/appearance
# paints by item name rather than as chip.*.
sketchybar --add item media left \
           --set media drawing=off \
                       icon="$ICON_MUSIC" \
                       icon.font="$(icon_font "$PT_MUSIC")" \
                       icon.padding_left="$PAD_MUSIC" \
                       label.max_chars=28 \
                       label.padding_right="$PAD_IN" \
                       padding_right="$GAP_CHIP" \
                       background.color="$CHROME_CHIP" \
                       background.border_color="$CHROME_BORDER" \
                       background.drawing=on \
                       click_script="$CONFIG_DIR/plugins/media-click"

# ── cpu and memory ──────────────────────────────────────────────────────────
#
# Sparklines rather than numbers. 44 points of width is 44 samples at one a
# second, so each shows about three quarters of a minute of history -- which is
# the actual question you have when you glance at a cpu meter. A single sampled
# percentage cannot tell you whether it is climbing.
#
# background.drawing=on is not a no-op and is the whole reason these line up. A
# graph is drawn inside its background's bounds, and with drawing off the
# bounds fall back to the height=0 sentinel, which means "the full height of
# the bar" -- so the trace hangs off the bottom edge instead of sitting beside
# its icon.
#
# The label is always on. It used to appear only above 40%/70%, on the theory
# that a quiet machine is not news -- but an idle cpu is a flat line at the
# bottom of a 16-point graph and memory barely moves, so the whole chip read as
# a static decoration. A number that ticks is what live looks like.
#
# The number is held at two digits' width and right-aligned, so 9% -> 10% does
# not widen the chip and shove every chip after it. label.width includes the
# label's padding, hence the 2 * PAD_IN. 100% does not widen it either: the
# third digit eats the padding on the graph's side and runs up against the
# trace, which is the right trade for a reading that rare. See text_width in
# sketchybarrc for why this is not a leading space.
METER_LABEL_WIDTH=$(( $(text_width "00%" "$FONT_LABEL:Bold:$SIZE_LABEL") + 2 * PAD_IN ))

add_graph() {
  local name="$1" icon="$2" pt="$3" pad="$4"
  sketchybar --add graph "$name" left "$GRAPH_WIDTH" \
             --set "$name" icon="$icon" \
                   icon.font="$(icon_font "$pt")" \
                   icon.padding_left="$pad" \
                   label="--" \
                   label.width="$METER_LABEL_WIDTH" \
                   label.align=right \
                   label.padding_left="$PAD_IN" \
                   label.padding_right="$PAD_IN" \
                   graph.color="$CHROME_GRAPH" \
                   graph.fill_color="$CHROME_GRAPH_FILL" \
                   graph.line_width=2.0 \
                   background.color="$CHROME_NONE" \
                   background.border_width=0 \
                   background.height="$GRAPH_HEIGHT" \
                   background.y_offset=0 \
                   background.drawing=on \
                   label.font="$FONT_LABEL:Bold:$SIZE_LABEL"
}

# One chip each: two meters in one box read as one number.
add_graph cpu "$ICON_CPU" "$PT_CPU" "$PAD_CPU"
chip cpu cpu
spacer sp.cpu left
add_graph mem "$ICON_MEM" "$PT_MEM" "$PAD_MEM"
chip mem mem

