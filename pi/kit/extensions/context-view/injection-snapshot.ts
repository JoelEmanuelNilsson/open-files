/** Source id of pi-native injections. */
export const PI_SOURCE_ID = "pi";
/** Source id of the injections no single extension can be credited with. */
export const AGGREGATE_SOURCE_ID = "aggregate:extensions";

export type CaptureOrigin = "real-turn" | "pi-native";

/** The frozen lifecycle phase represented by the v0.2.0 injection model. */
export type InjectionPhase = "initial";

/** What kind of context data an injection item is. */
export type InjectionKind =
	| "base-prompt"
	| "append-prompt"
	| "context-file"
	| "skills"
	| "tool"
	| "prompt-addition"
	| "message";

/** Who contributed one or more injection items. */
export interface InjectionSource {
	readonly id: string;
	readonly label: string;
	readonly native: boolean;
}

/** One measured context injection. */
export interface InjectionItem {
	readonly id: string;
	readonly phase: InjectionPhase;
	readonly kind: InjectionKind;
	readonly source: InjectionSource;
	readonly label: string;
	readonly chars: number;
	readonly tokens: number;
	readonly text: string;
	readonly contextOnly?: boolean;
	readonly children?: readonly InjectionItem[];
}

/** Items of one source, with a precomputed total. */
export interface InjectionGroup {
	readonly source: InjectionSource;
	readonly items: readonly InjectionItem[];
	readonly totalTokens: number;
}

/** The frozen Initial snapshot presented by the Injections view. */
export interface InitialSnapshot {
	readonly origin: CaptureOrigin;
	readonly capturedAt: Date;
	readonly groups: readonly InjectionGroup[];
	readonly totalTokens: number;
}

/** The unattributable source: prompt additions and context-only messages extensions made. */
export const AGGREGATE_SOURCE: InjectionSource = {
	id: AGGREGATE_SOURCE_ID,
	label: "extensions (aggregate)",
	native: false,
};

export function groupInjections(items: readonly InjectionItem[]): InjectionGroup[] {
	const groups = new Map<string, MutableGroup>();
	for (const input of items) {
		const item = copyItem(input);
		let group = groups.get(item.source.id);
		if (group === undefined) {
			group = { source: item.source, items: [], totalTokens: 0 };
			groups.set(item.source.id, group);
		}
		group.items.push(item);
		group.totalTokens += item.tokens;
	}
	for (const group of groups.values()) {
		group.items.sort(compareItems);
	}
	return [...groups.values()].sort(compareGroups);
}

/** Build an owned Initial snapshot from measured items. */
export function buildInitialSnapshot(
	items: readonly InjectionItem[],
	origin: CaptureOrigin,
	capturedAt: Date,
): InitialSnapshot {
	const groups = groupInjections(items);
	return {
		origin,
		capturedAt: new Date(capturedAt),
		groups,
		totalTokens: groups.reduce((sum, group) => sum + group.totalTokens, 0),
	};
}

/** Messages that existed only in the transformed provider context, not the session branch. */
export function contextOnlyItems(snapshot: InitialSnapshot): InjectionItem[] {
	return snapshot.groups.flatMap((group) =>
		group.items.filter((item) => item.kind === "message" && item.contextOnly === true)
	);
}

interface MutableGroup {
	source: InjectionSource;
	items: InjectionItem[];
	totalTokens: number;
}

function copyItem(item: InjectionItem): InjectionItem {
	return {
		...item,
		source: { ...item.source },
		children: item.children?.map((child) => copyItem(child)),
	};
}

function compareItems(a: InjectionItem, b: InjectionItem): number {
	const rankDelta = itemRank(a) - itemRank(b);
	if (rankDelta !== 0) return rankDelta;
	return b.tokens - a.tokens;
}

function itemRank(item: InjectionItem): number {
	switch (item.kind) {
		case "base-prompt":
		case "append-prompt":
			return 0;
		case "tool":
			return item.id === "tool:builtin" ? 1 : 2;
		case "skills":
			return 3;
		default:
			return 4;
	}
}

function compareGroups(a: InjectionGroup, b: InjectionGroup): number {
	if (a.source.native !== b.source.native) return a.source.native ? -1 : 1;
	const aAggregate = a.source.id === AGGREGATE_SOURCE_ID;
	const bAggregate = b.source.id === AGGREGATE_SOURCE_ID;
	if (aAggregate !== bAggregate) return aAggregate ? 1 : -1;
	return b.totalTokens - a.totalTokens;
}
