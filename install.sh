#!/usr/bin/env bash
#
# Link this repo into ~/.pi/agent and check that the result is coherent.
#
#   ./install.sh            link, then check
#   ./install.sh --doctor   check only, change nothing
#
# Everything pi loads lives in pi/kit, which settings.json names as a package,
# so the whole install is four symlinks. Re-running is a no-op.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
KIT="$REPO/pi/kit"
# The installed pi, resolved at run time. The vendor packages under $AGENT/npm
# import pi, pi-ai and pi-tui as peers; pi loads them through its own aliasing
# resolver, but the kit tests load them through plain node resolution, which
# needs the peers findable from that tree. `npm install` there prunes the
# links, which is how two suites went dark on 2026-09-02.
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
PEERS="$AGENT/npm/node_modules/@earendil-works"
peer_target() { case $1 in pi-coding-agent) echo "$PI_ROOT" ;; *) echo "$PI_ROOT/node_modules/@earendil-works/$1" ;; esac; }
HANDLER="$HOME/Applications/Pi Open.app"
HANDLER_SRC="$REPO/macos/pi-open-handler.applescript"
PROBE_SRC="$REPO/sketchybar/bin/sysprobe.m"
PROBE="$REPO/sketchybar/bin/sysprobe"
SUDOERS_POWER=/etc/sudoers.d/dotfiles-powermode
SUDOERS_BOOST=/etc/sudoers.d/dotfiles-chargeboost
MENUBAR_SRC="$REPO/sketchybar/bin/hide-menubar.c"
MENUBAR="$REPO/sketchybar/bin/hide-menubar"
WAKEPUI_SRC="$REPO/sketchybar/bin/wake-powerui.c"
WAKEPUI="$REPO/sketchybar/bin/wake-powerui"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

doctor_only=false
[[ "${1:-}" == "--doctor" ]] && doctor_only=true

problems=0
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; problems=$((problems + 1)); }

# --- link -------------------------------------------------------------------

# ln -sfn on a symlink-to-a-directory replaces the link instead of writing
# inside it, which is the difference between relinking and nesting.
link() {
	local target=$1 path=$2
	if [[ -L "$path" && "$(readlink "$path")" == "$target" ]]; then return; fi
	mkdir -p "$(dirname "$path")"
	ln -sfn "$target" "$path"
	say "linked $path -> $target"
}

# The status bar's one compiled part. It reads cpu, memory, battery, the audio
# device and the keyboard backlight from inside a single resident process, and
# two of those have no shell interface at all: cpu load is a delta between two
# samples, which a one-shot command cannot compute, and the keyboard backlight
# lives behind a private CoreBrightness class that ioreg and defaults cannot
# see. Generated, not tracked, for the same reason the .app below is.
build_probe() {
	clang -fobjc-arc -O2 \
		-framework Foundation -framework AppKit -framework IOKit \
		-framework CoreAudio -framework CoreFoundation \
		-framework SystemConfiguration \
		"$PROBE_SRC" -o "$PROBE"
	say "built sketchybar/bin/sysprobe"
}

# The thing that actually hides the menu bar. Auto-hide only reclaims the
# layout space -- the bar still slides back down on a pointer at the top edge,
# and our own bar is transparent now, so it shows through. This holds SkyLight's
# menu bar override alpha at zero, which it will only do for as long as it is
# running: the WindowServer keys that override to the sending connection.
# Linking -framework SkyLight is not optional; without it the connection call
# trips an assertion inside CoreGraphics rather than failing.
build_menubar() {
	clang -O2 -o "$MENUBAR" "$MENUBAR_SRC" \
		-framework ApplicationServices -framework CoreGraphics \
		-F /System/Library/PrivateFrameworks -framework SkyLight
	say "built sketchybar/bin/hide-menubar"
}

# Clicking the battery flips Low Power Mode, and `pmset` will not change it for
# a normal user. There is no public API either -- IOPMSetPMPreferences is
# root-only for the same reason -- so the alternatives were an admin prompt on
# every click, or a signed privileged helper and a launchd job for one boolean.
#
# This is the third option: a rule that names the four exact command lines the
# bar can run and nothing else. No wildcard on the flag, no wildcard on the
# value, so it cannot be widened into a general `pmset` grant. -b and -c rather
# than -a because macOS keeps a separate mode for battery and mains and ships
# them different on purpose.
#
# visudo -cf before installing: a syntax error anywhere under /etc/sudoers.d
# breaks sudo for everything, and "I cannot sudo any more" is a bad way to find
# out that a status bar was edited.
# Whether sudo would run every one of these exact command lines without a
# password, asked of sudo itself. The rule files cannot answer: they are 0440
# root:wheel, unreadable to you, so `[[ -r ]]` on one is false whether it is
# there or not -- which is how --doctor came to report a working rule as
# missing, and how a changed rule would never have been reinstalled.
#
# Nor can `sudo -l CMD`: it says whether CMD is permitted by *any* rule, and
# an admin is permitted everything with a password, so it answers yes for
# /bin/rm. `sudo -n -l` with no command lists the grants themselves, NOPASSWD
# tags included, without prompting; each command line must appear there
# exactly.
sudo_nopasswd() {
	sudo -n -l 2>/dev/null | awk -F', ' '/NOPASSWD: / { sub(/^.*NOPASSWD: /, ""); for (i = 1; i <= NF; i++) print $i }'
}
sudo_allows() {
	local granted cmd
	granted=$(sudo_nopasswd)
	for cmd in "$@"; do
		printf '%s\n' "$granted" | grep -Fxq -- "$cmd" || return 1
	done
}

