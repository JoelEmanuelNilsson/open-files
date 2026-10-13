# `agent-rows` — subagents in the same receipts as everything else

```
● 3 background agents launched (↓ to manage)
  ├─ Explore  where the parser lives
  ├─ Agent    write the missing tests
  └─ Agent    audit the error paths

● Agent(where the parser lives)
  ⎿  Done · 45 tools · 12.3k out · $0.42 · 11m 21s

● Result(where the parser lives)
  ⎿  The parser is in src/lex/parse.ts
     It is called from two places.
     Both of them are in the CLI.
     … +18 lines (ctrl+o to expand)
```

An agent's answer is output with no honest count, so it is shown the way the
transcript shows every other one: three lines and a count of the rest, out of
the same `outputPreview`. A row showing a preview has no body under it, which
is what used to print its first line twice the moment `ctrl+o` opened it.

Two surfaces in two grammars without this. A tool pi has no renderer for draws
as `▸ Agent  desc` inside pi's padded box — three blank lines a row — and a
custom message with no renderer draws four more in a shape no other row uses. A
turn that launched five agents and collected two of them spent about forty lines
saying so.

**Nothing here changes what the model sees.** The engine keeps the tool —
execute, parameter schema, description, prompt guidelines — and keeps the
`<task-notification>` text of the completion message. That is not restraint, it
is the design: the only other way to own a row is to register the tool, pi
resolves **one definition per name and the first registration wins, whole**, and
taking `Agent` that way would mean re-implementing a tool whose behaviour lives
in `lib/agents/agent-runtime.ts`, for two lines of paint.

So the rows are supplied by a renderer resolver instead. `pi.registerToolRenderer`
takes `(toolName, next) => renderers`; `index.ts` returns the receipt renderers for
the engine's five tool names and `next()` for every other name, so the tools stay
the engine's.

`registerMessageRenderer` is first-wins, and the kit registers the only
renderer for `subagent-notification` — the message comes from the kit's own
engine, so there is no second candidate and no load order to lose.

**Several launches in one message are one line.** A run of consecutive `Agent`
calls inside one assistant message is a batch; the first row draws the line and
the tree, and the rest draw nothing, which is the transcript's own mechanism and
its own rules — `ctrl+o` and a click on the line open it. A batch **dissolves**
the moment a member turns out not to be a background launch: a blocking call
returns the agent's whole answer and a failure is the record of what went wrong,
and neither is a name in a list.

`PI_AGENT_ROWS=off` gives every one of these rows back to pi's own drawing, and
`PI_TRANSCRIPT=off` does too — they are the transcript's components, so they
follow the transcript's switch.
