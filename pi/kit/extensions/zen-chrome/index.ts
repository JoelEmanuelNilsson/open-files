/**
 * zen-chrome — moves pi's footer into the frame around the prompt box.
 *
 *     ╭─ ~/code/pi ─────────────────────── claude-opus-5 ▱▱▱▱▱ ─╮
 *     │ what should we do about the flaky test?             │
 *     ╰─ main ──────────────────────────── 1m 12s ❄4m 31.4k ─╯
 *
 * The editor already draws a rule above and below itself, so those two rules
 * are relabelled in place and given rounded corners, and each content row is
 * flanked to close the box. The built-in footer is replaced by one that only
 * surfaces other extensions' `setStatus` text, so this costs no extra rows.
 *
 * Sending a message then keeps it in that box, under a `User` label, so the
 * transcript is a column of one shape instead of two (see user-message.ts).
 *
 * The frame is pi-zentui's minimalist statusline.
 *
 * This extension is also the sole writer of the shared turn clock (see
 * `lib/turn-clock.ts`). The elapsed time in the bottom rule, `notify`'s
 * duration, and the wave's phase are all read off it — one clock, one writer,
 * so no third consumer can invent a fourth definition of "a turn".
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { capDockFloor, fitDockRows, hideBlankRowsAbove } from "./dock.ts";
import {
	bottomRule,
	type BottomLabels,
	contextReading,
	formatCwd,
	insignia,
	isPlainRule,
	type Piece,
	rule,
	scrollIndicator,
	SIDE,
	TOP_ENDS,
} from "./chrome.ts";
import { AGENT_TASK_STATUS_KEY } from "../../lib/agent-task-count.ts";
import { agentRuntimeOf } from "../../lib/agent-runtime-seam.ts";
import { foldRows, isPromptFolded } from "./fold.ts";
import { type CacheWindow, cacheLabel, nextRedrawMs, readCacheWindow } from "../../lib/cache-window.ts";
import { isChatSeat } from "../../lib/seat.ts";
import { shared } from "../../lib/shared.ts";
import { isSideModeOn } from "../../lib/side-mode.ts";
import { inputsKey, predictWarmth, prefixInputsOf, reasoningChangeCost, type Warmth, warmPrefixDir } from "../../lib/warm-prefix.ts";
import {
	advanceTurnClock,
	elapsedMs,
	FLOOR_MS,
	formatDuration,
	ownsTurnClock,
	readTurn,
	readTurnClock,
} from "../../lib/turn-clock.ts";
import { FADE_MS, fg, FRAME_MS, SHIMMER_FRAME_MS } from "./animate.ts";
import { createAnimationClock, type ReleaseFrames } from "./animation-clock.ts";
import { arcColor, arcTrack, driftColor, FOLDED_BAR_LIGHT, inkOf, isNotFrame, LABEL_LIGHT, shadeBox, shadeLine, waveEnabled } from "./prism.ts";
import { greyOut, wakeAt } from "./wake.ts";
import { GLOW_NOTES, GLOWS, glowName, setGlowName } from "./choice.ts";
import { notice } from "../../lib/notice.ts";
import { type SlotColors, slotColors } from "../../lib/slot-colors.ts";
import { type EffortDrift, effortDrift, effortSlider, paintSlider, shortModelId, thinkingScale } from "./model-label.ts";
import { frameUserMessages } from "./user-message.ts";
import { warmthOf } from "./warmth.ts";

const WAVE = waveEnabled();

/**
 * How often the chrome asks the terminal what its colours are. One burst a
 * second is nothing on the wire, and it bounds how long the wave — or a diff
 * row — can go on painting a palette the terminal has since replaced.
 */
const SLOT_REFRESH_MS = 1000;

/** Columns taken by the left and right edges. */
const FRAME = 2;

/** Epoch ms the running turn started, or null when nothing is running. */
function runningSince(): number | null {
	return readTurnClock().startedAt;
}

/**
 * The turn that just settled, while its light is still fading: the epoch the
 * light was started from, so it keeps moving rather than freezing, and when it
 * was told to go.
 */
const fading = shared<{ light: { since: number; settledAt: number } | null }>("__piZenChromeFade", () => ({ light: null }));

/**
 * When this seat's chrome started waking, or null when it is awake. Shared for
 * the same reason `fading` is: the editor that reads it lives on a prototype
 * that outlives any one module instance.
 */
const waking = shared<{ since: number | null }>("__piZenChromeWake", () => ({ since: null }));

/**
 * Where the wake is now, or null once it is over — at which point the state is
 * dropped, so a later render pays nothing and the frame ticker stops.
 */
function boxWake(now: number): { since: number; grey: number; light: number } | null {
	const since = waking.since;
	if (since === null) return null;
	const stage = wakeAt(since, now);
	if (stage === null) {
		waking.since = null;
		return null;
	}
	return { since, ...stage };
}

/** The light to draw now: its time origin and how far it has faded, or null for none. */
function boxLight(now: number): { since: number; fade: number } | null {
	const since = runningSince();
	if (since !== null) return { since, fade: 0 };
	if (fading.light === null) return null;
	const fade = (now - fading.light.settledAt) / FADE_MS;
	if (fade >= 1) {
		fading.light = null;
		return null;
	}
	return { since: fading.light.since, fade };
}

/** Ends a run of truecolour, so a piece the theme did not paint cannot leak into the dashes. */
const RESET = "\x1b[0m";

/** How often the chrome re-asks whether the next request would read its prefix from cache. */
const WARMTH_TICK_MS = 1000;

/**
 * How the model label is lit: a band of light shimmering through it since an
 * epoch, held in the accent colour when the wave is switched off, or not at all.
 */
type Glow = { kind: "shimmer"; since: number } | { kind: "still" } | null;

