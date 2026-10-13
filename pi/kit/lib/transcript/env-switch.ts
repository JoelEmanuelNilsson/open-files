/** Whether the env switch `name` is set to `off`, in any case. Read on every call, never cached. */
export function envSwitchOff(name: string): boolean {
	return (process.env[name] ?? "").toLowerCase() === "off";
}
