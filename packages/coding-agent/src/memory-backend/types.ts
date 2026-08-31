/**
 * Memory backend abstraction.
 *
 * Backends are mutually exclusive — `await resolveMemoryBackend(settings)` returns
 * exactly one. A backend owns the session state it creates in `start()` through
 * the typed runtime returned by `runtime()`; callers never inspect provider
 * state directly.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";

export type MemoryBackendId = "off" | "local" | "hindsight" | "mnemopi" | "sharpshooter";

/** Explicit operations a backend exposes to built-in memory tools. */
export interface MemoryBackendCapabilities {
	readonly recall: boolean;
	readonly retain: boolean;
	readonly reflect: boolean;
	readonly edit: boolean;
	readonly save: boolean;
}

export interface MemoryBackendStatus {
	backend: MemoryBackendId;
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}

/** A provider-owned synchronous projection safe for session/UI identity surfaces. */
export type MemoryBackendIdentity =
	| { readonly backend: "off"; readonly status: "off" }
	| { readonly backend: "local"; readonly status: "active" }
	| { readonly backend: "sharpshooter"; readonly status: "active" }
	| { readonly backend: "mnemopi"; readonly status: "configured-not-started" }
	| { readonly backend: "mnemopi"; readonly status: "active"; readonly banks: readonly string[] }
	| { readonly backend: "hindsight"; readonly status: "configured-not-started" }
	| {
			readonly backend: "hindsight";
			readonly status: "active";
			readonly bank: string;
			readonly project: string;
			readonly scope: "global" | "per-project" | "per-project-tagged";
			readonly tags: readonly string[];
	  };

export interface MemoryBackendMentalModel {
	readonly id: string;
	readonly name: string;
	readonly content: string | undefined;
	readonly tags: readonly string[];
	readonly lastRefreshedAt: string | undefined;
	readonly sourceQuery: string | undefined;
	readonly refreshAfterConsolidation: boolean;
}

export interface MemoryBackendMentalModelHistoryEntry {
	readonly changedAt: string;
	readonly previousContent: string | undefined;
}

/** Hindsight owns the implementation; the command layer consumes only this operation contract. */
export interface MemoryBackendMentalModelController {
	readonly bank: string;
	list(): Promise<readonly MemoryBackendMentalModel[]>;
	show(id: string): Promise<MemoryBackendMentalModel | undefined>;
	history(id: string): Promise<
		| { readonly status: "not-found" }
		| {
				readonly status: "available";
				readonly model: MemoryBackendMentalModel;
				readonly entries: readonly MemoryBackendMentalModelHistoryEntry[];
		  }
	>;
	refresh(
		id: string | undefined,
	): Promise<
		| { readonly status: "queued-one"; readonly id: string }
		| { readonly status: "queued-many"; readonly queued: number; readonly total: number; readonly skipped: number }
		| { readonly status: "no-models" }
		| { readonly status: "no-auto-refresh"; readonly skipped: number }
	>;
	seed(): Promise<{
		readonly created: number;
		readonly skipped: number;
		readonly scope: "global" | "per-project" | "per-project-tagged";
	}>;
	reload(): Promise<boolean>;
	delete(id: string): Promise<boolean>;
}

export type MemoryBackendMentalModels =
	| { readonly backend: MemoryBackendId; readonly status: "unsupported" }
	| { readonly backend: "hindsight"; readonly status: "inactive" }
	| { readonly backend: "hindsight"; readonly status: "disabled" }
	| {
			readonly backend: "hindsight";
			readonly status: "active";
			readonly controller: MemoryBackendMentalModelController;
	  };

export interface MemoryBackendSearchOptions {
	limit?: number;
	/** Best-effort abort signal. Backends may only observe it before/after an underlying recall call. */
	signal?: AbortSignal;
}

export interface MemoryBackendSearchItem {
	id?: string;
	content: string;
	source?: string;
	timestamp?: string;
	score?: number;
}

export interface MemoryBackendSearchResult {
	backend: MemoryBackendId;
	query: string;
	count: number;
	items: MemoryBackendSearchItem[];
	message?: string;
}

/** Provenance preserved from a backend's rich recall result. */
export interface MemoryBackendRecallProvenance {
	factType?: string;
	occurredStart?: string;
	occurredEnd?: string;
	mentionedAt?: string;
	documentId?: string;
	chunkId?: string;
	tags?: string[];
	sourceFactIds?: string[];
	metadata?: Record<string, string>;
}

/** Scores a backend may expose without leaking its raw result object. */
export interface MemoryBackendRecallScore {
	final?: number;
	reranker?: number;
	semantic?: number;
	keyword?: number;
}

/** A typed recalled item plus the provider-owned rendering of the result set. */
export interface MemoryBackendRecallItem {
	id?: string;
	content: string;
	context?: string;
	source?: string;
	timestamp?: string;
	entities?: string[];
	provenance?: MemoryBackendRecallProvenance;
	score?: MemoryBackendRecallScore;
}

export interface MemoryBackendRecallResult {
	backend: MemoryBackendId;
	query: string;
	count: number;
	items: MemoryBackendRecallItem[];
	/** Provider-owned rich rendering, including any provenance annotations. */
	rendered: string;
	/** Provider-supplied UTC timestamp used in the shared recall heading. */
	asOf?: string;
	message?: string;
}

export interface MemoryBackendSaveInput {
	content: string;
	context?: string;
	source?: string;
	importance?: number;
	/** Selects provider-owned metadata and veracity semantics for an explicit save. */
	purpose?: "save" | "learn";
}

export interface MemoryBackendSaveResult {
	backend: MemoryBackendId;
	stored: number;
	ids?: string[];
	queued?: boolean;
	message?: string;
}

export interface MemoryBackendRetainItem {
	content: string;
	context?: string;
}

