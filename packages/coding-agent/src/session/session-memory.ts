/** Session memory backend lifecycle and transcript resets. */

import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import { memoryBackendToolNames } from "../memory-backend/tool-names";
import type { MemoryBackendIdentity, MemoryBackendRuntime, MemoryBackendStartOptions } from "../memory-backend/types";
import type { EffectiveSessionIdentity } from "./identity";

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionMemoryHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	isDisposed(): boolean;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	setBaseSystemPrompt(prompt: string[]): void;
	refreshBaseSystemPrompt(): Promise<void>;
	replaceMemoryTools(tools: AgentTool[]): Promise<void>;
}

/** Owns memory backend transitions and transcript-scoped memory state. */
export class SessionMemory {
	readonly #host: SessionMemoryHost;
	readonly #memoryAgentDir: string | undefined;
	readonly #memoryTaskDepth: number;
	readonly #identity: EffectiveSessionIdentity;
	readonly #createMemoryTools: (() => Promise<AgentTool[]>) | undefined;
	#memoryBackendTransition: Promise<void> = Promise.resolve();
	#activeMemoryRuntime: MemoryBackendRuntime | undefined;
	#localMemoryStartupAbort: AbortController | undefined;
	#baseSystemPromptBeforeMemoryPromotion: string[] | undefined;

	constructor(
		host: SessionMemoryHost,
		options: {
			identity: EffectiveSessionIdentity;
			memoryAgentDir?: string;
			memoryTaskDepth?: number;
			createMemoryTools?: () => Promise<AgentTool[]>;
		},
	) {
		this.#host = host;
		this.#identity = options.identity;
		this.#memoryAgentDir = options.memoryAgentDir;
		this.#memoryTaskDepth = options.memoryTaskDepth ?? 0;
		this.#createMemoryTools = options.createMemoryTools;
	}

	/** Current serialized backend transition, used by prompt and disposal drains. */
	get transition(): Promise<void> {
		return this.#memoryBackendTransition;
	}

	/** Synchronous provider-owned identity for session/UI consumers. */
	identity(): MemoryBackendIdentity | undefined {
		return this.#activeMemoryRuntime?.identity();
	}

