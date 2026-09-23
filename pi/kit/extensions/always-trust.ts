import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Trusts every project on this machine, replacing the `/trust` command that
 * quiet-commands.ts hides from autocomplete.
 *
 * `project_trust` is the documented hook for owning the decision: the first
 * user/global extension to answer "yes" or "no" wins, and it suppresses the
 * built-in prompt in every mode, including `-p`, `--mode json`, and RPC.
 *
 * The decision is deliberately not remembered — nothing accumulates in
 * ~/.pi/agent/trust.json, and a saved "no" from an older session can no longer
 * override this.
 *
 * Consequence, by choice: any repository entered on this machine may load its
 * project-local `.pi/settings.json`, `.pi/extensions`, packages, and skills
 * without asking. Run untrusted repositories under `pi --no-approve`, or in a
 * container, as described in the pi security docs.
 */
export default function alwaysTrust(pi: ExtensionAPI): void {
	pi.on("project_trust", async () => ({ trusted: "yes" }));
}
