/**
 * The repaint clock of whichever dock overlay is open.
 *
 * A running row is animated, so an open task list needs ~10fps while a child is
 * live — and nothing at all otherwise. The expensive state is made unreachable
 * rather than guarded: the timer's only effect is to call a refresh function
 * this object holds, so it is created by `attach` and destroyed by `detach`,
 * and it exists only while the attached view says it needs frames. There is one
 * place that can start it (`tune`) and it re-derives the answer from scratch
 * every time it is called — including on every frame it fires, which is how the
 * clock stops itself the moment the last agent settles.
 *
 * An overlay that does not animate says so by attaching without a claim: the
 * conversation box repaints on its events and never runs a timer.
 */
export class ModalRepaint {
	private readonly frameMs: number;
	private refresh: (() => void) | undefined;
	private needsFrames: () => boolean = () => false;
	private timer: ReturnType<typeof setInterval> | undefined;

	public constructor(frameMs: number) {
		this.frameMs = frameMs;
	}

	/** An overlay opened: its repaint function, and whether it has anything to animate right now. */
	public attach(refresh: () => void, needsFrames: () => boolean = () => false): void {
		this.refresh = refresh;
		this.needsFrames = needsFrames;
		this.tune();
	}

	/** The overlay closed. Nothing to repaint, so nothing to run. */
	public detach(): void {
		this.refresh = undefined;
		this.needsFrames = () => false;
		this.tune();
	}

	/** Repaint now, and re-derive the clock: call whenever anything an overlay shows has changed. */
	public paint(): void {
		this.refresh?.();
		this.tune();
	}

	/** Whether a timer is running. For tests and for saying what state this is in. */
	public get animating(): boolean {
		return this.timer !== undefined;
	}

	private tune(): void {
		const wanted = this.refresh !== undefined && this.needsFrames();
		if (wanted === (this.timer !== undefined)) return;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
			return;
		}
		const timer = setInterval(() => this.paint(), this.frameMs);
		timer.unref?.();
		this.timer = timer;
	}
}
