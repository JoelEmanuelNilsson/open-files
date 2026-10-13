# Provenance

Everything here is ours to change. Some of it started as someone else's work.

## `extensions/notify.ts`, `extensions/side-chat/`, `extensions/multi-edit/`

Rewritten from ideas in [`mitsupi`](https://www.npmjs.com/package/mitsupi) v1.6.0,
Apache-2.0, Copyright (c) Mario Zechner. `notify.ts`,
`multi-edit/` and `side-chat/` (the `/btw` command) are reimplementations
against the current pi API.

## `extensions/context-view/`

Started as [`pi-context-view`](https://github.com/dimk90/pi-context-view)
(npm `pi-context-view`), MIT, by dimk90: the `/context usage` map and the
`/context injections` view. Split and rewritten here since.

## `skills/commit/`

Adapted from [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/commit/SKILL.md),
Copyright (c) Armin Ronacher.


## `skills/principles/`, `skills/playbooks/`, `skills/swarm/`, `skills/figure-it-out/`, `skills/show-me-your-work/` (with `scripts/log.sh`), `skills/how/`, `skills/recall/`, `skills/benchmark-checklist/`, `skills/architect/`, `skills/no-comments/`, `skills/reflect/`, `skills/correct/`, `skills/bro/`, `skills/create-verification-skill/`, `skills/maintain-verification-skill/`, `skills/ketchup/`, `bin/worktree-audit.sh`; parts of `skills/codebase-design/` (`RED-FLAGS.md`, the arena in `DESIGN-IT-TWICE.md`), `skills/code-review/` (the Risk axis) and `skills/tdd/`

Adapted from PStack, the [`pstack`](https://github.com/cursor/plugins) plugin
v0.15.6 (commit 23e4138daa01c42d4969f7a5465f82704e64f798, with later text from commit 4bf3e08: the performance mantras, four red flags, the `ketchup` skill and the worktree audit script), MIT, by Lauren Tan.
Rewritten for pi; the licence follows.

```
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## `skills/codebase-design/`, `skills/tdd/`, `skills/diagnosing-bugs/`, `skills/domain-modeling/`, `skills/grilling/`, `skills/wayfinder/`, `skills/to-tickets/`, `skills/code-review/`, `skills/reflect/` (the retro parts), `skills/setup-issue-tracker/`, `skills/writing-for-agents/`

Started as [Matt Pocock's skills](https://github.com/mattpocock/skills)
(commit d81f3a183412e71a5b1e84ca21bc1a35eea03a60), MIT, Copyright (c) 2026
Matt Pocock. Changed here since; the licence follows.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## `skills/coding-standards/`, `skills/herdr/`, `skills/show-me/`, `skills/write-discoverable-code/`; changes merged into `skills/diagnosing-bugs/`

From [`dmmulroy/.dotfiles`](https://github.com/dmmulroy/.dotfiles)
(commit 574e1f2a95c6f40de09691c4dd742a64df1af30c), by Dillon Mulroy. The
repository carries no licence file at that commit.