/**
 * Whether this seat's first request would read its prefix back from cache, as
 * the chrome last worked it out (`evaluateWarmth`). Both fields go quiet once
 * the conversation has a message in it.
 *
 * `ledger` is the warm-prefix ledger's word, kept only before the seat's first
 * request: that is the one stretch where the bottom rule has no window of its
 * own to count down and can show the ledger's instead.
 */
interface WarmState {
	glow: Glow;
	ledger: Warmth | undefined;
	/**
	 * The mark for a level moved away from the one the cached conversation was
	 * written at, or null. Unlike the two fields above this one speaks all
	 * session: the question it answers is about the conversation tier, which only
	 * exists once there is a conversation.
	 */
	drift: EffortDrift | null;
}

/**
 * Reads live session state for the chrome.
 *
 * Every getter on `ctx` asserts the extension runner is still active, so reads
 * during teardown throw. Render must never throw, hence the blanket fallbacks.
 */
class ChromeState {
	constructor(
		private ctx: ExtensionContext,
		private footerData: () => ReadonlyFooterDataProvider | undefined,
		private warm: () => WarmState,
		private flashedAt: () => number | undefined,
		private taskGlow: (present: boolean) => number | null,
	) {}

	get theme(): Theme {
		return this.ctx.ui.theme;
	}

	/** `[SIDE] ~/code/pi`: the side-mode badge when on, the cwd, and the session name when one is set. */
	location(): Piece[] {
		return [...this.sideBadge(), ...this.cwd(), ...this.sessionName()];
	}

	/** Bold `[SIDE] ` in `success` while side mode is on for this session, otherwise nothing. */
	sideBadge(): Piece[] {
		try {
			if (!isSideModeOn(this.ctx.sessionManager.getSessionId())) return [];
			return [{ text: "[SIDE]", paint: (text) => this.theme.bold(this.theme.fg("success", text)), atomic: true }, { text: " " }];
		} catch {
			return [];
		}
	}

