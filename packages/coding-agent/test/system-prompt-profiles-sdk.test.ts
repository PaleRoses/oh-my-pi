import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { HindsightMemoryBinding } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
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

const ROLE_PROMPT = "Keep {{userTitle}} literal.\n{{#if tools}}<boundary>& unchanged</boundary>{{/if}}";

function routedSettings(workerMemory = false): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		systemPromptProfiles: {
			driver: { prompt: "DRIVER CONSTITUTION" },
			principal: { rolePrompt: ROLE_PROMPT },
			worker: {
				instructions: "WORKER CONSTITUTION",
				projectContextOnly: true,
				memory: workerMemory,
				mcpServerInstructions: false,
			},
		},
		systemPromptProfileRoutes: [
			{ agentKind: "main", model: "mock/constitutional-*", profile: "principal" },
			{ agentKind: "main", model: "mock/driver*", profile: "driver" },
			{ agentKind: "main", model: "mock/worker*", profile: "worker" },
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		],
	});
}

/** Routes that point at `driver`, plus two profiles owned by different memory principals. */
function boundSettings(bankId = "person-fable"): Settings {
	return Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		"memory.backend": "hindsight",
		"hindsight.mentalModelsEnabled": false,
		"hindsight.autoRecall": false,
		systemPromptProfiles: {
			driver: { prompt: "DRIVER CONSTITUTION" },
			"fable-memory": { prompt: "FABLE MEMORY", memoryBinding: { principal: "fable", bankId } },
			"astra-memory": { prompt: "ASTRA MEMORY", memoryBinding: { principal: "astra", bankId: "person-astra" } },
			"harness-memory": { prompt: "HARNESS MEMORY" },
			"quiet-worker": { instructions: "QUIET WORKER", memory: false },
		},
		systemPromptProfileRoutes: [
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "quiet-worker" },
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
			systemPromptProfile?: string;
			inheritedMemoryBinding?: HindsightMemoryBinding | null;
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
			systemPromptProfile: options.systemPromptProfile,
			inheritedMemoryBinding: options.inheritedMemoryBinding,
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
			profileSource: "route",
		});
	});
	it("renders the routed role instructions literally inside Role without leaking them to other profiles", async () => {
		const principal = await create("constitutional-main");
		const generic = await create("fable-in-name");
		const worker = await create("constitutional-main", routedSettings(), { taskDepth: 1 });
		const principalPrompt = principal.agent.state.systemPrompt.join("\n\n");

		expect(principal.systemPromptProfileId).toBe("principal");
		expect(principalPrompt).toContain(`§ Role\n${ROLE_PROMPT}\n\n# Engineering`);

		expect(generic.systemPromptProfileId).toBe("driver");
		expect(generic.agent.state.systemPrompt.join("\n\n")).not.toContain(ROLE_PROMPT);
		expect(worker.systemPromptProfileId).toBe("worker");
		expect(worker.agent.state.systemPrompt.join("\n\n")).not.toContain(ROLE_PROMPT);
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
		await session.settings.reloadForCwd(movedCwd);
		await rebindMemoryBackendForCwd(session);

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

	it.each(["driver-primary", "constitutional-main"])("honors an explicit SDK prompt over profile %s", async model => {
		const session = await create(model, routedSettings(), {
			customSystemPrompt: "EXPLICIT SYSTEM PROMPT",
			customSystemPromptSource: "explicit",
		});
		const prompt = session.agent.state.systemPrompt.join("\n\n");

		expect(prompt).toContain("EXPLICIT SYSTEM PROMPT");
		expect(prompt).not.toContain("DRIVER CONSTITUTION");
		expect(prompt).not.toContain(ROLE_PROMPT);
		expect(session.effectiveIdentity.prompt).toEqual({
			profileId: model === "driver-primary" ? "driver" : "principal",
			principal: "explicit-system-prompt",
			source: "explicit-system-prompt",
			profileSource: "route",
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
			profileSource: "route",
		});
		expect(maintained.effectiveIdentity.prompt).toEqual({
			profileId: undefined,
			principal: "maintained-omp-prompt",
			source: "maintained-omp-prompt",
			profileSource: "route",
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
	it("pins file-backed role instructions and cache identity across model changes", async () => {
		const settings = routedSettings();
		settings.override("includeModelInPrompt", false);
		await Bun.write(dir.join("charter.md"), `${ROLE_PROMPT}\n`);
		settings.override("systemPromptProfiles", {
			...settings.get("systemPromptProfiles"),
			principal: { rolePromptFile: "charter.md" },
		});
		const session = await create("constitutional-primary", settings);
		const initialPrompt = session.agent.state.systemPrompt.join("\n\n");
		const initialCacheKey = session.agent.promptCacheKey;
		const compatible = createMockModel({ id: "constitutional-secondary", handler: () => ({ content: ["ok"] }) });
		const incompatible = createMockModel({ id: "fable-in-name", handler: () => ({ content: ["ok"] }) });

		await Bun.write(dir.join("charter.md"), "Changed after session creation");
		await session.setModel(compatible);
		// The identity block's memory-provider segment settles asynchronously
		// after session construction; force the rebuild to land so the
		// comparison below observes the settled prompt on both sides of the
		// rejected transition rather than whichever await happened to flush it.
		await session.refreshBaseSystemPrompt();
		const compatiblePrompt = session.agent.state.systemPrompt.join("\n\n");
		const compatibleCacheKey = session.agent.promptCacheKey;
		expect(session.systemPromptProfileId).toBe("principal");
		expect(compatiblePrompt).toContain(`§ Role\n${ROLE_PROMPT}\n\n# Engineering`);
		expect(compatiblePrompt).not.toContain("Changed after session creation");
		expect(compatibleCacheKey).toContain("system-prompt-profile:principal");
		expect(initialPrompt).toContain(ROLE_PROMPT);
		expect(compatibleCacheKey).toBe(initialCacheKey);

		await expect(session.setModel(incompatible)).rejects.toThrow('pinned to system prompt profile "principal"');
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
		target.pinSystemPromptSelection({ profileId: "driver", source: "route", memoryBinding: null });
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
		target.pinSystemPromptSelection({ profileId: "worker", source: "route", memoryBinding: null });
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
		expect(() =>
			target.pinSystemPromptSelection({ profileId: "driver", source: "route", memoryBinding: null }),
		).toThrow("immutable once a transcript has started");
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

	it("pins an explicitly selected profile with its owner instead of the routed default", async () => {
		const sessionDir = path.join(dir.path(), "explicit-sessions");
		const session = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "astra-memory",
		});
		const header = session.sessionManager.getHeader();

		expect(session.systemPromptProfileId).toBe("astra-memory");
		expect(header?.systemPromptProfileSource).toBe("explicit");
		expect(header?.memoryBinding).toEqual({ principal: "astra", bankId: "person-astra" });
		expect(session.memoryBinding).toEqual({ principal: "astra", bankId: "person-astra" });
		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("ASTRA MEMORY");
	});

	it("pins an unbound routed session explicitly, distinguishing it from a legacy transcript", async () => {
		const session = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), path.join(dir.path(), "unbound-sessions")),
		});

		expect(session.sessionManager.getHeader()?.memoryBinding).toBeNull();
		expect(session.sessionManager.getHeader()?.systemPromptProfileSource).toBe("route");
		expect(session.memoryBinding).toBeNull();
	});

	it("resumes a persisted explicit selection without the flag while routes point elsewhere", async () => {
		const sessionDir = path.join(dir.path(), "resume-explicit");
		const original = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "astra-memory",
		});
		await original.prompt("seed");
		const sessionFile = original.sessionFile;
		await original.dispose();
		sessions = sessions.filter(session => session !== original);
		if (!sessionFile) throw new Error("Expected persisted source session");

		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		const resumed = await create("driver-primary", boundSettings(), { sessionManager: resumedManager });

		expect(resumed.systemPromptProfileId).toBe("astra-memory");
		expect(resumed.memoryBinding).toEqual({ principal: "astra", bankId: "person-astra" });
	});

	it("keeps an explicit selection through a model change that routes elsewhere", async () => {
		const settings = boundSettings();
		settings.override("systemPromptProfileRoutes", [
			{ agentKind: "main", model: "mock/worker*", profile: "harness-memory" },
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "quiet-worker" },
		]);
		const session = await create("driver-primary", settings, { systemPromptProfile: "astra-memory" });
		const routedElsewhere = createMockModel({ id: "worker-primary", handler: () => ({ content: ["ok"] }) });

		await session.setModel(routedElsewhere);

		expect(session.model?.id).toBe("worker-primary");
		expect(session.systemPromptProfileId).toBe("astra-memory");
		expect(session.memoryBinding).toEqual({ principal: "astra", bankId: "person-astra" });
	});

	it("refuses a flag that contradicts the pinned profile", async () => {
		const sessionDir = path.join(dir.path(), "conflict-sessions");
		const original = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "astra-memory",
		});
		await original.prompt("seed");
		const sessionFile = original.sessionFile;
		await original.dispose();
		sessions = sessions.filter(session => session !== original);
		if (!sessionFile) throw new Error("Expected persisted source session");

		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		try {
			await expect(
				create("driver-primary", boundSettings(), {
					sessionManager: resumedManager,
					systemPromptProfile: "fable-memory",
				}),
			).rejects.toThrow('pinned to system prompt profile "astra-memory"');
		} finally {
			await resumedManager.close();
		}
	});

	it("refuses a resume whose profile now names another bank, before memory starts", async () => {
		const sessionDir = path.join(dir.path(), "rebank-sessions");
		const original = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "fable-memory",
		});
		await original.prompt("seed");
		const sessionFile = original.sessionFile;
		await original.dispose();
		sessions = sessions.filter(session => session !== original);
		if (!sessionFile) throw new Error("Expected persisted source session");

		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		try {
			await expect(
				create("driver-primary", boundSettings("person-fable-v2"), { sessionManager: resumedManager }),
			).rejects.toThrow('pinned to memory owner "fable" (bank "person-fable")');
		} finally {
			await resumedManager.close();
		}
	});

	it("refuses a legacy transcript whose profile has since acquired an owner", async () => {
		const sessionDir = path.join(dir.path(), "legacy-sessions");
		const legacy = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});
		await legacy.prompt("seed");
		const sessionFile = legacy.sessionFile;
		await legacy.dispose();
		sessions = sessions.filter(session => session !== legacy);
		if (!sessionFile) throw new Error("Expected persisted legacy session");
		// Strip the pin fields the way a transcript written before they existed looks.
		const legacyLines = (await fs.readFile(sessionFile, "utf8")).split("\n").map(line => {
			if (!line.includes('"type":"session"')) return line;
			const parsed = JSON.parse(line);
			delete parsed.memoryBinding;
			delete parsed.systemPromptProfileSource;
			return JSON.stringify(parsed);
		});
		await fs.writeFile(sessionFile, legacyLines.join("\n"));

		const settings = boundSettings();
		settings.override("systemPromptProfiles", {
			driver: { prompt: "DRIVER CONSTITUTION", memoryBinding: { principal: "fable", bankId: "person-fable" } },
			"quiet-worker": { instructions: "QUIET WORKER", memory: false },
		});
		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		try {
			await expect(create("driver-primary", settings, { sessionManager: resumedManager })).rejects.toThrow(
				'predates memory owners; start a new session to use "fable"',
			);
		} finally {
			await resumedManager.close();
		}
	});

	it("refuses a bound profile when the memory backend is not Hindsight", async () => {
		const settings = boundSettings();
		settings.override("memory.backend", "local");

		await expect(create("driver-primary", settings, { systemPromptProfile: "fable-memory" })).rejects.toThrow(
			'requires the hindsight memory backend; memory.backend is "local"',
		);
	});

	it("carries profile, selection source, and owner into the transcript /new opens", async () => {
		const sessionDir = path.join(dir.path(), "new-sessions");
		const session = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "fable-memory",
		});

		await session.newSession();
		const header = session.sessionManager.getHeader();

		expect(header?.systemPromptProfile).toBe("fable-memory");
		expect(header?.systemPromptProfileSource).toBe("explicit");
		expect(header?.memoryBinding).toEqual({ principal: "fable", bankId: "person-fable" });
	});

	it("lets a same-owner select-profile fork change prompt but refuses another owner's fork", async () => {
		const sessionDir = path.join(dir.path(), "fork-sessions");
		const original = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "fable-memory",
		});
		await original.prompt("seed");
		const sessionFile = original.sessionFile;
		await original.dispose();
		sessions = sessions.filter(session => session !== original);
		if (!sessionFile) throw new Error("Expected persisted source session");

		const settings = boundSettings();
		settings.override("systemPromptProfiles", {
			driver: { prompt: "DRIVER CONSTITUTION" },
			"quiet-worker": { instructions: "QUIET WORKER", memory: false },
			"fable-memory": { prompt: "FABLE MEMORY", memoryBinding: { principal: "fable", bankId: "person-fable" } },
			"fable-review": { prompt: "FABLE REVIEW", memoryBinding: { principal: "fable", bankId: "person-fable" } },
			"astra-memory": { prompt: "ASTRA MEMORY", memoryBinding: { principal: "astra", bankId: "person-astra" } },
		});

		const sameOwnerFork = await SessionManager.forkFrom(sessionFile, dir.path(), sessionDir, undefined, {
			systemPromptProfile: "select",
		});
		const forked = await create("driver-primary", settings, {
			sessionManager: sameOwnerFork,
			systemPromptProfile: "fable-review",
		});
		expect(forked.systemPromptProfileId).toBe("fable-review");
		expect(forked.sessionManager.getHeader()?.memoryBinding).toEqual({ principal: "fable", bankId: "person-fable" });

		const crossOwnerFork = await SessionManager.forkFrom(sessionFile, dir.path(), sessionDir, undefined, {
			systemPromptProfile: "select",
		});
		try {
			await expect(
				create("driver-primary", settings, {
					sessionManager: crossOwnerFork,
					systemPromptProfile: "astra-memory",
				}),
			).rejects.toThrow("requires a fresh session");
		} finally {
			await crossOwnerFork.close();
		}
	});

	it("binds an independent helper to the owner it acts for and refuses a conflicting profile", async () => {
		const settings = boundSettings();
		const owner: HindsightMemoryBinding = { principal: "fable", bankId: "person-fable" };

		const helper = await create("driver-primary", settings, {
			systemPromptProfile: "harness-memory",
			inheritedMemoryBinding: owner,
		});
		expect(helper.memoryBinding).toEqual(owner);
		expect(helper.sessionManager.getHeader()?.memoryBinding).toEqual(owner);

		await expect(
			create("driver-primary", settings, {
				systemPromptProfile: "astra-memory",
				inheritedMemoryBinding: owner,
			}),
		).rejects.toThrow('profile "astra-memory" declares "astra"');
	});

	it("preserves a disabled worker's owner across persisted revival and history-bearing forks", async () => {
		const settings = boundSettings();
		const owner = { principal: "fable", bankId: "person-fable" };
		const sessionDir = path.join(dir.path(), "disabled-owner-sessions");
		const child = await create("driver-primary", settings, {
			agentKind: "sub",
			taskDepth: 1,
			inheritedMemoryBinding: owner,
			sessionManager: SessionManager.create(dir.path(), sessionDir),
		});

		expect(child.systemPromptProfileId).toBe("quiet-worker");
		expect(child.effectiveIdentity.memory.status).toBe("disabled-by-profile");
		await child.prompt("Preserve this worker history.");
		const sessionFile = child.sessionFile;
		await child.dispose();
		sessions = sessions.filter(session => session !== child);
		if (!sessionFile) throw new Error("Expected persisted worker");
		const reopened = await create("driver-primary", settings, {
			agentKind: "sub",
			taskDepth: 1,
			inheritedMemoryBinding: owner,
			sessionManager: await SessionManager.open(sessionFile, sessionDir),
		});
		await reopened.prompt("Continue the worker history.");
		expect(reopened.memoryBinding).toEqual(owner);
		expect(reopened.getHindsightSessionState()).toBeUndefined();
		expect(reopened.getActiveToolNames()).not.toContain("retain");

		const forkManager = await SessionManager.forkFrom(sessionFile, dir.path(), sessionDir, undefined, {
			systemPromptProfile: "select",
		});
		const forked = await create("driver-primary", settings, {
			agentKind: "sub",
			taskDepth: 1,
			inheritedMemoryBinding: owner,
			sessionManager: forkManager,
		});
		await forked.prompt("Continue from copied history.");
		expect(forked.memoryBinding).toEqual(owner);
		expect(forked.getHindsightSessionState()).toBeUndefined();
		expect(forked.getActiveToolNames()).not.toContain("recall");
	});

	it("refuses a live switch to a transcript of the same profile with another memory owner", async () => {
		const sessionDir = path.join(dir.path(), "switch-owner-sessions");
		const session = await create("driver-primary", boundSettings(), {
			sessionManager: SessionManager.create(dir.path(), sessionDir),
			systemPromptProfile: "fable-memory",
		});

		// Pinned before the profile named an owner: same prompt, no bank.
		const target = SessionManager.create(dir.path(), sessionDir);
		target.pinSystemPromptSelection({ profileId: "fable-memory", source: "explicit", memoryBinding: null });
		const targetModel = createMockModel({ id: "driver-secondary", handler: () => ({ content: ["ok"] }) });
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
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("Expected persisted target session");

		await expect(session.switchSession(targetFile)).rejects.toThrow(
			'Cannot switch from memory owner "fable" to "none"',
		);
		expect(session.memoryBinding).toEqual({ principal: "fable", bankId: "person-fable" });
	});
});
