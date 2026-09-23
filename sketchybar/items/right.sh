#!/usr/bin/env bash
# Right of the notch: the state of the machine, and the time.
#
# Six items where there were ten. The two meters and the now-playing title
# went to the left side, which had nothing on it -- so this side is now the
# things you check rather than the things you watch.
#
# WHAT SPEAKS. Two numbers are always on: the battery and the volume. Both were
# previously silent until they mattered, on the theory that a bar full of
# digits is a bar you stop reading. That theory is wrong about these two, where
# the number *is* the answer -- "am I about to run out" and "how loud is
# this" are questions you ask before the thing goes wrong, and an icon with
# eleven states can only answer them afterwards. (The meters' numbers are on
# too these days, dim at rest -- see items/left.sh for why.)
#
# Everything else stays icon-only: the audio device, the network and the
# keyboard backlight are all one-of-a-few states, and a glyph holds a state
# better than a word does.
#
# Each group is a chip.<group> bracket, and the spacers between them are the
# gaps; see items/left.sh.
#
# ORDER. sketchybar stacks right-hand items from the screen edge inward, so the
# first one added ends up furthest right. They are added here in reverse of how
# they read, and the comment on each says where it actually lands.

# ── clock ───────────────────────────────────────── furthest right ──────────
# "22 Sep Tue 19:25": the date, the weekday and the time, as text with no
# glyph. No seconds: a minute is the smallest unit anyone has ever needed from
# a status bar, and seconds would mean a redraw every second forever. The
# string is formatted by bin/sysprobe; see bin/pump for why it travels with
# underscores.
sketchybar --add item clock right \
           --set clock icon.drawing=off \
                       icon.width=0 \
                       label.font="$FONT_LABEL:Bold:$SIZE_LABEL" \
                       label="--:--" \
                       label.padding_left="$PAD_IN" \
                       label.padding_right="$PAD_IN" \
                       click_script="open -a Calendar"
chip clock clock
spacer sp.clock right

# ── battery ─────────────────────────────────────────────────────────────────
# The icon is one of eleven levels and the label is the number, because at 18%
# the shape tells you "low" and the number tells you "twenty minutes".
#
# Click toggles Low Power Mode.
#
# macOS calls this `powermode` and it needs root to change but not to read,
# which is why the click goes through a helper with one narrow sudoers rule
# rather than through an admin prompt every time. See plugins/power-toggle.
# The boost chevrons dock onto the battery's right edge when there is
# something to boost.
#
# The chevrons first: right-hand items stack from the screen edge inward, so
# "right of the battery" means added before it. Press to charge past the 80%
# limit to full, this once -- pressable at 2%, not only after the hold kicks
# in at 80. The chevrons vanish on the press and stay gone for the rest of the
# charge; there is no cancel. The limit comes back on its own at 100% or on unplug;
# bin/pump watches for both. On battery power there is nothing to boost and
# the chevrons vanish.
#
# The chevrons get a filled cell of their own, exactly like the active room:
# two click targets in one chip need a visible boundary. The battery's click
# -- Low Power Mode -- stays on the icon and the digits; the cell is the
# boost.
#
# The narrow spacer is the same move as sp.rooms.a and sp.rooms.b: it keeps
# the cell off the chip's right edge. It is hidden and shown with the cell,
# or the chip would keep a dead inset when the battery stands alone. The chip
# is a bracket, so it grows and shrinks around whichever members are drawn.
spacer sp.boost right "$CELL_INSET"
sketchybar --set sp.boost drawing=off
sketchybar --add item boost right \
           --set boost drawing=off \
                       icon="$ICON_BOOST" \
                       icon.width="$CELL_HEIGHT" \
                       icon.font="$(icon_font "$CELL_PT_BOOST")" \
                       icon.padding_left="$CELL_PAD_BOOST" \
                       label.drawing=off \
                       icon.highlight=on \
                       background.drawing=on \
                       background.color="$CHROME_CELL" \
                       background.border_width=0 \
                       background.height="$CELL_HEIGHT" \
                       background.corner_radius="$CELL_RADIUS" \
                       background.y_offset="$BOX_LIFT" \
                       click_script="$CONFIG_DIR/plugins/charge-boost"

sketchybar --add item battery right \
           --set battery icon="$ICON_BATT_100" \
                         icon.font="$(icon_font "$PT_BATT_100")" \
                         icon.padding_left="$PAD_BATT_100" \
                         label="--%" \
                         label.font="$FONT_LABEL:Bold:$SIZE_LABEL" \
                         label.padding_right="$PAD_IN" \
                         click_script="$CONFIG_DIR/plugins/power-toggle"
chip battery sp.boost boost battery

spacer sp.battery right