	/** `~/code/pi`: the working directory, home shortened to its glyph. */
	cwd(): Piece[] {
		try {
			const cwd = formatCwd(this.ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
			return [{ text: cwd, paint: (text) => this.theme.fg("accent", text) }];
		} catch {
			return [];
		}
	}

	/** ` • name` when the session is named, otherwise nothing. */
	sessionName(): Piece[] {
		try {
			const name = this.ctx.sessionManager.getSessionName();
			return name ? [{ text: ` • ${name}`, paint: (text) => this.theme.fg("dim", text) }] : [];
		} catch {
			return [];
		}
	}

	/**
	 * `opus ▱▱▱▱▱` with the third slot lit — the model, then the reasoning
	 * effort as a position on that model's own scale.
	 *
	 * A slider, not the word `high`, because the word says where the level is
	 * without saying what it is out of: the same word sits at the top of one
	 * model's range and in the middle of another's. Notches say both at once and
	 * say them at a glance, which is all the top rule is for — the word still
	 * lives in the picker, where the level is actually chosen.
	 *
	 * Every slot sits at its own place on the prism's hue arc, cold at the bottom
	 * of the model's range and warm at the top, so effort reads as temperature
	 * and the strip belongs to the same palette as the wave. The slot the level
	 * is on is lit; the rest are their own hue sunk into the background, over 100
	 * apart in luma. So the level is a position first and a temperature second,
	 * and neither reading needs anything counted.
	 *
	 * A `+` or `−` against the strip means the level has moved since the request
	 * that filled the cache and that moving it rewrites the conversation — a cost
	 * not yet spent. It is the one mark here that keeps moving while nothing is
	 * happening, which it earns by being temporary: the next request clears it.
	 *
	 * Nothing is left for glyph shape to say, which is deliberate: it also means
	 * the plain text no longer carries the level, so a terminal that resolves no
	 * colours sees the range and not the setting. The picker is where the level
	 * is read exactly; this is a glance.
	 *
	 * Lit — a band of light crossing the whole label as one, each piece keeping
	 * its own colour under it — while a fresh session's first request would read
	 * its prefix from cache, and for `FADE_MS` after the level changes. The light
	 * is the only difference between a lit label and a still one, so the label
	 * reads the same at a glance either way.
	 */
	model(): Piece[] {
		try {
			const model = this.ctx.model;
			const pieces: Piece[] = [
				{ text: model ? shortModelId(model.id) : "no model", paint: (t) => this.theme.fg("muted", t) },
			];
			const scale = thinkingScale(model, this.ctx.thinkingLevel ?? "off");
			if (scale !== null) {
				// Atomic: a clipped slider reads as a shorter scale at full effort, which is
				// a wrong answer rather than a partial one. `fit` drops it and keeps the name.
				// Being undroppable-in-part is also what lets the paint rebuild from `scale`
				// rather than from the text it is handed: the two cannot disagree in width.
				pieces.push({
					text: ` ${effortSlider(scale)}`,
					paint: () => ` ${paintSlider(scale, (at, lit) => fg(lit ? arcColor(at) : arcTrack(at)))}`,
					atomic: true,
				});
				// Against the slider with no space: one cell, and the mark belongs to the
				// reading rather than sitting beside it. Last, so `fit` spends it first —
				// where the level is beats what moving it costs.
				const drift = this.warm().drift;
				if (drift !== null) {
					pieces.push({ text: drift, paint: () => `${fg(driftColor(Date.now()))}${drift}${RESET}`, atomic: true });
				}
			}
			const light = this.labelLight(Date.now());
			if (light === null) return pieces;
			if (light === "still") return pieces.map((piece) => ({ ...piece, paint: (t) => this.theme.fg("accent", t) }));
			const total = pieces.reduce((width, piece) => width + piece.text.length, 0);
			const t = (Date.now() - light.since) / 1000;
			let offset = 0;
			return pieces.map((piece) => {
				const start = offset;
				offset += piece.text.length;
				const resting = piece.paint ?? ((text: string) => text);
				// Whether this terminal's colours can be resolved at all is a property of
				// the piece, not of the frame, so it is asked once and not 25 times a second.
				const resolves = inkOf(resting(piece.text)) !== null;
				return {
					...piece,
					paint: (shown) => {
						// Each glyph's own colour is the light's resting state — `"self"`, because
						// the slider is painted in two colours and one piece is still one piece.
						// The label reads identically between lamps; only its colour says it is lit.
						if (!resolves) return this.theme.fg("accent", shown);
						return shadeLine(resting(shown), t, "self", {
							offset: start,
							total,
							light: LABEL_LIGHT,
							fade: light.fade,
						});
					},
				};
			});
		} catch {
			return [];
		}
	}

	/**
	 * The light on the model label now: the warm shimmer, the flash a level change
	 * leaves behind as it fades, or none.
	 *
	 * The warm answer wins while it stands. Both are the same band of light, and
	 * the warm one is the rarer thing to have on screen — it lasts until the
	 * seat's first request, where the flash is a moment.
	 */
	private labelLight(now: number): { since: number; fade: number } | "still" | null {
		const glow = this.warm().glow;
		if (glow?.kind === "still") return "still";
		if (glow?.kind === "shimmer") return { since: glow.since, fade: 0 };
		const since = this.flashedAt();
		if (since === undefined) return null;
		const fade = (now - since) / FADE_MS;
		return fade >= 1 ? null : { since, fade };
	}

	/**
	 * The cache window — `❄4m`, or a bare `❄` once cold — fed
	 * by session-mode through `globalThis`, and sat between the timer and the
	 * context reading in the bottom rule. Owns the single space between it and
	 * the reading.
	 *
	 * Hidden whenever the cache cannot be going cold: while the agent runs, and
	 * while the window is held — this seat waiting on background agents, whose
	 * work keeps the ping chain renewing it. A held clock reads a whole idle
	 * window at every instant, so it would be a number that never moves.
	 */
	cache(): Piece[] {
		if (runningSince() !== null) return [];
		const window = this.window();
		if (window?.cold.kind === "held") return [];
		const label = cacheLabel(window, Date.now());
		if (!label) return [];
		return [{ text: `${label} `, paint: (text) => this.theme.fg("muted", text), atomic: true }];
	}

	/**
	 * The window the bottom rule counts down. This seat's own once it has sent
	 * anything; before that, the ledger's promise for its first request, on the
	 * TTL clock — the clock being read is
	 * another seat's, and `until` already carries that seat's commitment to keep
	 * replaying it.
	 */
	private window(): CacheWindow | undefined {
		const own = readCacheWindow(this.ctx.sessionManager.getSessionId());
		if (own === undefined || own.warmUntil > 0) return own;
		const ledger = this.warm().ledger;
		if (ledger?.kind !== "warm") return own;
		return { mode: own.mode, warmUntil: ledger.until, cold: { kind: "ttl" } };
	}

	/**
	 * `1m 12s ` — how long the user has been waiting, once the wait is long
	 * enough to be worth saying, then the final figure until the next turn.
	 *
	 * Painted in `accent`, the violet the cwd and the branch already use, so it
	 * reads as another label let into the frame. Explicitly not `borderAccent`:
	 * in these themes that is the same peach as `warning`, which is reserved for
	 * readings that are actually alarming.
	 */
	timer(): Piece[] {
		try {
			const { label } = readTurn(readTurnClock(), Date.now());
			if (label === "") return [];
			return [{ text: `${label} `, paint: (text) => this.theme.fg("accent", text), atomic: true }];
		} catch {
			return [];
		}
	}

	/**
	 * `31.4k` — how much context is used, coloured by how near compaction.
	 *
	 * At rest it is painted in the border's own colour rather than the theme
	 * accent, so it belongs to the box it hangs off instead of announcing itself
	 * in a second hue. Warning and critical still override, since those exist to
	 * break out of the frame's palette.
	 */
	context(border: (text: string) => string): Piece[] {
		let percent: number | null = null;
		let tokens: number | null = null;
		try {
			const usage = this.ctx.getContextUsage();
			percent = usage?.percent ?? null;
			tokens = usage?.tokens ?? null;
		} catch {
			return [];
		}
		const reading = contextReading(tokens, percent);
		const alert: ThemeColor | null =
			reading.level === "critical" ? "error" : reading.level === "warning" ? "warning" : null;
		const paint = alert === null ? border : (text: string) => this.theme.fg(alert, text);
		return [{ text: reading.label, paint, atomic: true }];
	}

	/**
	 * ` 4m 10s` — how long this seat's longest-running background agent has been
	 * at it, read off the agent registry's own start times. Only the folded row
	 * carries it, beside the task count.
	 */
	agentElapsed(): Piece[] {
		try {
			const live = agentRuntimeOf(this.ctx.sessionManager.getSessionId())?.registry.live() ?? [];
			if (live.length === 0) return [];
			const since = Math.min(...live.map((record) => record.startedAt));
			return [{ text: ` ${formatDuration(Date.now() - since)}`, paint: (text) => this.theme.fg("accent", text), atomic: true }];
		} catch {
			return [];
		}
	}

	/** The current git branch, or nothing outside a repository. */
	branch(): Piece[] {
		const branch = this.footerData()?.getGitBranch();
		if (!branch) return [];
		return [{ text: branch, paint: (text) => this.theme.fg("accent", text) }];
	}

	/**
	 * `2 tasks ↓` — background agents still running, published by `agent-dock`
	 * as a status and claimed here for the rule.
	 *
	 * Read, never written: the dock owns the count and this owns where it goes.
	 * Dim, because it is an offer rather than an alarm — the arrow is what opens
	 * the modal, and nothing is drawn at all when no agent is running.
	 *
	 * Lit for as long as it is on screen. The count exists only while an agent is
	 * working, so "drawn" and "something is happening" are the same state here —
	 * and the light is how the chrome says that everywhere else, on the outline
	 * while a request is in flight and on a task's own row in the dock. Dim stays
	 * the resting colour under it: away from a lamp the label is the label it
	 * always was.
	 *
	 * The strip is a label's length, not a row's, so it takes the label tuning —
	 * a row's spacing over nine cells puts both lamps over the whole thing and the
	 * count pulses as one block instead of showing colour travelling along it.
	 */
	tasks(): Piece[] {
		const text = this.footerData()?.getExtensionStatuses().get(AGENT_TASK_STATUS_KEY);
		const since = this.taskGlow(Boolean(text));
		if (!text) return [];
		const label = sanitize(text);
		const dim = (shown: string) => this.theme.fg("dim", shown);
		if (since === null) return [{ text: label, paint: dim, atomic: true }];
		const t = (Date.now() - since) / 1000;
		// Whether this terminal's colours resolve at all is a property of the piece,
		// not of the frame, so it is asked once a render and not once a lamp.
		const resolves = inkOf(dim(label)) !== null;
		return [
			{
				text: label,
				paint: (shown) => (resolves ? shadeLine(dim(shown), t, "self", { light: LABEL_LIGHT }) : dim(shown)),
				atomic: true,
			},
		];
	}
}

/**
 * The stock editor closed into a box.
 *
 * `super.render()` emits: top rule, content rows, bottom rule, then any
 * autocomplete rows. It is asked for a two-column-narrower render so the edges
 * fit, its rules become labelled ones with rounded corners, and its content
 * rows get flanked. pi's `↑ 3 more` scroll indicators are let into the labelled
 * rules rather than drawn in place of them, so scrolling the buffer never costs
 * the box its readings.
 */
class ChromeEditor extends CustomEditor {
	// Not `state`: the base Editor keeps its buffer in a private field of that
	// name, and a parameter property would silently overwrite it after super().
	private chrome: ChromeState;

