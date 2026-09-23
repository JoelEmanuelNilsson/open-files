# Joel's New Mac Setup

Runbook for setting up a new Mac. Written to be read by the agent doing the setup.

The agent is [pi](https://pi.dev/docs), and its whole configuration is one
command:

```bash
~/dotfiles/install.sh          # link and check
~/dotfiles/install.sh --doctor # check only
```

See [pi/README.md](pi/README.md). Claude Code, Codex, and Cursor configs are
still in here and still work if woken, but nothing installs or maintains them.

---

## COMPLETED

These steps have already been done on the new Mac:

- [x] SSH keys transferred via AirDrop and placed in `~/.ssh/` with correct permissions
- [x] `ssh -T git@github.com` works (authenticated as JoelEmanuelNilsson)
- [x] Homebrew installed (`brew --version` → 5.0.14)
- [x] Homebrew added to PATH via `~/.zprofile`
- [x] This dotfiles repo cloned to `~/dotfiles`
- [x] `~/.zshrc` symlinked to `~/dotfiles/zshrc`
- [x] `~/.gitconfig` symlinked to `~/dotfiles/gitconfig` (name: Joel Nilsson, email: joel.emanuel.nilsson@gmail.com)
- [x] `~/.codex/config.toml` symlinked to `~/dotfiles/codex/config.toml` (dormant)
- [x] Shell sourced cleanly with no errors

---

## NEXT STEPS

### 1. Install Ghostty + config

Download Ghostty from https://ghostty.org then:

```bash
mkdir -p ~/.config/ghostty
ln -sf ~/dotfiles/ghostty/config ~/.config/ghostty/config
```

The Ghostty config uses **Comic Code** font (13pt). Install that font too.

Ghostty config includes:
- 50M scrollback
- Keybinds: shift+enter, alt+backspace, super+u
- AZURE_OPENAI_API_KEY env var for Codex CLI

### 2. Install nvm + Node 22

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.zshrc
nvm install 22
```

### 3. Install global npm packages

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm install -g vercel wrangler
```

Then wire pi up and check it:

```bash
~/dotfiles/install.sh
```

### 4. Install Cursor + transparent windows

Download Cursor from https://cursor.com then:

**a) Install these extensions in Cursor (required for the config to work):**
- `subframe7536.custom-ui-style` — enables window transparency
- `beardedbear.beardedicons` — icon theme
- `github.github-vscode-theme` — GitHub Dark Default theme (active theme)
- `hsnazar.hyper-term-theme` — Hyper Term theme
- `pkief.material-icon-theme` — Material icons

**b) Quit Cursor completely, then symlink configs:**

```bash
ln -sf ~/dotfiles/cursor/argv.json ~/.cursor/argv.json
ln -sf ~/dotfiles/cursor/settings.json ~/Library/Application\ Support/Cursor/User/settings.json
ln -sf ~/dotfiles/cursor/keybindings.json ~/Library/Application\ Support/Cursor/User/keybindings.json
```

**c) Open Cursor, press Cmd+Shift+P, type "Custom UI Style: Reload", hit Enter**

**d) Restart Cursor completely (quit + reopen)**

How the transparency works:
- `cursor/argv.json` sets `disable-hardware-acceleration: true` (required for Electron transparency on macOS)
- `cursor/settings.json` has `custom-ui-style.electron.transparent: true` + `opacity: 0.95`
- The Custom UI Style extension patches Cursor's Electron bootstrap to apply these settings

Cursor config also includes:
- Font: JetBrainsMono Nerd Font Mono (12pt, 1.4 line height)
- Color themes for: GitHub Dark Default, GitHub Light Default, Cursor Dark, Atom One Light, Hyper Term Black
- Extensive terminal color customizations per theme
- Custom keybindings (cmd+i for agent mode, cmd+t for new terminal, shift+enter in terminal, many default unbinds)

### 5. Clone project repos

```bash
git clone git@github.com:Alstig/limitless-web.git ~/web-gym
git clone git@github.com:JoelEmanuelNilsson/open-lovable-parallel.git ~/open-lovable-parallel
git clone git@github.com:Alstig/publisher-platform.git ~/publisher-platform
```

### 6. Install Rust (when needed)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.zshrc
```

### 7. Install Docker (when needed)

```bash
brew install --cask docker
```

### 8. App logins (just sign in — everything syncs via cloud)

| App | Action |
|---|---|
| Google Chrome | Sign in with Google account → passwords, bookmarks, extensions sync |
| Discord | Sign in with email/password |
| Spotify | Sign in with account |
| 1Password | Sign in → vault syncs |
| WhatsApp | Link device via QR code from phone |

### 9. Other apps to install (whenever)

Brave, Zen, Obsidian, Raycast, Rectangle, QuickShade, ProtonVPN, Wispr Flow, OBS

### 10. Install the window manager

```bash
brew install --cask aerospace
brew install FelixKratz/formulae/borders
~/dotfiles/install.sh
```

AeroSpace asks for Accessibility permission on first launch. Turn Raycast's own
window management off, or it fights for the same keys.

What the keys are and why they are those keys: [aerospace/README.md](aerospace/README.md).

---

## What's in this repo

```
dotfiles/
├── README.md                      ← this file (setup runbook)
├── AGENTS.md                      ← global agent instructions (CLAUDE.md links here)
├── install.sh                     ← links the pi config, and --doctor checks it
├── zshrc                          ← shell config (aliases, PATH, nvm, etc.)
├── gitconfig                      ← git user name/email
├── aerospace/                     ← the window manager
│   ├── README.md                  ← rooms, the leader layer, and why
│   ├── aerospace.toml             ← linked to ~/.aerospace.toml
│   └── bin/aerospace-summon       ← brings an app to the room you are in, at a third of the screen
├── sketchybar/                    ← the status bar; replaces the macOS menu bar
│   ├── README.md                  ← the architecture, and the traps
│   ├── sketchybarrc               ← linked to ~/.config/sketchybar
│   ├── lib/                       ← sizes and glyphs
│   ├── bin/sysprobe.m             ← one resident probe: cpu, ram, battery, audio, keyboard
│   ├── bin/pump                   ← probe lines in, one batched render out
│   └── bin/bridge-*               ← aerospace and now-playing, both push-driven
├── herdr/                         ← terminal multiplexer config
├── nvim/                          ← editor config
├── starship/                      ← prompt
├── docs/agents/                   ← how skills read this repo's docs and issues
├── bin/
│   └── pi-open                    ← opens a clicked path in nvim (herdr split, or a Ghostty window)
├── macos/
│   └── pi-open-handler.applescript ← the app that claims `pi-open:` links; built by install.sh
├── pi/                            ← the live harness
│   ├── settings.json              ← packages, models, trust
│   ├── keybindings.json           ← shift+enter newline, ctrl+q follow-up
│   └── kit/                       ← extensions and skills (one package)
├── ghostty/
│   └── config                     ← terminal config (font, keybinds, API key)
├── cursor/                        ← dormant
│   ├── settings.json              ← editor settings (transparency, themes, colors)
│   ├── argv.json                  ← electron flags (disable-hardware-acceleration)
│   └── keybindings.json           ← custom keybindings
└── codex/                         ← dormant
    └── config.toml                ← Codex CLI settings (model, MCP servers, features)
```

## Notes

- The Codex config.toml has project paths referencing `/Users/test` — update these to `/Users/joel` if Codex is ever woken
- The zshrc uses `$HOME` everywhere so it works on any username
- All symlinks use `ln -sf` so they can be re-run safely
