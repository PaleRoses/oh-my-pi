import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	saveLearnedLesson,
	startMemoryStartupTask,
} from "../memories";
import type { MemoryBackend, MemoryBackendRuntime } from "./types";

/**
 * Wraps the existing `memories/` module as a `MemoryBackend`.
 *
 * The rollout-summarisation pipeline (rollouts → SQLite → memory_summary.md) is
 * delegated unchanged. On top of it, `save()` persists `learn`-tool lessons to
 * `learned.md` (so `status()` reports `writable: true`); structured search is
 * still unavailable.
 */
export const localBackend: MemoryBackend = {
	id: "local",
	capabilities: {
		recall: false,
		retain: false,
		reflect: false,
		edit: false,
		save: true,
	},
	start(options) {
		startMemoryStartupTask(options);
	},
	runtime(context): MemoryBackendRuntime {
		return {
			capabilities: localBackend.capabilities,
			identity() {
				return { backend: "local", status: "active" };
			},
			mentalModels() {
				return { backend: "local", status: "unsupported" };
			},
			async dispose() {
				// Local memory owns no transcript-scoped provider state.
			},
			async flush() {
				// Consolidation remains explicitly owned by enqueue().
			},
			rekey() {
				// Local memory is not keyed by the provider session id.
			},
			async resetTranscript() {
				return false;
			},
			async status() {
				return {
					backend: "local",
					active: true,
					writable: true,
					searchable: false,
					message:
						"Local rollout-summary memory is active; lessons from the `learn` tool are saved to learned.md. Structured search is not available.",
				};
			},
			async search(query) {
				return {
					backend: "local",
					query,
					count: 0,
					items: [],
					message: "Memory search is not available for the local backend.",
				};
			},
			async save(input) {
				return await saveLearnedLesson(context.agentDir, context.cwd, input);
			},
			async retain() {
				return {
					backend: "local",
					accepted: 0,
					stored: 0,
					queued: false,
					message: "Memory retain is not available for the local backend.",
				};
			},
			async recall(query) {
				return {
					backend: "local",
					query,
					count: 0,
					items: [],
					rendered: "",
					message: "Memory recall is not available for the local backend.",
				};
			},
			async reflect() {
				return {
					backend: "local",
					text: "",
					message: "Memory reflect is not available for the local backend.",
				};
			},
			async edit() {
				return {
					backend: "local",
					status: "unsupported",
					message: "Memory editing is not available for the local backend.",
				};
			},
		};
	},
	async buildDeveloperInstructions(agentDir, settings, session) {
		return buildMemoryToolDeveloperInstructions(agentDir, settings, session);
	},
	async clear(agentDir, cwd, session) {
		clearMemoryToolDeveloperInstructionsCache(session);
		await clearMemoryData(agentDir, cwd);
	},
	async enqueue(agentDir, cwd) {
		enqueueMemoryConsolidation(agentDir, cwd);
	},
};
