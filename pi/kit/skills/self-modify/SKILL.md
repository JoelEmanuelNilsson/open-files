---
name: self-modify
description: "pi docs and harness layout — read before modifying pi itself, its extensions, skills, themes, TUI, or this harness"
---

# Self-modify

You are running inside a customized pi harness. pi is the vendor coding
agent; everything you experience on top of it — the system prompt on the
wire, the extensions, the skills, the cache policy — is owned configuration
living in `~/dotfiles`. Read this before changing any of it.

## How this harness is assembled

- **Owned kit**: `~/dotfiles/pi/kit` — a local pi package (extensions,
  skills, themes) loaded via `~/dotfiles/pi/settings.json` (symlinked to
  `~/.pi/agent/settings.json`). Tests: `cd ~/dotfiles/pi/kit && npm test`.
- **System prompt**: pi builds its vanilla prompt, and the kit's
  `extensions/wire.ts` replaces the whole `system` array per request in
  `before_provider_request`, rebuilt from pi's structured
  `systemPromptOptions` by `lib/owned-prompt.ts`. Replace, never strip.
  There is deliberately no `~/.pi/agent/SYSTEM.md`: with the extension off,
  pi degrades to its current vanilla prompt instead of a stale capture.
  Always-on owned prose lives in `~/dotfiles/pi/APPEND_SYSTEM.md`.
- **Claude Code wire invariant**: every Anthropic OAuth request opens its
  system array with the `x-anthropic-billing-header:` block, then the Claude
  Code identity line, and carries the client headers — all produced by
  `lib/claude-code.ts`, pinned by tests against the installed `claude` binary.
  Never remove them, never add a second rewriter of `system` or of the
  headers, and never send experimental requests without them.
- **Wire ground truth**: `/prompt` dumps the whole context window last sent
  to the provider, verbatim — system blocks, full tool JSON, and messages.
  Use it before and after any prompt work.
- **Vendor pins**: `pi-web-search` in `~/.pi/agent/npm/package.json`,
  exact-pinned. Everything else is owned — including the agent engine
  (`extensions/agent-engine.ts`) and workflows (`extensions/workflow.ts`).
- **Symlinks**: `~/dotfiles/install.sh` links dotfiles into `~/.pi/agent`
  and validates them; new owned files get a `link` line plus a check entry.

## pi's own documentation

Resolve pi's package root at read time — never bake the path:

```bash
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
```

- Main documentation: `$PI_ROOT/README.md`
- Additional docs: `$PI_ROOT/docs` — extensions (`extensions.md`), themes
  (`themes.md`), skills (`skills.md`), prompt templates
  (`prompt-templates.md`), TUI (`tui.md`), keybindings (`keybindings.md`),
  SDK (`sdk.md`), custom providers (`custom-provider.md`), models
  (`models.md`), packages (`packages.md`), environment variables
  (`environment-variables.md`)
- Examples: `$PI_ROOT/examples` (extensions, custom tools, SDK)

Read pi `.md` files completely and follow their cross-references before
implementing. When comparing against what pi would generate on its own,
build it from the installed package:

```bash
node -e 'import(`${process.argv[1]}/dist/index.js`).then(m => console.log(m.buildSystemPrompt({ cwd: process.cwd() })))' "$PI_ROOT"
```

## Rules of change

- Every change to the wire payload is verified with `/prompt` and covered
  by the kit tests, which pin the owned builder against the installed pi
  package (they fail when pi's prompt skeleton or options schema drifts).
- Token efficiency and cache stability trump features: nothing enters every
  request without earning its place, and nothing rewrites a cached prefix
  mid-session.
- Placement rule: already in a tool schema → nowhere; always-on owned text
  → `APPEND_SYSTEM.md` (or `AGENTS.md`); conditional reference → a skill.
