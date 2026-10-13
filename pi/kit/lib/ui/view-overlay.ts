import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** A view the overlay drives: rendered per width, invalidated on theme change, handed raw input. */
export interface OverlayView {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

/** Full width and height, for the `/context` and `/skills` dialogs. */
export const FULLSCREEN_OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
} as const;

/** Opens a view with pi's `options`; resolves with the value the view passes to `done`. */
export function showViewOverlay<T>(
	ctx: ExtensionContext,
	createView: (tui: TUI, theme: Theme, done: (result: T) => void) => OverlayView,
	options: typeof FULLSCREEN_OVERLAY_OPTIONS | { readonly overlay: false },
	onRefresh?: (refresh: () => void) => void,
): Promise<T> {
	return ctx.ui.custom<T>((tui, theme, _keybindings, done) => {
		const view = createView(tui, theme, done);
		onRefresh?.(() => {
			view.invalidate();
			tui.requestRender();
		});
		return {
			render: (width: number) => view.render(width),
			invalidate: () => view.invalidate(),
			handleInput: (data: string) => {
				view.handleInput(data);
				tui.requestRender();
			},
		};
	}, options);
}
