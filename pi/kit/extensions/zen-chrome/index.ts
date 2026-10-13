import type { Api, Model } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { capDockFloor, hideBlankRowsAbove, restoreDockLayout } from "./dock-layout-rows.ts";
import { isPlainRule, type Piece, rule, scrollIndicator, SIDE, TOP_ENDS } from "../../lib/ui/labelled-rule.ts";
import { bottomRule, type BottomLabels, contextReading, formatCwd, insignia } from "./prompt-box-rules.ts";
import { AGENT_TASK_STATUS_KEY } from "../../lib/agents/agent-task-count.ts";
import { agentRuntimeOf } from "../../lib/agents/agent-runtime-seam.ts";
import { foldRows, isPromptFolded } from "./fold.ts";
import { isChatSeat } from "../../lib/session/seat-identity.ts";
import { cacheLabel, nextRedrawMs, readCacheTouch, seatWantsWarming } from "../../lib/wire/cache-touch.ts";
import { processShared } from "../../lib/process/process-shared-state.ts";
import { promptTargetOf } from "../../lib/session/prompt-target.ts";
import {
	advanceTurnClock,
	ownsTurnClock,
	turnClockReading,
	readTurnClock,
} from "../../lib/session/turn-clock.ts";
import { formatDuration } from "../../lib/ui/duration-label.ts";
import { fg, SGR_RESET } from "../../lib/ui/rgb-color.ts";
import { createAnimationClock, type ReleaseFrames } from "./animation-clock.ts";
import {
	arcColor,
	arcTrack,
	FADE_MS,
	FOLDED_BAR_LIGHT,
	FRAME_MS,
	inkOf,
	isNotFrame,
	LABEL_LIGHT,
	ONE_HUE,
	shadeBox,
	shadeLine,
	SHIMMER_FRAME_MS,
	waveEnabled,
} from "../../lib/ui/prism-light.ts";
import { greyOut, wakeAt } from "./box-wake.ts";
import { createLevelFlash } from "./level-flash.ts";
import { createRuleTickers } from "./rule-tickers.ts";
import { createStatusFooter, sanitizeStatusText } from "./status-footer.ts";
import { createTaskCountGlow } from "./task-count-glow.ts";
import { type SlotColors, slotColors } from "../../lib/ui/terminal-slot-colors.ts";
import { effortSlider, paintSlider, shortModelId, thinkingScale } from "../../lib/models/model-label.ts";
import { frameUserMessages } from "./user-message.ts";
import { FRAME } from "./user-message-box.ts";

const WAVE = waveEnabled();

const SLOT_REFRESH_MS = 1000;

function runningSince(): number | null {
	return readTurnClock().startedAt;
}

const fading = processShared<{ light: { since: number; settledAt: number } | null }>("__piZenChromeFade", () => ({ light: null }));

const waking = processShared<{ since: number | null }>("__piZenChromeWake", () => ({ since: null }));

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

class ChromeState {
	constructor(
		private ctx: ExtensionContext,
		private footerData: () => ReadonlyFooterDataProvider | undefined,
		private flashedAt: () => number | undefined,
		private taskGlow: (present: boolean) => number | null,
	) {}

	get theme(): Theme {
		return this.ctx.ui.theme;
	}

	location(): Piece[] {
		return [...this.promptTargetBadge(), ...this.cwd(), ...this.sessionName()];
	}

	promptTargetBadge(): Piece[] {
		try {
			const target = promptTargetOf(this.ctx.sessionManager.getSessionId());
			if (target === undefined) return [];
			const [text, color] = target.kind === "side" ? (["[SIDE]", "success"] as const) : ([`[${target.name}]`, "accent"] as const);
			return [{ text, paint: (painted) => this.theme.bold(this.theme.fg(color, painted)), atomic: true }, { text: " " }];
		} catch {
			return [];
		}
	}