# ── keyboard backlight ──────────────────────────────────────────────────────
# There is no shell interface to this at all -- ioreg, nvram, defaults and
# every Homebrew brightness tool come back empty. bin/sysprobe reaches it
# through a private CoreBrightness class, which is also why the level arrives
# here by callback rather than by polling.
#
# Scroll to dim and brighten, click to cycle off, low, full.
sketchybar --add item kbd right \
           --set kbd icon="$ICON_KBD" \
                     icon.font="$(icon_font "$PT_KBD")" \
                     icon.padding_left="$PAD_KBD" \
                     label.drawing=off \
                     script="$CONFIG_DIR/plugins/kbd-click" \
                     click_script="$CONFIG_DIR/plugins/kbd-click" \
                     updates=on \
           --subscribe kbd mouse.scrolled

# ── network ─────────────────────────────────────────────────────────────────
# Connected or not, over wifi or over a cable. Not the network's name: on
# macOS 26 the SSID is redacted unless the asking process holds Location
# Services permission, and a status bar that prompts for your location in order
# to draw a glyph is a bad bargain. See the note in bin/sysprobe.m.
sketchybar --add item wifi right \
           --set wifi icon="$ICON_WIFI" \
                      icon.font="$(icon_font "$PT_WIFI")" \
                      icon.padding_left="$PAD_WIFI" \
                      label.drawing=off \
                      click_script="open -b com.apple.systempreferences /System/Library/PreferencePanes/Network.prefPane"

# ── audio output device ─────────────────────────────────────────────────────
# Click cycles: wired, then bluetooth, then USB, then display, then AirPlay,
# then the built-in speakers, and round again. That order is by kind rather
# than by CoreAudio's own device order, which is an enumeration artefact and
# reshuffles whenever something reconnects -- so the naive cycle sends you
# somewhere different every time.
#
# No device is named anywhere. This machine's AirPods report as "Joel's AirPods
# Pro" with a curly U+2019 apostrophe, so a script written with an ASCII quote
# matches nothing and fails silently.
sketchybar --add item audio right \
           --set audio icon="$ICON_DEV_BUILTIN" \
                       icon.font="$(icon_font "$PT_DEV_BUILTIN")" \
                       icon.padding_left="$PAD_DEV_BUILTIN" \
                       label.drawing=off \
                       click_script="$CONFIG_DIR/bin/sysprobe audio cycle"

# ── volume ──────────────────────── nearest the notch ───────────────────────
# Pushed by CoreAudio, not polled, so the number moves as you move the slider.
#
# Volume is per device on macOS, so this legitimately jumps when the audio
# device changes -- the AirPods and the speakers each remember their own level.
sketchybar --add item volume right \
           --set volume icon="$ICON_VOL_HIGH" \
                        icon.font="$(icon_font "$PT_VOL_HIGH")" \
                        icon.padding_left="$PAD_VOL_HIGH" \
                        label="--%" \
                        label.font="$FONT_LABEL:Bold:$SIZE_LABEL" \
                        label.padding_right="$PAD_IN"
chip system volume audio wifi kbd

spacer sp.appearance right

# ── appearance ──────────────────────────────────────────────────────────────
# Click flips the whole machine between light and dark. Ghostty and herdr
# follow the system flag live; this bar and the wallpaper are re-applied by
# plugins/appearance on the appearance_change event.
sketchybar --add item appearance right \
           --set appearance icon="$ICON_DARK" \
                            icon.font="$(icon_font "$PT_DARK")" \
                            icon.padding_left="$PAD_DARK" \
                            label.drawing=off \
                            script="$CONFIG_DIR/plugins/appearance" \
                            click_script="$CONFIG_DIR/plugins/appearance-toggle" \
                            updates=on \
           --subscribe appearance appearance_change

# ── shazam ──────────────────────────────────────────────────────────────────
# Click to identify the song playing nearby. macOS exposes music recognition
# only through Shortcuts, so this runs a shortcut named "Shazam" whose single
# action is Recognize Music. If that shortcut does not exist, the click opens
# Shortcuts so you can create it.
sketchybar --add item shazam right \
           --set shazam icon="$ICON_SHAZAM" \
                        icon.font="$(icon_font "$PT_SHAZAM")" \
                        icon.padding_left="$PAD_SHAZAM" \
                        label.drawing=off \
                        click_script="shortcuts run Shazam || open -a Shortcuts"

# Shazam and the appearance flip share a chip: two one-glyph buttons, each
# alone in a chip, read as two stray squares.
chip tools shazam appearance

"$CONFIG_DIR/plugins/appearance"   # colours, blur, and the mode's glyph

# ── game hide ───────────────────────────────────────────────────────────────
# Invisible item whose only job is to receive front_app_switched and hide the
# bar while a game in games.txt is frontmost. See plugins/game-hide.
sketchybar --add item game_hide right \
           --set game_hide drawing=off \
                           script="$CONFIG_DIR/plugins/game-hide" \
                           updates=on \
           --subscribe game_hide front_app_switched
