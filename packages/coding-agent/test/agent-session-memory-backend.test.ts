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
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";
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
});