	/** What the terminal shows for its ANSI slots; shared with the diff rows. */
	private slots: SlotColors;

	/** When the slots were last asked for; see `SLOT_REFRESH_MS`. */
	private slotsReadAt = 0;

	/** Lowers pi's three-row floor for the editor to the rows a folded box draws; see dock.ts. */
	private fitFloor: (rows: number) => void;

	/** Drops pi's blank spacer row between the transcript and the box; see dock.ts. */
	private hideGapAbove: () => void;

	/** Buffer rows scrolled out of view above and below the box, as of the last render. */
	private hidden = { above: 0, below: 0 };

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, chrome: ChromeState) {
		super(tui, theme, keybindings);
		this.chrome = chrome;
		this.fitFloor = capDockFloor(tui, () => this);
		this.hideGapAbove = hideBlankRowsAbove(tui, () => this);
		// The editor is the one component that holds a TUI for the whole session, so
		// it is where the process-wide cache gets its terminal. Everything else —
		// the diff rows above all — only reads it.
		this.slots = slotColors();
		this.slots.attach(
			{
				write: (data) => tui.terminal.write(data),
				addInputListener: (listener) => tui.addInputListener(listener),
			},
			() => tui.requestRender(),
		);
		this.setPaddingX(1);
	}

	/**
	 * Text sitting flush against `│` reads badly, so keep at least one column of
	 * gutter. pi pushes the `editorPaddingX` setting in here, and a larger value
	 * still wins.
	 */
	setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(1, padding));
	}

	/**
	 * pi draws its `↑ 3 more` indicator into the rule itself, which would leave no
	 * room for labels. Take the count instead and hand back a plain rule for the
	 * frame to label; the indicator goes back in as one of those labels.
	 */
	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.hidden.above = hiddenLineCount;
		return this.borderColor("─".repeat(width));
	}

	/** The bottom edge's `↓ 3 more`, taken the same way as the top's. */
	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.hidden.below = hiddenLineCount;
		return this.borderColor("─".repeat(width));
	}

	render(width: number): string[] {
		const lines = this.renderFramed(width);
		// Every frame, from inside render, so the layout allocates this frame's rows.
		this.fitFloor(lines.length);
		this.hideGapAbove();
		return lines;
	}

	private renderFramed(width: number): string[] {
		const inner = width - FRAME;
		if (inner < 4) return super.render(width);

		// Every render is a chance to notice the terminal's palette has changed —
		// throttled, and independent of the wave, since a diff row needs the answers
		// whether or not anything is animating.
		this.readSlots(Date.now());

		const lines = super.render(inner);
		if (lines.length < 2) return lines;

		// The bottom edge is the last rule; anything after it is the autocomplete
		// list, which hangs below the box rather than inside it.
		let bottom = -1;
		for (let i = lines.length - 1; i > 0; i--) {
			if (isPlainRule(lines[i] ?? "", inner)) {
				bottom = i;
				break;
			}
		}
		if (bottom < 1) return lines;

		const folded = isPromptFolded({
			text: this.getText(),
			contentRows: bottom - 1,
			autocompleteRows: lines.length - bottom - 1,
			scrolled: this.hidden.above > 0 || this.hidden.below > 0,
		});
		if (folded) {
			const tasks = this.chrome.tasks();
			const rows = foldRows(
				width,
				{
					side: this.chrome.sideBadge(),
					path: this.chrome.cwd(),
					session: this.chrome.sessionName(),
					branch: this.chrome.branch(),
					model: this.chrome.model(),
					timer: this.chrome.timer(),
					tasks: tasks.length > 0 ? [...tasks, ...this.chrome.agentElapsed()] : [],
					cache: this.chrome.cache(),
					context: this.chrome.context(this.borderColor),
				},
				this.borderColor,
			);
			return this.lit(rows, Date.now(), true) ?? rows;
		}

		const side = this.borderColor(SIDE);
		lines[0] = rule(
			width,
			this.chrome.location(),
			this.chrome.model(),
			this.borderColor,
			TOP_ENDS,
			insignia(this.borderColor),
			scrollIndicator("↑", this.hidden.above, this.borderColor),
		);
		const labels: BottomLabels = {
			branch: this.chrome.branch(),
			tasks: this.chrome.tasks(),
			timer: this.chrome.timer(),
			cache: this.chrome.cache(),
			context: this.chrome.context(this.borderColor),
			scroll: scrollIndicator("↓", this.hidden.below, this.borderColor),
		};
		lines[bottom] = bottomRule(width, labels, this.borderColor);
		for (let i = 1; i < bottom; i++) lines[i] = side + lines[i] + side;
		// Autocomplete rows sit outside the box; indent them to line up with its text.
		for (let i = bottom + 1; i < lines.length; i++) lines[i] = ` ${lines[i]}`;

		// The light rolls along the box (not the autocomplete rows).
		const box = this.lit(lines.slice(0, bottom + 1), Date.now());
		if (box !== null) for (let i = 0; i <= bottom; i++) lines[i] = box[i] ?? lines[i];
		return lines;
	}

	/**
	 * The box under whatever light is on it now — the wave while a request is in
	 * flight, otherwise the wake a session opens with — or null for the box as it
	 * was rendered.
	 *
	 * `folded` rows are the idle bar, which has no box outline: the light takes
	 * every glyph on them, readings as well as rule, each keeping its own colour.
	 *
	 * Purely cosmetic, so it must never break a render: a throw here leaves the
	 * rows alone.
	 */
	private lit(rows: string[], now: number, folded = false): string[] | null {
		if (!WAVE) return null;
		try {
			// The light is a field sampled at an instant, so a render arriving off
			// schedule needs no correction: there is no crest whose travel between
			// frames has to be blurred, only a smooth function of position and time.
			const light = boxLight(now);
			if (light !== null) {
				const t = (now - light.since) / 1000;
				if (folded) return rows.map((row) => shadeLine(row, t, "self", { light: FOLDED_BAR_LIGHT, fade: light.fade }));
				return shadeBox(rows, t, { fade: light.fade });
			}
			const wake = boxWake(now);
			if (wake === null) return null;
			// Waking, the light takes the whole box rather than the outline: the
			// labels and the typed text are tinted by it, each keeping its own colour,
			// and the grey goes over the top of all of it. So the colour that arrives
			// as the grey lifts is the chrome's own palette plus the light, which is
			// what a bar switching on looks like.
			const t = (now - wake.since) / 1000;
			const shone = folded
				? rows.map((row) => shadeLine(row, t, "self", { light: FOLDED_BAR_LIGHT, fade: 1 - wake.light }))
				: shadeBox(rows, t, { tint: isNotFrame, fade: 1 - wake.light });
			return greyOut(shone, wake.grey);
		} catch {
			return null;
		}
	}

	/** Re-reads the terminal's colours, at most once per `SLOT_REFRESH_MS`. */
	private readSlots(now: number): void {
		if (now - this.slotsReadAt < SLOT_REFRESH_MS) return;
		this.slotsReadAt = now;
		this.slots.refresh();
	}

}

