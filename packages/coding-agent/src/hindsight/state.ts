import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { formatIdentityModel } from "../session/identity";
import { type BankScope, ensureBankExists, resolveProjectLabel } from "./bank";
import type {
	HindsightApi,
	MemoryItemInput,
	MemoryProvenanceKey,
	MemoryProvenanceMetadata,
	MemoryProvenanceSource,
} from "./client";
import type { HindsightConfig } from "./config";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	truncateRecallQuery,
} from "./content";
import {
	ensureMentalModels,
	loadMentalModelsBlock,
	MENTAL_MODEL_FIRST_TURN_DEADLINE_MS,
	resolveSeedsForScope,
} from "./mental-models";
import { extractMessages } from "./transcript";

const RETAIN_FLUSH_BATCH_SIZE = 16;
const RETAIN_FLUSH_INTERVAL_MS = 5_000;
const RETENTION_METADATA_VALUE_MAX_CHARS = 512;

interface HindsightRouteSnapshot {
	readonly client: HindsightApi;
	readonly bankId: string;
	readonly projectLabel: string;
	readonly retainTags?: string[];
	readonly recallTags?: string[];
	readonly recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	readonly config: HindsightConfig;
	readonly banksSet: Set<string>;
}

interface PendingRetainItem {
	readonly content: string;
	readonly context?: string;
	readonly timestamp: Date;
	readonly metadata: Record<string, string>;
	readonly route: HindsightRouteSnapshot;
}

interface RecallOutcome {
	context: string | null;
	ok: boolean;
}

interface HindsightSessionStateBaseOptions {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	session: AgentSession;
	lastRetainedTurn?: number;
	hasRecalledForFirstTurn?: boolean;
}

interface HindsightPrimarySessionStateOptions extends HindsightSessionStateBaseOptions {
	client: HindsightApi;
	bankId: string;
	projectLabel?: string;
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	config: HindsightConfig;
	banksSet: Set<string>;
	aliasOf?: never;
}

interface HindsightAliasSessionStateOptions extends HindsightSessionStateBaseOptions {
	/** Resolve every operation through the primary parent's live state slot. */
	aliasOf: HindsightSessionState;
	client?: never;
	bankId?: never;
	projectLabel?: never;
	retainTags?: never;
	recallTags?: never;
	recallTagsMatch?: never;
	config?: never;
	banksSet?: never;
}

export type HindsightSessionStateOptions = HindsightPrimarySessionStateOptions | HindsightAliasSessionStateOptions;

/**
 * Debounced batch queue for tool-initiated `retain` calls owned by one
 * Hindsight session state instance.
 *
 * Auto-retain (`HindsightSessionState.retainSession`) is intentionally not
 * routed through this queue — it submits a full transcript as one large item
 * and already runs `async: true` server-side.
 */
export class HindsightRetainQueue {
	readonly #state: HindsightSessionState;
	#items: PendingRetainItem[] = [];
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;

	constructor(state: HindsightSessionState) {
		this.#state = state;
	}

	get depth(): number {
		return this.#items.length;
	}

	enqueue(content: string, context?: string): void {
		if (this.#closed) {
			throw new Error("Hindsight retain queue is closed.");
		}
		const route = this.#state.captureRoute();
		this.#items.push({
			content,
			context,
			timestamp: new Date(),
			metadata: buildRetentionMetadata(this.#state, "agent-retain", route.projectLabel),
			route,
		});

