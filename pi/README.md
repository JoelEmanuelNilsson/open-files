# pi

Configuration for the [pi coding agent](https://pi.dev/docs). One harness, one
repo, one install command:

```bash
~/dotfiles/install.sh
```

## How it is wired

Everything pi loads is a package — `pi/kit` — named once in `settings.json`.
That leaves seven symlinks, which `install.sh` makes and re-checks:

```
~/.pi/agent/AGENTS.md                  -> dotfiles/pi/AGENTS.md
~/.pi/agent/settings.json              -> dotfiles/pi/settings.json
~/.pi/agent/keybindings.json           -> dotfiles/pi/keybindings.json
~/.pi/agent/APPEND_SYSTEM.md           -> dotfiles/pi/APPEND_SYSTEM.md
~/.pi/agent/agents                     -> dotfiles/pi/agents
~/.agents/skills                       -> dotfiles/pi/kit/skills
~/.pi/agent/bin/chat                   -> dotfiles/bin/chat
~/.pi/agent/bin/pi-try                 -> dotfiles/bin/pi-try
```

`agents/` is the agent types the engine reads at session start; see below.

`~/.agents/skills` is not pi's path. pi finds the skills through kit's manifest; the
link exists so the dormant harnesses' `.claude/skills/*` symlinks still resolve.
pi does discover `~/.agents/skills` on its own, and dedupes it against the
manifest by real path, so the skills load exactly once.

`settings.json` is a symlink into the repo and pi writes it in place, so a model
switch or a changelog bump shows up as a diff. That is the point: the settings
are versioned like everything else.

On macOS `install.sh` also builds `~/Applications/Pi Open.app` from
`macos/pi-open-handler.applescript` and registers it with LaunchServices. It is
the app that claims the `pi-open:` links the transcript puts on every path, and
all it does is run `bin/pi-open`, which opens the file in nvim. Build output, so
it is not tracked; `--doctor` checks it is there and still claims the scheme.

Never tracked, and `install.sh --doctor` checks it: `auth.json`, `trust.json`,
`sessions/`, `models-store.json`, `git/`, `npm/`.

## Agents

The Agent tool and its four siblings are the kit's own — `agent-engine`, in
`kit/extensions/agent-engine/`. Nothing vendored is left: the tools, the child prompts, the
registry, the cache TTLs and the dock's events all come from one place, and
every seat gets the identical tools array, because the array is the front of the
cached prefix and a per-seat one costs a child its parent's tools+system entry.

`agents/*.md` are the types the engine offers: `explore`, `worker`, `lead`,
`reviewer`, `design-review`. A type file sets a model, a thinking level, a tool
list, a prompt body and the one-line description that routes work to it. The
engine reads the `tools:` key, and `install.sh --doctor` parses every file
with the engine's own parser.

## Layout

```
pi/
├── AGENTS.md                   working doctrine every seat reads
├── APPEND_SYSTEM.md            the prose appended to pi's system prompt
├── settings.json               packages, models, trust
├── keybindings.json            shift+enter newline, ctrl+q follow-up
├── agents/                     the agent types: explore, worker, lead, reviewer, design-review
└── kit/                        the package — extensions, lib, skills, tests
```

See [kit/README.md](kit/README.md) for what is in it and
[kit/ARCHITECTURE.md](kit/ARCHITECTURE.md) for the rules its code keeps.

## Other harnesses

`~/.claude`, `~/.codex`, `dotfiles/codex`, `dotfiles/cursor` still exist and
still work if woken. Nothing here installs, updates, or reviews them. Their
skill symlinks resolve through `~/.agents/skills`, which `--doctor` keeps
unbroken.
