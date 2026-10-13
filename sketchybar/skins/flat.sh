#!/usr/bin/env bash
# flat -- bordered boxes, square corners, nothing filled.
#
# The shape follows Ghostty and herdr: sharp corners, no margin, edge to edge.
# Every surface on this machine has already lost its chrome, and a row of
# rounded pills floating on a translucent strip would be the one thing on
# screen pretending to be a different operating system.
#
# A chip is an outline. The only filled thing on the bar is a lit cell -- the
# room you are in, the boost button when it has something to boost -- so fill
# means "this one, now" and nothing else competes with it.
#
# Chosen against a 32-point bar (lib/geometry.sh measures the real one).

# ── Colour roles ────────────────────────────────────────────────────────────
#
#   BAR          the window behind everything
#   CHIP         a chip's fill: surface, one step off the bar
#   BORDER       a chip's outline
#   CELL         a lit member inside a chip
#   ON_CELL      what a lit member's glyph inverts to
#   TEXT         every other glyph and digit
#   GRAPH        a sparkline's trace, with GRAPH_FILL under it
#   POPUP        the power menu's panel, which hangs below the bar and so
#                needs its own outline to separate it from the desktop
export CHROME_BAR="$THEME_BG"
export CHROME_TEXT="$THEME_FG"
export CHROME_CHIP="$THEME_SURFACE"
export CHROME_BORDER="$THEME_DIM"
export CHROME_CELL="$THEME_MUTED"
export CHROME_ON_CELL="$THEME_BG"
export CHROME_GRAPH="$THEME_MUTED"
export CHROME_GRAPH_FILL="$THEME_DIM"
export CHROME_POPUP="$THEME_BG"
export CHROME_POPUP_BORDER="$THEME_DIM"

# ── The bar ─────────────────────────────────────────────────────────────────
# Opaque, so there is nothing to blur. The bar covers the auto-hidden menu bar
# and a translucent one would show the top of whatever window is beneath it,
# which is a moving background behind static text.
export BAR_BLUR=0
export CHIP_BLUR=0

# How far the row is held off each screen edge. Not equal, and not meant to be:
# the left has a rounded display corner beneath it and the right does not.
export BAR_PAD_LEFT=58
export BAR_PAD_RIGHT=29

# ── Item spacing ────────────────────────────────────────────────────────────
# Two numbers, and everything else derives from them. The bar previously had
# four different gaps between its chips -- measured at 0, 6, 6 and 12 points --
# and not one of them had been chosen. They fell out of a rule nobody had
# noticed:
#
#   A bracket's background spans its members *including their padding*. A
#   standalone item's background stops at its own content, so that item's
#   padding lands outside the box.
#
# So two brackets side by side touch: each has already eaten the padding that
# was meant to separate them. A bracket beside a plain item gets that item's
# padding only. Two plain items get both. One setting, three answers, and a row
# that looks arbitrary because it is.
#
# The fix is to stop paying for gaps out of item padding. Every item's own
# padding is zero. Chips are held apart by explicit spacer items, which belong
# to no bracket and so cannot be swallowed by one. The space *inside* a chip
# comes from icon and label padding, which brackets do not touch.
#
# PAD_IN is the inset from a chip's border to its contents, and it is half a
# gap on purpose: two items inside a chip each contribute PAD_IN, so they sit
# 2*PAD_IN apart, and the chip's edge is the half-gap a margin should be.
export PAD_IN=6
export GAP_CHIP=10

# ── The chips ───────────────────────────────────────────────────────────────
#
# BOX_HEIGHT is 29 inside a 32-point bar, leaving half a point of air above and
# below it. That air is the reason the bar no longer collides with the window
# beneath: macOS starts every window at exactly 32, and the old full-width
# background ran to 32 as well, so the bar's last row of pixels and the
# window's border were neighbours with nothing between them.
#
# BOX_LIFT raises the chips one further point off that seam. The bar window
# stays 32 tall regardless -- it has to, because it is what covers the menu
# bar, and a 31-point bar would leave a one-point strip of Apple menu showing.
# The bar did not shrink; the visible part of it moved up.
#
# BOX_LIFT moves the chip. It has to move the contents too, or the icons stay
# centred on the bar while their boxes sit a point higher -- which is exactly
# what happened: every glyph measured 1.25 points below its own chip's centre,
# uniformly, across all thirteen items. sketchybarrc applies this to icon and
# label y_offset so the two can never drift apart again.
export BOX_HEIGHT=29
export BOX_LIFT=1
export CHIP_RADIUS=0
export CHIP_BORDER=1

# The active room's cell, and how far it stays clear of the chip's border. An
# item's background is exactly the item's width and cannot be narrowed, so the
# clearance is bought with spacer items inside the bracket instead.
export CELL_HEIGHT=$((BOX_HEIGHT - 8))
export CELL_INSET=4

# The graphs. 44pt of width buys about 44 samples at one a second, so each
# sparkline shows roughly three quarters of a minute of history.
#
# 16 tall, to stay in proportion with the glyph beside it. A graph box out of
# step with the type next to it reads as misaligned even when it is centred.
export GRAPH_WIDTH=44
export GRAPH_HEIGHT=16

# ── Type ────────────────────────────────────────────────────────────────────
# Comic Code for anything you read, on the same argument the Ghostty config
# makes: distinct letterforms, easier for a dyslexic reader, and a bar is
# glanced at far more often than any single line of terminal output.
export FONT_LABEL="Comic Code Ligatures"
export SIZE_LABEL=17.0

# The icon sizes. lib/icons.sh turns the measured ink of each glyph into a
# point size using these three; see bin/measure-icons for what they mean.
#
# The caps belong here rather than with the measurement because they are
# statements about the chip: ink may not be wider than 20 points, nor taller
# than 23, or it escapes a 29-point box. They bind on about four glyphs.
export ICON_TARGET=17.5
export ICON_MAX_W=20.0
export ICON_MAX_H=23.0