		if (this.#items.length >= RETAIN_FLUSH_BATCH_SIZE) {
			void this.flush();
			return;
		}
		if (!this.#timer) {
			this.#timer = setTimeout(() => {
				void this.flush();
			}, RETAIN_FLUSH_INTERVAL_MS);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) {
			// Coalesce: wait for the in-flight flush, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#items.length > 0) await this.flush();
			return;
		}

		if (this.#items.length === 0) return;

		const items = this.#items.splice(0);
		const flushPromise = this.#doFlush(items);
		this.#flushing = flushPromise;
		try {
			await flushPromise;
		} finally {
			this.#flushing = undefined;
		}
	}

	/**
	 * Refuse new intake before awaiting any in-flight write, then drain every
	 * item accepted before retirement. JavaScript executes the close flag and
	 * enqueue push synchronously, so no accepted retain can land behind the
	 * terminal drain.
	 */
	async retire(): Promise<void> {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		await this.flush();
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	async #doFlush(items: PendingRetainItem[]): Promise<void> {
		const sessionId = this.#state.sessionId;
		const groups = items.reduce((grouped, item) => {
			const group = grouped.get(item.route);
			if (group) group.push(item);
			else grouped.set(item.route, [item]);
			return grouped;
		}, new Map<HindsightRouteSnapshot, PendingRetainItem[]>());

		await Promise.all(
			Array.from(groups, async ([route, routeItems]) => {
				try {
					await ensureBankExists(route.client, route.bankId, route.config, route.banksSet);
					const batch: MemoryItemInput[] = routeItems.map(item => ({
						content: item.content,
						context: item.context ?? route.config.retainContext,
						metadata: item.metadata,
						tags: route.retainTags,
						timestamp: item.timestamp,
					}));
					await route.client.retainBatch(route.bankId, batch, { async: true });
					if (route.config.debug) {
						logger.debug("Hindsight retain queue: batch flushed", {
							sessionId,
							bankId: route.bankId,
							items: routeItems.length,
						});
					}
				} catch (err) {
					const errorText = err instanceof Error ? err.message : String(err);
					logger.warn("Hindsight retain queue: batch flush failed", {
						sessionId,
						bankId: route.bankId,
						items: routeItems.length,
						error: errorText,
					});
					this.#notifyRetainFailure(routeItems.length, errorText);
				}
			}),
		);
	}

	#notifyRetainFailure(count: number, errorText: string): void {
		const noun = count === 1 ? "memory" : "memories";
		this.#state.session.emitNotice(
			"warning",
			`Memory retention failed for ${count} ${noun}: ${errorText}`,
			"Hindsight",
		);
	}
}

/** Rolling hash of messages[0, count) for retention-cache validation (see #lastRetainedPrefixKey). */
function retentionPrefixKey(messages: HindsightMessage[], count: number): string {
	let key = "";
	for (let i = 0; i < count; i++) {
		const m = messages[i];
		if (m === undefined) break;
		key = Bun.hash(`${key}\u0000${m.role}\u0000${m.content}\u0000${m.timestamp ?? ""}`).toString(36);
	}
	return key;
}

function buildRetentionMetadata(
	state: HindsightSessionState,
	source: MemoryProvenanceSource,
	projectLabel = state.projectLabel,
): Record<string, string> {
	const metadata: Record<string, string> = {};
	const add = (key: MemoryProvenanceKey, value: unknown): void => {
		const bounded = boundedMetadataValue(value);
		if (bounded) metadata[key] = bounded;
	};

	add("session_id", state.sessionId);
	const identity = state.session.effectiveIdentity;
	add("agent_kind", identity.role);
	add("prompt_profile", identity.prompt.profileId ?? "default");
	add("prompt_principal", identity.prompt.principal);
	add("prompt_source", identity.prompt.source);
	add("model", formatIdentityModel(state.session.model));
	add("project", projectLabel);
	add("cwd", state.session.sessionManager.getCwd());
	add("source", source);
	return metadata satisfies MemoryProvenanceMetadata;
}

function boundedMetadataValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/\s+/g, " ");
	if (!normalized) return undefined;
	return normalized.slice(0, RETENTION_METADATA_VALUE_MAX_CHARS);
}

/** Per-session Hindsight runtime state owned by its AgentSession. */
export class HindsightSessionState {
	/** Session id used for retain-queue metadata. */
	sessionId: string;
	readonly session: AgentSession;
	readonly #route?: HindsightRouteSnapshot;
	readonly #primarySession?: AgentSession;
	lastRetainedTurn: number;
	#lastRetainedMessageIndex: number = 0;
	#cachedTranscript: string = "";
	// Rolling hash of ALL messages in [0, #lastRetainedMessageIndex) at cache
	// time. The incremental full-session cache assumes the branch is append-only;
	// a rewind, branch switch, compaction, or in-place edit rewrites the prefix
	// without changing the session id. Re-hashing the current prefix at use time
	// makes the cache self-healing: on ANY prefix change (not just the boundary
	// message) we rebuild the full transcript instead of retaining stale content
	// or silently retaining nothing forever. Hashing is orders of magnitude
	// cheaper than the re-formatting this cache avoids.
	#lastRetainedPrefixKey: string = "";
	hasRecalledForFirstTurn: boolean;
	lastRecallSnippet?: string;
	/** Cached `<mental_models>` block injected into developer instructions. */
	mentalModelsSnippet?: string;
	/** When the cached snippet was last refreshed; gates the agent_end re-list. */
	mentalModelsLoadedAt?: number;
	/**
	 * In-flight ensure+load promise. `beforeAgentStartPrompt` awaits this on
	 * the first turn so the MM block lands in the system prompt before the
	 * LLM generates, even though `start()` returns before the load completes.
	 */
	mentalModelsLoadPromise?: Promise<void>;
	unsubscribe?: () => void;
	/**
	 * Releases the `onHindsightScopeChanged` subscription that drives live
	 * rebuilds when `hindsight.bankId` / `bankIdPrefix` / `scoping` change.
	 * Only set on primary states; aliases inherit the parent's subscription.
	 */
	unsubscribeScope?: () => void;
	readonly retainQueue: HindsightRetainQueue;