/**
 * Status keys that only ever report that nothing is wrong.
 *
 * pi-claude-oauth-adapter parks `✓ Claude OAuth active` in the footer for the
 * whole session, which costs a row to say "still fine". Its problems arrive
 * under a different key (`claude-oauth-issue`), so usage limits and broken
 * setups still show up.
 */
const MUTED_STATUSES = new Set(["claude-oauth-ready"]);

/**
 * Status keys some other part of the chrome has already put on screen.
 *
 * `agent-dock`'s task count is let into the bottom rule (see `ChromeState.tasks`),
 * so the footer must not print it a second time. One fact, one place.
 */
const RULE_STATUSES = new Set([AGENT_TASK_STATUS_KEY]);

/** Newlines in status text would break the single-line footer. */
function sanitize(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	/** The seat this instance renders for; the cache window seam is keyed on it. */
	let sessionId = "";
	const animationClock = createAnimationClock(() => tui?.requestRender());
	let waveFrames: ReleaseFrames | undefined;
	let cacheTicker: ReturnType<typeof setTimeout> | undefined;
	let floorTimer: ReturnType<typeof setTimeout> | undefined;
	let secondTicker: ReturnType<typeof setInterval> | undefined;
	let wakeFrames: ReleaseFrames | undefined;
	/** Set only while this session is the one wearing the frame. */
	let unframe: (() => void) | undefined;

	// ---- the wake -----------------------------------------------------------------

	/**
	 * Frames for as long as the bar is waking, and not one after.
	 *
	 * Armed from the editor factory rather than from `session_start`, because the
	 * TUI does not exist yet when the session opens: the instant is stamped there
	 * and the frames start the moment there is something to paint them on.
	 */
	function startWakeFrames(): void {
		if (wakeFrames || !tui || !WAVE || waking.since === null) return;
		wakeFrames = animationClock.demandFrames(FRAME_MS, () => {
			// `boxWake` drops the state on the last frame, so this tick's render is the
			// one that paints the bar at rest.
			if (boxWake(Date.now()) === null) stopWakeFrames();
		});
	}

	function stopWakeFrames(): void {
		wakeFrames?.();
		wakeFrames = undefined;
	}

	/**
	 * Ends the wake now. The instant is shared, so only a runtime entitled to
	 * speak for this seat's chrome calls this — a subagent's shutdown takes its
	 * own frames down with `stopWakeFrames` and leaves the bar alone.
	 */
	function stopWaking(): void {
		waking.since = null;
		stopWakeFrames();
	}

	// ---- the cache glow -----------------------------------------------------------

	let warm: WarmState = { glow: null, ledger: undefined, drift: null };
	let warmthTicker: ReturnType<typeof setInterval> | undefined;
	let shimmerFrames: ReleaseFrames | undefined;
	let driftFrames: ReleaseFrames | undefined;
	/**
	 * The model and level the last request went out on — the state the cached
	 * conversation was written at. Undefined until this seat has sent a turn,
	 * which is the drift mark's one declared limit: a resumed session cannot know
	 * what its predecessor sent, and the ledger keys only the tools+system tier,
	 * so nothing on disk can recover it. Silent beats guessed.
	 */
	let sentEffort: { model: string | undefined; level: string } | undefined;
	/**
	 * Whether this conversation has a message in it. Sticky until the next session
	 * reset, so a resumed seat is not re-walked every second: once there is a
	 * message, the ledger's tools+system entry is no longer the whole prefix.
	 */
	let conversationStarted = false;
	const CHAT = isChatSeat();

	function stopShimmer(): void {
		shimmerFrames?.();
		shimmerFrames = undefined;
	}

	function stopDrift(): void {
		driftFrames?.();
		driftFrames = undefined;
	}

	/**
	 * The drift mark now, or null: whether the level has moved away from the one
	 * the cached conversation was written at, and whether that move rewrites it.
	 *
	 * On the warmth tick rather than in a render, because the second question is
	 * a file read. The coerced id from `inputs` is what asks the ledger — that is
	 * the id the request carries and the id the fact was measured under — while
	 * the scales come from the model on screen, so the mark is about the label
	 * the eye is reading.
	 */
	function driftNow(ctx: ExtensionContext, inputs: ReturnType<typeof prefixInputsOf>): EffortDrift | null {
		// No inputs means the next request is not an Anthropic one, so this ledger
		// holds no conversation for it to cost.
		if (inputs === undefined || sentEffort === undefined) return null;
		const now = thinkingScale(ctx.model, ctx.thinkingLevel ?? "off");
		if (now === null) return null;
		const sent = sentEffort.model === ctx.model?.id ? thinkingScale(ctx.model, sentEffort.level) : null;
		return effortDrift(now, sent, reasoningChangeCost(warmPrefixDir(), inputs.model) === "rewrites");
	}

	/**
	 * Gather what `warmthOf` needs and adopt its verdict. The facts are read off
	 * pi and the ledger here; the rule lives in warmth.ts, where it is tested.
	 */
	function evaluateWarmth(ctx: ExtensionContext): void {
		try {
			const now = Date.now();
			const inputs = prefixInputsOf(pi, ctx, CHAT);
			const verdict = warmthOf({
				now,
				running: runningSince() !== null,
				seat: inputs === undefined ? undefined : { model: inputs.model, reasoning: inputs.reasoning, inputsKey: inputsKey(inputs) },
				conversationStarted: (conversationStarted ||= ctx.sessionManager.getBranch().some((entry) => entry.type === "message")),
				ledger: (key) => predictWarmth(warmPrefixDir(), key, now),
			});
			setWarm({ glow: lit(verdict.warm), ledger: verdict.ledger, drift: driftNow(ctx, inputs) });
		} catch {
			// A read that threw mid-teardown decides nothing; the last answer stands.
		}
	}

	/** The glow a warm answer earns: the shimmer, its epoch kept across ticks so the band does not jump; or the still accent with the wave off. */
	function lit(warmNow: boolean): Glow {
		if (!warmNow) return null;
		if (!WAVE) return { kind: "still" };
		return warm.glow?.kind === "shimmer" ? warm.glow : { kind: "shimmer", since: Date.now() };
	}

	/** Adopt an answer, and ask for frames exactly while there is something to animate. */
	function setWarm(next: WarmState): void {
		const changed = next.glow?.kind !== warm.glow?.kind || next.ledger?.kind !== warm.ledger?.kind || next.drift !== warm.drift;
		warm = next;
		// The one thing on this chrome that moves while nothing is happening. It is
		// affordable because it is temporary: the next request clears the mark and
		// with it these frames.
		if (next.drift !== null && WAVE && tui) {
			driftFrames ??= animationClock.demandFrames(SHIMMER_FRAME_MS);
		} else {
			stopDrift();
		}
		if (next.glow?.kind === "shimmer") {
			if (!shimmerFrames && tui) shimmerFrames = animationClock.demandFrames(SHIMMER_FRAME_MS);
		} else {
			stopShimmer();
		}
		// The ledger's countdown in the bottom rule moves on its own clock, and with
		// the shimmer off nothing else is asking for frames; one a second is enough.
		if (changed || (next.ledger?.kind === "warm" && !shimmerFrames)) tui?.requestRender();
	}

	// ---- the level flash ----------------------------------------------------------

	/**
	 * When the reasoning level last changed, while the light that change lit is
	 * still fading; undefined once it has gone.
	 */
	let flashedAt: number | undefined;
	let flashFrames: ReleaseFrames | undefined;

	function stopFlash(): void {
		flashedAt = undefined;
		flashFrames?.();
		flashFrames = undefined;
	}

	/**
	 * Light the model label for `FADE_MS`, then let it go.
	 *
	 * The slider is static the rest of the time, deliberately: the light on this
	 * chrome means something is happening — a turn in flight, an agent working, a
	 * prefix still warm — and a strip that shimmered all session would cost a
	 * render every frame to say nothing. A level change is the one event this
	 * surface has, so it is the one time it moves.
	 */
	function flashLevel(): void {
		if (!WAVE || !tui) return;
		flashedAt = Date.now();
		flashFrames ??= animationClock.demandFrames(SHIMMER_FRAME_MS);
		// A second change during the fade moves the epoch on; whichever timeout finds
		// the flash actually spent is the one that puts the light out.
		setTimeout(() => {
			if (flashedAt !== undefined && Date.now() - flashedAt >= FADE_MS) stopFlash();
			tui?.requestRender();
		}, FADE_MS + FRAME_MS).unref();
	}

	// ---- the task count -----------------------------------------------------------

	/**
	 * When the task count appeared in the bottom rule, and the frames lighting it.
	 * Both are undefined while no count is drawn; the frames are also absent with
	 * the wave off or before there is a TUI to paint on.
	 */
	let tasksSince: number | undefined;
	let tasksFrames: ReleaseFrames | undefined;

	function stopTaskFrames(): void {
		tasksSince = undefined;
		tasksFrames?.();
		tasksFrames = undefined;
	}

	/**
	 * The epoch the task count is lit from, or null for a still label.
	 *
	 * Asked during the render that draws the rule, because reading the status is
	 * the only way this extension learns the count — the dock owns it and asks for
	 * a render whenever it moves, so the first render after an agent starts is
	 * where the frames start, and the first render after the last one settles is
	 * where they stop. The frames then sustain themselves for as long as the label
	 * is on screen.
	 *
	 * The epoch is the moment the label appeared, held while it stays: a second
	 * agent starting must not jump the band back to its beginning.
	 */
	function taskGlow(present: boolean): number | null {
		if (!present) {
			stopTaskFrames();
			return null;
		}
		if (!WAVE) return null;
		tasksSince ??= Date.now();
		if (!tasksFrames && tui) tasksFrames = animationClock.demandFrames(SHIMMER_FRAME_MS);
		return tasksSince;
	}

	function stopWarmthTicker(): void {
		if (warmthTicker) {
			clearInterval(warmthTicker);
			warmthTicker = undefined;
		}
		stopShimmer();
		stopDrift();
	}

	/** One evaluation a second while the seat is idle: two small file reads and a hash. Unreffed, like every timer here. */
	function startWarmthTicker(ctx: ExtensionContext): void {
		stopWarmthTicker();
		evaluateWarmth(ctx);
		warmthTicker = setInterval(() => evaluateWarmth(ctx), WARMTH_TICK_MS);
		warmthTicker.unref?.();
	}

	// One render per change of the number, not per second: the label counts minutes
	// until the last one, so it re-arms for the next boundary and only reaches 1 Hz
	// inside the final minute. A cold ❄ has nothing moving, so the ticker stops.
	function stopCacheTicker(): void {
		if (cacheTicker) {
			clearTimeout(cacheTicker);
			cacheTicker = undefined;
		}
	}
	function startCacheTicker(): void {
		if (cacheTicker || !tui) return;
		const delay = nextRedrawMs(readCacheWindow(sessionId), Date.now());
		if (delay === undefined) return;
		cacheTicker = setTimeout(() => {
			cacheTicker = undefined;
			tui?.requestRender();
			if (runningSince() === null) startCacheTicker();
		}, delay);
		cacheTicker.unref?.();
	}

	/**
	 * Renders while the elapsed time is on screen.
	 *
	 * Nothing is armed beyond one timeout for the remainder of the floor, so a
	 * turn that finishes inside thirty seconds — nearly all of them — never
	 * starts a ticker at all. The timeout fires once, paints the first number,
	 * and hands over to a 1 Hz interval.
	 *
	 * Deliberately independent of `PI_ZEN_WAVE`. That flag exists to stop a
	 * terminal compositing a translucent background 30 times a second; one line
	 * of text once a second is not that cost, and the quiet mode is precisely
	 * the mode with no other running indicator.
	 */
	function stopTicking(): void {
		if (floorTimer) {
			clearTimeout(floorTimer);
			floorTimer = undefined;
		}
		if (secondTicker) {
			clearInterval(secondTicker);
			secondTicker = undefined;
		}
	}
	function startTicking(): void {
		if (!tui || floorTimer || secondTicker) return;
		const remaining = FLOOR_MS - (elapsedMs(readTurnClock(), Date.now()) ?? 0);
		// Unreffed, like the cache ticker: pi's own render timer is not, so a timer
		// that keeps the loop alive would hold the process open at quit.
		floorTimer = setTimeout(() => {
			floorTimer = undefined;
			tui?.requestRender();
			secondTicker = setInterval(() => tui?.requestRender(), 1000);
			secondTicker.unref?.();
		}, Math.max(0, remaining));
		floorTimer.unref?.();
	}

	/**
	 * The turn, opened.
	 *
	 * Fed by `before_agent_start` and by `agent_start`, because neither alone
	 * covers every run: a user prompt raises both, while a background task
	 * delivered with `triggerTurn` raises only the second. The clock's start is
	 * sticky, so whichever arrives first wins and the later one is a no-op —
	 * which is also what keeps a mid-turn retry or auto-compaction, each of which
	 * raises `agent_start` again, from restarting the number and the wave with it.
	 */
	const turnStarted = (_event: unknown, ctx: ExtensionContext) => {
		if (!ownsTurnClock(ctx)) return;
		advanceTurnClock("turn_start", Date.now());
		fading.light = null;
		// A request during the wake ends it: the wave is the same light saying
		// something, and two lights on one box would be one animation misread.
		stopWaking();
		stopCacheTicker();
		// This is the state the conversation about to be cached is written at, so it
		// is recorded before the mark is cleared: the level has not moved from itself.
		sentEffort = { model: ctx.model?.id, level: ctx.thinkingLevel ?? "off" };
		// The request wave takes the frame over; the glow answers for the *next* request.
		setWarm({ glow: null, ledger: undefined, drift: null });
		startTicking();
		// No TUI (print mode, teardown) means nothing to animate, and with the wave
		// off there is no reason to ask for frames at all.
		if (!waveFrames && tui && WAVE) waveFrames = animationClock.demandFrames(FRAME_MS);
	};

	// The box outline's light. It changes nothing but how the chrome looks, so it
	// is a preference kept outside git rather than a setting (see choice.ts), and
	// the change lands in this session as well as the next one: a light you cannot
	// see until you restart is a light you cannot choose by eye.
	pi.registerCommand("glow", {
		description: `[${GLOWS.join("|")}] — which light the box outline carries`,
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const matches = GLOWS.filter((name) => name.startsWith(typed));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name, description: GLOW_NOTES[name] })) : null;
		},
		handler: (args, ctx) => {
			const asked = args.trim().toLowerCase();
			if (asked === "") {
				const now = glowName();
				notice(ctx, `Glow: ${now} — ${GLOW_NOTES[now]}. ${GLOWS.filter((n) => n !== now).map((n) => `/glow ${n}`).join(", ")}`);
				return;
			}
			const chosen = GLOWS.find((name) => name === asked);
			if (chosen === undefined) {
				notice(ctx, `Usage: /glow [${GLOWS.join("|")}]`, "error");
				return;
			}
			setGlowName(chosen);
			tui?.requestRender();
			notice(ctx, `Glow: ${chosen} — ${GLOW_NOTES[chosen]}.`);
		},
	});

	pi.on("before_agent_start", turnStarted);
	pi.on("agent_start", turnStarted);

	// pi raises this from a `finally` around the whole run, so it lands on a
	// normal finish, on ESC, and on a retry-exhausted API error alike. There is
	// no separate abort event and none is needed.
	pi.on("agent_settled", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		const since = runningSince();
		const now = Date.now();
		advanceTurnClock("turn_settled", now);
		// The light fades rather than stops: keep asking for frames until it has
		// gone, then let the frame timer go with it.
		fading.light = since === null ? null : { since, settledAt: now };
		const frames = waveFrames;
		if (frames) {
			setTimeout(() => {
				// A turn that started during the fade still owns the frames.
				if (waveFrames === frames && runningSince() === null) {
					frames();
					waveFrames = undefined;
				}
				tui?.requestRender();
			}, FADE_MS + FRAME_MS).unref();
		}
		stopTicking();
		// One more render: the number freezes.
		tui?.requestRender();
		startCacheTicker();
		evaluateWarmth(ctx);
	});

	// Ctrl-P and Shift-Tab: the answer is for the model shown, so it is re-asked
	// the moment the label changes rather than at the next tick.
	pi.on("model_select", (_event, ctx) => {
		if (ownsTurnClock(ctx)) evaluateWarmth(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		flashLevel();
		evaluateWarmth(ctx);
	});

	// The frame lives on a shared prototype, so it outlives this runtime unless it
	// is taken down with it — but only by the runtime that put it there. pi runs
	// subagents in this process, on this prototype, and they shut down all session
	// long; the frame is not theirs to remove.
	pi.on("session_shutdown", () => {
		stopCacheTicker();
		stopTicking();
		stopWarmthTicker();
		stopFlash();
		stopTaskFrames();
		stopWakeFrames();
		waveFrames = undefined;
		animationClock.releaseAllFrames();
		unframe?.();
		unframe = undefined;
	});

	// Owning the clock and wearing the frame are the same session, by
	// construction: one predicate decides both, so they cannot drift apart.
	pi.on("session_start", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		sessionId = ctx.sessionManager.getSessionId();

		// pi raises this for startup, reload, and every /new, /resume and /fork, so
		// it is the whole of "session reset": a held duration never outlives the
		// conversation it described.
		advanceTurnClock("session_reset", Date.now());
		// Every session reset — startup, reload, /new, /resume, /fork — opens a bar
		// that is not lit yet, and the wake is what lights it. One rule, so the bar
		// a fresh conversation gets is the bar the first one got.
		stopWaking();
		if (WAVE) waking.since = Date.now();
		conversationStarted = false;
		warm = { glow: null, ledger: undefined, drift: null };
		sentEffort = undefined;
		stopDrift();
		stopFlash();
		// A reset empties the dock's registry with it, so the count on screen belongs
		// to the conversation that just ended; the next render re-arms if it is real.
		stopTaskFrames();

		// Sent messages keep the box they were typed in; see user-message.ts.
		unframe = frameUserMessages(() => ctx.ui.theme);

		// The wave on the border is the loading indicator; the built-in spinner
		// row (and whimsical.ts's flavour text with it) would say the same thing
		// while costing a row.
		ctx.ui.setWorkingVisible(false);

		// setFooter is the only place a FooterDataProvider is handed out, so the
		// footer captures it for the editor, which needs the git branch.
		let footerData: ReadonlyFooterDataProvider | undefined;
		const chrome = new ChromeState(ctx, () => footerData, () => warm, () => flashedAt, taskGlow);

		ctx.ui.setFooter((tui, theme, data) => {
			footerData = data;
			// pi reserves a row for the footer whether or not it has anything in it,
			// which would leave a blank line under the box; ask for only the rows
			// actually used (see dock.ts).
			const fit = fitDockRows(tui, () => footer);
			const footer = {
				dispose: data.onBranchChange(() => tui.requestRender()),
				invalidate() {},
				render(width: number): string[] {
					const shown = Array.from(data.getExtensionStatuses().entries())
						.filter(([key]) => !MUTED_STATUSES.has(key) && !RULE_STATUSES.has(key))
						.sort(([a], [b]) => a.localeCompare(b));
					if (shown.length === 0) {
						fit(0);
						return [];
					}
					fit(1);
					const line = shown.map(([, text]) => sanitize(text)).join(" ");
					return [truncateToWidth(line, width, theme.fg("dim", "..."))];
				},
			};
			return footer;
		});

		ctx.ui.setEditorComponent((editorTui, theme, keybindings) => {
			tui = editorTui;
			startWakeFrames();
			return new ChromeEditor(editorTui, theme, keybindings, chrome);
		});

		startWarmthTicker(ctx);
		// A reset mid-session already has its editor, so the frames start here; at
		// startup there is no TUI yet and this is a no-op until the factory runs.
		startWakeFrames();
	});
}
