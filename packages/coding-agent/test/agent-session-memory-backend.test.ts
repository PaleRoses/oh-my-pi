import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { MEMORY_BACKEND_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/memory-backend/tool-names";
import { computeMnemopiBankScope } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} memory tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("AgentSession memory backend lifecycle", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@memory-backend-lifecycle-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		resetMemoryForTests();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(createMemoryTools: () => Promise<AgentTool[]>): AgentSession {
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const read = createTool("read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
		});
		const toolRegistry = new Map<string, AgentTool>([[read.name, read]]);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			memoryAgentDir: tempDir.path(),
			memoryTaskDepth: 0,
			createMemoryTools,
			toolRegistry,
			builtInToolNames: [read.name],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`backend:${settings.get("memory.backend")};tools:${toolNames.sort().join(",")}`],
			}),
		});
		return session;
	}

	it("removes unusable Hindsight tools after a cwd reload clears the URL and restores them when configured", async () => {
		const apiUrl = "http://127.0.0.1:1";
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", apiUrl);
		settings.override("hindsight.mentalModelsEnabled", false);
		settings.override("autolearn.enabled", true);
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
		} as ToolSession;
		const current = createSession(async () => {
			const tools = await Promise.all(MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)));
			return tools.filter((tool): tool is AgentTool => tool !== null);
		});
		await current.applyMemoryBackend();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "learn"]));

		settings.override("hindsight.apiUrl", "");
		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.getActiveToolNames()).toEqual(["read"]);

		settings.override("hindsight.apiUrl", apiUrl);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		await rebindMemoryBackendForCwd(current);
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "learn"]));
	});

	it("switches runtime state, memory tools, and prompt in one apply", async () => {
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("retain"), createTool("memory_edit")] : [],
		);

		settings.override("memory.backend", "mnemopi");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "retain", "memory_edit"]));
		expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:memory_edit,read,retain"]);

		settings.override("memory.backend", "off");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
	});
	it("applies destination backends and project labels across cwd move and rollback", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", "http://localhost:8888");
		settings.override("hindsight.mentalModelsEnabled", false);
		settings.override("hindsight.scoping", "global");
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("retain")] : [],
		);
		await current.applyMemoryBackend();
		const initial = current.getHindsightSessionState();
		expect(initial).toBeDefined();

		const destinationCwd = path.join(tempDir.path(), "destination-project");
		current.sessionManager.setCwdWithoutRelocation(destinationCwd);
		await settings.reloadForCwd(destinationCwd);
		await rebindMemoryBackendForCwd(current);
		const destination = current.getHindsightSessionState();
		expect(destination).toBeDefined();
		expect(destination).not.toBe(initial);
		expect(destination?.projectLabel).not.toBe(initial?.projectLabel);

		settings.override("memory.backend", "mnemopi");
		await rebindMemoryBackendForCwd(current);
		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(getMnemopiSessionState(current)).toBeDefined();

		settings.override("memory.backend", "hindsight");
		await rebindMemoryBackendForCwd(current);
		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getHindsightSessionState()).toBeDefined();

		settings.override("memory.backend", "off");
		await rebindMemoryBackendForCwd(current);
		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(getMnemopiSessionState(current)).toBeUndefined();
	});

	it.each([
		["mnemopi", "mnemopi"],
		["mnemopi", "off"],
		["off", "mnemopi"],
	] as const)("rebinds %s to %s on a cwd move without Hindsight", async (source, destination) => {
		settings.override("memory.backend", source);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("retain")] : [],
		);
		await current.applyMemoryBackend();

		const destinationCwd = path.join(tempDir.path(), "destination");
		current.sessionManager.setCwdWithoutRelocation(destinationCwd);
		settings.override("memory.backend", destination);
		await settings.reloadForCwd(destinationCwd);
		await rebindMemoryBackendForCwd(current);

		const state = getMnemopiSessionState(current);
		if (destination === "mnemopi") {
			const scope = computeMnemopiBankScope(
				settings.get("mnemopi.bank"),
				destinationCwd,
				settings.get("mnemopi.scoping"),
			);
			expect(state?.config.retainBank).toBe(scope.retainBank);
			expect(state?.config.recallBanks).toEqual(scope.recallBanks);
			expect(current.getActiveToolNames()).toEqual(["read", "retain"]);
			expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:read,retain"]);
		} else {
			expect(state).toBeUndefined();
			expect(current.getActiveToolNames()).toEqual(["read"]);
			expect(current.getAllToolNames()).toEqual(["read"]);
			expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
		}
	});

	it.each([false, true])("does not auto-retain during cwd rebind teardown (rollback: %s)", async rollback => {
		settings.override("memory.backend", "mnemopi");
		settings.override("mnemopi.scoping", "per-project");
		const sourceCwd = tempDir.path();
		const destinationCwd = path.join(sourceCwd, "destination");
		await settings.reloadForCwd(sourceCwd);
		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		current.sessionManager.appendMessage({
			role: "user",
			content: "The source project uses a dedicated release branch for production deployments.",
			timestamp: Date.now(),
		});
		const sourceState = getMnemopiSessionState(current)!;
		expect(sourceState.config.autoRetain).toBe(true);
		const sourceDbPath = sourceState.memory.dbPath!;

		await current.moveSession(destinationCwd);
		await settings.reloadForCwd(destinationCwd);
		await rebindMemoryBackendForCwd(current);
		const destinationDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
		if (rollback) {
			current.sessionManager.setCwdWithoutRelocation(sourceCwd);
			await settings.reloadForCwd(sourceCwd);
			await rebindMemoryBackendForCwd(current);
		}

		const db = new Database(rollback ? destinationDbPath : sourceDbPath, { readonly: true });
		try {
			expect(
				db.query("SELECT metadata_json FROM working_memory WHERE source = 'coding-agent-transcript'").all(),
			).toEqual([]);
		} finally {
			db.close();
		}

		// Ordinary backend changes must still retain the current transcript.
		const activeState = getMnemopiSessionState(current)!;
		const activeDbPath = activeState.memory.dbPath!;
		settings.override("memory.backend", "off");
		await current.applyMemoryBackend();
		const retainedDb = new Database(activeDbPath, { readonly: true });
		try {
			expect(
				retainedDb
					.query(
						"SELECT json_extract(metadata_json, '$.cwd') AS cwd FROM working_memory WHERE source = 'coding-agent-transcript'",
					)
					.all(),
			).toEqual([{ cwd: rollback ? sourceCwd : destinationCwd }]);
		} finally {
			retainedDb.close();
		}
	});

	it("cancels a displaced local startup generation", async () => {
		const current = createSession(async () => []);
		const localStartup = current.beginLocalMemoryStartup();

		await current.applyMemoryBackend();

		expect(localStartup.aborted).toBe(true);
	});

	it("serializes concurrent backend applies", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		let running = 0;
		let maxRunning = 0;
		const current = createSession(async () => {
			calls++;
			running++;
			maxRunning = Math.max(maxRunning, running);
			if (calls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running--;
			return [];
		});

		const first = current.applyMemoryBackend();
		await firstStarted.promise;
		const second = current.applyMemoryBackend();
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(maxRunning).toBe(1);
		expect(calls).toBe(2);
	});

	it("waits for an in-flight initial backend apply before terminal disposal", async () => {
		settings.override("memory.backend", "mnemopi");
		const toolsStarted = Promise.withResolvers<void>();
		const releaseTools = Promise.withResolvers<void>();
		const current = createSession(async () => {
			toolsStarted.resolve();
			await releaseTools.promise;
			return [createTool("retain")];
		});
		const startup = current.applyMemoryBackend();
		await toolsStarted.promise;

		let disposalSettled = false;
		const disposal = current.dispose().then(() => {
			disposalSettled = true;
		});
		await Bun.sleep(0);
		expect(disposalSettled).toBe(false);

		releaseTools.resolve();
		await Promise.all([startup, disposal]);
		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getHindsightSessionState()).toBeUndefined();
		session = undefined;
	});

	it("serializes a destination rebind after an in-flight initial backend apply", async () => {
		settings.override("memory.backend", "mnemopi");
		const toolsStarted = Promise.withResolvers<void>();
		const releaseTools = Promise.withResolvers<void>();
		let toolBuilds = 0;
		const current = createSession(async () => {
			toolBuilds++;
			if (toolBuilds === 1) {
				toolsStarted.resolve();
				await releaseTools.promise;
			}
			return settings.get("memory.backend") === "mnemopi" ? [createTool("retain")] : [];
		});
		const startup = current.applyMemoryBackend();
		await toolsStarted.promise;

		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", "http://localhost:8888");
		settings.override("hindsight.mentalModelsEnabled", false);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const rebound = rebindMemoryBackendForCwd(current);
		releaseTools.resolve();
		await Promise.all([startup, rebound]);

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getHindsightSessionState()).toBeDefined();
	});

	it("serializes a Hindsight scope rebuild with terminal disposal", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", "http://localhost:8888");
		settings.override("hindsight.mentalModelsEnabled", false);
		settings.set("hindsight.bankId", "initial");
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retainStarted = Promise.withResolvers<void>();
		const releaseRetain = Promise.withResolvers<void>();
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockImplementation(async () => {
			retainStarted.resolve();
			await releaseRetain.promise;
			return {} as never;
		});
		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		const initial = current.getHindsightSessionState();
		expect(initial).toBeDefined();
		initial!.enqueueRetain("accepted before scope change");

		settings.set("hindsight.bankId", "replacement");
		await retainStarted.promise;
		const disposal = current.dispose();
		releaseRetain.resolve();
		await disposal;

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(current.getHindsightSessionState()).toBeUndefined();
		session = undefined;
	});

	it("keeps Hindsight child auto-recall suppressed across transcript resets", async () => {
		settings.override("memory.backend", "hindsight");
		const resetConversationTracking = vi.fn();
		const aliasState = {
			isAlias: true,
			hasRecalledForFirstTurn: true,
			resetConversationTracking,
		};
		const memory = new SessionMemory(
			{
				settings,
				getHindsightSessionState: () => aliasState,
				getMnemopiSessionState: () => undefined,
			} as never,
			{},
		);

		await memory.resetContextForNewTranscript();

		expect(resetConversationTracking).not.toHaveBeenCalled();
		expect(aliasState.hasRecalledForFirstTurn).toBe(true);
	});

	// A cwd move re-scopes Settings, so the destination project's
	// `memory.backend` is what the session must run. The Hindsight scope
	// rebuild alone only re-derives an already-active Hindsight bank, so a
	// destination project that turns memory off used to keep the source
	// project's backend, memory tools, and prompt for the rest of the session.
	it("applies the destination project's memory backend on a cwd move", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		const current = createSession(async () =>
			settings.get("memory.backend") === "hindsight" ? [createTool("recall"), createTool("retain")] : [],
		);

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));

		// Destination project settings, as `settings.reloadForCwd` would leave them.
		settings.override("memory.backend", "off");
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
	});

	// A rebind that fails must fail the move instead of being logged and
	// dropped, which used to leave a half-rebound session reporting success.
	it("surfaces a failed destination rebind to the caller", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return settings.get("memory.backend") === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		settings.override("memory.backend", "off");
		failToolBuild = true;

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});

	// `Settings.reloadForCwd` fires the memory scope hooks synchronously, so the
	// move's own rebind coalesces onto a rebuild that is already in flight. When
	// the first attempt fails after `applyMemoryBackend` already tore the
	// outgoing state down, the coalesced retry finds a runtime that matches the
	// destination settings and no-ops — which must not launder the half-applied
	// move into a success.
	it("keeps a failed rebind failed when the coalesced retry has nothing left to move", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return settings.get("memory.backend") === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();

		// Destination project settings, as `settings.reloadForCwd` would leave
		// them; the reload then queues the rebuild the move awaits.
		settings.override("memory.backend", "off");
		failToolBuild = true;
		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});
});
