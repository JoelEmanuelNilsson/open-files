export PATH="$HOME/.local/bin:$PATH"

# Rust/Cargo environment
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

typeset -U path PATH

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# Owned commands (chat, …), linked there by dotfiles/install.sh. Must sit in
# front of the system dirs: macOS ships /usr/sbin/chat (a PPP relic) which
# otherwise swallows `chat` and exits silently.
export PATH="$HOME/.pi/agent/bin:$PATH"

# pi's built-in llama.cpp provider (/llama) reads this; the router itself runs
# from ~/Library/LaunchAgents/org.ggml.llama-server.plist.
export LLAMA_BASE_URL="http://127.0.0.1:8080"

# opencode
[ -d "$HOME/.opencode/bin" ] && export PATH="$HOME/.opencode/bin:$PATH"

# Keep Homebrew's Node 22 available as a fallback without invoking Homebrew on
# every shell startup.
[ -d "/opt/homebrew/opt/node@22/bin" ] && path=(/opt/homebrew/opt/node@22/bin $path)

alias cc='claude --dangerously-skip-permissions'
# Same as `cc`, but writes 5-minute prompt-cache entries instead of the 1-hour
# ones a subscription defaults to. Cheaper writes; the cache goes cold after a
# five-minute pause.
alias cc5='CLAUDE_CODE_PROMPT_CACHE_TTL=5m claude --dangerously-skip-permissions'
alias ä='claude --dangerously-skip-permissions'
alias ñ='claude --dangerously-skip-permissions --effort max'
# Never alias `:` (or any builtin): aliases expand inside every function
# parsed after this line, so `|| :` in nvm/fzf/starship became `|| codex`,
# which printed "Error: stdin is not a terminal" on random prompts.
alias cxa='codex --ask-for-approval never --sandbox danger-full-access'
alias cx="codex --dangerously-bypass-approvals-and-sandbox"
alias claudex='/Users/joel/.local/bin/claudex'
# Claude Code (native binary at ~/.local/bin/claude)

# Keep the active NVM Node version on PATH, but skip NVM's expensive automatic
# version selection. `nvm use` updates the `current` symlink normally.
export NVM_DIR="$HOME/.nvm"
export NVM_SYMLINK_CURRENT=true
[ -d "$NVM_DIR/current/bin" ] && path=("$NVM_DIR/current/bin" $path)
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" --no-use

# The next line updates PATH for the Google Cloud SDK.
if [ -f "$HOME/google-cloud-sdk/path.zsh.inc" ]; then . "$HOME/google-cloud-sdk/path.zsh.inc"; fi

# The next line enables shell command completion for gcloud.
if [ -f "$HOME/google-cloud-sdk/completion.zsh.inc" ]; then . "$HOME/google-cloud-sdk/completion.zsh.inc"; fi

export PATH="$PATH:/usr/local/share/dotnet/x64"

# Added by Antigravity
export PATH="/Users/joel/.antigravity/antigravity/bin:$PATH"

# Secrets (CONTEXT7_API_KEY, ...) live in ~/.zshrc.local, outside the repo.
[[ -f ~/.zshrc.local ]] && source ~/.zshrc.local

# pi-claude-oauth-adapter: never re-inject pi docs as a message. The splice
# anchors to the latest user message, which moves every turn, so any injection
# guarantees a full re-bill of the previous turn's prompt on the next request.
# Scope only gates the docs message; the OAuth fingerprint work (system prompt
# strip + billing header) runs unconditionally and is unaffected.
export PI_CLAUDE_OAUTH_REINJECT_SCOPE=never

# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/joel/.lmstudio/bin"
# End of LM Studio CLI section

export PATH="$HOME/.grok/bin:$PATH"

# Shell completions
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
[ -f "$HOME/.openclaw/completions/openclaw.zsh" ] && source "$HOME/.openclaw/completions/openclaw.zsh"

# Fuzzy finders on Ctrl+R (history), Ctrl+T (files), Alt+C (directories).
#
# Both file searches use `fd` with --hidden and --no-ignore, so names starting
# with a dot and anything listed in .gitignore are included. The plain versions
# of these tools hide both, which is why a file you knew existed could not be
# found. `.git` is the one thing left out: thousands of machine-written files
# that you will never open, and that would drown every result.
export FZF_CTRL_T_COMMAND='fd --type f --hidden --no-ignore --exclude .git'
export FZF_ALT_C_COMMAND='fd --type d --hidden --no-ignore --exclude .git'
export FZF_CTRL_T_OPTS="--height=60% --layout=reverse --border --preview 'head -200 {}'"
export FZF_ALT_C_OPTS="--height=60% --layout=reverse --border --preview 'eza -1 --color=always --icons=always {}'"
source <(fzf --zsh)

# ripgrep reads a config file only when this names one. ~/.config/ripgrep/rc
# is a symlink to dotfiles/ripgrep/rc; it teaches rg the `tsx` and `mjs` types.
export RIPGREP_CONFIG_PATH="$HOME/.config/ripgrep/rc"

