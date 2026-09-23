/** PROTOTYPE — throwaway. Contract every effect variant is written against. */

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** What a cell is, so an effect can treat the outline and its labels differently. */
export type CellKind = "corner" | "rule" | "side" | "label" | "interior" | "cursor";

export interface Cell {
	/** Grid column / row, 0-based. */
	x: number;
	y: number;
	glyph: string;
	kind: CellKind;
	/** Position along the outline, 0..1 clockwise from the top-left corner. -1 for interior cells. */
	ring: number;
	/** Same position in whole cells. -1 for interior cells. */
	ringIndex: number;
	/** The colour the chrome painted it, before any effect. */
	color: Rgb;
}

export interface Box {
	cols: number;
	rows: number;
	cells: Cell[];
	/** Number of cells in the outline path. */
	ringLength: number;
}

/** Canvas geometry, in CSS pixels. The box sits inside `bleed` on every side. */
export interface Metrics {
	cw: number;
	ch: number;
	/** Stroke width of the box outline, in CSS px. */
	lw: number;
	bleed: number;
	width: number;
	height: number;
	/** Text baseline offset inside a cell. */
	baseline: number;
	font: string;
}

export interface Palette {
	bg: Rgb;
	/** Resting outline. */
	base: Rgb;
	/** Mid-intensity outline, the theme's accent. */
	hot: Rgb;
	/** Crest — the hottest core. */
	peak: Rgb;
	/** Label text. */
	label: Rgb;
	/** Dimmed label text. */
	dim: Rgb;
}

export interface Frame {
	/** Seconds since the page loaded, already scaled by the speed control. */
	t: number;
	/** Seconds since the previous frame, already scaled. */
	dt: number;
	/** Seconds since the working state began; 0 while idle. */
	since: number;
	working: boolean;
	/** Seconds since work finished, or null if it never has. Lets an effect play an outro. */
	settled: number | null;
	box: Box;
	metrics: Metrics;
	palette: Palette;
	/** 0..1 master intensity from the control strip. */
	intensity: number;
	/** Per-effect parameter values, keyed by ParamSpec.key. */
	params: Record<string, number>;
}

/** How one cell is drawn this frame. Every field is optional; omitted means "as the chrome had it". */
export interface CellStyle {
	color?: Rgb;
	glyph?: string;
	/** Pixel offset from the cell's grid position. */
	dx?: number;
	dy?: number;
	alpha?: number;
	/** Canvas shadowBlur in px, using `color` as the shadow colour. */
	glow?: number;
	/** Scale about the cell centre. */
	scale?: number;
	/** Painted behind the glyph, filling the cell. */
	bg?: Rgb;
}

export interface EffectInstance {
	/** Advance internal state once per frame, before any cell is asked about. */
	update?(f: Frame): void;
	/** Restyle one cell. Return null to leave it alone. */
	cell?(cell: Cell, f: Frame): CellStyle | null;
	/** Free-form canvas painting behind the glyphs. */
	drawUnder?(g: CanvasRenderingContext2D, f: Frame): void;
	/** Free-form canvas painting in front of the glyphs. */
	drawOver?(g: CanvasRenderingContext2D, f: Frame): void;
}

export interface ParamSpec {
	key: string;
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
}

export interface Effect {
	id: string;
	name: string;
	/** Rough family, for grouping the contact sheet. */
	group: string;
	/** One line: what the effect is doing, physically. */
	blurb: string;
	/** The effect's natural colours, overriding the theme unless the pi ramp is forced. */
	palette?: Partial<Palette>;
	params?: ParamSpec[];
	create(): EffectInstance;
}
