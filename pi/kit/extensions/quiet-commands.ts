/**
 * quiet-commands — hides slash commands I never use from autocomplete.
 *
 * Built-in commands cannot be unregistered: they are dispatched by name before
 * extension commands ever run. But autocomplete is stackable, so filtering the
 * wrapped provider's suggestions keeps them out of sight. Typing the full
 * command still works, which is the point — this is noise reduction, not a lock.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HIDDEN = new Set(["trust", "changelog", "import"]);

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: current.triggerCharacters,
			applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
			shouldTriggerFileCompletion: (lines, line, col) =>
				current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
			async getSuggestions(lines, line, col, options) {
				const suggestions = await current.getSuggestions(lines, line, col, options);
				// Command suggestions are the ones whose prefix is the typed `/…`.
				if (!suggestions || !suggestions.prefix.startsWith("/")) return suggestions;
				const items = suggestions.items.filter((item) => !HIDDEN.has(item.value));
				return items.length > 0 ? { ...suggestions, items } : null;
			},
		}));
	});
}
