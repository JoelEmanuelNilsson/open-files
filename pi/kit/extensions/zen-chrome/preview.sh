#!/usr/bin/env bash
# Renders the editor chrome at many widths and runs its layout checks.
#
# chrome.ts imports @earendil-works/pi-tui, which only resolves inside pi's own
# install, so stage the sources under a symlink to it and run there. The stage
# mirrors the kit's own layout, because preview.ts also reaches up into lib/.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
pi_root="$(npm root -g)/@earendil-works/pi-coding-agent"
[ -d "$pi_root/node_modules" ] || { echo "no pi install at $pi_root" >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/extensions/zen-chrome" "$stage/lib"
ln -s "$pi_root/node_modules" "$stage/node_modules"
cp "$here/chrome.ts" "$here/fold.ts" "$here/message.ts" "$here/preview.ts" "$stage/extensions/zen-chrome/"
# The whole of lib/, not the one or two files today's imports name: a helper
# added to chrome.ts should not be able to break the preview at a distance.
cp "$here/../../lib/"*.ts "$stage/lib/"

cd "$stage/extensions/zen-chrome" && node preview.ts
