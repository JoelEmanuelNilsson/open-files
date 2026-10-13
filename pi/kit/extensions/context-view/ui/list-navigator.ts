export class ListNavigator {
	private readonly rowCount: number;
	private readonly selectableRowCount: number;
	private visibleCount: number;
	private selectedIndex = 0;
	private scrollOffset = 0;

	public constructor(rowCount: number, visibleCount: number, selectableRowCount = rowCount) {
		this.rowCount = Math.max(0, rowCount);
		this.selectableRowCount = Math.min(this.rowCount, Math.max(0, selectableRowCount));
		this.visibleCount = Math.max(1, visibleCount);
	}

	public get selected(): number {
		return this.selectedIndex;
	}

	public get selectedOrdinal(): number {
		return this.selectedIndex;
	}

	public get selectableCount(): number {
		return this.selectableRowCount;
	}

	public get offset(): number {
		return this.scrollOffset;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.rowCount);
	}

	public get visibleEnd(): number {
		return Math.min(this.rowCount, this.scrollOffset + this.windowSize);
	}

	public get hasOverflow(): boolean {
		return this.rowCount > this.visibleCount;
	}

	public setVisibleCount(count: number): void {
		this.visibleCount = Math.max(1, count);
		this.ensureVisible();
	}

	public moveBy(delta: number): boolean {
		return this.moveTo(this.selectedIndex + delta);
	}

	public moveTo(index: number): boolean {
		if (this.selectableRowCount === 0) return false;
		const next = Math.min(this.selectableRowCount - 1, Math.max(0, index));
		if (next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.ensureVisible();
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.moveBy(direction * Math.max(1, this.visibleCount - 1));
	}

	private ensureVisible(): void {
		const maxOffset = Math.max(0, this.rowCount - this.visibleCount);
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + this.visibleCount) {
			this.scrollOffset = this.selectedIndex - this.visibleCount + 1;
		}

		const trailingRows = this.rowCount - this.selectedIndex - 1;
		if (this.selectedIndex === this.selectableRowCount - 1 && trailingRows < this.visibleCount) {
			this.scrollOffset = maxOffset;
		}
		this.scrollOffset = Math.min(maxOffset, Math.max(0, this.scrollOffset));
	}
}

export class PreviewScroller {
	private lineCount = 0;
	private visibleCount = 1;
	private offsetValue = 0;

	public get offset(): number {
		return this.offsetValue;
	}

	public get windowSize(): number {
		return Math.min(this.visibleCount, this.lineCount);
	}

	public get visibleEnd(): number {
		return Math.min(this.lineCount, this.offsetValue + this.windowSize);
	}

	public get hasOverflow(): boolean {
		return this.lineCount > this.visibleCount;
	}

	public get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	public setExtent(lineCount: number, visibleCount: number): void {
		this.lineCount = Math.max(0, lineCount);
		this.visibleCount = Math.max(1, visibleCount);
		this.offsetValue = Math.min(this.maxOffset, this.offsetValue);
	}

	public scrollBy(delta: number): boolean {
		return this.scrollTo(this.offsetValue + delta);
	}

	public scrollTo(offset: number): boolean {
		const next = Math.min(this.maxOffset, Math.max(0, offset));
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	public page(direction: -1 | 1): boolean {
		return this.scrollBy(direction * Math.max(1, this.visibleCount - 1));
	}

	public reset(): void {
		this.offsetValue = 0;
	}
}