	constructor(options: HindsightSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.session = options.session;
		if (options.aliasOf) {
			const primary = options.aliasOf.isAlias ? options.aliasOf.aliasOf : options.aliasOf;
			if (!primary) throw new Error("Hindsight parent route is no longer active.");
			this.#primarySession = primary.session;
		} else {
			this.#route = {
				client: options.client,
				bankId: options.bankId,
				projectLabel: options.projectLabel ?? resolveProjectLabel(options.session.sessionManager.getCwd?.() ?? ""),
				retainTags: options.retainTags,
				recallTags: options.recallTags,
				recallTagsMatch: options.recallTagsMatch,
				config: options.config,
				banksSet: options.banksSet,
			};
		}
		this.lastRetainedTurn = options.lastRetainedTurn ?? 0;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		this.retainQueue = new HindsightRetainQueue(this);
	}

	get isAlias(): boolean {
		return this.#primarySession !== undefined;
	}

	/** The primary state currently installed in the parent session. */
	get aliasOf(): HindsightSessionState | undefined {
		const state = this.#primarySession?.getHindsightSessionState();
		return state?.isAlias ? state.aliasOf : state;
	}

	captureRoute(): HindsightRouteSnapshot {
		const primary = this.aliasOf;
		const route = primary ? primary.#route : this.#route;
		if (!route) throw new Error("Hindsight parent route is no longer active.");
		return route;
	}

	get client(): HindsightApi {
		return this.captureRoute().client;
	}

	get bankId(): string {
		return this.captureRoute().bankId;
	}

	get projectLabel(): string {
		return this.captureRoute().projectLabel;
	}

	get retainTags(): string[] | undefined {
		return this.captureRoute().retainTags;
	}

	get recallTags(): string[] | undefined {
		return this.captureRoute().recallTags;
	}

	get recallTagsMatch(): "any" | "all" | "any_strict" | "all_strict" | undefined {
		return this.captureRoute().recallTagsMatch;
	}

	get config(): HindsightConfig {
		return this.captureRoute().config;
	}

	get banksSet(): Set<string> {
		return this.captureRoute().banksSet;
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	resetConversationTracking(): void {
		this.lastRetainedTurn = 0;
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
	}

	enqueueRetain(content: string, context?: string): void {
		this.retainQueue.enqueue(content, context);
	}

	async flushRetainQueue(): Promise<void> {
		await this.retainQueue.flush();
	}

	async retireRetainQueue(): Promise<void> {
		await this.retainQueue.retire();
	}

	async recallForContext(query: string, signal?: AbortSignal): Promise<RecallOutcome> {
		const route = this.captureRoute();
		try {
			const response = await route.client.recall(route.bankId, query, {
				budget: route.config.recallBudget,
				maxTokens: route.config.recallMaxTokens,
				types: route.config.recallTypes.length > 0 ? route.config.recallTypes : undefined,
				tags: route.recallTags,
				tagsMatch: route.recallTagsMatch,
			});
			if (signal?.aborted) return { context: null, ok: false };
			const results = response.results ?? [];
			if (results.length === 0) return { context: null, ok: true };
			const formatted = formatMemories(results);
			const block = `<memories>\n${route.config.recallPromptPreamble}\nCurrent time: ${formatCurrentTime()} UTC\n\n${formatted}\n</memories>`;
			return { context: block, ok: true };
		} catch (err) {
			if (route.config.debug) {
				logger.debug("Hindsight: recall failed", { bankId: route.bankId, error: String(err) });
			}
			return { context: null, ok: false };
		}
	}

	#sessionSourceTimestamp(): Date | undefined {
		const header = this.session.sessionManager?.getHeader?.();
		const timestamp = header?.timestamp;
		if (typeof timestamp !== "string") return undefined;
		const trimmed = timestamp.trim();
		if (!trimmed) return undefined;
		const parsed = new Date(trimmed);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	async retainSession(messages: HindsightMessage[]): Promise<void> {
		const retainedAt = new Date();
		const sourceTimestamp = this.#sessionSourceTimestamp() ?? retainedAt;
		const retainFullWindow = this.config.retainMode === "full-session";
		let documentId: string;
		let transcript: string;
		let nextCachedTranscript: string | undefined;

		if (retainFullWindow) {
			documentId = this.sessionId;
			const boundary = this.#lastRetainedMessageIndex;
			if (boundary > messages.length || retentionPrefixKey(messages, boundary) !== this.#lastRetainedPrefixKey) {
				this.#lastRetainedMessageIndex = 0;
				this.#cachedTranscript = "";
				this.#lastRetainedPrefixKey = "";
			}
			const newMessages = messages.slice(this.#lastRetainedMessageIndex);
			const { transcript: newPart } = prepareRetentionTranscript(newMessages, true, { includeTimestamps: true });
			if (!newPart) return;
			nextCachedTranscript = this.#cachedTranscript ? `${this.#cachedTranscript}\n\n${newPart}` : newPart;
			transcript = nextCachedTranscript;
		} else {
			const windowTurns = this.config.retainEveryNTurns + this.config.retainOverlapTurns;
			const target = sliceLastTurnsByUserBoundary(messages, windowTurns);
			documentId = `${this.sessionId}-${retainedAt.getTime()}`;
			this.#lastRetainedMessageIndex = 0;
			this.#cachedTranscript = "";
			this.#lastRetainedPrefixKey = "";
			const { transcript: windowTranscript } = prepareRetentionTranscript(target, true, { includeTimestamps: true });
			if (!windowTranscript) return;
			transcript = windowTranscript;
		}

		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);
		await this.client.retain(this.bankId, transcript, {
			documentId,
			context: this.config.retainContext,
			metadata: buildRetentionMetadata(this, "session-auto-retain"),
			tags: this.retainTags,
			timestamp: sourceTimestamp,
			async: true,
		});
		if (nextCachedTranscript !== undefined) {
			this.#cachedTranscript = nextCachedTranscript;
			this.#lastRetainedMessageIndex = messages.length;
			this.#lastRetainedPrefixKey = retentionPrefixKey(messages, messages.length);
		}
	}

	async maybeRetainOnAgentEnd(): Promise<void> {
		if (!this.config.autoRetain) return;
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		const userTurns = messages.filter(m => m.role === "user").length;
		if (userTurns - this.lastRetainedTurn < this.config.retainEveryNTurns) return;

		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = userTurns;
			if (this.config.debug) {
				logger.debug("Hindsight: auto-retain succeeded", {
					sessionId: this.sessionId,
					bankId: this.bankId,
					userTurns,
					messages: messages.length,
				});
			}
		} catch (err) {
			logger.warn("Hindsight: auto-retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async forceRetainCurrentSession(): Promise<void> {
		const messages = extractMessages(this.session.sessionManager);
		if (messages.length === 0) return;
		// Forced retains are user-initiated rebuilds (`/memory enqueue`): drop the
		// incremental cache so the full transcript is reformatted and resent even
		// when no new messages arrived since the last auto-retain — otherwise a
		// rebuild could never recover an upstream document that was deleted or a
		// previous async retain that never materialized.
		this.#lastRetainedMessageIndex = 0;
		this.#cachedTranscript = "";
		this.#lastRetainedPrefixKey = "";
		try {
			await this.retainSession(messages);
			this.lastRetainedTurn = messages.filter(m => m.role === "user").length;
		} catch (err) {
			logger.warn("Hindsight: forced retain failed", {
				sessionId: this.sessionId,
				bankId: this.bankId,
				error: String(err),
			});
		}
	}

	async beforeAgentStartPrompt(promptText: string): Promise<string | undefined> {
		if (this.isAlias) return undefined;
		if (this.config.mentalModelsEnabled && this.mentalModelsLoadPromise && this.mentalModelsLoadedAt === undefined) {
			await Promise.race([this.mentalModelsLoadPromise, Bun.sleep(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS)]);
		}

		if (!this.config.autoRecall || this.hasRecalledForFirstTurn) return undefined;

		const latestPrompt = promptText.trim();
		if (!latestPrompt) return undefined;

		const history = extractMessages(this.session.sessionManager);
		const queryMessages = [...history, { role: "user" as const, content: latestPrompt }];
		const query = composeRecallQuery(latestPrompt, queryMessages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, latestPrompt, this.config.recallMaxQueryChars);
		const { context, ok } = await this.recallForContext(truncated);
		if (!ok) return undefined;

		this.hasRecalledForFirstTurn = true;
		if (!context) return undefined;

		this.lastRecallSnippet = context;
		return context;
	}

	async recallForCompaction(messages: HindsightMessage[]): Promise<string | undefined> {
		const lastUser = messages.findLast(m => m.role === "user");
		if (!lastUser) return undefined;

		const query = composeRecallQuery(lastUser.content, messages, this.config.recallContextTurns);
		const truncated = truncateRecallQuery(query, lastUser.content, this.config.recallMaxQueryChars);
		const { context } = await this.recallForContext(truncated);
		return context ?? undefined;
	}

	async runMentalModelLoad(scope: BankScope): Promise<void> {
		if (!this.config.mentalModelsEnabled) return;

		// Create/ensure the bank BEFORE the first mental-model POST so we don't
		// land `createMentalModel` against a bank the server has never seen —
		// that surfaces as a FK / 404 on Hindsight's side. `ensureBankExists`
		// is idempotent (PUT) and skips after the first call via `banksSet`.
		await ensureBankExists(this.client, this.bankId, this.config, this.banksSet);

		// Seeding is opt-in (`hindsight.mentalModelAutoSeed`). Default behaviour is
		// read-only: we surface whatever models the operator has curated on the
		// bank, but we do NOT POST to create new ones unless they explicitly
		// asked. `/memory mm seed` remains the explicit-write entry point.
		if (this.config.mentalModelAutoSeed) {
			const seeds = resolveSeedsForScope(scope, this.config.scoping);
			if (seeds.length > 0) {
				await ensureMentalModels(this.client, this.bankId, seeds, this.config.debug);
			}
		}

		await this.refreshMentalModelsSnippet();
		await this.#refreshBaseSystemPromptAfter("MM load");
	}

	async refreshMentalModelsSnippet(): Promise<void> {
		const snippet = await loadMentalModelsBlock(
			this.client,
			this.bankId,
			this.config.mentalModelMaxRenderChars,
			this.recallTags,
		);
		this.mentalModelsSnippet = snippet;
		this.mentalModelsLoadedAt = Date.now();
	}

	async reloadMentalModels(): Promise<boolean> {
		if (this.isAlias) return false;
		if (!this.config.mentalModelsEnabled) return false;
		await this.refreshMentalModelsSnippet();
		await this.#refreshBaseSystemPromptAfter("MM reload");
		return true;
	}

	attachSessionListeners(): void {
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe(event => {
			if (event.type === "agent_end") {
				void this.maybeRetainOnAgentEnd();
				// Drain any queued tool-initiated retain calls now that the turn
				// is settled. The queue is also debounced/size-bounded, but
				// flushing here keeps the bank fresh between turns.
				void this.flushRetainQueue();
				// MM TTL refresh: re-list once we're past the cache deadline. List
				// is cheap (no reflect call); the LLM doesn't see this happen.
				if (
					this.config.mentalModelsEnabled &&
					this.mentalModelsLoadedAt !== undefined &&
					Date.now() - this.mentalModelsLoadedAt >= this.config.mentalModelRefreshIntervalMs
				) {
					void this.refreshMentalModelsSnippet().then(async () => {
						await this.#refreshBaseSystemPromptAfter("MM TTL reload");
					});
				}
			}
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeScope?.();
		this.unsubscribeScope = undefined;
		this.retainQueue.dispose();
	}

	async #refreshBaseSystemPromptAfter(reason: "MM load" | "MM reload" | "MM TTL reload"): Promise<void> {
		try {
			await this.session.refreshBaseSystemPrompt();
		} catch (err) {
			logger.debug(`Hindsight: refreshBaseSystemPrompt after ${reason} failed`, { error: String(err) });
		}
	}
}
