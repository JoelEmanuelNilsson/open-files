/** PROTOTYPE — throwaway. Terminal themes. The theme is a variable here, not a given. */

import { hex } from "./color.ts";
import type { Palette } from "./types.ts";

export interface Theme {
	id: string;
	name: string;
	palette: Palette;
	/** Painted behind the whole page, so the box is judged against a real desktop. */
	backdrop: string;
}

const make = (bg: string, base: string, hot: string, peak: string, label: string, dim: string): Palette => ({
	bg: hex(bg),
	base: hex(base),
	hot: hex(hot),
	peak: hex(peak),
	label: hex(label),
	dim: hex(dim),
});

export const THEMES: Theme[] = [
	{
		id: "pi-dark",
		name: "pi dark (current)",
		palette: make("#0f1720", "#3d4d63", "#4c7fd4", "#cfe0ff", "#5b8dd9", "#8a9bb3"),
		backdrop: "linear-gradient(140deg,#0b1119,#131d29 45%,#0d151d)",
	},
	{
		id: "midnight",
		name: "midnight ink",
		palette: make("#070b12", "#26344a", "#3b82f6", "#e0edff", "#6b9fe8", "#7b8aa1"),
		backdrop: "radial-gradient(120% 120% at 30% 0%,#101a2b,#05080e 70%)",
	},
	{
		id: "graphite",
		name: "graphite mono",
		palette: make("#101010", "#3a3a3a", "#9a9a9a", "#ffffff", "#c8c8c8", "#6e6e6e"),
		backdrop: "linear-gradient(160deg,#0a0a0a,#161616)",
	},
	{
		id: "paper",
		name: "paper (light)",
		palette: make("#f4f1ea", "#c9c2b4", "#3f6bb5", "#0d2748", "#4a5568", "#9aa2ae"),
		backdrop: "linear-gradient(160deg,#efece4,#e2ded3)",
	},
	{
		id: "amber",
		name: "amber CRT",
		palette: make("#0d0a04", "#4a3410", "#ffae3b", "#fff2d0", "#e0a03a", "#8a6a30"),
		backdrop: "radial-gradient(120% 120% at 50% 20%,#1a1204,#060402 70%)",
	},
	{
		id: "moss",
		name: "moss",
		palette: make("#0a1210", "#2a4038", "#5fd6a0", "#ddfff0", "#7fbfa4", "#6b8078"),
		backdrop: "linear-gradient(150deg,#08120f,#122019)",
	},
	{
		id: "vapor",
		name: "vapor",
		palette: make("#120a1c", "#3b2a52", "#ff6bd6", "#fff0ff", "#a97fe8", "#7a6a95"),
		backdrop: "linear-gradient(160deg,#170d24,#2a1240 60%,#0e0817)",
	},
];

export const DEFAULT_THEME = THEMES[0] as Theme;
