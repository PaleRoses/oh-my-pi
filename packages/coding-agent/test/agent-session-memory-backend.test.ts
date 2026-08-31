import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { createSessionMemoryRuntimeContext } from "@oh-my-pi/pi-coding-agent/memory-backend";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sharpshooterBankId, sharpshooterMemoryFilePath } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
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

	it("installs only the selected backend's memory operations", async () => {
		const current = createSession(async () =>
			["retain", "recall", "reflect", "memory_edit", "learn"].map(createTool),
		);
		const expectedToolNames = new Map([
			["hindsight", ["learn", "read", "recall", "reflect", "retain"]],
			["mnemopi", ["learn", "memory_edit", "read", "recall", "reflect", "retain"]],
			["local", ["learn", "read"]],
			["sharpshooter", ["read"]],
			["off", ["read"]],
		] as const);

		for (const [backend, toolNames] of expectedToolNames) {
			settings.override("memory.backend", backend);
			await current.applyMemoryBackend();
			expect(current.getActiveToolNames().sort()).toEqual([...toolNames]);
			expect(current.getAllToolNames().sort()).toEqual([...toolNames]);
			expect(current.systemPrompt).toEqual([`backend:${backend};tools:${toolNames.join(",")}`]);
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
	it("writes a local learned lesson to the moved session's project", async () => {
		settings.override("memory.backend", "local");
		const current = createSession(async () => [createTool("learn")]);
		const memory = createSessionMemoryRuntimeContext(current, tempDir.path());
		const previousCwd = current.sessionManager.getCwd();
		const movedCwd = path.join(tempDir.path(), "moved-project");

		await memory.status();
		await current.moveSession(movedCwd);
		await expect(memory.save({ content: "Prefer behavioral tests." })).resolves.toMatchObject({
			backend: "local",
			stored: 1,
		});

		expect(await Bun.file(path.join(getMemoryRoot(tempDir.path(), movedCwd), "learned.md")).text()).toContain(
			"Prefer behavioral tests.",
		);
		expect(await Bun.file(path.join(getMemoryRoot(tempDir.path(), previousCwd), "learned.md")).exists()).toBe(false);
	});

	it("searches and reports the moved Sharpshooter bank through its cached runtime", async () => {
		settings.override("memory.backend", "sharpshooter");
		const current = createSession(async () => []);
		const memory = createSessionMemoryRuntimeContext(current, tempDir.path());
		const previousCwd = current.sessionManager.getCwd();
		const movedCwd = path.join(tempDir.path(), "moved-project");
		const sourceFile = sharpshooterMemoryFilePath(tempDir.path(), previousCwd, "architecture.md");
		const movedFile = sharpshooterMemoryFilePath(tempDir.path(), movedCwd, "architecture.md");
		await mkdir(path.dirname(sourceFile), { recursive: true });
		await mkdir(path.dirname(movedFile), { recursive: true });
		await Bun.write(sourceFile, "source evidence\nsource evidence\nsource evidence\n");
		await Bun.write(movedFile, "target search evidence\n");

		await memory.status();
		await current.moveSession(movedCwd);
		const [status, search] = await Promise.all([memory.status(), memory.search("target search")]);

		expect(status).toMatchObject({ backend: "sharpshooter", scope: sharpshooterBankId(movedCwd) });
		expect(status.message).toContain("architecture.md: 1 lines");
		expect(search.items).toEqual([{ content: "target search evidence", source: "architecture.md" }]);
	});
	it("keeps Mnemopi child aliases live across parent transitions without owning SQLite handles", async () => {
		settings.override("memory.backend", "mnemopi");
		const parent = createSession(async () => [createTool("retain"), createTool("recall"), createTool("memory_edit")]);
		await parent.applyMemoryBackend();
		const childCwd = path.join(tempDir.path(), "child-project");
		const makeChildSession = (sessionId: string) =>
			({
				sessionId,
				settings,
				sessionManager: { getCwd: () => childCwd },
				subscribe: () => () => {},
			}) as never;
		const child = makeChildSession("mnemopi-child");
		await mnemopiBackend.start({
			session: child,
			settings,
			modelRegistry: {} as never,
			agentDir: tempDir.path(),
			taskDepth: 1,
			parentSession: parent,
		});
		const alias = getMnemopiSessionState(child);
		const initial = getMnemopiSessionState(parent);
		expect(alias?.aliasOf).toBe(initial);

		await parent.moveSession(path.join(tempDir.path(), "moved-project"));
		const moved = getMnemopiSessionState(parent);
		expect(moved).not.toBe(initial);
		expect(alias?.aliasOf).toBe(moved);

		await parent.applyMemoryBackend();
		const reapplied = getMnemopiSessionState(parent);
		expect(reapplied).not.toBe(moved);
		expect(alias?.aliasOf).toBe(reapplied);

		settings.override("memory.backend", "off");
		await parent.applyMemoryBackend();
		expect(alias?.aliasOf).toBeUndefined();
		settings.override("memory.backend", "mnemopi");
		await parent.applyMemoryBackend();
		const selected = getMnemopiSessionState(parent);
		expect(alias?.aliasOf).toBe(selected);

		const childRuntime = mnemopiBackend.runtime({ agentDir: tempDir.path(), cwd: childCwd, session: child });
		const retained = "dynamic child alias retained after parent transition";
		await expect(childRuntime.retain({ items: [{ content: retained }] })).resolves.toMatchObject({
			backend: "mnemopi",
			stored: 1,
		});
		await expect(childRuntime.recall(retained)).resolves.toMatchObject({
			backend: "mnemopi",
			items: expect.arrayContaining([expect.objectContaining({ content: retained })]),
		});

		const activeMemory = selected!.memory;
		await childRuntime.dispose({ persistPending: false });
		expect(activeMemory.getStats()).toBeDefined();

		const lateChild = makeChildSession("mnemopi-child-after-parent");
		await mnemopiBackend.start({
			session: lateChild,
			settings,
			modelRegistry: {} as never,
			agentDir: tempDir.path(),
			taskDepth: 1,
			parentSession: parent,
		});
		const lateChildRuntime = mnemopiBackend.runtime({ agentDir: tempDir.path(), cwd: childCwd, session: lateChild });
		const parentRuntime = mnemopiBackend.runtime({
			agentDir: tempDir.path(),
			cwd: parent.sessionManager.getCwd(),
			session: parent,
		});
		const closeSpy = vi.spyOn(selected!.memory, "close");
		await parentRuntime.dispose({ persistPending: false });
		const closesAfterParent = closeSpy.mock.calls.length;
		await lateChildRuntime.dispose({ persistPending: false });
		expect(closeSpy).toHaveBeenCalledTimes(closesAfterParent);
	});
});
