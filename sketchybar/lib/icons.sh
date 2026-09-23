#!/usr/bin/env bash
# The glyphs, the font they come from, and the size each one is drawn at.
#
# All three live here together because they are one decision. An icon is not a
# character, it is a character *at a size*, and three items on this bar change
# their glyph while it runs -- so a font size stored anywhere but next to the
# glyph is a size that is right for one state and wrong for the others.
#
# Every codepoint here was read out of the font's own cmap table rather than
# copied from the Nerd Fonts cheat sheet, because the cheat sheet is versioned
# and the font on this machine is whatever was installed the day it was
# installed. A glyph that is not in the file renders as a blank box, and a
# blank box in a status bar looks like a bug in your config rather than a
# missing character.
#
# To re-verify after a font update:
#   python3 -c "from fontTools.ttLib import TTFont; \
#     print({n for n in TTFont('~/Library/Fonts/HackNerdFontMono-Bold.ttf').getGlyphOrder()})"
#
# Literal characters rather than printf escapes: macOS ships bash 3.2, whose
# printf has no \u, so an escape here would silently emit the text "\uf02a0".

# Hack Nerd Font Mono, because Comic Code has no icons. Keeping the two jobs in
# two fonts means an icon can never be silently substituted by a fallback with
# the wrong metrics.
#
# GLYPH_FONT is the prefix a size is appended to. It exists so the hot loop in
# bin/pump can build `icon.font` by string concatenation: `$(icon_font "$pt")`
# would be correct too, but command substitution in bash is a fork, and this
# runs on every glyph change.
export FONT_ICON="Hack Nerd Font Mono"
export GLYPH_FONT="$FONT_ICON:Bold:"
icon_font() { printf '%s%s' "$GLYPH_FONT" "$1"; }

