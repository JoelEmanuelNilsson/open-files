/** Absolute line span of one block inside the flattened preview stream. */
export interface PreviewBlockExtent {
	readonly start: number;
	readonly height: number;
}

/** Owner of one flattened preview line; blank separator rows have none. */
export interface PreviewLineRef {
	readonly blockIndex: number;
	readonly lineIndex: number;
}

/** Flattened preview stream: block spans plus per-line ownership. */
export interface PreviewLayout {
	readonly extents: readonly PreviewBlockExtent[];
	readonly lines: ReadonlyArray<PreviewLineRef | undefined>;
}

/** Stack block heights into one line stream separated by a blank row. */
export function layoutPreviewBlocks(heights: readonly number[]): PreviewLayout {
	const extents: PreviewBlockExtent[] = [];
	const lines: Array<PreviewLineRef | undefined> = [];
	for (const [blockIndex, height] of heights.entries()) {
		if (blockIndex > 0) lines.push(undefined);
		extents.push({ start: lines.length, height });
		for (let lineIndex = 0; lineIndex < height; lineIndex++) lines.push({ blockIndex, lineIndex });
	}
	return { extents, lines };
}

export class BlockNavigator {
	private extents: readonly PreviewBlockExtent[] = [];
	private lineCount = 0;
	private visibleCount = 1;
	private selectedIndex = 0;
	private offsetValue = 0;

	public get selected(): number {
		return this.selectedIndex;
	}

	public get blockCount(): number {
		return this.extents.length;
	}

	public get offset(): number {
		return this.offsetValue;
	}

	public get maxOffset(): number {
		return Math.max(0, this.lineCount - this.visibleCount);
	}

	public setExtent(layout: PreviewLayout, visibleCount: number): void {
		this.extents = layout.extents;
		this.lineCount = layout.lines.length;
		this.visibleCount = Math.max(1, visibleCount);
		this.selectedIndex = clamp(this.selectedIndex, this.extents.length - 1);
		this.offsetValue = clamp(this.offsetValue, this.maxOffset);
		if (!this.isSelectionAnchored()) this.revealSelected();
	}

	public stepBack(): boolean {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return false;
		if (block.start < this.offsetValue) return this.scrollTo(this.offsetValue - 1);
		return this.selectBlock(this.selectedIndex - 1, -1);
	}

	public stepForward(): boolean {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return false;
		if (block.start + block.height > this.offsetValue + this.visibleCount) {
			return this.scrollTo(this.offsetValue + 1);
		}
		return this.selectBlock(this.selectedIndex + 1, 1);
	}

	public page(direction: -1 | 1): boolean {
		if (this.extents.length === 0) return false;
		const offset = clamp(this.offsetValue + direction * this.visibleCount, this.maxOffset);
		if (offset === this.offsetValue) {
			const boundaryIndex = direction < 0 ? 0 : this.extents.length - 1;
			return this.moveTo(boundaryIndex, offset);
		}
		return this.moveTo(this.firstVisibleBlock(offset), offset);
	}

	public moveToFirst(): boolean {
		return this.moveTo(0, 0);
	}

	public moveToLast(): boolean {
		return this.moveTo(this.extents.length - 1, this.maxOffset);
	}

	public reset(): void {
		this.selectedIndex = 0;
		this.offsetValue = 0;
	}

	private selectBlock(index: number, direction: -1 | 1): boolean {
		if (index < 0 || index >= this.extents.length || index === this.selectedIndex) return false;
		this.selectedIndex = index;
		this.revealSelected(direction);
		return true;
	}

	private scrollTo(offset: number): boolean {
		const next = clamp(offset, this.maxOffset);
		if (next === this.offsetValue) return false;
		this.offsetValue = next;
		return true;
	}

	private moveTo(index: number, offset: number): boolean {
		const nextIndex = clamp(index, this.extents.length - 1);
		const nextOffset = clamp(offset, this.maxOffset);
		if (nextIndex === this.selectedIndex && nextOffset === this.offsetValue) return false;
		this.selectedIndex = nextIndex;
		this.offsetValue = nextOffset;
		return true;
	}

	private isSelectionAnchored(): boolean {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return true;
		const end = block.start + block.height;
		if (block.height <= this.visibleCount) {
			return block.start >= this.offsetValue && end <= this.offsetValue + this.visibleCount;
		}
		return block.start < this.offsetValue + this.visibleCount && end > this.offsetValue;
	}

	private revealSelected(direction?: -1 | 1): void {
		const block = this.extents[this.selectedIndex];
		if (block === undefined) return;
		const end = block.start + block.height;
		if (block.height > this.visibleCount) {
			if (direction === -1) this.scrollTo(end - this.visibleCount);
			else if (direction === 1 || !this.isSelectionAnchored()) this.scrollTo(block.start);
			return;
		}
		if (block.start < this.offsetValue) this.scrollTo(block.start);
		else if (end > this.offsetValue + this.visibleCount) this.scrollTo(end - this.visibleCount);
	}

	private firstVisibleBlock(offset: number): number {
		const end = offset + this.visibleCount;
		let firstIntersecting: number | undefined;
		for (const [index, block] of this.extents.entries()) {
			const blockEnd = block.start + block.height;
			if (block.start >= offset && blockEnd <= end) return index;
			if (firstIntersecting === undefined && block.start < end && blockEnd > offset) {
				firstIntersecting = index;
			}
		}
		return firstIntersecting ?? this.selectedIndex;
	}
}

function clamp(value: number, max: number): number {
	return Math.max(0, Math.min(max, value));
}