# --- Stale herdr guard ------------------------------------------------------
# HERDR_* vars are only legitimate in shells that descend from the herdr
# server. But macOS `open -n` hands the caller's whole environment to the
# app it launches, so a Ghostty started from inside a herdr pane carries
# that pane's identity forever and passes it to every shell it opens.
# herdr's nested-launch guard then refuses to start ("nested herdr is
# disabled") in windows that were never panes at all.
# So: verify the claim instead of trusting it. Walk our ancestry once;
# if no ancestor is herdr, the vars are fossils — drop them. Real pane
# shells (and nested shells inside panes) keep theirs. Costs one `ps`
# call, and only in shells that carry HERDR_ENV in the first place.
if [[ -n $HERDR_ENV ]]; then
  () {
    local -A parent comm
    local pid ppid cmd
    while read -r pid ppid cmd; do
      parent[$pid]=$ppid
      comm[$pid]=$cmd
    done < <(command ps -axo pid=,ppid=,comm=)
    pid=$$
    while (( pid > 1 )); do
      [[ ${comm[$pid]:t} == herdr ]] && return
      pid=${parent[$pid]:-0}
    done
    unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID \
          HERDR_SOCKET_PATH HERDR_BIN_PATH
  }
fi

# --- Shell upgrades ---------------------------------------------------------

# Bigger history. Ctrl+R is only as good as what it can search.
HISTSIZE=50000
SAVEHIST=50000
setopt HIST_IGNORE_ALL_DUPS   # keep only the newest copy of a repeated command
setopt HIST_REDUCE_BLANKS
setopt SHARE_HISTORY          # every open shell sees the same history

alias ..='cd ..'
export EDITOR=nvim   # git and other tools open Neovim instead of vi

# --- Finding files ----------------------------------------------------------
# Three commands, all searching the same way: every file, dotfiles included,
# gitignored files included, no index to go stale. This is what replaces
# Raycast and Finder's Cmd-Shift-G. Raycast asks Spotlight, and Spotlight
# refuses to index anything whose name starts with a dot, so it can never
# find them.
#
#   f          pick a file, open it in Neovim
#   fp         pick a file, copy its full path to the clipboard
#   fd. NAME   list every match for NAME under here, no picker
#
# Give any of them a starting folder: `f ~/dotfiles`.
_fd_all() { fd --type f --hidden --no-ignore --exclude .git . "${1:-.}" }

f() {
  local file
  file=$(_fd_all "$1" | fzf --height=70% --layout=reverse --border \
    --preview 'head -200 {}' --prompt='open > ') || return
  [ -n "$file" ] && nvim "$file"
}

fp() {
  local file
  file=$(_fd_all "$1" | fzf --height=70% --layout=reverse --border \
    --preview 'head -200 {}' --prompt='copy path > ') || return
  [ -n "$file" ] || return
  printf '%s' "${file:a}" | pbcopy       # :a makes it an absolute path
  print -r -- "copied: ${file:a}"
}

alias fd.='fd --hidden --no-ignore --exclude .git'

# --- Status bar -------------------------------------------------------------
# `sketchybar on` and `sketchybar off` turn the whole bar on and off; off also
# brings back the macOS menu bar. See sketchybar/plugins/bar-power. Every other
# argument goes to the real binary untouched. A function rather than a script
# on PATH, so the bar's own scripts always reach the real sketchybar.
sketchybar() {
  case "$1" in
    on|off) "$HOME/dotfiles/sketchybar/plugins/bar-power" "$1" ;;
    *)      command sketchybar "$@" ;;
  esac
}

# Prompt: directory, git branch, command duration.
eval "$(starship init zsh)"

# Jump to directories by name instead of by path: `z agents`.
eval "$(zoxide init zsh)"

# Give Ctrl+R a readable window.
export FZF_CTRL_R_OPTS="--height=60% --layout=reverse --border --info=inline"

# --- Tab completion ---------------------------------------------------------
# fzf-tab must load after compinit (line ~61) and before the two plugins below.
_comp_options+=(globdots)                                   # offer files starting with a dot
zstyle ':completion:*' menu no                              # fzf-tab draws the menu instead
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'   # ignore case while matching
zstyle ':completion:*:descriptions' format '[%d]'

source /opt/homebrew/opt/fzf-tab/share/fzf-tab/fzf-tab.zsh

# Preview pane: directories as a listing, files as their first lines.
_preview='if [ -d "$realpath" ]; then eza -1 --color=always --icons=always "$realpath";
          elif [ -f "$realpath" ]; then head -200 "$realpath"; else echo "$word"; fi'
zstyle ':fzf-tab:complete:*:*' fzf-preview "$_preview"
zstyle ':fzf-tab:*' fzf-flags --height=60% --layout=reverse --border --info=inline
zstyle ':fzf-tab:*' switch-group '<' '>'                    # move between result groups
# Replaces fzf-tab's default binds, which include `tab:down`. Appending with
# `fzf-bindings` does not remove that, so the whole default set is restated here.
zstyle ':fzf-tab:*' fzf-bindings-default \
  'tab:accept' 'btab:up' 'change:top' 'ctrl-space:toggle' \
  'bspace:backward-delete-char/eof' 'ctrl-h:backward-delete-char/eof'
zstyle ':fzf-tab:*' continuous-trigger '/'                  # `/` accepts a directory and opens it

# Grey suggestion from history. Ctrl+F or Right arrow accepts the whole line.
source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
bindkey '^f' autosuggest-accept
bindkey '^[[1;5C' forward-word    # Ctrl + Right arrow: accept one word
bindkey '^[[1;3C' forward-word    # Option + Right arrow: same

# Colors the command line as you type. Must stay last.
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# opencode
export PATH=/Users/joel/.opencode/bin:$PATH