export ICON_APPLE="󰀵"   # U+F0035  md-apple
export ICON_WS1="󰊠"   # U+F02A0
export ICON_WS2="󰖟"   # U+F059F
export ICON_WS3="󰌨"   # U+F0328
export ICON_CPU="󰘚"   # U+F061A
export ICON_MEM="󰍛"   # U+F035B
export ICON_SPOTIFY=""   # U+F1BC
export ICON_CHROME="󰊯"   # U+F02AF
export ICON_MUSIC="󰎇"   # U+F0387
export ICON_PLAY="󰐊"   # U+F040A
export ICON_PAUSE="󰏤"   # U+F03E4
export ICON_VOL_HIGH="󰕾"   # U+F057E
export ICON_VOL_MED="󰖀"   # U+F0580
export ICON_VOL_LOW="󰕿"   # U+F057F
export ICON_VOL_ZERO="󰖁"   # U+F0581
export ICON_VOL_MUTE="󰝟"   # U+F075F
export ICON_DEV_BUILTIN="󰓃"   # U+F04C3
export ICON_DEV_BT="󱡏"   # U+F184F
export ICON_DEV_USB="󰕓"   # U+F0553
export ICON_DEV_DISPLAY="󰽟"   # U+F0F5F
export ICON_DEV_AIRPLAY="󰄘"   # U+F0118  md-cast (there is no md-airplay in this font)
export ICON_DEV_WIRED="󰋋"   # U+F02CB  md-headphones — USB-C EarPods or the 3.5mm jack
export ICON_DEV_OTHER=""   # U+F025
export ICON_WIFI="󰖩"   # U+F05A9
export ICON_WIFI_OFF="󰖪"   # U+F05AA
export ICON_ETHERNET="󰈀"   # U+F0200
export ICON_DARK="󰖔"   # U+F0594
export ICON_LIGHT="󰖨"   # U+F05A8
export ICON_KBD="󰌌"   # U+F030C
export ICON_KBD_OFF="󰥻"   # U+F097B
export ICON_BATT_100="󰁹"   # U+F0079
export ICON_BATT_90="󰂂"   # U+F0082
export ICON_BATT_80="󰂁"   # U+F0081
export ICON_BATT_70="󰂀"   # U+F0080
export ICON_BATT_60="󰁿"   # U+F007F
export ICON_BATT_50="󰁾"   # U+F007E
export ICON_BATT_40="󰁽"   # U+F007D
export ICON_BATT_30="󰁼"   # U+F007C
export ICON_BATT_20="󰁻"   # U+F007B
export ICON_BATT_10="󰁺"   # U+F007A
export ICON_BATT_ALERT="󰂃"   # U+F0083
export ICON_BATT_CHARGE="󰂄"   # U+F0084
export ICON_BOOST="󰄿"   # U+F013F  md-chevron_double_up — charge past the 80% limit
export ICON_PLUG="󰚥"   # U+F06A5
export ICON_CLOCK="󰅐"   # U+F0150
export ICON_SHAZAM="󱑽"   # U+F147D  md-waveform — the font has no Shazam glyph
export ICON_SLEEP="󰤄"   # U+F0904  md-power_sleep
export ICON_RESTART="󰜉"   # U+F0709  md-restart
export ICON_SHUTDOWN="󰤆"   # U+F0906  md-power_standby
export ICON_LOGOUT="󰍃"   # U+F0343  md-logout
export ICON_BAR_OFF="󰈉"   # U+F0209  md-eye_off
# ── From ink to point size ──────────────────────────────────────────────────
#
# lib/ink.sh holds the ink in each glyph as a fraction of the em, measured by
# bin/measure-icons. That is a fact about the font. The size to draw a glyph at
# is not: it depends on how tall the chip is, and the chip height is the skin's
# decision. So the arithmetic happens here, at load, from three numbers the
# skin supplies -- ICON_TARGET, ICON_MAX_W, ICON_MAX_H -- and PT_<name> comes
# out the far end for every glyph above.
#
# This used to be a table of point sizes computed against a 29-point chip and
# committed. A skin with a 20-point chip would have inherited those sizes in
# silence, which is a row of glyphs hanging out of their own boxes. A point
# size that is not derived from the chip it sits in is a bug waiting for a
# second skin.
#
# WHY sqrt(w*h). Two glyphs look equally big when their optical size matches,
# and optical size is the geometric mean of the ink's width and height. Height
# alone leaves the flat wide keyboard half again as wide as everything beside
# it; width alone barely varies in a monospaced font.
#
# THE CAPS bind on about four glyphs and are invisible on the rest: the optical
# mean alone is happy to make a very flat glyph enormously wide, or a very tall
# one taller than the chip it lives in.
#
# One awk, not one per glyph. macOS bash is 3.2 and has no floating point at
# all, so each size would otherwise be a fork -- fifty of them every time a
# plugin runs. This is one fork at load, and bin/pump then builds icon.font by
# string concatenation in its hot loop exactly as before.
# ── From ink to a place in the cell ─────────────────────────────────────────
#
# PAD_<name> comes out beside PT_<name>, and it is the left padding that puts
# that glyph's ink in the middle of a square cell BOX_HEIGHT points wide. Every
# icon-only item on the bar is that square, and the glyph is in the centre of
# it.
#
# IT HAS TO BE COMPUTED, because sketchybar will not do it. An item's width is
# its text's width plus its padding, and the width sketchybar measures for a
# glyph is not the glyph's advance -- it is the ink's right edge, rounded up,
# with the left side bearing thrown away. So the box is about a point and a
# half wider than the glyph on the right side only, and the glyph sits left of
# centre by half of that. Measured at 0.75pt on this machine's 20-point chips,
# which is three device pixels of daylight on one side and none on the other:
# small, and the first thing you see.
#
# So the width is stated rather than measured -- items/*.sh forces `width` to
# BOX_HEIGHT -- and the pen is placed by hand from the ink's own centre. The
# ink's centre is the third number in lib/ink.sh, measured from the pen, so:
#
#   pad = BOX_HEIGHT/2 - cx * pt
#
# and nothing sketchybar computes is in the answer.
#
# THE LIMIT: sketchybar parses padding as a whole number of points and throws
# away the fraction. So this rounds, and the residual error is at most half a
# point -- one device pixel on a 2x display, which is the finest a glyph can be
# placed here at all. Below that is not a number the API can carry.
#
# ── A glyph alone in a lit cell ─────────────────────────────────────────────
#
# CELL_PT_<name> and CELL_PAD_<name> are the same two numbers for a glyph that
# lives by itself in a lit cell -- the boost chevrons -- rather than in a chip.
# The cell is CELL_HEIGHT, smaller than the chip, and the item is made that
# wide so the cell is a square. Sized for the chip, the
# chevrons filled their disc nearly edge to edge; scaled by CELL_HEIGHT over
# BOX_HEIGHT they keep the same proportion to their cell that every other
# glyph keeps to its chip.
source "$(dirname "${BASH_SOURCE[0]}")/ink.sh"
eval "$(printf '%s\n' "$ICON_INK" | /usr/bin/awk \
  -v target="${ICON_TARGET:-17.5}" \
  -v maxw="${ICON_MAX_W:-20.0}" \
  -v maxh="${ICON_MAX_H:-23.0}" \
  -v cell="${BOX_HEIGHT:-29}" \
  -v lit="${CELL_HEIGHT:-21}" '
  NF == 4 {
    pt = target / sqrt($2 * $3)
    if (maxw / $2 < pt) pt = maxw / $2
    if (maxh / $3 < pt) pt = maxh / $3
    pad = cell / 2 - $4 * pt
    if (pad < 0) pad = 0
    printf "export PT_%s=%.1f\n", $1, pt
    printf "export PAD_%s=%d\n", $1, int(pad + 0.5)
    cpt = pt * lit / cell
    cpad = lit / 2 - $4 * cpt
    if (cpad < 0) cpad = 0
    printf "export CELL_PT_%s=%.1f\n", $1, cpt
    printf "export CELL_PAD_%s=%d\n", $1, int(cpad + 0.5)
  }')"
unset ICON_INK