	cwd(): Piece[] {
		try {
			const cwd = formatCwd(this.ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
			return [{ text: cwd, paint: (text) => this.theme.fg("accent", text) }];
		} catch {
			return [];
		}
	}

	sessionName(): Piece[] {
		try {
			const name = this.ctx.sessionManager.getSessionName();
			return name ? [{ text: ` • ${name}`, paint: (text) => this.theme.fg("dim", text) }] : [];
		} catch {
			return [];
		}
	}

	model(): Piece[] {
		try {
			const model = this.ctx.model;
			const pieces: Piece[] = [
				{ text: model ? shortModelId(model.id) : "no model", paint: (t) => this.theme.fg("muted", t) },
			];
			const scale = thinkingScale(model, this.ctx.thinkingLevel ?? "off");
			if (scale !== null) {
				pieces.push({
					text: ` ${effortSlider(scale)}`,
					paint: () => ` ${paintSlider(scale, (at, lit) => fg(lit ? arcColor(at) : arcTrack(at)))}`,
					atomic: true,
				});
			}
			const light = this.labelLight(Date.now());
			if (light === null) return pieces;
			const total = pieces.reduce((width, piece) => width + piece.text.length, 0);
			const t = (Date.now() - light.since) / 1000;
			let offset = 0;
			return pieces.map((piece) => {
				const start = offset;
				offset += piece.text.length;
				const resting = piece.paint ?? ((text: string) => text);
				const resolves = inkOf(resting(piece.text)) !== null;
				return {
					...piece,
					paint: (shown) => {
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

	private labelLight(now: number): { since: number; fade: number } | null {
		const since = this.flashedAt();
		if (since === undefined) return null;
		const fade = (now - since) / FADE_MS;
		return fade >= 1 ? null : { since, fade };
	}

	timer(): Piece[] {
		try {
			const { label } = turnClockReading(readTurnClock(), Date.now());
			if (label === "") return [];
			return [{ text: `${label} `, paint: (text) => this.theme.fg("accent", text), atomic: true }];
		} catch {
			return [];
		}
	}

	cache(): Piece[] {
		try {
			if (runningSince() !== null) return [];
			const label = cacheLabel(readCacheTouch(this.ctx.sessionManager.getSessionId()), Date.now(), seatWantsWarming(this.ctx.sessionManager.getSessionId()));
			if (label === "") return [];
			return [{ text: `${label} `, paint: (text) => this.theme.fg("muted", text), atomic: true }];
		} catch {
			return [];
		}
	}

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

	runningAgentNames(): string[] {
		try {
			return (agentRuntimeOf(this.ctx.sessionManager.getSessionId())?.registry.live() ?? []).map((record) => record.name);
		} catch {
			return [];
		}
	}

	notifyReloadRefused(running: readonly string[]): void {
		this.ctx.ui.notify(`Reload would stop ${running.length} running agent${running.length === 1 ? "" : "s"}: ${running.join(", ")}. Run /reload --force to reload anyway.`, "warning");
	}

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

	bottomRuleLabel(): Piece[] {
		try {
			const target = promptTargetOf(this.ctx.sessionManager.getSessionId());
			if (target?.kind === "agent") return [{ text: target.name, paint: (text) => this.theme.fg("accent", text) }];
		} catch {
		}
		return this.branch();
	}

	branch(): Piece[] {
		const branch = this.footerData()?.getGitBranch();
		if (!branch) return [];
		return [{ text: branch, paint: (text) => this.theme.fg("accent", text) }];
	}

	tasks(): Piece[] {
		const text = this.footerData()?.getExtensionStatuses().get(AGENT_TASK_STATUS_KEY);
		const since = this.taskGlow(Boolean(text));
		if (!text) return [];
		const label = sanitizeStatusText(text);
		const dim = (shown: string) => this.theme.fg("dim", shown);
		if (since === null) return [{ text: label, paint: dim, atomic: true }];
		const t = (Date.now() - since) / 1000;
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

class ChromeEditor extends CustomEditor {
	private chrome: ChromeState;

	private slots: SlotColors;

	private slotsReadAt = 0;

	private fitFloor: (rows: number) => void;

	private hideGapAbove: () => void;

	private hidden = { above: 0, below: 0 };

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, chrome: ChromeState) {
		super(tui, theme, keybindings);
		this.chrome = chrome;
		this.fitFloor = capDockFloor(tui, () => this);
		this.hideGapAbove = hideBlankRowsAbove(tui, () => this);
		this.slots = slotColors();
		this.slots.attach(
			{
				write: (data) => tui.terminal.write(data),
				addInputListener: (listener) => tui.addInputListener(listener),
			},
			() => tui.requestRender(),
		);
		this.setPaddingX(1);
		this.guardReload();
	}

	private guardReload(): void {
		let submit = this.onSubmit;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			get: () => (text: string) => {
				const trimmed = text.trim();
				if (trimmed === "/reload --force") return submit?.("/reload");
				if (trimmed === "/reload") {
					const running = this.chrome.runningAgentNames();
					if (running.length > 0) {
						this.chrome.notifyReloadRefused(running);
						return;
					}
				}
				submit?.(text);
			},
			set: (next: ((text: string) => void) | undefined) => {
				submit = next;
			},
		});
	}

	setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(1, padding));
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.hidden.above = hiddenLineCount;
		return this.borderColor("─".repeat(width));
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.hidden.below = hiddenLineCount;
		return this.borderColor("─".repeat(width));
	}

	render(width: number): string[] {
		const lines = this.renderFramed(width);
		this.fitFloor(lines.length);
		this.hideGapAbove();
		return lines;
	}

	private renderFramed(width: number): string[] {
		const inner = width - FRAME;
		if (inner < 4) return super.render(width);

		this.readSlots(Date.now());

		const lines = super.render(inner);
		if (lines.length < 2) return lines;

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
					side: this.chrome.promptTargetBadge(),
					path: this.chrome.cwd(),
					session: this.chrome.sessionName(),
					branch: this.chrome.bottomRuleLabel(),
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
			branch: this.chrome.bottomRuleLabel(),
			tasks: this.chrome.tasks(),
			timer: this.chrome.timer(),
			cache: this.chrome.cache(),
			context: this.chrome.context(this.borderColor),
			scroll: scrollIndicator("↓", this.hidden.below, this.borderColor),
		};
		lines[bottom] = bottomRule(width, labels, this.borderColor);
		for (let i = 1; i < bottom; i++) lines[i] = side + lines[i] + side;
		for (let i = bottom + 1; i < lines.length; i++) lines[i] = ` ${lines[i]}`;

		const box = this.lit(lines.slice(0, bottom + 1), Date.now());
		if (box !== null) for (let i = 0; i <= bottom; i++) lines[i] = box[i] ?? lines[i];
		return lines;
	}

	private lit(rows: string[], now: number, folded = false): string[] | null {
		if (!WAVE) return null;
		try {
			const light = boxLight(now);
			if (light !== null) {
				const t = (now - light.since) / 1000;
				if (folded) return rows.map((row) => shadeLine(row, t, "self", { light: FOLDED_BAR_LIGHT, fade: light.fade }));
				return shadeBox(rows, t, { light: ONE_HUE, fade: light.fade });
			}
			const wake = boxWake(now);
			if (wake === null) return null;
			const t = (now - wake.since) / 1000;
			const shone = folded
				? rows.map((row) => shadeLine(row, t, "self", { light: FOLDED_BAR_LIGHT, fade: 1 - wake.light }))
				: shadeBox(rows, t, { light: ONE_HUE, tint: isNotFrame, fade: 1 - wake.light });
			return greyOut(shone, wake.grey);
		} catch {
			return null;
		}
	}

	private readSlots(now: number): void {
		if (now - this.slotsReadAt < SLOT_REFRESH_MS) return;
		this.slotsReadAt = now;
		this.slots.refresh();
	}

}

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	const animationClock = createAnimationClock(() => tui?.requestRender());
	let sessionId = "";
	const ruleTickers = createRuleTickers(() => tui, () => nextRedrawMs(readCacheTouch(sessionId), Date.now(), seatWantsWarming(sessionId)));
	let waveFrames: ReleaseFrames | undefined;
	let settleFadeTimer: ReturnType<typeof setTimeout> | undefined;
	let wakeFrames: ReleaseFrames | undefined;
	let unframe: (() => void) | undefined;

	function startWakeFrames(): void {
		if (wakeFrames || !tui || !WAVE || waking.since === null) return;
		wakeFrames = animationClock.demandFrames(FRAME_MS, () => {
			if (boxWake(Date.now()) === null) stopWakeFrames();
		});
	}

	function stopWakeFrames(): void {
		wakeFrames?.();
		wakeFrames = undefined;
	}

	function stopWaking(): void {
		waking.since = null;
		stopWakeFrames();
	}

	const levelFlash = createLevelFlash(animationClock, () => tui, WAVE);
	const taskCountGlow = createTaskCountGlow(animationClock, () => tui, WAVE);

	const turnStarted = (_event: unknown, ctx: ExtensionContext) => {
		if (!ownsTurnClock(ctx)) return;
		advanceTurnClock("turn_start", Date.now());
		fading.light = null;
		stopWaking();
		ruleTickers.stopCacheTicker();
		ruleTickers.startTurnTicker();
		if (!waveFrames && tui && WAVE) waveFrames = animationClock.demandFrames(FRAME_MS);
	};


	pi.on("before_agent_start", turnStarted);
	pi.on("agent_start", turnStarted);

	pi.on("agent_settled", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		const since = runningSince();
		const now = Date.now();
		advanceTurnClock("turn_settled", now);
		fading.light = since === null ? null : { since, settledAt: now };
		const frames = waveFrames;
		if (frames) {
			clearTimeout(settleFadeTimer);
			// raw-timer: the chrome's fade and ticker timers, back from main's animation-clock rewrite after the scope sweep, pending their move onto the scope
			settleFadeTimer = setTimeout(() => {
				if (waveFrames === frames && runningSince() === null) {
					frames();
					waveFrames = undefined;
				}
				tui?.requestRender();
			}, FADE_MS + FRAME_MS).unref();
		}
		ruleTickers.stopTurnTicker();
		tui?.requestRender();
		sessionId = ctx.sessionManager.getSessionId();
		ruleTickers.startCacheTicker();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		levelFlash.flashLevel();
	});

	pi.on("session_shutdown", () => {
		ruleTickers.stopCacheTicker();
		ruleTickers.stopTurnTicker();
		levelFlash.stopFlash();
		taskCountGlow.stopTaskFrames();
		stopWakeFrames();
		clearTimeout(settleFadeTimer);
		settleFadeTimer = undefined;
		waveFrames = undefined;
		animationClock.releaseAllFrames();
		unframe?.();
		unframe = undefined;
		if (tui) restoreDockLayout(tui);
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ownsTurnClock(ctx)) return;
		advanceTurnClock("session_reset", Date.now());
		stopWaking();
		if (WAVE) waking.since = Date.now();
		levelFlash.stopFlash();
		taskCountGlow.stopTaskFrames();

		unframe = frameUserMessages(() => ctx.ui.theme);

		ctx.ui.setWorkingVisible(false);

		let footerData: ReadonlyFooterDataProvider | undefined;
		const chrome = new ChromeState(ctx, () => footerData, levelFlash.flashedAt, taskCountGlow.taskGlow);

		ctx.ui.setFooter((tui, theme, data) => {
			footerData = data;
			return createStatusFooter(tui, theme, data);
		});

		ctx.ui.setEditorComponent((editorTui, theme, keybindings) => {
			tui = editorTui;
			startWakeFrames();
			return new ChromeEditor(editorTui, theme, keybindings, chrome);
		});

		startWakeFrames();
	});
}
