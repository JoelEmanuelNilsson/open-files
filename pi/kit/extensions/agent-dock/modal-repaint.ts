export class ModalRepaint {
	private readonly frameMs: number;
	private refresh: (() => void) | undefined;
	private needsFrames: () => boolean = () => false;
	private timer: ReturnType<typeof setInterval> | undefined;

	public constructor(frameMs: number) {
		this.frameMs = frameMs;
	}

	public attach(refresh: () => void, needsFrames: () => boolean = () => false): void {
		this.refresh = refresh;
		this.needsFrames = needsFrames;
		this.tune();
	}

	public detach(): void {
		this.refresh = undefined;
		this.needsFrames = () => false;
		this.tune();
	}

	public paint(): void {
		this.refresh?.();
		this.tune();
	}

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
		// raw-timer: a TUI component timer: an open overlay's frames
		const timer = setInterval(() => this.paint(), this.frameMs);
		timer.unref?.();
		this.timer = timer;
	}
}
