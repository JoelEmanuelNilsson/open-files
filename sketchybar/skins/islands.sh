#!/usr/bin/env bash
# islands -- one rounded chip of the terminal's glass per group, floating on
# nothing.
#
# The bar itself draws nothing: no colour, no blur. Each group -- the rooms,
# what is playing, each meter, the state items, the battery, the clock --
# is its own chip, and the gaps between them are the desktop.
#
# THE CHIPS ARE THE GLASS. Fill is the theme's background at the mode's glass
# opacity, the number bin/theme also writes to Ghostty, so a chip and the
# terminal are the same colour at the same opacity and change together per
# mode. Text is the terminal's foreground.
#
# The one thing the glass skin has that this cannot: blur. sketchybar blurs
# per window -- the bar, a popup -- and an item's background has no blur
# property. Blurring the bar would frost the gaps too and the chips would stop
# floating, so the chips are translucent over an unblurred desktop. At 0.85
# opacity the difference is small. The power popup is its own window and does
# get the blur.
#
# Chosen against a 32-point bar (lib/geometry.sh measures the real one).

# ── Colour roles ────────────────────────────────────────────────────────────
export CHROME_BAR="$CHROME_NONE"
export BAR_BLUR=0

export CHROME_CHIP="$(alpha "$THEME_GLASS_ALPHA" "$THEME_BG")"
export CHROME_TEXT="$THEME_FG"
export CHIP_BLUR="$THEME_GLASS_BLUR"

# A hairline of the foreground at a fifth of its strength. Without it a
# near-black chip over a dark part of the wallpaper has no edge at all; at
# full strength it is a box drawn round a box.
export CHROME_BORDER="$(alpha 33 "$THEME_FG")"

# A lit cell inverts, as in glass: a solid foreground cell with the
# background's colour for its glyph.
export CHROME_CELL="$THEME_FG"
export CHROME_ON_CELL="$THEME_BG"

# Ink on the chip, and the same ink at 45% under the trace. See glass.sh.
export CHROME_GRAPH="$THEME_FG"
export CHROME_GRAPH_FILL="$(alpha 73 "$THEME_FG")"

# The power menu is the same glass with the same hairline.
export CHROME_POPUP="$CHROME_CHIP"
export CHROME_POPUP_BORDER="$CHROME_BORDER"

# ── The bar ─────────────────────────────────────────────────────────────────
# The outermost chips sit one gap in from each edge, so the desktop shows the
# same width at the ends of the row as between its chips.
export GAP_CHIP=10
export BAR_PAD_LEFT="$GAP_CHIP"
export BAR_PAD_RIGHT="$GAP_CHIP"

# ── Inside a chip ───────────────────────────────────────────────────────────
# Glass's numbers: the inset from a chip's edge to a label, and the type.
export PAD_IN=7

# 28 points inside a 32-point bar: 2 points of desktop above and below, which
# is what lets a chip read as floating rather than as a slab of bar.
export BOX_HEIGHT=28
export BOX_LIFT=0
export CHIP_BORDER=1

# A third of the height. Square enough that a chip is a box, round enough that
# a row of them reads as separate objects. The lit cell's radius is derived
# from this (lib/skin.sh) so its corners stay concentric.
export CHIP_RADIUS=9

# The lit room cell and the boost cell, 3 points clear of the chip on every
# side. Vertical by height; horizontal by the spacers in items/.
export CELL_INSET=3
export CELL_HEIGHT=$((BOX_HEIGHT - 2 * CELL_INSET))

export GRAPH_WIDTH=56
export GRAPH_HEIGHT="$CELL_HEIGHT"

# ── Type ────────────────────────────────────────────────────────────────────
# Same face and sizes as glass: the chip is the same height, so the glyphs and
# their caps are too.
export FONT_LABEL="Comic Code Ligatures"
export SIZE_LABEL=15
export ICON_TARGET=15.6
export ICON_MAX_W=18.2
export ICON_MAX_H=18.0
