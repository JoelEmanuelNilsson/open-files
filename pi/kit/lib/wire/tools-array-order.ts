export function canonicalToolOrder(tools: readonly unknown[]): unknown[] {
	try {
		const active = tools.filter((tool) => !isDeferred(tool)).sort((left, right) => (nameOf(left) < nameOf(right) ? -1 : nameOf(left) > nameOf(right) ? 1 : 0));
		return placeBreakpoint([...active, ...tools.filter(isDeferred)]);
	} catch {
		return [...tools];
	}
}

function placeBreakpoint(tools: unknown[]): unknown[] {
	const target = breakpointHolder(tools);
	let breakpoint: unknown;
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index];
		if (index === target || !isRecord(tool) || tool.cache_control === undefined) continue;
		const { cache_control, ...rest } = tool;
		breakpoint ??= cache_control;
		tools[index] = rest;
	}
	if (target < 0 || breakpoint === undefined) return tools;
	const holder = tools[target];
	if (isRecord(holder) && holder.cache_control === undefined) tools[target] = { ...holder, cache_control: breakpoint };
	return tools;
}

function breakpointHolder(tools: readonly unknown[]): number {
	for (let index = tools.length - 1; index >= 0; index--) {
		const tool = tools[index];
		if (isRecord(tool) && !isDeferred(tool)) return index;
	}
	return -1;
}

function isDeferred(tool: unknown): boolean {
	return isRecord(tool) && tool.defer_loading === true;
}

const nameOf = (tool: unknown): string => (isRecord(tool) && typeof tool.name === "string" ? tool.name : "");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
