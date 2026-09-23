/**
 * Click a tool row to open it.
 *
 * This is the thing the handoff said could not be done, and it turns out it can
 * — in fullscreen mode only, and by wrapping one method.
 *
 * The chain: `TuiAltScreen` is exported from `@earendil-works/pi-tui`, it
 * already parses SGR mouse events for selection and scrolling, and it keeps the
 * frame it last laid out on `currentLayout`. A layout box knows its component,
 * its rect and its clip. That is hit testing, sitting there unused by anything
 * except the scrollbar.
 *
 * What the layout does *not* have is a box per message: `Container` has no
 * layout node, so the whole transcript is one leaf box full of lines. So the
 * click is resolved in two hops instead of one. The scroll box gives the
 * document line — its content child's `rect.y` is already translated by the
 * scroll offset, so `y - contentBox.rect.y` is the line under the pointer. Then
 * the document container's children are measured in order until that line falls
 * inside one, which is the row that was clicked.
 *
 * Measuring means rendering, and rendering is cached by every component in the
 * transcript, so a click costs a walk and no layout. Nothing here runs on a
 * frame; it runs on a press and on a release.
 *
 * In regular mode none of this exists: pi never turns mouse reporting on, the
 * terminal owns the pointer, and rows that have scrolled into the terminal's
 * own scrollback are not pi's to repaint. That is not a gap to be plugged, it
 * is what regular mode *is*. `PI_TRANSCRIPT_CLICK=off` turns this off.
 */

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type Component, TuiAltScreen } from "@earendil-works/pi-tui";

/** The parts of pi's `LayoutFrame` this needs. Restated, not deep-imported. */
interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface Box {
	component: Component;
	rect: Rect;
	clip: Rect;
	children: Box[];
	scrollView?: unknown;
}
interface Frame {
	root: Box;
}

/** The alt screen, as much of it as a click needs. */
interface Screen {
	currentLayout?: Frame;
	pressedUrl?: string;
	selectionDragged?: boolean;
	requestRender: () => void;
}

interface Press {
	row: ToolExecutionComponent;
	/** A press that landed on a hyperlink belongs to the link, not to the row. */
	onLink: boolean;
	at: number;
}

const presses = new WeakMap<object, Press | undefined>();

/** Two clicks in the same place inside this are a double-click, and pi owns those. */
const DOUBLE_CLICK_MS = 400;