POWERMODE_CMDS=(
	"/usr/bin/pmset -b powermode 1" "/usr/bin/pmset -b powermode 2"
	"/usr/bin/pmset -c powermode 1" "/usr/bin/pmset -c powermode 2"
)

install_powermode_rule() {
	sudo_allows "${POWERMODE_CMDS[@]}" && return
	local tmp
	tmp=$(mktemp)
	{
		echo "# Written by dotfiles/install.sh. Lets the sketchybar battery item"
		echo "# toggle Low Power Mode without an admin prompt on every click."
		echo "$USER ALL=(root) NOPASSWD: $(IFS=,; echo "${POWERMODE_CMDS[*]}" | sed 's/,/, /g')"
	} >"$tmp"
	if ! visudo -cf "$tmp" >/dev/null 2>&1; then
		say "refusing to install a sudoers rule that does not parse"
		rm -f "$tmp"
		return
	 fi
	say "the battery item needs one sudoers rule to flip Low Power Mode"
	if sudo install -m 0440 -o root -g wheel "$tmp" "$SUDOERS_POWER"; then
		say "installed $SUDOERS_POWER"
	fi
	rm -f "$tmp"
}

# The knock that makes launchd respawn PowerUIAgent on demand, so a charge
# limit change takes effect in seconds rather than whenever the agent next
# happens to be needed. See the comment block in wake-powerui.c.
build_wakepui() {
	clang -O2 -o "$WAKEPUI" "$WAKEPUI_SRC"
	say "built sketchybar/bin/wake-powerui"
}

# The bar sets the native Charge Limit: held at or above the charge while the
# cable is in, so macOS never drains the battery on the cable, and raised to
# 100 by the boost button. Apple ships no command for this: PowerUIAgent
# (root) owns the limit, caches its settings for life, ignores SIGTERM, and
# SIP blocks `launchctl kickstart`. What works -- measured, see
# plugins/charge-boost -- is rewriting one integer in its plist and
# SIGKILLing it, so launchd respawns it onto the new value. Six exact command
# lines: one write per step the Settings slider offers, and the kill. No
# wildcards anywhere, so the grant cannot be widened into general `defaults`
# or `killall` as root.
#
# Checked by asking sudo rather than by the file existing, so a rule from
# before the steps were added (80 and 100 only) is replaced, not kept.
CHARGELIMIT_CMDS=()
for _l in 80 85 90 95 100; do
	CHARGELIMIT_CMDS+=("/usr/bin/defaults write com.apple.smartcharging.topoffprotection mclLimitValue -int $_l")
done
CHARGELIMIT_CMDS+=("/usr/bin/killall -9 PowerUIAgent")
unset _l

install_chargeboost_rule() {
	sudo_allows "${CHARGELIMIT_CMDS[@]}" && return
	local tmp
	tmp=$(mktemp)
	{
		echo "# Written by dotfiles/install.sh. Lets sketchybar set the native charge"
		echo "# limit to one of the Settings slider's five steps without a prompt."
		echo "$USER ALL=(root) NOPASSWD: $(IFS=,; echo "${CHARGELIMIT_CMDS[*]}" | sed 's/,/, /g')"
	} >"$tmp"
	if ! visudo -cf "$tmp" >/dev/null 2>&1; then
		say "refusing to install a sudoers rule that does not parse"
		rm -f "$tmp"
		return
	fi
	say "the bar needs one sudoers rule to set the charge limit"
	if sudo install -m 0440 -o root -g wheel "$tmp" "$SUDOERS_BOOST"; then
		say "installed $SUDOERS_BOOST"
	fi
	rm -f "$tmp"
}

# The app that owns `pi-open:` links, which is how a cmd-click on a path in the
# transcript reaches nvim instead of whatever LaunchServices thinks owns `.ts`
# (QuickTime Player, as it turns out). A URL scheme needs a bundle to deliver
# the Apple Event to, so the doorbell is compiled here and the work stays in
# bin/pi-open. Generated, not tracked: an .app is a directory of build output.
build_handler() {
	local plist="$HANDLER/Contents/Info.plist"
	rm -rf "$HANDLER"
	mkdir -p "$HOME/Applications"
	osacompile -o "$HANDLER" "$HANDLER_SRC"
	/usr/libexec/PlistBuddy \
		-c "Set :CFBundleIdentifier com.joelnilsson.pi-open" \
		-c "Add :LSBackgroundOnly bool true" \
		-c "Add :CFBundleURLTypes array" \
		-c "Add :CFBundleURLTypes:0 dict" \
		-c "Add :CFBundleURLTypes:0:CFBundleURLName string 'pi transcript link'" \
		-c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
		-c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string pi-open" \
		"$plist" >/dev/null
	# LaunchServices only learns about a bundle it has seen. Without this the
	# first click is answered by "there is no application set to open the URL".
	"$LSREGISTER" -f "$HANDLER"
	say "built $HANDLER"
}

