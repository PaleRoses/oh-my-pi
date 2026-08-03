import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

registerMockApi();

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

function routedSettings(): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		systemPromptProfiles: {
			driver: { prompt: "DRIVER CONSTITUTION" },
			worker: {
				instructions: "WORKER CONSTITUTION",
				projectContextOnly: true,
				memory: false,
				mcpServerInstructions: false,
			},
		},
		systemPromptProfileRoutes: [
			{ agentKind: "main", model: "mock/driver*", profile: "driver" },
			{ agentKind: "main", model: "mock/worker*", profile: "worker" },
			{ agentKind: "sub", profile: "worker" },
		],
	});
}

describe("SDK system prompt profiles", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let sessions: AgentSession[];

	beforeEach(async () => {
		dir = TempDir.createSync("@system-prompt-profiles-sdk-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		auth.setRuntimeApiKey("mock", "test-key");
		registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		sessions = [];
	});

	afterEach(async () => {
		await Promise.all(sessions.map(session => session.dispose()));
		auth.close();
		dir.removeSync();
	});

	async function create(
		modelId: string,
		settings: Settings = routedSettings(),
		options: {
			taskDepth?: number;
			agentKind?: "main" | "sub";
			sessionManager?: SessionManager;
			customSystemPrompt?: string;
			customSystemPromptSource?: "explicit" | "discovered";
			contextFiles?: Array<{ path: string; content: string; depth?: number }>;
			toolNames?: string[];
		} = {},
	): Promise<AgentSession> {
		const model = createMockModel({ id: modelId, handler: () => ({ content: ["ok"] }) });
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			modelRegistry: registry,
			model,
			settings,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(dir.path()),
			taskDepth: options.taskDepth,
			agentKind: options.agentKind,
			customSystemPrompt: options.customSystemPrompt,
			customSystemPromptSource: options.customSystemPromptSource,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: options.contextFiles ?? [],
			workspaceTree: { ...EMPTY_TREE, rootPath: dir.path() },
			toolNames: options.toolNames ?? [],
		});
		sessions.push(session);
		return session;
	}

	it("pins the main profile in the prompt, transcript header, and provider cache key", async () => {
		const session = await create("driver-primary");
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(session.systemPromptProfileId).toBe("driver");
		expect(session.sessionManager.getHeader()?.systemPromptProfile).toBe("driver");
		expect(prompt).toContain("DRIVER CONSTITUTION");
		expect(prompt).not.toContain("WORKER CONSTITUTION");
		expect(prompt).toContain('<system-prompt-profile id="driver" />');
		expect(session.agent.promptCacheKey).toContain("system-prompt-profile:driver");
	});

	it("routes a subagent using the same model family to the worker profile instead of ambient SYSTEM.md", async () => {
		const session = await create("driver-primary", routedSettings(), {
			taskDepth: 1,
			customSystemPrompt: "AMBIENT SYSTEM PROMPT",
			customSystemPromptSource: "discovered",
			contextFiles: [
				{ path: path.join(dir.path(), "AGENTS.md"), content: "PROJECT WORKER RULES" },
				{ path: path.join(dir.path(), "..", "global", "CLAUDE.md"), content: "GLOBAL DRIVER IDENTITY" },
			],
		});
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(session.systemPromptProfileId).toBe("worker");
		expect(prompt).toContain("WORKER CONSTITUTION");
		expect(prompt).not.toContain("DRIVER CONSTITUTION");
		expect(prompt).not.toContain("AMBIENT SYSTEM PROMPT");
		expect(prompt).toContain("ROLE\n==============");
		expect(prompt).toContain("PROJECT WORKER RULES");
		expect(prompt).not.toContain("GLOBAL DRIVER IDENTITY");
	});

	it("removes memory and auto-learn capabilities from an isolated worker profile", async () => {
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"compaction.enabled": false,
			"memory.backend": "local",
			"retry.enabled": false,
			"todo.enabled": false,
			systemPromptProfiles: {
				worker: {
					instructions: "WORKER CONSTITUTION",
					memory: false,
				},
			},
			systemPromptProfileRoutes: [{ agentKind: "sub", profile: "worker" }],
		});
		const session = await create("driver-primary", settings, {
			agentKind: "sub",
			taskDepth: 1,
			toolNames: ["learn", "manage_skill"],
		});
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(session.getToolByName("learn")).toBeUndefined();
		expect(session.getToolByName("manage_skill")).toBeUndefined();
		expect(prompt).not.toContain("## Auto-Learn (experimental)");
	});

	it("routes an internal session explicitly marked as a subagent to the worker profile", async () => {
		const session = await create("driver-primary", routedSettings(), { agentKind: "sub" });
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(session.systemPromptProfileId).toBe("worker");
		expect(prompt).toContain("WORKER CONSTITUTION");
		expect(prompt).not.toContain("DRIVER CONSTITUTION");
	});
	it("selects the worker profile for a forked subagent instead of inheriting the driver", async () => {
		const sessionDir = path.join(dir.path(), "fork-sessions");
		const parent = await create("driver-primary", routedSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		await parent.prompt("seed");
		const parentFile = parent.sessionFile;
		await parent.dispose();
		sessions = sessions.filter(session => session !== parent);
		if (!parentFile) throw new Error("Expected persisted parent session");

		const forkedManager = await SessionManager.forkFrom(parentFile, dir.path(), sessionDir, undefined, {
			systemPromptProfile: "select",
		});
		const worker = await create("driver-primary", routedSettings(), {
			taskDepth: 1,
			sessionManager: forkedManager,
		});
		const prompt = worker.agent.state.systemPrompt.join("\n\n");

		expect(worker.systemPromptProfileId).toBe("worker");
		expect(worker.sessionManager.getHeader()?.systemPromptProfile).toBe("worker");
		expect(prompt).toContain("WORKER CONSTITUTION");
		expect(prompt).not.toContain("DRIVER CONSTITUTION");
		expect(worker.agent.promptCacheKey).toContain("system-prompt-profile:worker");
	});

	it("selects the driver profile when a top-level session forks worker history", async () => {
		const sessionDir = path.join(dir.path(), "promoted-fork-sessions");
		const worker = await create("driver-primary", routedSettings(), {
			taskDepth: 1,
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		await worker.prompt("seed");
		const workerFile = worker.sessionFile;
		await worker.dispose();
		sessions = sessions.filter(session => session !== worker);
		if (!workerFile) throw new Error("Expected persisted worker session");

		const forkedManager = await SessionManager.forkFrom(workerFile, dir.path(), sessionDir, undefined, {
			systemPromptProfile: "select",
		});
		const driver = await create("driver-primary", routedSettings(), { sessionManager: forkedManager });
		const prompt = driver.agent.state.systemPrompt.join("\n\n");

		expect(driver.systemPromptProfileId).toBe("driver");
		expect(driver.sessionManager.getHeader()?.systemPromptProfile).toBe("driver");
		expect(prompt).toContain("DRIVER CONSTITUTION");
		expect(prompt).not.toContain("WORKER CONSTITUTION");
	});

	it("honors an explicit SDK system prompt override over the selected profile", async () => {
		const session = await create("driver-primary", routedSettings(), {
			customSystemPrompt: "EXPLICIT SYSTEM PROMPT",
			customSystemPromptSource: "explicit",
		});
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(prompt).toContain("EXPLICIT SYSTEM PROMPT");
		expect(prompt).not.toContain("DRIVER CONSTITUTION");
		expect(prompt).toContain('<system-prompt-profile id="driver" />');
	});

	it("keeps the maintained OMP prompt when a selected profile has no prompt override", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.enabled": false,
			systemPromptProfiles: { driver: {} },
			systemPromptProfileRoutes: [{ agentKind: "main", profile: "driver" }],
		});
		const session = await create("driver-primary", settings);
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(prompt).toContain("ROLE\n==============");
		expect(prompt).toContain('<system-prompt-profile id="driver" />');
	});

	it("allows compatible model changes and rejects profile-changing transitions before mutation", async () => {
		const session = await create("driver-primary");
		const compatible = createMockModel({ id: "driver-secondary", handler: () => ({ content: ["ok"] }) });
		const incompatible = createMockModel({ id: "worker-primary", handler: () => ({ content: ["ok"] }) });

		await session.setModel(compatible);
		expect(session.model?.id).toBe("driver-secondary");
		expect(session.agent.promptCacheKey).toContain("system-prompt-profile:driver");
		await expect(session.setModel(incompatible)).rejects.toThrow('pinned to system prompt profile "driver"');
		expect(session.model?.id).toBe("driver-secondary");
	});

	it("rejects resume when the requested model routes away from the transcript profile", async () => {
		const sessionDir = path.join(dir.path(), "resume-sessions");
		const original = await create("driver-primary", routedSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		await original.prompt("seed");
		const sessionFile = original.sessionFile;
		await original.dispose();
		sessions = sessions.filter(session => session !== original);
		if (!sessionFile) throw new Error("Expected persisted source session");

		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		try {
			await expect(create("worker-primary", routedSettings(), { sessionManager: resumedManager })).rejects.toThrow(
				'pinned to system prompt profile "driver"',
			);
		} finally {
			await resumedManager.close();
		}
	});

	it("preserves the profile across new transcripts and refuses a live switch to another profile", async () => {
		const sessionDir = path.join(dir.path(), "sessions");
		const session = await create("driver-primary", routedSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		const previousPromptCacheKey = session.agent.promptCacheKey;
		await session.newSession();
		expect(session.sessionManager.getHeader()?.systemPromptProfile).toBe("driver");
		expect(session.agent.promptCacheKey).toContain("system-prompt-profile:driver");
		expect(session.agent.promptCacheKey).not.toBe(previousPromptCacheKey);

		const target = SessionManager.create(dir.path(), sessionDir);
		target.pinSystemPromptProfile("worker");
		const targetModel = createMockModel({ id: "worker-primary", handler: () => ({ content: ["ok"] }) });
		target.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "target" }],
			api: targetModel.api,
			provider: targetModel.provider,
			model: targetModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		expect(() => target.pinSystemPromptProfile("driver")).toThrow("immutable once a transcript has started");
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("Expected persisted target session");

		await expect(session.switchSession(targetFile)).rejects.toThrow(
			'Cannot switch from system prompt profile "driver" to "worker"',
		);
		expect(session.systemPromptProfileId).toBe("driver");
	});
});
