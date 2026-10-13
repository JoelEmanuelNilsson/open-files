interface RejectionRoute {
	readonly realms: Map<object, (reason: unknown) => void>;
	readonly listener: (reason: unknown, promise: Promise<unknown>) => void;
	readonly sync: () => void;
}

const REJECTION_ROUTE = Symbol.for("pi-kit/workflow-sandbox/rejection-route");

/** Claim the unhandled rejections of promises descending from `realm` until the returned function is called. */
export function openRejectionRealm(realm: object, sink: (reason: unknown) => void): () => void {
	const route = rejectionRoute();
	route.realms.set(realm, sink);
	route.sync();
	return () => {
		route.realms.delete(realm);
		route.sync();
	};
}

function rejectionRoute(): RejectionRoute {
	// SAFETY: the slot is written only by this module with a RejectionRoute
	const slot = globalThis as { [REJECTION_ROUTE]?: RejectionRoute };
	const existing = slot[REJECTION_ROUTE];
	if (existing !== undefined) return existing;
	const realms = new Map<object, (reason: unknown) => void>();
	const listener = (reason: unknown, promise: Promise<unknown>): void => {
		for (const [realm, sink] of realms) {
			if (descendsFrom(promise, realm)) return sink(reason);
		}
		if (process.listenerCount("unhandledRejection") > 1) return;
		process.off("unhandledRejection", listener);
		void Promise.reject(reason);
		setImmediate(sync);
	};
	const sync = (): void => {
		const listening = process.listeners("unhandledRejection").includes(listener);
		if (realms.size > 0 && !listening) process.on("unhandledRejection", listener);
		if (realms.size === 0 && listening) process.off("unhandledRejection", listener);
	};
	slot[REJECTION_ROUTE] = { realms, listener, sync };
	return slot[REJECTION_ROUTE];
}

function descendsFrom(value: object, realm: object): boolean {
	try {
		return Object.prototype.isPrototypeOf.call(realm, value);
	} catch {
		return false;
	}
}
