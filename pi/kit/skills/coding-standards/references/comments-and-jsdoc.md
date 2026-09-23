# Comments and JSDoc

Code is the truth, and models read it well. A comment earns its place only when it says something the code cannot.

## The three legal comments

**One line of JSDoc on an export**, at its original declaration. Agents search by name and read the first line, so discoverability rests on it. State the sharpest caller-visible fact the signature cannot show; re-exports rely on that one declaration.

```ts
/** Parse an email address at an external input boundary. */
export function parseEmailAddress(input: string): Result<EmailAddress, InvalidEmailAddress>;
```

**A why, one to two lines**, where the code cannot say it: the reason this exists or is shaped this way, including a trade-off a reader would otherwise re-litigate. Put it on the line it explains.

```ts
// A ping that has to be retried has already lost the race it exists to win;
// the caller owns retrying, and it knows about the window.
maxRetries: 0,
```

**A safety justification on a cast**, stating the invariant the compiler cannot express.

```ts
// SAFETY: this id was resolved from the same map one statement above.
const entry = targets.get(id) as PingTarget;
```

Everything else is deleted: narration of what the code does, section headers, essays, "Note:", a restatement of the ticket. When a comment exists to explain a vague name, sharpen the name.

## Enforced by lint

Three `anti-slop` rules (see `skills/install-anti-slop`), so two of the bans are checked rather than remembered:

- **`anti-slop/no-comment-essay`** — a comment block over three lines of prose. One delimited comment, or a run of `//` lines, is one block. Tunable with `maxLines`.
- **`anti-slop/no-narrating-comment`** — a comment opening `This function`, `Here we`, `Note that`, `First,` and the like. The list is the rule's `openers` option.
- **`anti-slop/require-safety-comment-for-type-assertion`** — a non-const cast with no `SAFETY:` justification near it.

Licence headers, lint directives, and `SAFETY:` justifications are exempt from the first two.

## Short code is a rule, not a lint

Smallest change that does the job; no helper for one caller. Function-length caps punish honest code, so this one is judged rather than measured.

## Vocabulary

Names, public documentation, UI copy, and rendered errors use durable vocabulary for their audience, including the ordinary domain phrase a reader would search for when it differs from the identifier's spelling. Ticket names, migration phases, and planning language stay in planning material.

## Completion check

Complete when every added or changed export carries one line of JSDoc at its original declaration; every other surviving comment is a why the code cannot say or a `SAFETY:` justification; no comment block runs over three lines of prose; no comment narrates the code, heads a section, or restates a ticket; and public vocabulary is durable and audience-appropriate.
