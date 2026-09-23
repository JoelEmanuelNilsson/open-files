#!/usr/bin/env bash
# Animated preview of the chrome's light: ./test.sh (Ctrl+C stops it)
#
# chrome.ts imports @earendil-works/pi-tui, which only resolves inside pi's own
# install, so stage the sources next to a symlink to it and run there.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
pi_root="$(npm root -g)/@earendil-works/pi-coding-agent"
[ -d "$pi_root/node_modules" ] || { echo "no pi install at $pi_root" >&2; exit 1; }

# Only one preview may run at a time. Two of them painting the same pane looks
# exactly like a preview that will not pick up your edits: both home the cursor
# and write a full frame, so the older process keeps overwriting the newer one's
# colours with the code it was started from, and every restart adds another
# painter instead of replacing one. Take over from any predecessor.
#
# The predecessor is found by a marker in its argv, not by a pidfile: a pid
# outlives the process it named, so a stale pidfile aims a signal at whatever
# unrelated process the number was recycled to. An argv match cannot.
marker="zen-chrome-preview"
pattern="zen-chrome/test.ts $marker"
if pgrep -f "$pattern" >/dev/null 2>&1; then
	# SIGINT rather than SIGTERM: the preview traps it and restores the cursor.
	pkill -INT -f "$pattern" 2>/dev/null || true
	for _ in $(seq 40); do
		pgrep -f "$pattern" >/dev/null 2>&1 || break
		sleep 0.05
	done
	pkill -KILL -f "$pattern" 2>/dev/null || true
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT INT TERM
ln -s "$pi_root/node_modules" "$stage/node_modules"
# chrome.ts reaches up into lib/, so the stage keeps the kit's own layout.
mkdir -p "$stage/extensions/zen-chrome" "$stage/lib"
# Both directories whole, rather than the files the preview happens to import:
# an enumerated list is a second copy of the import graph, and it goes stale the
# first time a preview reaches for a module nobody remembered to add — which it
# did (2026-09-12). Copying everything cannot go stale, and the unused files
# cost a copy of some text. prism.ts asks the terminal what colour it is, so
# lib/ brings slot-colors and its process cache; PI_ZEN_SURFACE overrides it.
cp "$here"/*.ts "$stage/extensions/zen-chrome/"
cp "$here/../../lib"/*.ts "$stage/lib/"

# The prism picks its surface from the terminal's OSC 11 reply, which only a TUI
# can collect. The preview is not one, so left unset the prism silently falls
# back to dark — on a light terminal that shows the dark tuning on paper and
# looks exactly like light-mode edits that never land. Decide it here instead:
# follow macOS appearance, the same thing Ghostty follows for its theme.
if [ -z "${PI_ZEN_SURFACE:-}" ]; then
	if [ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" = "Dark" ]; then
		PI_ZEN_SURFACE=dark
	else
		PI_ZEN_SURFACE=light
	fi
fi
echo "surface: $PI_ZEN_SURFACE" >&2

cd "$stage" && PI_ROOT="$pi_root" PI_ZEN_SURFACE="$PI_ZEN_SURFACE" node extensions/zen-chrome/test.ts "$marker"