export interface MemoryBackendRetainInput {
	items: MemoryBackendRetainItem[];
}

export interface MemoryBackendRetainResult {
	backend: MemoryBackendId;
	accepted: number;
	stored: number;
	queued: boolean;
	ids?: string[];
	message?: string;
}

export interface MemoryBackendReflectInput {
	query: string;
	context?: string;
	signal?: AbortSignal;
}

export interface MemoryBackendReflectResult {
	backend: MemoryBackendId;
	text: string;
	message?: string;
}

export type MemoryBackendEditOperation = "update" | "forget" | "invalidate";

export interface MemoryBackendEditInput {
	op: MemoryBackendEditOperation;
	id: string;
	content?: string;
	importance?: number;
	replacementId?: string;
}

export interface MemoryBackendEditResult {
	backend: MemoryBackendId;
	status: "updated" | "deleted" | "invalidated" | "not_found" | "not_editable" | "unsupported";
	bank?: string;
	store?: string;
	message?: string;
}

/** Whether disposal should persist the provider's pending session work. */
export interface MemoryBackendDisposeOptions {
	persistPending?: boolean;
}

export interface MemoryBackendOperationContext {
	agentDir: string;
	cwd: string;
	session?: AgentSession;
	/** Lets tool hosts provide the selected settings without impersonating an AgentSession. */
	settings?: Settings;
}

/** Provider-owned session lifecycle and explicit-memory operations. */
export interface MemoryBackendRuntime {
	readonly capabilities: MemoryBackendCapabilities;
	identity(): MemoryBackendIdentity;
	mentalModels(): MemoryBackendMentalModels;
	dispose(options?: MemoryBackendDisposeOptions): Promise<void>;
	flush(): Promise<void>;
	rekey(sessionId: string): void;
	resetTranscript(): Promise<boolean>;
	status(): Promise<MemoryBackendStatus>;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
	retain(input: MemoryBackendRetainInput): Promise<MemoryBackendRetainResult>;
	recall(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendRecallResult>;
	reflect(input: MemoryBackendReflectInput): Promise<MemoryBackendReflectResult>;
	edit(input: MemoryBackendEditInput): Promise<MemoryBackendEditResult>;
}

/** Dynamic runtime exposed to extensions and tool hosts. */
export interface MemoryRuntimeContext {
	capabilities(): Promise<MemoryBackendCapabilities>;
	status(): Promise<MemoryBackendStatus>;
	identity(): Promise<MemoryBackendIdentity>;
	mentalModels(): Promise<MemoryBackendMentalModels>;
	search(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendSearchResult>;
	save(input: string | MemoryBackendSaveInput): Promise<MemoryBackendSaveResult>;
	retain(input: MemoryBackendRetainInput): Promise<MemoryBackendRetainResult>;
	recall(query: string, options?: MemoryBackendSearchOptions): Promise<MemoryBackendRecallResult>;
	reflect(input: MemoryBackendReflectInput): Promise<MemoryBackendReflectResult>;
	edit(input: MemoryBackendEditInput): Promise<MemoryBackendEditResult>;
}

export interface MemoryBackendStartOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
	/** Parent session whose provider-owned runtime may be aliased by a subagent. */
	parentSession?: AgentSession;
}

export interface MemoryBackend {
	readonly id: MemoryBackendId;
	readonly capabilities: MemoryBackendCapabilities;

	/**
	 * Wire any background work or session subscriptions for this backend.
	 *
	 * Called once per agent session at startup. Implementations MUST be
	 * non-throwing: failures should be logged and swallowed so a misconfigured
	 * memory backend cannot break the agent loop.
	 */
	start(options: MemoryBackendStartOptions): void | Promise<void>;

	/** Creates the only lifecycle and explicit-tool surface for this provider. */
	runtime(context: MemoryBackendOperationContext): MemoryBackendRuntime;

	/**
	 * Markdown injected as the system-prompt append section.
	 * Returned on every prompt rebuild via `refreshBaseSystemPrompt()`.
	 */
	buildDeveloperInstructions(
		agentDir: string,
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;

	/** Wipe all persisted state for this backend (slash `/memory clear`). */
	clear(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Force consolidation/retain to happen now (slash `/memory enqueue`). */
	enqueue(agentDir: string, cwd: string, session?: AgentSession): Promise<void>;

	/** Render backend-specific memory statistics as markdown (`/memory stats`). */
	stats?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;

	/** Render backend-specific memory diagnostics as markdown (`/memory diagnose`). */
	diagnose?(agentDir: string, cwd: string, session?: AgentSession): Promise<string | undefined>;
	/** Render pending deltas awaiting consolidation (`/memory queue`). */
	queuePreview?(context: MemoryBackendOperationContext): Promise<string | undefined>;
	/**
	 * Optional hook to inject a backend-specific block into the current turn's
	 * system prompt before the agent starts generating.
	 *
	 * This is the only place a backend can affect the very first answer of a
	 * fresh session. The returned text is appended to the already-built base
	 * system prompt for this turn only; callers may separately cache it and
	 * surface it through `buildDeveloperInstructions()` on later rebuilds.
	 */
	beforeAgentStartPrompt?(session: AgentSession, promptText: string): Promise<string | undefined>;

	/**
	 * Optional hook to splice extra context into a compaction summarization.
	 *
	 * Called from the compaction call site before the LLM summary is requested.
	 * Returning a string appends one entry to the compaction's `extraContext`
	 * list (which becomes part of the summarization prompt). Return `undefined`
	 * to inject nothing — the local backend takes this branch because its
	 * summary is already part of the system prompt.
	 */
	preCompactionContext?(
		messages: AgentMessage[],
		settings: Settings,
		session?: AgentSession,
	): Promise<string | undefined>;
}
