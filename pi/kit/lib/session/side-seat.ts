import { processShared } from "../process/process-shared-state.ts";

/** What a side seat's requests are built from: main's session and main's last payload. */
export interface SideRequestBasis {
	readonly mainSessionId: string;
	readonly mainPayload: Record<string, unknown> | undefined;
}

const sideSeats = (): Map<string, SideRequestBasis> => processShared("__piKitSideSeats", () => new Map<string, SideRequestBasis>());

/** Declare `sideSessionId` a side seat of `basis.mainSessionId`; the payload is cloned here. */
export function publishSideRequestBasis(sideSessionId: string, basis: SideRequestBasis): void {
	sideSeats().set(sideSessionId, {
		mainSessionId: basis.mainSessionId,
		mainPayload: basis.mainPayload === undefined ? undefined : structuredClone(basis.mainPayload),
	});
}

/** The basis a side seat's next request is built from, or undefined for any other session. */
export function readSideRequestBasis(sideSessionId: string): SideRequestBasis | undefined {
	return sideSeats().get(sideSessionId);
}

/** Drop a side seat once its session is disposed. */
export function forgetSideRequestBasis(sideSessionId: string): void {
	sideSeats().delete(sideSessionId);
}
