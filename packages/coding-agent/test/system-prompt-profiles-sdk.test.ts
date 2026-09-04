import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { formatAgentIdentityReport, snapshotAgentIdentity } from "@oh-my-pi/pi-coding-agent/session/identity";
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

function routedSettings(workerMemory = false): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		systemPromptProfiles: {
			driver: { prompt: "DRIVER CONSTITUTION" },
			"fable-driver": { constitution: "fable" },
			worker: {
				instructions: "WORKER CONSTITUTION",
				projectContextOnly: true,
				memory: workerMemory,
				mcpServerInstructions: false,
			},
		},
		systemPromptProfileRoutes: [
			{ agentKind: "main", model: "mock/constitutional-*", profile: "fable-driver" },
			{ agentKind: "main", model: "mock/driver*", profile: "driver" },
			{ agentKind: "main", model: "mock/worker*", profile: "worker" },
			{ agentKind: "main", profile: "driver" },
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
			restrictToolNames?: boolean;
			parentSession?: AgentSession;
			extensions?: ExtensionFactory[];
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
			restrictToolNames: options.restrictToolNames,
			parentHindsightSessionState: options.parentSession?.getHindsightSessionState(),
			customSystemPrompt: options.customSystemPrompt,
			customSystemPromptSource: options.customSystemPromptSource,
			disableExtensionDiscovery: true,
			extensions: options.extensions,
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
		expect(prompt).toContain("Prompt profile: driver");
		expect(session.agent.promptCacheKey).toContain("system-prompt-profile:driver");
		expect(prompt).toContain("<agent-identity>");
		expect(prompt).toContain("Prompt principal: prompt-profile:driver");
		expect(prompt).toContain("Model: mock/driver-primary");
		expect(session.effectiveIdentity.prompt).toEqual({
			profileId: "driver",
			principal: "prompt-profile:driver",
			source: "system-prompt-profile",
		});
	});
	it("renders Fable only for the selected constitutional profile, not a model name", async () => {
		const constitutional = await create("constitutional-main");
		const fableNamedGeneric = await create("fable-in-name");
		const constitutionalPrompt = constitutional.agent.state.systemPrompt.join("\n\n");
		const genericPrompt = fableNamedGeneric.agent.state.systemPrompt.join("\n\n");

		expect(constitutional.systemPromptProfileId).toBe("fable-driver");
		expect(constitutionalPrompt).toContain("You are Fable, trusted absolutely");
		expect(fableNamedGeneric.systemPromptProfileId).toBe("driver");
		expect(genericPrompt).toContain("DRIVER CONSTITUTION");
		expect(genericPrompt).not.toContain("You are Fable, trusted absolutely");
		expect(genericPrompt).not.toContain("Helpful, trusted assistant");
	});

	it("injects the active Hindsight bank, project, and scope into the runtime identity prompt", async () => {
		const settings = routedSettings();
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", "http://localhost:8888");
		settings.override("hindsight.bankId", "memory-bank");
		settings.override("hindsight.scoping", "per-project-tagged");
		settings.override("hindsight.mentalModelsEnabled", false);
		settings.override("hindsight.autoRecall", false);

		const session = await create("driver-primary", settings);
		const project = path.basename(dir.path()).toLowerCase();
		const prompt = session.agent.state.systemPrompt.join("\n\n");
		const hindsight = snapshotAgentIdentity(session).memory.hindsight;

		expect(hindsight).toEqual({
			status: "active",
			bank: "memory-bank",
			project,
			scope: "per-project-tagged",
			tags: [`project:${project}`],
		});
		expect(prompt).toContain("Model: mock/driver-primary");
		expect(prompt).toContain(
			`Memory identity: bank=memory-bank; scope=per-project-tagged; project=${project}; tags=project:${project}`,
		);
	});

	it("starts Hindsight aliases for a restricted live worker without widening its tool grant", async () => {
		const settings = routedSettings(true);
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", "http://localhost:8888");
		settings.override("hindsight.bankId", "memory-bank");
		settings.override("hindsight.mentalModelsEnabled", false);
		settings.override("hindsight.autoRecall", false);

		const parent = await create("driver-primary", settings);
		const child = await create("worker-restricted-memory", settings, {
			agentKind: "sub",
			taskDepth: 1,
			parentSession: parent,
			restrictToolNames: true,
			toolNames: ["recall"],
		});
		const parentState = parent.getHindsightSessionState();
		const childState = child.getHindsightSessionState();

		expect(child.systemPromptProfileId).toBe("worker");
		expect(parentState).toBeDefined();
		expect(childState?.aliasOf).toBe(parentState);
		expect(childState?.projectLabel).toBe(parentState?.projectLabel);
		expect(child.agent.state.tools.map(tool => tool.name)).toEqual(["recall"]);
	});

	it("rebinds Hindsight project provenance after moving the session cwd", async () => {
		const settings = routedSettings(true);
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.apiUrl", "http://localhost:8888");
		settings.override("hindsight.bankId", "omp");
		settings.override("hindsight.scoping", "per-project-tagged");
		settings.override("hindsight.mentalModelsEnabled", false);
		settings.override("hindsight.autoRecall", false);

		const session = await create("driver-primary", settings);
		const before = session.getHindsightSessionState();
		const movedCwd = path.join(dir.path(), "moved-project");
		await fs.mkdir(movedCwd, { recursive: true });

		await session.moveSession(movedCwd);

		const after = session.getHindsightSessionState();
		expect(after).toBeDefined();
		expect(after).not.toBe(before);
		expect(after?.projectLabel).toBe("moved-project");
		expect(after?.retainTags).toEqual(["project:moved-project"]);
		expect(snapshotAgentIdentity(session).memory.hindsight).toMatchObject({
			status: "active",
			project: "moved-project",
			tags: ["project:moved-project"],
		});
	});
	it("routes a fable-named subagent to the worker profile instead of ambient SYSTEM.md", async () => {
		const session = await create("fable-in-name", routedSettings(), {
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
		expect(prompt).not.toContain("You are Fable, trusted absolutely");
		expect(prompt).not.toContain("AMBIENT SYSTEM PROMPT");
		expect(prompt).toContain("§ Role");
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
		let extensionMemory: unknown = Symbol("not observed");
		const captureMemory: ExtensionFactory = pi => {
			pi.on("before_agent_start", (_event, context) => {
				extensionMemory = context.memory;
			});
		};
		const session = await create("driver-primary", settings, {
			agentKind: "sub",
			taskDepth: 1,
			toolNames: ["learn", "manage_skill"],
			extensions: [captureMemory],
		});
		await session.prompt("profile memory gate");
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(session.getToolByName("learn")).toBeUndefined();
		expect(session.getToolByName("manage_skill")).toBeUndefined();
		expect(prompt).not.toContain("## Auto-Learn (experimental)");
		expect(session.effectiveIdentity.memory).toEqual({
			status: "disabled-by-profile",
			profileId: "worker",
		});
		expect(snapshotAgentIdentity(session).memory.hindsight).toEqual({ status: "disabled-by-profile" });

		expect(extensionMemory).toBeUndefined();
	});

	it("routes an internal session explicitly marked as a subagent to the worker profile", async () => {
		const session = await create("driver-primary", routedSettings(), { agentKind: "sub" });
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(session.systemPromptProfileId).toBe("worker");
		expect(prompt).toContain("WORKER CONSTITUTION");
		expect(prompt).not.toContain("DRIVER CONSTITUTION");
	});

	it("rejects main-agent identity on a structurally subagent session", async () => {
		await expect(create("driver-primary", routedSettings(), { agentKind: "main", taskDepth: 1 })).rejects.toThrow(
			'agentKind "main" contradicts subagent task metadata.',
		);
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
		expect(prompt).toContain("Prompt profile: driver");
		expect(session.effectiveIdentity.prompt).toEqual({
			profileId: "driver",
			principal: "explicit-system-prompt",
			source: "explicit-system-prompt",
		});
	});

	it("records discovered SYSTEM.md and the maintained prompt as distinct effective principals", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.enabled": false,
		});
		const discovered = await create("driver-primary", settings, {
			customSystemPrompt: "AMBIENT SYSTEM PROMPT",
			customSystemPromptSource: "discovered",
		});
		const maintained = await create("driver-primary", settings);

		expect(discovered.effectiveIdentity.prompt).toEqual({
			profileId: undefined,
			principal: "discovered-system-prompt",
			source: "discovered-system-prompt",
		});
		expect(maintained.effectiveIdentity.prompt).toEqual({
			profileId: undefined,
			principal: "maintained-omp-prompt",
			source: "maintained-omp-prompt",
		});
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

		expect(prompt).toContain("§ Role");
		expect(prompt).toContain("Prompt profile: driver");
		expect(session.effectiveIdentity.prompt.source).toBe("maintained-omp-prompt");
	});

	it("allows compatible model changes and rejects profile-changing transitions before mutation", async () => {
		const session = await create("driver-primary");
		const compatible = createMockModel({ id: "driver-secondary", handler: () => ({ content: ["ok"] }) });
		const incompatible = createMockModel({ id: "worker-primary", handler: () => ({ content: ["ok"] }) });
		expect(formatAgentIdentityReport(snapshotAgentIdentity(session))).toContain("Model: mock/driver-primary");

		await session.setModel(compatible);
		expect(session.model?.id).toBe("driver-secondary");
		expect(session.agent.promptCacheKey).toContain("system-prompt-profile:driver");
		const changedReport = formatAgentIdentityReport(snapshotAgentIdentity(session));
		expect(changedReport).toContain("Model: mock/driver-secondary");
		expect(changedReport).not.toContain("Model: mock/driver-primary");
		await expect(session.setModel(incompatible)).rejects.toThrow('pinned to system prompt profile "driver"');
		expect(session.model?.id).toBe("driver-secondary");
	});
	it("keeps constitutional content and cache identity stable across compatible and rejected model changes", async () => {
		const settings = routedSettings();
		settings.override("includeModelInPrompt", false);
		const session = await create("constitutional-primary", settings);
		const initialPrompt = session.agent.state.systemPrompt.join("\n\n");
		const initialCacheKey = session.agent.promptCacheKey;
		const compatible = createMockModel({ id: "constitutional-secondary", handler: () => ({ content: ["ok"] }) });
		const incompatible = createMockModel({ id: "fable-in-name", handler: () => ({ content: ["ok"] }) });

		await session.setModel(compatible);
		// The identity block's memory-provider segment settles asynchronously
		// after session construction; force the rebuild to land so the
		// comparison below observes the settled prompt on both sides of the
		// rejected transition rather than whichever await happened to flush it.
		await session.refreshBaseSystemPrompt();
		const compatiblePrompt = session.agent.state.systemPrompt.join("\n\n");
		const compatibleCacheKey = session.agent.promptCacheKey;
		expect(session.systemPromptProfileId).toBe("fable-driver");
		expect(compatiblePrompt).toContain("You are Fable, trusted absolutely");
		expect(compatibleCacheKey).toContain("system-prompt-profile:fable-driver");
		expect(initialPrompt).toContain("You are Fable, trusted absolutely");
		expect(compatibleCacheKey).toBe(initialCacheKey);

		await expect(session.setModel(incompatible)).rejects.toThrow('pinned to system prompt profile "fable-driver"');
		expect(session.model?.id).toBe("constitutional-secondary");
		expect(session.agent.state.systemPrompt.join("\n\n")).toBe(compatiblePrompt);
		expect(session.agent.promptCacheKey).toBe(compatibleCacheKey);
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

	it("rejects a config-drifted target model before mutating the live session", async () => {
		const settings = routedSettings();
		settings.override("systemPromptProfileRoutes", [
			{ agentKind: "main", model: "mock/driver-primary", profile: "driver" },
			{ agentKind: "main", model: "mock/driver-stale", profile: "worker" },
			{ agentKind: "sub", profile: "worker" },
		]);
		const sessionDir = path.join(dir.path(), "drift-sessions");
		const session = await create("driver-primary", settings, {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		await session.prompt("live-session");
		const previousFile = session.sessionFile;
		const previousMessages = [...session.messages];
		const staleModel = createMockModel({ id: "driver-stale", handler: () => ({ content: ["stale"] }) });

		const target = SessionManager.create(dir.path(), sessionDir);
		target.pinSystemPromptProfile("driver");
		target.appendModelChange("mock/driver-stale", "default");
		target.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "stale target" }],
			api: staleModel.api,
			provider: staleModel.provider,
			model: staleModel.id,
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
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("Expected persisted target session");
		const resumeState = await SessionManager.peekResumeState(targetFile);
		expect(resumeState.header?.systemPromptProfile).toBe("driver");
		expect(resumeState.targetModelStrings).toContain("mock/driver-stale");
		expect(targetFile).not.toBe(previousFile);
		vi.spyOn(registry, "getAvailable").mockReturnValue([staleModel]);

		await expect(session.switchSession(targetFile)).rejects.toThrow('pinned to system prompt profile "driver"');

		expect(session.sessionFile).toBe(previousFile);
		expect(session.model?.id).toBe("driver-primary");
		expect(session.messages).toEqual(previousMessages);
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

	it("pairs hub into the active set for a profile that allowlists task without it", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			systemPromptProfiles: { orchestrator: { tools: ["read", "task"] } },
			systemPromptProfileRoutes: [{ agentKind: "main", profile: "orchestrator" }],
		});
		const session = await create("driver-primary", settings, { toolNames: ["read", "task", "hub"] });

		expect(session.systemPromptProfileId).toBe("orchestrator");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "task", "hub"]));
		// The kernel `tool.<name>` bridge resolves against the same enabled set.
		expect(session.getToolForEvalBridge("hub")?.name).toBe("hub");
	});

	it("keeps hub out of the active set for a profile that allowlists neither task nor hub", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			systemPromptProfiles: { reader: { tools: ["read"] } },
			systemPromptProfileRoutes: [{ agentKind: "main", profile: "reader" }],
		});
		const session = await create("driver-primary", settings, { toolNames: ["read", "task", "hub"] });

		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getActiveToolNames()).not.toContain("task");
		expect(session.getActiveToolNames()).not.toContain("hub");
		expect(session.getToolForEvalBridge("hub")).toBeUndefined();
	});

	it("keeps the checkpoint/rewind pairing intact under a profile tool allowlist", async () => {
		const settings = Settings.isolated({
			"checkpoint.enabled": true,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			systemPromptProfiles: { checkpointer: { tools: ["read", "checkpoint"] } },
			systemPromptProfileRoutes: [{ agentKind: "main", profile: "checkpointer" }],
		});
		const session = await create("driver-primary", settings, { toolNames: ["read", "checkpoint"] });

		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "checkpoint", "rewind"]));
		expect(session.getActiveToolNames()).not.toContain("hub");
	});
});
