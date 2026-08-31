import type { MemoryBackend, MemoryBackendRuntime } from "./types";

/**
 * No-op memory backend.
 *
 * Selected when `memory.backend` is `"off"`.
 */
export const offBackend: MemoryBackend = {
	id: "off",
	capabilities: {
		recall: false,
		retain: false,
		reflect: false,
		edit: false,
		save: false,
	},
	async start() {},
	runtime(): MemoryBackendRuntime {
		return {
			capabilities: offBackend.capabilities,
			identity() {
				return { backend: "off", status: "off" };
			},
			mentalModels() {
				return { backend: "off", status: "unsupported" };
			},
			async dispose() {},
			async flush() {},
			rekey() {},
			async resetTranscript() {
				return false;
			},
			async status() {
				return {
					backend: "off",
					active: false,
					writable: false,
					searchable: false,
					message: "Memory backend is off.",
				};
			},
			async search(query) {
				return { backend: "off", query, count: 0, items: [], message: "Memory backend is off." };
			},
			async save() {
				return { backend: "off", stored: 0, message: "Memory backend is off." };
			},
			async retain() {
				return { backend: "off", accepted: 0, stored: 0, queued: false, message: "Memory backend is off." };
			},
			async recall(query) {
				return { backend: "off", query, count: 0, items: [], rendered: "", message: "Memory backend is off." };
			},
			async reflect() {
				return { backend: "off", text: "", message: "Memory backend is off." };
			},
			async edit() {
				return { backend: "off", status: "unsupported", message: "Memory backend is off." };
			},
		};
	},
	async buildDeveloperInstructions() {
		return undefined;
	},
	async clear() {},
	async enqueue() {},
};
