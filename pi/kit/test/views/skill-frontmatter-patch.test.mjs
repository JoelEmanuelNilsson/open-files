/**
 * Can I hide a skill from the model without breaking its file?
 *
 * `skill-frontmatter-patch.ts` is a string in and a string out: the whole risk
 * of `/skills` is that a one-line frontmatter edit damages a file that is
 * mostly hand-written prose, so every case here is a file shape that a naive
 * line edit gets wrong — block scalars, CRLF, duplicate keys, a `---` rule
 * inside the body.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const { setMuted, isPatchable } = await jiti.import(`${KIT_ROOT}/extensions/skills/skill-frontmatter-patch.ts`);

// --- patch: the ordinary cases ---------------------------------------------

const PLAIN = "---\nname: commit\ndescription: Make a commit\n---\n\nBody text.\n";

eq("mute adds the key last in the block",
	setMuted(PLAIN, true),
	"---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\n\nBody text.\n");

eq("unmute on an already-unmuted file is a no-op",
	setMuted(PLAIN, false),
	undefined);

const MUTED = "---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\n\nBody.\n";

eq("unmute removes the key and leaves the rest",
	setMuted(MUTED, false),
	"---\nname: commit\ndescription: Make a commit\n---\n\nBody.\n");

eq("mute on an already-muted file is a no-op",
	setMuted(MUTED, true),
	undefined);

eq("a round trip returns the original bytes",
	setMuted(setMuted(PLAIN, true), false),
	PLAIN);

// --- patch: the shapes a naive line edit gets wrong -------------------------

eq("a `---` rule in the body is not mistaken for the fence",
	setMuted("---\nname: a\n---\n\ntext\n\n---\n\nmore\n", true),
	"---\nname: a\ndisable-model-invocation: true\n---\n\ntext\n\n---\n\nmore\n");

eq("a block-scalar description survives, key lands at column zero after it",
	setMuted("---\nname: a\ndescription: >\n  one line\n  and another\n---\nbody\n", true),
	"---\nname: a\ndescription: >\n  one line\n  and another\ndisable-model-invocation: true\n---\nbody\n");

eq("an indented lookalike key is left alone",
	setMuted("---\nname: a\nmeta:\n  disable-model-invocation: true\n---\nbody\n", true),
	"---\nname: a\nmeta:\n  disable-model-invocation: true\ndisable-model-invocation: true\n---\nbody\n");

eq("duplicate keys all go, not just the first",
	setMuted("---\nname: a\ndisable-model-invocation: true\nx: 1\ndisable-model-invocation: true\n---\nb\n", false),
	"---\nname: a\nx: 1\n---\nb\n");

eq("a duplicate collapses to one when muting",
	setMuted("---\nname: a\ndisable-model-invocation: true\ndisable-model-invocation: true\n---\nb\n", true),
	"---\nname: a\ndisable-model-invocation: true\n---\nb\n");

eq("spacing around the colon still counts as the key",
	setMuted("---\nname: a\ndisable-model-invocation : true\n---\nb\n", false),
	"---\nname: a\n---\nb\n");

eq("CRLF stays CRLF",
	setMuted("---\r\nname: a\r\n---\r\nbody\r\n", true),
	"---\r\nname: a\r\ndisable-model-invocation: true\r\n---\r\nbody\r\n");

// --- patch: files it must refuse -------------------------------------------

eq("no frontmatter is refused", setMuted("# Just a heading\n", true), undefined);
eq("an unclosed fence is refused", setMuted("---\nname: a\nbody\n", true), undefined);
eq("a fence that is not the first line is refused", setMuted("\n---\nname: a\n---\n", true), undefined);

eq("isPatchable agrees with setMuted on prose", isPatchable("# heading\n"), false);
eq("isPatchable agrees with setMuted on frontmatter", isPatchable(PLAIN), true);

await finish();
