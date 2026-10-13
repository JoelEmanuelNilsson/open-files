/** A tool name lowered for matching; `""` for anything that is not a string, which matches no tool. */
export const lowerToolName = (name: unknown): string => (typeof name === "string" ? name.toLowerCase() : "");
