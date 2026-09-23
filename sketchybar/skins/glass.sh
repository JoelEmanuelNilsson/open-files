#!/usr/bin/env bash
# glass -- one continuous strip of the terminal's glass, edge to edge.
#
# The bar itself is the background: full width, square corners, no outline,
# behind every item. The group chips items/ declares are painted transparent,
# so the only fills on the bar are the lit room cell and the boost button.
# skins/islands.sh is the same glass cut into one chip per group.
#
# It grew out of `pill` -- rounded chips after PraveenGongada/dotfiles. Chips
# per group read as scattered; one chip per side stopped short of the notch;
# one panel per side, edge to notch, left most of each panel empty. The strip
# is what the bar was before any of those. The sizes below are still pill's,
# scaled up.
#
# THE BAR IS A PIECE OF GHOSTTY. Its fill is the theme's background at the
# mode's glass opacity, blurred by the mode's glass blur -- the numbers
# bin/theme also writes to Ghostty's `glass`, so the bar and the terminal are
# one material and change together, per mode. Text is the terminal's
# foreground.
#
# Chosen against a 32-point bar (lib/geometry.sh measures the real one).

# ── Colour roles ────────────────────────────────────────────────────────────
export CHROME_GLASS="$(alpha "$THEME_GLASS_ALPHA" "$THEME_BG")"
export CHROME_CHIP="$CHROME_NONE"
export CHROME_TEXT="$THEME_FG"
export CHROME_BORDER="$CHROME_NONE"
export CHIP_BLUR="$THEME_GLASS_BLUR"

# A lit cell inverts: a solid foreground-coloured cell with the background's
# colour for its glyph. The room you are in is the one light shape in a row of
# glass.
export CHROME_CELL="$THEME_FG"
export CHROME_ON_CELL="$THEME_BG"

# The trace is ink on the chip, and the area under it is the same ink at 45%
# -- NOT the palette's dim tone, which would blur into the glass. At a fifth
# the area barely separated from the chip, and the level was hard to read.
export CHROME_GRAPH="$THEME_FG"
export CHROME_GRAPH_FILL="$(alpha 73 "$THEME_FG")"

# The power menu is the same glass, and needs no outline because its fill
# already separates it from the desktop.
export CHROME_POPUP="$CHROME_GLASS"
export CHROME_POPUP_BORDER="$CHROME_NONE"

# ── The bar ─────────────────────────────────────────────────────────────────
# The glass, across the whole screen.
export CHROME_BAR="$CHROME_GLASS"
export BAR_BLUR="$THEME_GLASS_BLUR"

# Symmetric, unlike flat. Flat holds the row 58 points off the left edge
# because its 29-point chip reaches within a couple of points of the rounded
# display corner; a 28-point chip inset 2 from the top clears that corner
# entirely, so the number has no reason left and the row can be centred the way
# a row of items should be. Copying flat's 58 was exactly the mistake this
# split exists to prevent: a number chosen for one shape, inherited by another.
#
# 27 points from each edge to the first glyph. The left side gets 3 of those
# from the spacer inside the rooms chip (CELL_INSET), the right side none, so
# the bar's padding differs by exactly that.
export BAR_PAD_LEFT=24
export BAR_PAD_RIGHT=27

# ── Item spacing ────────────────────────────────────────────────────────────
# His 4 points of item padding on each side makes an 8-point gap; the inset
# from a pill's edge to its contents is 6 on the outside and 3+3 between icon
# and label. One symmetric number gets both here, because PAD_IN is applied at
# a chip's edges and once between its members.
#
# Every number in this file from here down is his, scaled by about 1.4: his
# 20-point pill read as too small on this display, and so did 24. Scale them
# together or the chip and its contents stop being in proportion.
export PAD_IN=7
export GAP_CHIP=12

# ── The chips ───────────────────────────────────────────────────────────────
# 28 points inside a 32-point bar, centred, so there are 2 points of bar above
# and below. Flat's 29-point chip had to be lifted a point off the seam where
# the window below starts; with the corners rounded, the panel's ends reach
# full height only between the corners, so 2 points is clear of it. Radius 6,
# not half the height: Joel asked for squared corners, not a pill's ends.
export BOX_HEIGHT=28
export BOX_LIFT=0
export CHIP_RADIUS=6
export CHIP_BORDER=0

# A lit cell sits inside the chip with the same clearance on every side, so a
# ring of chip shows all the way round it. It used to be the full height of
# the chip with no inset: a dark disc flush against the pill's end, which read
# as a bite out of the pill rather than as a selected segment. The inset is
# vertical by height and horizontal by the spacers in items/left.sh, and the
# two must match; lib/skin.sh derives the cell's radius from the same inset.
# 3, not 2: at 2 the ring was a hairline and the cell looked pressed against
# the chip's edge.
export CELL_INSET=3
export CELL_HEIGHT=$((BOX_HEIGHT - 2 * CELL_INSET))

# As tall as a lit cell, so it keeps the same clearance from the chip's edge
# that the cells do; the taller the box, the more points each percent gets.
export GRAPH_WIDTH=56
export GRAPH_HEIGHT="$CELL_HEIGHT"

# ── Type ────────────────────────────────────────────────────────────────────
# Comic Code stays: the reason for it is legibility, which no skin overrules.
# He uses SF Pro Semibold 12; 11.5 is the same optical size in our face, and
# 15 is that scaled with the chip.
export FONT_LABEL="Comic Code Ligatures"
export SIZE_LABEL=15

# Scaled from the 24-point chip's numbers by 13/12, not by the full 28/24: a
# room's glyph has to fit inside its lit cell (CELL_HEIGHT, 22), not just the
# chip. The caps are the statement "ink may not escape that cell", which is
# the only reason they are here and not with the measurement in
# bin/measure-icons.
export ICON_TARGET=15.6
export ICON_MAX_W=18.2
export ICON_MAX_H=18.0
