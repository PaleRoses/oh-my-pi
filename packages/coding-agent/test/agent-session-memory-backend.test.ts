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
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { getProjectAgentDir, getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
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

	it.each([false, true])("headless /move suppresses teardown retention (rollback: %s)", async rollback => {
		const sourceCwd = tempDir.path();
		const destinationCwd = path.join(sourceCwd, "destination");
		await Promise.all(
			[sourceCwd, destinationCwd].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend: "mnemopi" },
						mnemopi: {
							scoping: "per-project",
							autoRetain: true,
							noEmbeddings: true,
							llmMode: "none",
						},
					}),
				),
			),
		);
		settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		current.sessionManager.appendMessage({
			role: "user",
			content: "The source project uses a dedicated release branch for production deployments.",
			timestamp: Date.now(),
		});
		const sourceDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
		let destinationDbPath: string | undefined;
		const output: string[] = [];
		const originalProjectDir = getProjectDir();
		try {
			await executeAcpBuiltinSlashCommand("/move " + destinationCwd, {
				session: current,
				sessionManager: current.sessionManager,
				settings,
				cwd: sourceCwd,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {
					if (current.sessionManager.getCwd() !== destinationCwd) return;
					destinationDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
					if (rollback) throw new Error("destination plugin rescope failed");
				},
			});
		} finally {
			setProjectDir(originalProjectDir);
		}
		const committedCwd = rollback ? sourceCwd : destinationCwd;
		expect(current.sessionManager.getCwd()).toBe(committedCwd);
		expect(output).toContainEqual(
			expect.stringContaining(rollback ? "destination plugin rescope failed" : destinationCwd),
		);
		expect(destinationDbPath).toBeDefined();
		expect(destinationDbPath).not.toBe(sourceDbPath);
		const transcriptRows = (dbPath: string) => {
			const db = new Database(dbPath, { readonly: true });
			try {
				return db
					.query(
						"SELECT json_extract(metadata_json, '$.cwd') AS cwd FROM working_memory WHERE source = 'coding-agent-transcript'",
					)
					.all();
			} finally {
				db.close();
			}
		};
		expect(transcriptRows(sourceDbPath)).toEqual([]);
		expect(transcriptRows(destinationDbPath!)).toEqual([]);

		// Ordinary backend changes still retain once, in the committed project.
		settings.override("memory.backend", "off");
		await current.applyMemoryBackend();
		expect(transcriptRows(sourceDbPath)).toEqual(rollback ? [{ cwd: sourceCwd }] : []);
		expect(transcriptRows(destinationDbPath!)).toEqual(rollback ? [] : [{ cwd: destinationCwd }]);
	});

	it.each(["mnemopi", "hindsight"] as const)(
		"headless /move rolls back from %s when destination Mnemopi cannot open its database",
		async source => {
			const sourceCwd = tempDir.path();
			const destinationCwd = path.join(sourceCwd, "destination");
			const sourceDbPath = path.join(sourceCwd, "source.db");
			const destinationConfig = path.join(getProjectAgentDir(destinationCwd), "config.yml");
			const mnemopi = { scoping: "global", autoRetain: false, noEmbeddings: true, llmMode: "none" };
			await Bun.write(
				path.join(getProjectAgentDir(sourceCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: source },
					mnemopi: { ...mnemopi, dbPath: sourceDbPath },
					hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
				}),
			);
			// An existing directory is not a SQLite database, regardless of filesystem permissions.
			await Bun.write(
				destinationConfig,
				Bun.YAML.stringify({ memory: { backend: "mnemopi" }, mnemopi: { ...mnemopi, dbPath: sourceCwd } }),
			);
			settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
			const toolSession = {
				cwd: sourceCwd,
				hasUI: false,
				settings,
				getHindsightSessionState: () => session?.getHindsightSessionState(),
				getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			} as ToolSession;
			const current = createSession(async () => {
				const tools = await Promise.all(MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)));
				return tools.filter((tool): tool is AgentTool => tool !== null);
			});
			await current.applyMemoryBackend();
			const sourceTools = current.getActiveToolNames();
			const sourcePrompt = current.systemPrompt;
			const sourceBank = source === "hindsight" ? current.getHindsightSessionState()!.bankId : undefined;
			const output: string[] = [];
			const runtime = {
				session: current,
				sessionManager: current.sessionManager,
				settings,
				cwd: sourceCwd,
				output: (text: string) => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};
			const originalProjectDir = getProjectDir();
			try {
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, runtime);
				expect(output).toContainEqual(expect.stringMatching(/Move failed:.*Mnemopi/));
				expect(current.sessionManager.getCwd()).toBe(sourceCwd);
				expect(settings.get("memory.backend")).toBe(source);
				expect(current.getActiveToolNames()).toEqual(sourceTools);
				expect(current.systemPrompt).toEqual(sourcePrompt);
				if (source === "mnemopi") {
					expect(current.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
				} else {
					expect(current.getHindsightSessionState()?.bankId).toBe(sourceBank);
				}

				// Repair the destination and retry the same command; the installed tool must really write there.
				const destinationDbPath = path.join(destinationCwd, "memory.db");
				await Bun.write(
					destinationConfig,
					Bun.YAML.stringify({
						memory: { backend: "mnemopi" },
						mnemopi: { ...mnemopi, dbPath: destinationDbPath },
					}),
				);
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, runtime);
				expect(current.sessionManager.getCwd()).toBe(destinationCwd);
				await current.getToolByName("retain")!.execute("after-move", {
					items: [{ content: "The destination project deploys from its release branch." }],
				});
				const db = new Database(destinationDbPath, { readonly: true });
				try {
					expect(
						db.query("SELECT content FROM working_memory WHERE source = 'coding-agent-retain'").all(),
					).toEqual([{ content: "The destination project deploys from its release branch." }]);
				} finally {
					db.close();
				}
			} finally {
				setProjectDir(originalProjectDir);
			}
		},
	);

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

	it("applies the destination project's memory backend on a cwd move", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		const current = createSession(async () =>
			settings.get("memory.backend") === "hindsight" ? [createTool("recall"), createTool("retain")] : [],
		);

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));

		settings.override("memory.backend", "off");
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
	});

	// A hook-triggered retry may find teardown already done; that no-op must preserve the failure.
	it.each([false, true])("reports destination rebind failures (coalesced no-op: %s)", async coalesced => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return settings.get("memory.backend") === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		settings.override("memory.backend", "off");
		failToolBuild = true;
		if (coalesced) await settings.reloadForCwd(path.join(tempDir.path(), "destination"));

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});
});