if ! $doctor_only; then
	link "$REPO/pi/AGENTS.md"          "$AGENT/AGENTS.md"
	link "$REPO/pi/settings.json"      "$AGENT/settings.json"
	link "$REPO/pi/keybindings.json"   "$AGENT/keybindings.json"
	# Owned always-on prose (the <COMMUNICATION> block). pi appends it to its
	# generated prompt natively, so it survives even with the kit's system-payload
	# extension off. The prompt itself is rebuilt per request by that extension;
	# there is deliberately no SYSTEM.md — no custom prompt means the extension-off
	# degraded mode is pi's current vanilla prompt, not a stale capture.
	link "$REPO/pi/APPEND_SYSTEM.md"   "$AGENT/APPEND_SYSTEM.md"
	# The agent types the engine reads at session start (map C21).
	link "$REPO/pi/agents"             "$AGENT/agents"
	# Not pi's own path — pi finds skills through the kit manifest. This is here
	# so the dormant harnesses' skill links keep resolving.
	link "$KIT/skills"                 "$HOME/.agents/skills"
	# The chat seat: pi stripped to the wire invariant and web search. PI_CHAT
	# is read by kit/extensions/wire.ts; ~/.pi/agent/bin is already on PATH.
	link "$REPO/bin/chat"              "$AGENT/bin/chat"
	for peer in pi-coding-agent pi-ai pi-tui; do link "$(peer_target "$peer")" "$PEERS/$peer"; done

	# The terminal and its neighbours.
	link "$REPO/ghostty/config"          "$HOME/.config/ghostty/config"
	# Ghostty resolves `theme = NAME` inside its config dir's themes/, and
	# `config-file = font.conf` relative to the config dir, so both have to
	# appear there under those exact names.
	link "$REPO/theme/gen/ghostty"       "$HOME/.config/ghostty/themes"
	link "$REPO/ghostty/font.conf"       "$HOME/.config/ghostty/font.conf"
	link "$REPO/herdr/config.toml"       "$HOME/.config/herdr/config.toml"
	link "$REPO/starship/starship.toml"  "$HOME/.config/starship.toml"
	link "$REPO/nvim"                    "$HOME/.config/nvim"

	# The window manager. AeroSpace reads ~/.aerospace.toml first and only falls
	# back to ~/.config/aerospace/aerospace.toml, so linking the dotfile path is
	# what makes the repo's copy the one that wins.
	link "$REPO/aerospace/aerospace.toml" "$HOME/.aerospace.toml"

	# The status bar. sketchybar looks in ~/.config/sketchybar and nowhere else
	# unless it is started with --config, and the launchd job it ships is not.
	link "$REPO/sketchybar"               "$HOME/.config/sketchybar"

	# ripgrep only reads a config file named by RIPGREP_CONFIG_PATH (exported in
	# zshrc; the kit's bash tool sets it for the commands it spawns).
	link "$REPO/ripgrep/rc"             "$HOME/.config/ripgrep/rc"

	# Git's default global ignore path — no core.excludesfile needed, so the
	# tracked gitconfig stays free of machine-specific paths.
	link "$REPO/gitignore_global"        "$HOME/.config/git/ignore"

	# settings.json is tracked, so the package is normally already listed and
	# `pi install` would only add a duplicate. Install only when it is missing.
	if ! grep -q '"~/dotfiles/pi/kit"' "$REPO/pi/settings.json"; then
		say "kit is not in settings.packages; installing"
		pi install "$KIT"
	fi

	if [[ $OSTYPE == darwin* ]]; then
		chmod +x "$REPO/bin/pi-open"
		chmod +x "$REPO"/aerospace/bin/*
		chmod +x "$REPO"/sketchybar/bin/* "$REPO"/sketchybar/plugins/* "$REPO/sketchybar/sketchybarrc"
		if [[ ! -d $HANDLER || $HANDLER_SRC -nt $HANDLER/Contents/Info.plist ]]; then
			build_handler
		fi
		if [[ ! -x $PROBE || $PROBE_SRC -nt $PROBE ]]; then
			build_probe
		fi
		if [[ ! -x $MENUBAR || $MENUBAR_SRC -nt $MENUBAR ]]; then
			build_menubar
		fi
		if [[ ! -x $WAKEPUI || $WAKEPUI_SRC -nt $WAKEPUI ]]; then
			build_wakepui
		fi
		install_powermode_rule
		install_chargeboost_rule

		# Spotify's ads. Built only when ABSENT, never rebuilt -- unlike the
		# handlers above, which are rebuilt whenever their source is newer. The
		# app's only job is to own an Automation permission, and macOS pins that
		# grant to the bundle's hash: rebuild it and the grant silently stops
		# applying, the watcher hangs on its first question, and ads come back
		# with no error anywhere. The logic lives in bin/, outside the bundle,
		# precisely so it can change without touching this.
		chmod +x "$REPO"/spotify/bin/* "$REPO/spotify/build-app.sh"
		if [[ ! -d $REPO/spotify/SpotifyAdSkip.app ]]; then
			"$REPO/spotify/build-app.sh"
		fi
		link "$REPO/spotify/com.joel.spotify-ad-skip.plist" \
			"$HOME/Library/LaunchAgents/com.joel.spotify-ad-skip.plist"

		# ¡ -> F13 at the HID layer so it is Herdr's prefix and types nothing.
		link "$REPO/macos/com.joel.keymap.plist" \
			"$HOME/Library/LaunchAgents/com.joel.keymap.plist"
		launchctl bootstrap "gui/$(id -u)" \
			"$HOME/Library/LaunchAgents/com.joel.keymap.plist" 2>/dev/null || true
	fi

	# pi rewrites settings.json as you work, so the keys it toggles mid-session
	# are filtered out of git in both directions (see bin/pi-settings-filter).
	# .gitattributes names the filter; this is where it gets a definition, which
	# git only ever reads from local config, never from a tracked file.
	chmod +x "$REPO/bin/pi-settings-filter"
	git -C "$REPO" config filter.pi-settings.clean "$REPO/bin/pi-settings-filter clean"
	# The handoff footer names this script by absolute path; the model runs it
	# from the bash tool, so it has to be executable and need nothing installed.
	chmod +x "$KIT/bin/pi-recall.mjs"

	say "running kit tests"
	(cd "$KIT" && npm test >/dev/null) && say "kit tests pass"
	say
fi

# --- check ------------------------------------------------------------------

say "links"
for pair in \
	"$AGENT/AGENTS.md:$REPO/pi/AGENTS.md" \
	"$AGENT/settings.json:$REPO/pi/settings.json" \
	"$AGENT/keybindings.json:$REPO/pi/keybindings.json" \
	"$AGENT/APPEND_SYSTEM.md:$REPO/pi/APPEND_SYSTEM.md" \
	"$AGENT/agents:$REPO/pi/agents" \
	"$AGENT/bin/chat:$REPO/bin/chat" \
	"$PEERS/pi-coding-agent:$PI_ROOT" \
	"$PEERS/pi-ai:$PI_ROOT/node_modules/@earendil-works/pi-ai" \
	"$PEERS/pi-tui:$PI_ROOT/node_modules/@earendil-works/pi-tui" \
	"$HOME/.agents/skills:$KIT/skills" \
	"$HOME/.config/ghostty/config:$REPO/ghostty/config" \
	"$HOME/.config/ghostty/themes:$REPO/theme/gen/ghostty" \
	"$HOME/.config/ghostty/fonts:$REPO/ghostty/fonts" \
	"$HOME/.config/herdr/config.toml:$REPO/herdr/config.toml" \
	"$HOME/.config/starship.toml:$REPO/starship/starship.toml" \
	"$HOME/.config/nvim:$REPO/nvim" \
	"$HOME/.config/git/ignore:$REPO/gitignore_global" \
	"$HOME/.config/ripgrep/rc:$REPO/ripgrep/rc" \
	"$HOME/.aerospace.toml:$REPO/aerospace/aerospace.toml"
do
	path=${pair%%:*} want=${pair#*:}
	if [[ ! -L "$path" ]];                          then bad "$path is not a symlink"
	elif [[ "$(readlink "$path")" != "$want" ]];    then bad "$path -> $(readlink "$path"), want $want"
	else ok "$path"
	fi
done

say
say "the handoff can read the past"
# A compacted session points the model at pi-recall. If it cannot run, the
# past is unreachable and the model finds out mid-task.
if [[ ! -x "$KIT/bin/pi-recall.mjs" ]]; then bad "pi/kit/bin/pi-recall.mjs is not executable"
elif [[ "$("$KIT/bin/pi-recall.mjs" 2>&1 || true)" != usage:* ]]; then bad "pi/kit/bin/pi-recall.mjs does not run"
else ok "pi-recall runs"
fi

say
say "owned commands win the PATH race"
# A link that exists but loses to a system binary fails silently — macOS ships
# /usr/sbin/chat (PPP), which is exactly how `chat` exited 0 doing nothing on
# 2026-09-01. Resolve through a real interactive zsh, the shell the user types
# into, not this script's inherited PATH.
if [[ "$(zsh -ic 'command -v chat' 2>/dev/null)" != "$AGENT/bin/chat" ]]; then
	bad "chat resolves to $(zsh -ic 'command -v chat' 2>/dev/null || echo nothing), want $AGENT/bin/chat — is ~/.pi/agent/bin on PATH in zshrc?"
else ok "chat is $AGENT/bin/chat"
fi

say
say "session toggles stay out of git"
# Three things have to agree or a toggle becomes a diff again: the attribute
# that names the filter, the local config that defines it, and the pinned
# defaults matching what is actually committed.
if [[ "$(git -C "$REPO" check-attr filter -- pi/settings.json)" != *"filter: pi-settings" ]]; then
	bad "pi/settings.json has no pi-settings filter attribute"
else ok "pi/settings.json is filtered"
fi
if [[ "$(git -C "$REPO" config --get filter.pi-settings.clean || true)" != "$REPO/bin/pi-settings-filter clean" ]]; then
	bad "filter.pi-settings is not configured in this clone: run without --doctor"
else ok "filter.pi-settings is configured"
fi
if ! "$REPO/bin/pi-settings-filter" check; then
	bad "the committed settings disagree with the pins in bin/pi-settings-filter"
else ok "the committed settings match their pins"
fi

say
say "every model named by hand is the newest of its family"
# There is no models.json here: pi ships every model this machine uses. What is
# left to check is the two places a *release* is still typed out by hand — pi's
# defaultModel, and the seat bin/chat launches. Everything else in the kit names
# a family and resolves it at run time (pi/kit/lib/model-family.ts), and these
# two cannot, because pi resolves them before any extension loads.
#
# So they are checked instead of remembered. An id pi does not define is a 404
# on the first request; an id a newer release of the same family has passed is
# worse, because it works — that is how three of four agent types sat a release
# behind through 2026-09-20 while their frontmatter read correctly.
CATALOG_DIR="$PI_ROOT/node_modules/@earendil-works/pi-ai/dist/providers/data"
# The newest undated release of $2's family in provider $1's catalog, or empty.
newest_release() {
	local catalog="$CATALOG_DIR/$1.json" family
	[[ -f $catalog ]] || return 1
	family=${2#claude-}
	family=${family%%-*}
	jq -r --arg f "$family" '
		[ .[] | keys[] ]
		| map(select(test("^(claude-)?" + $f + "-[0-9]+(-[0-9]+)*$")))
		| map(select(test("-[0-9]{8}$") | not))
		| map({ id: ., v: [ (sub("^(claude-)?[a-z]+-"; "") | split("-") | .[] | tonumber) ] })
		| sort_by(.v) | last | .id // empty
	' "$catalog"
}
check_pin() {
	local what=$1 provider=$2 model=$3 newest
	if ! newest=$(newest_release "$provider" "$model"); then
		# Providers pi configures at runtime rather than from a bundled file
		# (llama.cpp, anything an extension registers) have no catalog to read.
		say "  - $provider has no bundled catalog; $what ($model) unchecked"
	elif [[ -z $newest ]]; then
		bad "$what names $provider/$model, whose family pi's catalog does not define"
	elif [[ $newest != "$model" ]]; then
		bad "$what names $provider/$model, but pi ships $newest — a newer release of the same model"
	else ok "$what: $provider/$model"
	fi
}
check_pin "pi's defaultModel" "$(jq -r '.defaultProvider' "$REPO/pi/settings.json")" "$(jq -r '.defaultModel' "$REPO/pi/settings.json")"
# bin/chat launches its seat with --model provider/id:thinking, the one other
# release this repo types out. Read from the script so the two cannot drift.
chat_spec=$(sed -n 's/^[[:space:]]*--model "\([^"]*\)".*/\1/p' "$REPO/bin/chat")
if [[ -z $chat_spec ]]; then
	bad "bin/chat no longer passes --model \"provider/id\"; this check cannot read its pin"