	#serializeMemoryTransition(action: () => Promise<void>): Promise<void> {
		const transition = this.#memoryBackendTransition.then(action);
		this.#memoryBackendTransition = transition.then(
			() => undefined,
			() => undefined,
		);
		return transition;
	}

	/** Base prompt captured before a per-turn memory promotion. */
	get promotionSnapshot(): string[] | undefined {
		return this.#baseSystemPromptBeforeMemoryPromotion;
	}

	/** Clears the per-turn memory promotion after a canonical prompt rebuild. */
	clearPromotionSnapshot(): void {
		this.#baseSystemPromptBeforeMemoryPromotion = undefined;
	}

	/** Captures the canonical prompt before the first per-turn memory promotion. */
	capturePromotionSnapshot(prompt: string[]): void {
		this.#baseSystemPromptBeforeMemoryPromotion ??= prompt;
	}

	/** Restores a promotion snapshot while rolling back a failed session switch. */
	restorePromotionSnapshot(prompt: string[] | undefined): void {
		this.#baseSystemPromptBeforeMemoryPromotion = prompt;
	}

	/** Rekeys the active backend to the current provider session. */
	rekeyForCurrentSessionId(): void {
		const sessionId = this.#host.agent.sessionId;
		if (sessionId) this.#activeMemoryRuntime?.rekey(sessionId);
	}

	/** Resets transcript-scoped memory counters and removes a promoted prompt. */
	async resetContextForNewTranscript(): Promise<void> {
		const hadPromotedMemoryPrompt = this.#baseSystemPromptBeforeMemoryPromotion !== undefined;
		const resetMemoryTracking = (await this.#activeMemoryRuntime?.resetTranscript()) ?? false;
		if (hadPromotedMemoryPrompt) {
			this.#host.setBaseSystemPrompt(this.#baseSystemPromptBeforeMemoryPromotion!);
			this.#baseSystemPromptBeforeMemoryPromotion = undefined;
		}
		if (resetMemoryTracking || hadPromotedMemoryPrompt) {
			await this.#host.refreshBaseSystemPrompt();
		}
	}

	/** Cancel the local rollout-memory startup owned by this session. */
	cancelLocalMemoryStartup(): void {
		this.#localMemoryStartupAbort?.abort();
		this.#localMemoryStartupAbort = undefined;
	}

	/** Start a new local rollout-memory generation and cancel its predecessor. */
	beginLocalMemoryStartup(): AbortSignal {
		this.cancelLocalMemoryStartup();
		const controller = new AbortController();
		this.#localMemoryStartupAbort = controller;
		return controller.signal;
	}

	/** Release the local startup slot if `signal` still owns it. */
	endLocalMemoryStartup(signal: AbortSignal): void {
		if (this.#localMemoryStartupAbort?.signal === signal) this.#localMemoryStartupAbort = undefined;
	}

	async #disposeMemoryBackendState(persistPending = true): Promise<void> {
		this.cancelLocalMemoryStartup();
		const runtime = this.#activeMemoryRuntime;
		this.#activeMemoryRuntime = undefined;
		if (!runtime) return;
		try {
			await runtime.dispose({ persistPending });
		} catch (error) {
			logger.warn("Memory lifecycle: backend dispose failed", { error: String(error) });
		}
	}

	/**
	 * Apply the selected memory backend to runtime state, tools, and prompt.
	 * Concurrent settings changes run in order and settle before the next turn.
	 */
	async applyMemoryBackend(): Promise<void> {
		if (this.#host.isDisposed()) return;
		await this.#serializeMemoryTransition(() => this.#applyMemoryBackend());
	}

	/** Release the active provider runtime after all pending backend transitions settle. */
	async dispose(persistPending = true): Promise<void> {
		await this.#serializeMemoryTransition(() => this.#disposeMemoryBackendState(persistPending));
	}

	/** Start and retain the selected provider runtime for a session-owned backend. */
	async start(options: MemoryBackendStartOptions): Promise<void> {
		if (this.#host.isDisposed()) return;
		await this.#serializeMemoryTransition(async () => {
			if (this.#host.isDisposed()) return;
			await this.#disposeMemoryBackendState();
			try {
				await this.#startMemoryBackend(options);
			} catch (error) {
				await this.#disposeMemoryBackendState(false);
				throw error;
			}
		});
	}

	async #startMemoryBackend(options: MemoryBackendStartOptions): Promise<void> {
		const backend = await resolveMemoryBackend(options.settings);
		this.#activeMemoryRuntime = backend.runtime({
			agentDir: options.agentDir,
			cwd: options.settings.getCwd(),
			session: options.session,
		});
		await backend.start(options);
	}

	async #applyMemoryBackend(): Promise<void> {
		if (this.#host.isDisposed()) return;
		try {
			await this.#disposeMemoryBackendState();
			if (
				this.#identity.memory.status === "enabled" &&
				this.#memoryAgentDir &&
				this.#memoryTaskDepth === 0 &&
				!this.#host.isDisposed()
			) {
				await this.#startMemoryBackend({
					session: this.#host.memoryBackendSession(),
					settings: this.#host.settings,
					modelRegistry: this.#host.modelRegistry,
					agentDir: this.#memoryAgentDir,
					taskDepth: this.#memoryTaskDepth,
				});
			}
			if (this.#host.isDisposed()) return;
			await this.#refreshMemoryTools();
			if (this.#host.isDisposed()) return;
			await this.#host.refreshBaseSystemPrompt();
		} catch (error) {
			await this.#disposeMemoryBackendState(false);
			if (!this.#host.isDisposed()) {
				await this.#replaceMemoryTools([]).catch(refreshError => {
					logger.warn("Failed to remove memory tools after backend apply error", {
						error: String(refreshError),
					});
				});
			}
			throw error;
		}
	}

	async #refreshMemoryTools(): Promise<void> {
		let tools: AgentTool[] = [];
		if (this.#identity.memory.status === "enabled") {
			const backend = await resolveMemoryBackend(this.#host.settings);
			const admittedNames = new Set<string>(memoryBackendToolNames(backend.capabilities));
			tools = ((await this.#createMemoryTools?.()) ?? []).filter(tool => admittedNames.has(tool.name));
		}
		await this.#replaceMemoryTools(tools);
	}
	#replaceMemoryTools(tools: AgentTool[]): Promise<void> {
		return this.#host.replaceMemoryTools(tools);
	}
}
