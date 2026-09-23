/**
 * Draw another extension's tool rows without taking its tool.
 *
 * pi resolves one tool definition per name and **the first registration wins,
 * whole** (`dist/core/extensions/runner.js`, `getAllRegisteredTools`). So an
 * extension that wants a second extension's *row* has to register that tool
 * name itself — and then it owns the execute, the schema, the description and
 * the prompt guidelines as well — which means re-implementing a tool whose
 * behaviour lives somewhere else entirely, in order to change two lines of
 * paint. That trade is not worth making, and it is not necessary.
 *
 * `ToolExecutionComponent` — pi's own row, exported from the package root —
 * asks for its render slots by method on every frame:
 * `getCallRenderer()`, `getResultRenderer()`, `getRenderShell()`, and
 * `hasRendererDefinition()` for whether it has any at all. A claim keyed by tool
 * name, consulted inside those four, outranks whatever definition pi resolved
 * and changes **nothing else about the tool**. Execution, schema and wire text
 * stay the registrar's by construction rather than by copying, so a vendor
 * release cannot make them drift.
 *
 * Same seam and same style as `extensions/transcript/click.ts`, which wraps
 * `TuiAltScreen.handleViewportInput`: one method family, patched once, keyed on
 * a registry the kit owns.
 *
 * Two rules make the patch safe to leave installed:
 *
 * - **The claims are process-scoped, the patch is not undone.** pi loads every
 *   extension file with its own jiti and `moduleCache: false`, so module scope
 *   is per file; the registry therefore lives on `globalThis` under
 *   `Symbol.for("pi.kit.tool-rows")` and every file that imports this joins the
 *   same one. Releasing a claim empties its names out of the map, which makes
 *   the patch a pass-through again. It is never uninstalled, because a second
 *   claimant's release would otherwise restore methods the first still needs.
 * - **A claim is checked against pi's shape when it is made, not when a frame
 *   is drawn.** {@link claimToolRows} throws
 *   `claimToolRows: pi's ToolExecutionComponent has no <method>` if any of the
 *   four methods has gone, so a pi release that renames one fails a test rather
 *   than silently reverting every claimed row to the vendor's rendering.
 */

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { shared } from "./shared.ts";

/**
 * The three render fields of a tool definition, claimable by tool name.
 *
 * Same meaning as on `ToolDefinition`: `renderShell: "self"` makes the row draw
 * its own framing, which is what every receipt in this kit wants.
 */
export interface ToolRowSlots {
	renderShell?: "self" | "default";
	renderCall?: unknown;
	renderResult?: unknown;
}

interface ToolRowRegistry {
	claims: Map<string, ToolRowSlots>;
	patched: boolean;
}

const REGISTRY_KEY = Symbol.for("pi.kit.tool-rows");

const registry = (): ToolRowRegistry => shared(REGISTRY_KEY, () => ({ claims: new Map(), patched: false }));

/** The claimed slots for the row being drawn, or undefined when nobody claimed its tool. */
function claimFor(row: unknown): ToolRowSlots | undefined {
	const name = (row as { toolName?: unknown }).toolName;
	if (typeof name !== "string") return undefined;
	return registry().claims.get(name);
}

/** The four methods a claim has to reach. Named here so the test can pin the list. */
export const PATCHED_METHODS = ["getCallRenderer", "getResultRenderer", "getRenderShell", "hasRendererDefinition"] as const;

type Patchable = Record<string, (this: unknown, ...args: unknown[]) => unknown>;

function installPatch(): void {
	const state = registry();
	if (state.patched) return;
	const proto = ToolExecutionComponent.prototype as unknown as Patchable;
	for (const method of PATCHED_METHODS) {
		if (typeof proto[method] !== "function") {
			throw new Error(`claimToolRows: pi's ToolExecutionComponent has no ${method}`);
		}
	}

	const originalCall = proto.getCallRenderer;
	const originalResult = proto.getResultRenderer;
	const originalShell = proto.getRenderShell;
	const originalHas = proto.hasRendererDefinition;

	proto.getCallRenderer = function (this: unknown, ...rest: unknown[]) {
		return claimFor(this)?.renderCall ?? originalCall.apply(this, rest);
	};
	proto.getResultRenderer = function (this: unknown, ...rest: unknown[]) {
		return claimFor(this)?.renderResult ?? originalResult.apply(this, rest);
	};
	proto.getRenderShell = function (this: unknown, ...rest: unknown[]) {
		return claimFor(this)?.renderShell ?? originalShell.apply(this, rest);
	};
	proto.hasRendererDefinition = function (this: unknown, ...rest: unknown[]) {
		return claimFor(this) !== undefined || originalHas.apply(this, rest) === true;
	};
	state.patched = true;
}

/**
 * Claim the rows of the named tools for this kit's renderers.
 *
 * Returns a release that drops exactly the names it claimed, so a session
 * shutdown gives the rows back to whoever registered the tools. Claiming a name
 * a second time replaces the first claim: last claimant wins, which is the only
 * answer that lets `/reload` re-run an extension factory without stacking.
 *
 * Throws if pi's row component no longer has the methods the patch needs. The
 * caller decides whether that is fatal; an extension should warn and carry on
 * with the vendor's rows rather than fail to load.
 */
export function claimToolRows(slots: Record<string, ToolRowSlots>): () => void {
	installPatch();
	const state = registry();
	const names = Object.keys(slots);
	for (const name of names) {
		const claim = slots[name];
		if (claim) state.claims.set(name, claim);
	}
	return () => {
		for (const name of names) {
			if (state.claims.get(name) === slots[name]) state.claims.delete(name);
		}
	};
}

/** The tool names currently claimed. For tests and for `/context`-style introspection. */
export function claimedToolNames(): string[] {
	return [...registry().claims.keys()].sort();
}