else
	chat_spec=${chat_spec%%:*}
	check_pin "bin/chat's seat" "${chat_spec%%/*}" "${chat_spec#*/}"
fi

if [[ $OSTYPE == darwin* ]]; then
	say
	say "clicking a path opens nvim"
	if [[ ! -x "$REPO/bin/pi-open" ]]; then bad "bin/pi-open is not executable"
	else ok "bin/pi-open"
	fi

	if [[ ! -x "$HANDLER/Contents/MacOS/applet" ]]; then bad "$HANDLER is missing; run without --doctor"
	elif ! /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$HANDLER/Contents/Info.plist" 2>/dev/null | grep -qx "pi-open"; then
		bad "$HANDLER does not claim the pi-open scheme"
	else ok "$HANDLER claims pi-open:"
	fi

	say
	say "the window manager's keys reach real scripts"
	# aerospace.toml calls these by absolute path from a `/bin/bash -c` with no
	# shell profile, so a lost +x bit shows up as a leader key that silently
	# does nothing rather than as an error anyone would see.
	for helper in "$REPO"/aerospace/bin/*; do
		if [[ ! -x "$helper" ]]; then bad "${helper#"$REPO"/} is not executable"
		else ok "${helper#"$REPO"/}"
		fi
	done
	# The other direction: a key bound to a script that was renamed or never
	# written is a key that does nothing, silently, forever.
	while read -r helper; do
		path="$REPO/${helper#*/dotfiles/}"
		[[ -e "$path" ]] || bad "aerospace.toml binds a key to missing $path"
	done < <(grep -o '/dotfiles/aerospace/bin/[a-z-]*' "$REPO/aerospace/aerospace.toml" | sort -u)

	# The other kind of exec: a bare command name, found on the PATH that
	# aerospace.toml hands to its execs. A missing binary here is a border that
	# never appears, with nothing on screen to say why.
	while read -r cmd; do
		if command -v "$cmd" >/dev/null; then ok "$cmd (named by aerospace.toml)"
		else bad "aerospace.toml runs '$cmd', which is not installed"
		fi
	done < <(grep -o "exec-and-forget [a-z][a-z0-9_-]*" "$REPO/aerospace/aerospace.toml" | awk '{print $2}' | sort -u)

	# Inside the leader layer every key on the board is bound, so that an
	# unbound one cannot leak a character into the terminal and strand you
	# there. The price is that promoting a key to a real command means deleting
	# it from the catch-all below — and a key written twice in one mode is a
	# duplicate TOML key, which makes AeroSpace reject the whole file. That
	# fails as "the window manager stopped working", not as "line 203".
	# `[[double]]` brackets are an array of tables, so every entry legitimately
	# repeats the same field names; each one is counted as its own section.
	dupes=$(awk '
		/^\[\[/          { section = $0 " #" ++n; next }
		/^\[/            { section = $0; next }
		/^[^#[:space:]]/ { key = $1; gsub(/[^a-zA-Z0-9-]/, "", key)
		                   if (key != "") print section, key }
	' "$REPO/aerospace/aerospace.toml" | sort | uniq -d)
	if [[ -n "$dupes" ]]; then
		while IFS= read -r dupe; do bad "aerospace.toml binds twice: $dupe"; done <<<"$dupes"
	else
		ok "no key is bound twice in one mode"
	fi

	say
	say "the status bar"

	if sudo_allows "${POWERMODE_CMDS[@]}"; then ok "clicking the battery can flip Low Power Mode"
	else bad "clicking the battery cannot flip Low Power Mode: run without --doctor"
	fi
	if sudo_allows "${CHARGELIMIT_CMDS[@]}"; then ok "the bar can set the charge limit"
	else bad "the bar cannot set every charge limit step: run without --doctor"
	fi

	if ! command -v sketchybar >/dev/null; then bad "sketchybar is not installed"
	else ok "sketchybar $(sketchybar --version 2>/dev/null)"
	fi

	# The probe is the only compiled part, and a stale one is worse than a
	# missing one: it runs, so nothing looks broken, but it reports whatever the
	# source said last time it was built.
	if [[ ! -x $PROBE ]]; then bad "sketchybar/bin/sysprobe is missing; run without --doctor"
	elif [[ $PROBE_SRC -nt $PROBE ]]; then bad "sketchybar/bin/sysprobe is older than its source; run without --doctor"
	elif ! "$PROBE" metrics >/dev/null 2>&1; then bad "sketchybar/bin/sysprobe does not run"
	else ok "sketchybar/bin/sysprobe"
	fi

	# Same trap as the aerospace helpers: sketchybarrc calls these by absolute
	# path from a process with no shell profile, so a lost +x bit is an item that
	# silently never updates.
	for helper in "$REPO"/sketchybar/bin/* "$REPO"/sketchybar/plugins/*; do
		[[ "$helper" == *.m || "$helper" == *.c ]] && continue   # sources, not helpers
		[[ -x "$helper" ]] || bad "${helper#"$REPO"/} is not executable"
	done

	# macOS already withholds the notch strip from every app and AeroSpace tiles
	# inside what is left, so a top gap here is measured from *below* the bar. Any
	# small value is a deliberate margin and none of this check's business.
	#
	# What it is looking for is the bar's height being counted twice. That is a
	# real bug with a real symptom -- gaps.outer.top of 42, from 38 plus a 4pt
	# frame, once put 74 points of dead air above every window -- and it always
	# looks like a gap at least as large as the bar itself.
	#
	# This check used to demand exactly 0, which was wrong: it read a deliberate
	# 9pt margin under the bar as a failure and told you to delete it.
	# Measured, not written down, because it is also what the next check compares
	# the live bar height against.
	safe_top=$([[ -x $PROBE ]] && "$PROBE" screen 2>/dev/null |
		awk '{for(i=1;i<=NF;i++){split($i,a,"="); if(a[1]=="bar") print a[2]}}')
	gap_t=$(awk -F= '/^gaps\.outer\.top/ {gsub(/[^0-9]/,"",$2); print $2}' "$REPO/aerospace/aerospace.toml")
	if [[ -z ${safe_top:-} ]]; then
		bad "sysprobe screen reported no safe-area inset"
	elif [[ -z ${gap_t:-} ]]; then
		bad "aerospace gaps.outer.top is unset"
	elif (( gap_t >= safe_top )); then
		bad "aerospace gaps.outer.top is ${gap_t}, at least the ${safe_top}pt the bar already occupies; that is the bar's height counted twice"
	else ok "aerospace adds ${gap_t}pt under the bar, not a second bar's worth"
	fi

	# And the bar must be exactly as tall as that reserved strip. Taller and a
	# seam of bar hangs below the notch across the whole screen; shorter and the
	# notch pokes out below it. Both look like a rendering fault rather than an
	# arithmetic one, so the number is measured rather than written down.
	if [[ -n ${safe_top:-} ]]; then
		bar_h=$(sketchybar --query bar 2>/dev/null | awk -F'[:,]' '/"height"/ {gsub(/[^0-9]/,"",$2); print $2}')
		if [[ -n $bar_h && $bar_h != "$safe_top" ]]; then
			bad "the bar is ${bar_h}pt but this screen reserves ${safe_top}pt; restart sketchybar"
		else ok "the bar is ${safe_top}pt, exactly the strip macOS reserves"
		fi
	fi

	# topmost=on covers the menu bar, but only while sketchybar is running.
	# Two separate things, and both are needed.
	#
	# Auto-hide reclaims the 32pt strip so windows start at the top of the
	# screen. It does not hide anything: the bar still slides back down when the
	# pointer reaches the top edge, and since our bar is transparent it shows
	# straight through.
	#
	# hide-menubar is what stops the pixels. It holds SkyLight's menu bar
	# override alpha at zero, and the WindowServer keys that override to the
	# connection that set it -- so "is it installed" is not the question, "is it
	# running right now" is.
	if [[ $(defaults read NSGlobalDomain _HIHideMenuBar 2>/dev/null) == 1 ]]; then
		ok "the menu bar's 32pt strip is given back to windows"
	else
		bad "the menu bar still reserves its strip: defaults write NSGlobalDomain _HIHideMenuBar -bool true"
	fi

	if [[ ! -x $MENUBAR ]]; then
		bad "sketchybar/bin/hide-menubar is missing; run without --doctor"
	# Matched on the path suffix, not on $MENUBAR: supervise launches it through
	# ~/.config/sketchybar, which is a symlink to here, so the running process's
	# argv holds the linked path and never the repo one.
	elif pgrep -f "sketchybar/bin/hide-menubar" >/dev/null 2>&1; then
		ok "the menu bar cannot draw itself"
	else
		bad "hide-menubar is not running, so the menu bar reappears on hover"
	fi

	# Every external command the bar shells out to. Each missing one is a single
	# dark item rather than a visible error.
	for cmd in media-control jq aerospace; do
		if command -v "$cmd" >/dev/null; then ok "$cmd (used by the bar)"
		else bad "the status bar runs '$cmd', which is not installed"
		fi
	done

	# A glyph that is not in the installed font renders as an empty box, which
	# reads as a broken config rather than as a missing character. lib/icons.sh
	# carries literal characters, so this checks them against the font itself.
	font="$HOME/Library/Fonts/HackNerdFontMono-Bold.ttf"
	if [[ ! -f $font ]]; then bad "Hack Nerd Font Mono is not installed; every icon will be a box"
	elif command -v python3 >/dev/null && python3 -c 'import fontTools' 2>/dev/null; then
		missing=$(python3 - "$font" "$REPO/sketchybar/lib/icons.sh" <<-'PY'
			import re, sys
			from fontTools.ttLib import TTFont
			cmap = TTFont(sys.argv[1]).getBestCmap()
			pat = re.compile(r'^export (ICON_[A-Z0-9_]+)="(.+?)"')
			for line in open(sys.argv[2], encoding='utf-8'):
			    m = pat.match(line)
			    if m and ord(m.group(2)[0]) not in cmap:
			        print('%s (U+%04X)' % (m.group(1), ord(m.group(2)[0])))
		PY
		)
		if [[ -n $missing ]]; then
			while IFS= read -r glyph; do bad "icons.sh names a glyph the font does not have: $glyph"; done <<<"$missing"
		else ok "every icon exists in Hack Nerd Font Mono"
		fi

		# Every glyph is drawn at its own point size and placed by hand in its
		# cell, because one font size does not give one icon size -- the ink in
		# these glyphs varies by more than two to one -- and because sketchybar
		# measures a glyph's box from the ink's right edge and drops the left
		# side bearing, so left to itself it hangs every icon off-centre.
		# lib/ink.sh holds the ink and where its centre falls, measured;
		# lib/icons.sh turns both into a point size and a left padding using the
		# current skin's chip height. A glyph added without re-running
		# bin/measure-icons has no row there, falls back to the default size,
		# and is quietly wrong forever -- which is how the built-in speaker came
		# to overflow its chip by 28%.
		sized=$(python3 - "$REPO/sketchybar/lib/icons.sh" "$REPO/sketchybar/lib/ink.sh" <<-'PY'
			import re, sys
			src = open(sys.argv[1], encoding="utf-8").read()
			ink = open(sys.argv[2], encoding="utf-8").read()
			glyphs  = {n for n, v in re.findall(r'^export ICON_(\w+)="([^"]*)"', src, re.M) if v}
			measured = set(re.findall(r'^(\w+) [\d.]+ [\d.]+ [-\d.]+$', ink, re.M))
			for n in sorted(glyphs - measured):
			    print(n)
		PY
		)
		if [[ -n $sized ]]; then
			while IFS= read -r g; do bad "ICON_$g has no measured ink; run sketchybar/bin/measure-icons"; done <<<"$sized"
		else ok "every icon has ink measured from the font"
		fi

		# A skin is what the bar looks like, and lib/skin.sh falls back to flat
		# for a name that does not resolve -- quietly, because a theme naming a
		# skin nobody wrote should still leave you with a bar. Quiet is right at
		# runtime and wrong here: a typo in a setup file would otherwise never
		# be mentioned by anything.
		for setup in "$REPO"/theme/setups/*.toml; do
			want=$(sed -n 's/^skin *= *"\([a-z0-9-]*\)".*/\1/p' "$setup" | head -1)
			[[ -z $want ]] && continue
			if [[ -f "$REPO/sketchybar/skins/$want.sh" ]]; then
				ok "$(basename "$setup" .toml) wears the $want skin"
			else
				bad "$(basename "$setup" .toml) names skin '$want'; no sketchybar/skins/$want.sh"
			fi
		done
	else
		ok "Hack Nerd Font Mono is installed (glyphs unchecked: no fontTools)"
	fi

	# The bar replaces the menu bar, so a bar that is not running leaves nothing
	# at all up there -- no clock, no battery, and no way back to either without
	# a terminal. That makes starting at login load-bearing rather than a
	# convenience, which is the opposite of the call aerospace.toml makes for the
	# window manager.
	if brew services list 2>/dev/null | grep -qE '^sketchybar +(started|scheduled)'; then
		ok "sketchybar starts at login"
	else
		bad "sketchybar does not start at login: brew services start sketchybar"
	fi

	# The ad skipper fails silently by nature: without the Automation grant it
	# hangs on its first question rather than erroring, so "is it running" is not
	# enough to know it works. Check the grant itself.
	say
	say "spotify ad skipper"
	tcc_db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
	grant=$(sqlite3 "$tcc_db" \
		"select auth_value from access where client='com.joel.spotify-ad-skip' and indirect_object_identifier='com.spotify.client';" 2>/dev/null)
	case "${grant:-}" in
		2) ok "allowed to control Spotify" ;;
		0) bad "DENIED control of Spotify: tccutil reset AppleEvents com.joel.spotify-ad-skip, then open spotify/SpotifyAdSkip.app and click Allow" ;;
		*) bad "not granted yet: open spotify/SpotifyAdSkip.app and click Allow (cannot be granted from launchd -- no dialog can be shown there)" ;;
	esac
	if pgrep -f 'bin/spotify-ad-skip' >/dev/null 2>&1; then
		ok "watcher is running"
	else
		bad "watcher is not running: open spotify/SpotifyAdSkip.app"
	fi
fi

say
say "nothing dangling"
dangling=$(find "$HOME/.pi" "$HOME/.agents" "$HOME/.claude" "$HOME/.codex" "$REPO" \
	-type l ! -exec test -e {} \; -print 2>/dev/null || true)
if [[ -n "$dangling" ]]; then
	while IFS= read -r link; do bad "dangling $link -> $(readlink "$link")"; done <<<"$dangling"
else
	ok "no dangling symlinks"
fi

say
say "no stub instructions"
# A one-byte AGENTS.md is a file pretending to hold instructions. It shadows the
# real one for every tool that stops at the first match.
stubs=$(find "$HOME/.pi" "$HOME/.claude" "$HOME/.codex" "$REPO" \
	\( -name AGENTS.md -o -name CLAUDE.md \) -type f -size -2c 2>/dev/null || true)
if [[ -n "$stubs" ]]; then
	while IFS= read -r stub; do bad "stub $stub"; done <<<"$stubs"
else
	ok "no empty AGENTS.md or CLAUDE.md"
fi

say
say "agent types name no tools"
# An agent type sets a model, a thinking level, a prompt body and a routing-rule
# description — never a tool list (map C21). Every seat carries the identical
# tools array, because the array is the front of the cache key and a per-type
# one costs a child its parent's tools+system entry (map C4). The engine reads
# `tools:` and ignores it (`pi/kit/lib/agent-types.ts`), so a file that declares
# one is a promise the harness will not keep, which is worse than no promise.
for file in "$REPO"/pi/agents/*.md; do
	name=$(basename "$file" .md)
	if grep -q '^enabled: false' "$file"; then
		ok "$name is disabled"
	elif grep -q '^tools:' "$file"; then
		bad "$name declares tools:, which the engine ignores — every seat holds the same tools (C4)"
	else
		ok "$name names no tools"
	fi
done

say
say "no conversation content left lying around"
# Every hand-rolled wire probe before the standing one wrote whole conversations
# to /tmp at mode 644, and nothing here noticed for weeks (issues/18). The trace
# that replaced them lives in the state dir and is private by construction; this
# checks both halves, so the next probe someone writes gets caught by its sink.
TRACE="${XDG_STATE_HOME:-$HOME/.local/state}/pi-kit/wire-trace"
if [[ -d "$TRACE" ]]; then
	loose=$(find "$TRACE" -maxdepth 1 -type f ! -perm 600 -print 2>/dev/null || true)
	dirmode=$(stat -f '%Lp' "$TRACE" 2>/dev/null || stat -c '%a' "$TRACE")
	if [[ "$dirmode" != 700 ]];  then bad "$TRACE is mode $dirmode, want 700"
	elif [[ -n "$loose" ]];      then while IFS= read -r f; do bad "world-readable trace $f"; done <<<"$loose"
	else ok "$TRACE is private"
	fi
else
	ok "no wire traces yet"
fi
strays=$(find -H /tmp -maxdepth 1 \( -name 'wire-*.json' -o -name 'wire-probe.jsonl' -o -name 'cache-probe.log' \) -user "$(id -un)" 2>/dev/null || true)
if [[ -n "$strays" ]]; then
	while IFS= read -r f; do bad "probe leftover in world-readable /tmp: $f"; done <<<"$strays"
else
	ok "no probe leftovers in /tmp"
fi

say
say "secrets stay out of the repo"
# Whole path segments, not substrings. `*sessions*` also matches
# pi/kit/test/sessions.mjs, which is a test file and not pi's session store, so
# the old form failed the install over a name collision. `:(glob)**/x` matches x
# at the repo root and at any depth; sessions is only ever a directory.
for never in auth.json trust.json models-store.json; do
	if git -C "$REPO" ls-files --error-unmatch ":(glob)**/$never" >/dev/null 2>&1; then
		bad "$never is tracked"
	else
		ok "$never untracked"
	fi
done
if git -C "$REPO" ls-files --error-unmatch ":(glob)**/sessions/**" >/dev/null 2>&1; then
	bad "a sessions/ directory is tracked"
else
	ok "sessions/ untracked"
fi

say
if (( problems )); then
	say "$problems problem(s)"
	exit 1
fi
say "all good"
