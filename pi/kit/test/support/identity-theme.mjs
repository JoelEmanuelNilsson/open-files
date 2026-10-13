/** A pi theme that paints nothing: every call hands its text back, so rendered rows compare as plain strings. */
export const identityTheme = {
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
	dim: (t) => t,
	inverse: (t) => t,
	strikethrough: (t) => t,
};
