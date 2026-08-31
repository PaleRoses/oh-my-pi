import type { MemoryBackendCapabilities } from "./types";

/** Built-in tools whose availability depends on the selected memory backend. */
export const MEMORY_BACKEND_TOOL_NAMES = ["retain", "recall", "reflect", "memory_edit", "learn"] as const;

export type MemoryBackendToolName = (typeof MEMORY_BACKEND_TOOL_NAMES)[number];

const MEMORY_TOOL_CAPABILITY = {
	retain: "retain",
	recall: "recall",
	reflect: "reflect",
	memory_edit: "edit",
	learn: "save",
} satisfies Record<MemoryBackendToolName, keyof MemoryBackendCapabilities>;

/** Projects provider-owned operation capabilities onto the built-in tool surface. */
export function memoryBackendToolNames(capabilities: MemoryBackendCapabilities): MemoryBackendToolName[] {
	return MEMORY_BACKEND_TOOL_NAMES.filter(name => capabilities[MEMORY_TOOL_CAPABILITY[name]]);
}