function contains(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** The innermost scrolling box under the pointer, which is the transcript. */
function scrollBoxAt(box: Box, x: number, y: number): Box | undefined {
	if (!contains(box.clip, x, y)) return undefined;
	for (const child of box.children) {
		const inner = scrollBoxAt(child, x, y);
		if (inner) return inner;
	}
	return box.scrollView ? box : undefined;
}

/**
 * The tool row that drew a given line of a container's render.
 *
 * `Container.render` concatenates its children in order, so the offsets are a
 * running sum of their heights, and every component in a transcript row caches
 * its lines by width. A click walks; it does not lay anything out.
 *
 * It has to walk more than one level: pi's document holds a header, a resources
 * container and a chat container, and the tool rows are inside the last of
 * those. The descent stops at the first container whose children do not add up
 * to its own height — a `Box` with padding, a component that draws a frame —
 * because from there on the line numbers no longer line up, and a click that
 * guesses is worse than a click that does nothing.
 */
function rowAtLine(component: Component, width: number, line: number): ToolExecutionComponent | undefined {
	if (component instanceof ToolExecutionComponent) return component;
	const children = (component as { children?: Component[] }).children;
	if (!Array.isArray(children) || children.length === 0) return undefined;
	const heights = children.map((child) => child.render(width).length);
	const total = heights.reduce((sum, height) => sum + height, 0);
	if (total !== component.render(width).length) return undefined;
	let top = 0;
	for (let index = 0; index < children.length; index++) {
		const height = heights[index] ?? 0;
		const child = children[index];
		if (child && line < top + height) return rowAtLine(child, width, line - top);
		top += height;
	}
	return undefined;
}

/** The tool row under the pointer, if the pointer is over one at all. */
export function rowAt(frame: Frame | undefined, x: number, y: number): ToolExecutionComponent | undefined {
	if (!frame) return undefined;
	const scroll = scrollBoxAt(frame.root, x, y);
	const content = scroll?.children[0];
	if (!content) return undefined;
	// The content box was translated by the scroll offset when the frame was
	// laid out, so this is the document line, not the screen line.
	return rowAtLine(content.component, content.rect.width, y - content.rect.y);
}

const SGR = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * A press remembers the row; a release on the same row opens it.
 *
 * Not the press, because a press that turns into a drag is a selection, and a
 * selection that expanded a row underneath it would be a fight over what the
 * mouse is for. pi's own handler runs first either way: this only ever adds a
 * toggle to a click it decided was not a selection and not a link.
 */
export function handleMouse(screen: Screen, data: string, now: number = Date.now()): void {
	const match = SGR.exec(data);
	if (!match) return;
	const button = Number.parseInt(match[1] ?? "", 10);
	const x = Number.parseInt(match[2] ?? "", 10) - 1;
	const y = Number.parseInt(match[3] ?? "", 10) - 1;
	const release = match[4] === "m";
	// A plain left button and nothing else. The same field carries the wheel
	// (64), the motion bit (32), the other buttons and every modifier, and all of
	// those already mean something to pi — scroll, drag, paste, extend selection.
	if (button !== 0) return;

	if (!release) {
		const row = rowAt(screen.currentLayout, x, y);
		const previous = presses.get(screen);
		// The second press of a double-click: pi is selecting a word, and a row
		// that expanded and collapsed under that would just flicker.
		const doubled = previous && previous.row === row && now - previous.at < DOUBLE_CLICK_MS;
		presses.set(screen, row && !doubled ? { row, onLink: screen.pressedUrl !== undefined, at: now } : undefined);
		return;
	}

	const press = presses.get(screen);
	presses.set(screen, press ? { ...press, at: now } : undefined);
	if (!press || press.onLink || screen.selectionDragged) return;
	if (rowAt(screen.currentLayout, x, y) !== press.row) return;
	toggle(press.row);
	screen.requestRender();
}

/**
 * `expanded` is private to `ToolExecutionComponent` in TypeScript and a plain
 * property at runtime. It is read rather than tracked here so that `ctrl+o`,
 * which sets the same field on every row, and a click, which sets it on one,
 * cannot disagree about what a row is doing.
 */
function toggle(row: ToolExecutionComponent): void {
	const current = (row as unknown as { expanded?: boolean }).expanded === true;
	row.setExpanded(!current);
}

type Handler = (this: Screen, data: string) => unknown;

/** The wrapper carries the method it replaced, so a reload can put it back. */
const WRAPPED = Symbol.for("transcript.viewport-input");
type Wrapper = Handler & { [WRAPPED]?: Handler };

// `handleViewportInput` is private to `TuiAltScreen` in TypeScript and an
// ordinary prototype method at runtime, which is the same seam the thinking
// rail uses on `AssistantMessageComponent.render`.
function prototypeOf(): { handleViewportInput: Wrapper } {
	return TuiAltScreen.prototype as unknown as { handleViewportInput: Wrapper };
}

/**
 * The one wrapper. pi's handler runs first and keeps its answer, so selection,
 * scrolling, links and search behave exactly as they did; the click is read a
 * second time afterwards, for a meaning pi has no opinion about.
 *
 * Reading stops when the returned handle is called. The prototype is
 * process-wide and every session in the process shares this module, subagents
 * included, so the handle is what says whose wrapper it is.
 */
export function enableRowClicks(): () => void {
	// A reload re-imports this module, so drop the previous wrapper before
	// installing one that would otherwise nest inside it.
	dropClicks();

	const prototype = prototypeOf();
	const original = prototype.handleViewportInput as Handler;
	const wrapper: Wrapper = function (this: Screen, data: string) {
		const result = original.call(this, data);
		try {
			handleMouse(this, data);
		} catch {
			// A click that cannot be resolved is a click that does nothing. It is
			// not a reason to break the input loop for the rest of the session.
		}
		return result;
	};
	wrapper[WRAPPED] = original;
	prototype.handleViewportInput = wrapper;

	return () => {
		// Only ever restore over this wrapper: anything installed after it belongs
		// to whoever installed it, and its callers still expect it to be there.
		if (prototypeOf().handleViewportInput === wrapper) prototype.handleViewportInput = original;
	};
}

/**
 * Takes down a wrapper left behind by an earlier copy of this module, which a
 * reload has no handle to. The symbol is global, so it is found across copies.
 */
function dropClicks(): void {
	const prototype = prototypeOf();
	const original = prototype.handleViewportInput?.[WRAPPED];
	if (original) prototype.handleViewportInput = original;
}
