#!/usr/bin/env bash
#
# Build SpotifyAdSkip.app -- the thing that owns the permission.
#
# ── Why an app exists at all ────────────────────────────────────────────────
#
# The watcher is a shell script, and a shell script cannot hold a macOS
# Automation permission. TCC identifies whoever sends an Apple Event by the
# RESPONSIBLE process, and for a script started by launchd that is /bin/bash --
# shared by every script on the machine, and on this Mac already recorded as
# DENIED for Spotify:
#
#   kTCCServiceAppleEvents | /bin/bash             | 0 | com.spotify.client
#   kTCCServiceAppleEvents | com.mitchellh.ghostty | 2 | com.spotify.client
#
# That is the whole reason the watcher worked when run from the terminal and
# hung for ever under launchd: from Ghostty the responsible process is Ghostty,
# which you have already allowed. Editing the database directly does not work
# either -- tccd rewrote the row back to 0 within seconds. Measured, both.
#
# So the watcher needs an identity of its own. This bundle is that identity,
# and nothing else: it asks Spotify one harmless question, which is what makes
# macOS offer the consent dialog, and then it starts the watcher and quits.
#
# ── Two things here that look like details and are not ──────────────────────
#
# NO LSUIElement. A UI-less app cannot put the consent dialog on screen: with
# LSUIElement set, the request sat at authValue=1 (undecided) for ever and no
# dialog was drawn. Without it, UserNotificationCenter shows the prompt. The
# app quits immediately after starting the watcher, so the Dock icon is there
# for about a second at login and then gone.
#
# THE BUNDLE MUST NOT CHANGE once you have allowed it. Ad-hoc signing pins the
# grant to the bundle's cdhash, so editing anything in here means a new
# identity and a permission you have to grant again. That is why all the actual
# logic lives in bin/spotify-ad-skip, outside the bundle, where it can be
# edited freely for ever.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/SpotifyAdSkip.app"
WATCHER="$HERE/bin/spotify-ad-skip"

rm -rf "$APP"

osacompile -o "$APP" -e "
-- Ask Spotify one harmless question. This is what makes macOS show the
-- Automation consent dialog the first time, and it is the grant the watcher
-- then inherits as our child.
try
	tell application \"Spotify\" to get player state
end try

-- Start the watcher detached and quit, so there is no Dock icon sitting there
-- all day. It keeps this app as its responsible process, which is the point.
do shell script \"nohup '$WATCHER' >/dev/null 2>&1 &\"
"

PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.joel.spotify-ad-skip' "$PL" >/dev/null 2>&1 ||
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.joel.spotify-ad-skip' "$PL"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string SpotifyAdSkip' "$PL" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c 'Set :NSAppleEventsUsageDescription Skip Spotify ads by restarting Spotify.' "$PL" >/dev/null 2>&1 || true

codesign --force --deep -s - "$APP"

echo "built: $APP"
echo "  bundle id: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PL")"
codesign -dv "$APP" 2>&1 | rg 'Identifier|Signature' || true
