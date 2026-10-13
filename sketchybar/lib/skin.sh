#!/usr/bin/env bash
# What the bar looks like: the loader for skins/<name>.sh.
#
# Two things decide the bar's appearance and they change on different clocks.
# The palette changes whenever a theme is applied or macOS flips between light
# and dark -- often, and cheaply, by recolouring items in place. The shape
# changes when you pick a different skin -- rarely, and only by rebuilding the
# bar, because a chip's height and corner radius are set when the item is
# created.
#
# So this file resolves both and hands them to one skin file, which is the only
# place that says what the bar looks like:
#
#   the palette   theme/gen/sketchybar/<mode>.sh, written by bin/theme.
#                 Six colours, named by what they are: THEME_BG, THEME_FG,
#                 THEME_SURFACE, THEME_DIM, THEME_MUTED, THEME_ACCENT.
#                 Plus the mode's glass, the same numbers Ghostty's window
#                 gets: THEME_GLASS_ALPHA (opacity as an alpha byte, for
#                 alpha()) and THEME_GLASS_BLUR.
#   the skin      theme/gen/sketchybar/skin, also written by bin/theme, from
#                 the `skin` key of the theme's TOML. A name, defaulting to
#                 flat.
#
# A skin maps those six colours onto the bar's ROLES -- the bar, a chip's fill,
# a chip's outline, a lit cell, what a lit glyph inverts to -- and sets every
# number that was chosen rather than measured. Roles rather than hex is the
# whole point: a chip is "surface", never #14192f, so a new theme gets a bar
# without anyone writing one.
#
# WHY THE ROLES EXIST AT ALL. They did not, between 0172392 and d24f076, and
# the bar drew no chips for it -- border_width was 1 and border_color was 0x0,
# which is a transparent border, and nothing warns you. Four of the six
# generated colours were read by nobody.
#
# sketchybar's format is 0xAARRGGBB. Alpha first, and it is not optional: a
# six-digit value parses as a colour with alpha 0x00, which is invisible.
#
# Sourced by sketchybarrc (the first paint), by items/*.sh, and by
# plugins/appearance, bin/pump and bin/bridge-aerospace. It must come BEFORE
# lib/icons.sh, which needs the skin's chip height to size a glyph. Sourcing it
# twice costs nothing.
#
# Absolute paths: plugins/appearance runs from launchd at login, whose PATH has
# no Homebrew and no /usr/bin guarantee worth relying on.

_skin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if /usr/bin/defaults read -g AppleInterfaceStyle 2>/dev/null | /usr/bin/grep -q Dark; then
  CHROME_MODE=dark
else
  CHROME_MODE=light
fi
export CHROME_MODE

# Absent until the first `bin/theme apply`, so every role below carries a
# fallback and a fresh clone still draws a bar rather than an invisible one.
_palette="$_skin_dir/../theme/gen/sketchybar/$CHROME_MODE.sh"
[ -f "$_palette" ] && source "$_palette"

export THEME_BG="${THEME_BG:-0xff000000}"
export THEME_FG="${THEME_FG:-0xffffffff}"
export THEME_SURFACE="${THEME_SURFACE:-0xff1c1e26}"
export THEME_DIM="${THEME_DIM:-0xff6e6a86}"
export THEME_MUTED="${THEME_MUTED:-0xff9097b2}"
export THEME_ACCENT="${THEME_ACCENT:-0xff9097b2}"
export THEME_GLASS_ALPHA="${THEME_GLASS_ALPHA:-ff}"
export THEME_GLASS_BLUR="${THEME_GLASS_BLUR:-0}"

# For an item whose background exists only to bound something else -- a graph
# is drawn inside its background's rect, so the rect has to be on and has to be
# invisible.
export CHROME_NONE=0x00000000

# Same colour, different opacity. `alpha cc "$THEME_BG"` is the bar colour a
# blurred skin wants: sketchybar only blurs what it can see through, so a bar
# left at the palette's opaque background shows no blur at all and looks like
# the setting did nothing.
alpha() { printf '0x%s%s' "$1" "${2#0x??}"; }

# The name is generated, so it is checked before it becomes a path. `flat` is
# the answer whenever there is no file, the file is empty, or it names a skin
# that does not exist -- a theme naming a skin nobody wrote should leave you
# with a plain bar, not no bar.
SKIN_NAME="$(cat "$_skin_dir/../theme/gen/sketchybar/skin" 2>/dev/null)"
case "$SKIN_NAME" in
  *[!a-z0-9-]* | "") SKIN_NAME=flat ;;
esac
[ -f "$_skin_dir/skins/$SKIN_NAME.sh" ] || SKIN_NAME=flat
export SKIN_NAME
source "$_skin_dir/skins/$SKIN_NAME.sh"

# A skin is a complete answer or it is not a skin. Half of one is a bar with
# invisible chips or zero-height boxes, which reads as a broken bar rather than
# as a missing variable -- so say which variable, once, and carry on with
# whatever the skin did set.
for _role in CHROME_BAR CHROME_TEXT CHROME_CHIP CHROME_BORDER CHROME_CELL \
             CHROME_ON_CELL CHROME_GRAPH CHROME_GRAPH_FILL CHROME_POPUP \
             CHROME_POPUP_BORDER PAD_IN GAP_CHIP BAR_PAD_LEFT BAR_PAD_RIGHT \
             BOX_HEIGHT BOX_LIFT CHIP_RADIUS CHIP_BORDER BAR_BLUR CHIP_BLUR \
             CELL_HEIGHT CELL_INSET GRAPH_WIDTH GRAPH_HEIGHT \
             FONT_LABEL SIZE_LABEL ICON_TARGET ICON_MAX_W ICON_MAX_H; do
  [ -n "${!_role:-}" ] || echo "skin $SKIN_NAME: $_role is unset" >&2
done
unset _role _palette _skin_dir

# A lit cell's corners are concentric with its chip's: the chip's radius less
# the inset between them. Any other radius makes the ring of chip around the
# cell visibly thicker at the corners than along the sides. Derived, not set by
# the skin, because it is geometry, not a choice.
CELL_RADIUS=$(( CHIP_RADIUS > CELL_INSET ? CHIP_RADIUS - CELL_INSET : 0 ))
export CELL_RADIUS
