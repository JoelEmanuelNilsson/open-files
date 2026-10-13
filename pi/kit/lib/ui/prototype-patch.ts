type Method = (this: never, ...args: never[]) => unknown;
type Marked = { [marker: symbol]: unknown };

export function patchPrototypeMethod<M extends Method>(prototype: object, method: string, marker: symbol, wrap: (original: M) => M): () => void {
	// SAFETY: prototype is a class prototype whose method slots hold functions of type M
	const slots = prototype as Record<string, M & Marked>;
	const previous = slots[method]?.[marker];
	if (previous) {
		// SAFETY: slots[method][marker] is stored by this function as the original M
		slots[method] = previous as M & Marked;
	}

	const original = slots[method];
	const wrapper = Object.assign(wrap(original), { [marker]: original });
	slots[method] = wrapper;

	return () => {
		if (slots[method] === wrapper) slots[method] = original;
	};
}
