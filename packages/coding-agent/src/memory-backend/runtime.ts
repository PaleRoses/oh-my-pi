import type { AgentSession } from "../session/agent-session";
import { resolveMemoryBackend } from "./resolve";
import type {
	MemoryBackendCapabilities,
	MemoryBackendEditInput,
	MemoryBackendOperationContext,
	MemoryBackendReflectInput,
	MemoryBackendRetainInput,
	MemoryBackendRuntime,
	MemoryBackendSaveInput,
	MemoryBackendSearchOptions,
	MemoryRuntimeContext,
} from "./types";

const NO_MEMORY_CAPABILITIES: MemoryBackendCapabilities = {
	recall: false,
	retain: false,
	reflect: false,
	edit: false,
	save: false,
};

/**
 * Resolve the selected backend lazily and expose only its typed runtime.
 *
 * The cached provider runtime is invalidated when settings select a different
 * backend, so extensions and tools observe live backend changes without ever
 * reaching into provider session state.
 */
export function createMemoryRuntimeContext(context: MemoryBackendOperationContext): MemoryRuntimeContext {
	const settings = context.settings ?? context.session?.settings;
	let backendId: string | undefined;
	let runtime: MemoryBackendRuntime | undefined;

	const resolveRuntime = async (): Promise<MemoryBackendRuntime | undefined> => {
		if (!settings) return undefined;
		const nextId = settings.get("memory.backend");
		if (!runtime || backendId !== nextId) {
			const backend = await resolveMemoryBackend(settings);
			backendId = backend.id;
			runtime = backend.runtime(context);
		}
		return runtime;
	};

	return {
		async capabilities() {
			return (await resolveRuntime())?.capabilities ?? NO_MEMORY_CAPABILITIES;
		},
		async identity() {
			return (await resolveRuntime())?.identity() ?? { backend: "off", status: "off" };
		},
		async mentalModels() {
			return (await resolveRuntime())?.mentalModels() ?? { backend: "off", status: "unsupported" };
		},
		async status() {
			return (
				(await resolveRuntime())?.status() ?? {
					backend: "off",
					active: false,
					writable: false,
					searchable: false,
					message: "No active agent session.",
				}
			);
		},
		async search(query: string, options?: MemoryBackendSearchOptions) {
			return (
				(await resolveRuntime())?.search(query, options) ?? {
					backend: "off",
					query,
					count: 0,
					items: [],
					message: "No active agent session.",
				}
			);
		},
		async save(input: string | MemoryBackendSaveInput) {
			const normalized = typeof input === "string" ? { content: input } : input;
			return (
				(await resolveRuntime())?.save(normalized) ?? {
					backend: "off",
					stored: 0,
					message: "No active agent session.",
				}
			);
		},
		async retain(input: MemoryBackendRetainInput) {
			return (
				(await resolveRuntime())?.retain(input) ?? {
					backend: "off",
					accepted: 0,
					stored: 0,
					queued: false,
					message: "No active agent session.",
				}
			);
		},
		async recall(query: string, options?: MemoryBackendSearchOptions) {
			return (
				(await resolveRuntime())?.recall(query, options) ?? {
					backend: "off",
					query,
					count: 0,
					items: [],
					rendered: "",
					message: "No active agent session.",
				}
			);
		},
		async reflect(input: MemoryBackendReflectInput) {
			return (
				(await resolveRuntime())?.reflect(input) ?? {
					backend: "off",
					text: "",
					message: "No active agent session.",
				}
			);
		},
		async edit(input: MemoryBackendEditInput) {
			return (
				(await resolveRuntime())?.edit(input) ?? {
					backend: "off",
					status: "unsupported",
					message: "No active agent session.",
				}
			);
		},
	};
}

export function createSessionMemoryRuntimeContext(session: AgentSession, agentDir: string): MemoryRuntimeContext {
	return createMemoryRuntimeContext({
		agentDir,
		get cwd() {
			return session.sessionManager.getCwd();
		},
		session,
	});
}
