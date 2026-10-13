import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";

const jiti = kitJiti();

// ---------------------------------------------------------------------------
// The wiring: the extension takes over exactly the tools it claims.
// ---------------------------------------------------------------------------

const pi = fakeExtensionApi();
const registered = pi.tools;
const load = async (path) => (await jiti.import(`${KIT_ROOT}/extensions/${path}`, { default: true }))(pi.api);
await load("transcript/index.ts");

eq("re-registers only write, for its overwrite diff", [...registered.keys()], ["write"]);

const resolver = pi.toolRenderers[0];
eq("one renderer resolver is registered", typeof resolver, "function");
for (const name of ["read", "write"]) {
	eq(`${name} gets the receipt`, resolver(name, () => undefined)?.renderShell, "self");
}
eq("other tools fall through to next()", resolver("Agent", () => "next"), "next");
// bash is the kit's own tool: extensions/bash/index.ts registers it and wears this
// extension's receipt, so one registrar holds execution and rendering both.
await load("bash/index.ts");
eq("bash arrives from its own extension wearing the same receipt", registered.get("bash")?.renderShell, "self");
eq("never registers powershell", registered.has("powershell"), false);
eq("leaves edit to multi-edit", registered.has("edit"), false);
eq("keeps the built-in schema", typeof registered.get("write").parameters, "object");
eq("subscribes to session_shutdown", pi.handlers.has("session_shutdown"), true);
// Message boundaries are watched again, but for a fact rather than a guess: how
// many calls a message has streamed so far, so the rows behind the one being
// waited on never draw. The deleted merging watched them to predict whether more
// calls were coming, which is the thing that could be wrong.
eq("watches a message for the calls it has streamed", pi.handlers.has("message_update"), true);

await load("multi-edit/index.ts");
eq("edit joins the same system", registered.get("edit").renderShell, "self");

await finish();
