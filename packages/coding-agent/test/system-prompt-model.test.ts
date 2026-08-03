import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { usesCodexTaskPrompt } from "@oh-my-pi/pi-coding-agent/task/prompt-policy";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

async function expectPromptDateFromStartupTimezone(options: {
	tempDir: string;
	tempHomeDir: string;
	timeZone: string;
	now: string;
	expectedDate: string;
	rejectedDate: string;
}): Promise<void> {
	const scenarioPath = path.join(options.tempDir, "prompt-date-timezone.test.ts");
	await Bun.write(
		scenarioPath,
		`import { expect, it, setSystemTime } from "bun:test";
import { buildSystemPrompt } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/system-prompt.ts"))};

it("renders the prompt date in the startup timezone", async () => {
	setSystemTime(new Date(process.env.OMP_TEST_NOW!));
	try {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: process.cwd(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
		});
		const rendered = systemPrompt.join("\\n\\n");
		expect(rendered).toContain(\`Today is \${process.env.OMP_EXPECTED_DATE}\`);
		expect(rendered).not.toContain(\`Today is \${process.env.OMP_REJECTED_DATE}\`);
	} finally {
		setSystemTime();
	}
});
`,
	);
	const child = Bun.spawn([process.execPath, "test", scenarioPath], {
		cwd: options.tempDir,
		env: {
			...process.env,
			HOME: options.tempHomeDir,
			TZ: options.timeZone,
			OMP_TEST_NOW: options.now,
			OMP_EXPECTED_DATE: options.expectedDate,
			OMP_REJECTED_DATE: options.rejectedDate,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(`${stdout}\n${stderr}`).toContain("1 pass");
	expect(exitCode).toBe(0);
}

describe("system prompt model identifier", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders the model identifier into the workstation block when provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	it("renders the prompt date from the startup local timezone rather than UTC", async () => {
		await expectPromptDateFromStartupTimezone({
			tempDir,
			tempHomeDir,
			timeZone: "America/Los_Angeles",
			now: "2026-07-01T03:15:00Z",
			expectedDate: "2026-06-30",
			rejectedDate: "2026-07-01",
		});
	});

	it("omits the model line when no model is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});
});

describe("AgentSession model-change prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function pickTwoModels(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(m => m.provider !== first.provider || m.id !== first.id);
		if (!first || !second) throw new Error("Expected at least two distinct models in the registry");
		return [first, second];
	}

	function pickTwoModelsWithSameTaskPolicy(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(
			model =>
				(model.provider !== first.provider || model.id !== first.id) &&
				usesCodexTaskPrompt(model.id) === usesCodexTaskPrompt(first.id),
		);
		if (!first || !second) throw new Error("Expected two distinct models with the same task prompt policy");
		return [first, second];
	}

	function pickModelsAcrossTaskPolicies(): [Model, Model] {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => !usesCodexTaskPrompt(model.id));
		const codexPolicy = all.find(model => usesCodexTaskPrompt(model.id));
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		return [defaultPolicy, codexPolicy];
	}

	function newSession(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
		agentProfileId?: string,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
			agentProfileId,
		});
	}

	it("renders a routed profile instead of discovered SYSTEM.md", async () => {
		const [model] = pickTwoModels();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			agentProfiles: {
				driver: {
					prompt: "DRIVER CONSTITUTION\nRemain in the driver's seat.",
					hindsight: { bankId: "driver-bank" },
				},
			},
			agentProfileRoutes: [
				{
					agentKind: "main",
					model: `${model.provider}/${model.id}`,
					profile: "driver",
				},
			],
		});

		({ session } = await createAgentSession({
			cwd: tempDir,
			authStorage,
			modelRegistry,
			settings,
			model,
			sessionManager: SessionManager.inMemory(tempDir),
			discoveredSystemPrompt: "DISCOVERED CONSTITUTION\nThis must remain subordinate.",
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		}));

		const rendered = session.agent.state.systemPrompt.join("\n\n");
		expect(rendered).toContain("DRIVER CONSTITUTION");
		expect(rendered).toContain("ROLE\n==============");
		expect(rendered).toContain("TOOL POLICY\n==============");
		expect(rendered).toContain("EXECUTION WORKFLOW\n==============");
		expect(rendered).toContain("DELIVERY CONTRACT\n==============");
		expect(rendered).not.toContain("DISCOVERED CONSTITUTION");
		expect(session.agentProfileId).toBe("driver");
		expect(session.hindsightScope?.bankId).toBe("driver-bank");
	});

	it("layers a profile constitution over an explicit custom base", async () => {
		const [model] = pickTwoModels();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			agentProfiles: {
				driver: {
					prompt: "DRIVER CONSTITUTION",
					hindsight: { bankId: "driver-bank" },
				},
			},
			agentProfileRoutes: [{ agentKind: "main", profile: "driver" }],
		});

		({ session } = await createAgentSession({
			cwd: tempDir,
			authStorage,
			modelRegistry,
			settings,
			model,
			sessionManager: SessionManager.inMemory(tempDir),
			customSystemPrompt: "EXPLICIT CUSTOM BASE",
			discoveredSystemPrompt: "DISCOVERED CONSTITUTION",
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		}));

		const rendered = session.agent.state.systemPrompt.join("\n\n");
		expect(rendered).toContain("EXPLICIT CUSTOM BASE");
		expect(rendered).toContain("DRIVER CONSTITUTION");
		expect(rendered.split("DRIVER CONSTITUTION")).toHaveLength(2);
		expect(rendered).not.toContain("DISCOVERED CONSTITUTION");
	});

	it("routes task-depth sessions to the worker identity", async () => {
		const [model] = pickTwoModels();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			agentProfiles: {
				driver: { prompt: "DRIVER CONSTITUTION", hindsight: { bankId: "driver-bank" } },
				worker: {
					prompt: "WORKER CONSTITUTION",
					hindsight: { bankId: "worker-bank" },
					tools: ["read"],
					projectContextOnly: true,
				},
			},
			agentProfileRoutes: [
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		({ session } = await createAgentSession({
			cwd: tempDir,
			authStorage,
			modelRegistry,
			settings,
			model,
			taskDepth: 1,
			sessionManager: SessionManager.inMemory(tempDir),
			contextFiles: [
				{ path: path.join(tempDir, "AGENTS.md"), content: "PROJECT POLICY" },
				{ path: path.join(os.homedir(), "CLAUDE.md"), content: "FABLE PRIVATE CONSTITUTION" },
			],
			skills: [],
			rules: [],
			toolNames: ["read", "bash"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		}));

		const rendered = session.agent.state.systemPrompt.join("\n\n");
		expect(session.agentProfileId).toBe("worker");
		expect(session.hindsightScope?.bankId).toBe("worker-bank");
		expect(rendered).toContain("WORKER CONSTITUTION");
		expect(rendered).not.toContain("DRIVER CONSTITUTION");
		expect(rendered).toContain("PROJECT POLICY");
		expect(rendered).not.toContain("FABLE PRIVATE CONSTITUTION");
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("selects one explicit profile from multiple configured identities", async () => {
		const [model] = pickTwoModels();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			agentProfiles: {
				driver: { prompt: "DRIVER CONSTITUTION", hindsight: { bankId: "driver-bank" } },
				reviewer: {
					prompt: "REVIEWER CONSTITUTION",
					hindsight: {
						bankId: "reviewer-bank",
						retainTags: ["mind:reviewer"],
						recallTags: ["mind:reviewer"],
						recallTagsMatch: "all_strict",
					},
					tools: ["read", "grep"],
					projectContextOnly: true,
				},
			},
			agentProfileRoutes: [{ agentKind: "main", profile: "driver" }],
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		({ session } = await createAgentSession({
			cwd: tempDir,
			authStorage,
			modelRegistry,
			settings,
			model,
			sessionManager,
			agentProfile: "reviewer",
			contextFiles: [
				{ path: path.join(tempDir, "AGENTS.md"), content: "PROJECT POLICY" },
				{ path: path.join(os.homedir(), "CLAUDE.md"), content: "FABLE PRIVATE CONSTITUTION" },
			],
			skills: [],
			rules: [],
			toolNames: ["read", "grep", "bash"],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		}));

		const rendered = session.agent.state.systemPrompt.join("\n\n");
		expect(rendered).toContain("REVIEWER CONSTITUTION");
		expect(rendered.split("REVIEWER CONSTITUTION")).toHaveLength(2);
		expect(rendered).not.toContain("DRIVER CONSTITUTION");
		expect(rendered).toContain("PROJECT POLICY");
		expect(rendered).not.toContain("FABLE PRIVATE CONSTITUTION");
		expect(session.agentProfileId).toBe("reviewer");
		expect(sessionManager.getHeader()?.agentProfile).toBe("reviewer");
		expect(session.hindsightScope).toEqual({
			bankId: "reviewer-bank",
			retainTags: ["mind:reviewer"],
			recallTags: ["mind:reviewer"],
			recallTagsMatch: "all_strict",
		});
		expect(new Set(session.getActiveToolNames())).toEqual(new Set(["read", "grep"]));
	});

	it("does not let an explicit custom prompt bypass an identity denial", async () => {
		const [model] = pickTwoModels();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			agentProfiles: {},
			agentProfileRoutes: [
				{
					agentKind: "main",
					model: `${model.provider}/${model.id}`,
					deny: true,
					reason: "This model cannot own a main session.",
				},
			],
		});

		await expect(
			createAgentSession({
				cwd: tempDir,
				authStorage,
				modelRegistry,
				settings,
				model,
				sessionManager: SessionManager.inMemory(tempDir),
				customSystemPrompt: "EXPLICIT CONSTITUTION\nThis prompt owns the session.",
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: [],
				workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			}),
		).rejects.toThrow("This model cannot own a main session.");
	});

	it("rejects a denied model before mutating the active session", async () => {
		const [driverModel, deniedModel] = pickTwoModels();
		authStorage.setRuntimeApiKey(driverModel.provider, "driver-key");
		authStorage.setRuntimeApiKey(deniedModel.provider, "denied-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			agentProfiles: {
				driver: {
					prompt: "DRIVER CONSTITUTION\nRemain in the driver's seat.",
					models: [`${driverModel.provider}/${driverModel.id}`],
					hindsight: { bankId: "driver-bank" },
				},
			},
			agentProfileRoutes: [
				{
					agentKind: "main",
					profile: "driver",
				},
			],
		});

		({ session } = await createAgentSession({
			cwd: tempDir,
			authStorage,
			modelRegistry,
			settings,
			model: driverModel,
			sessionManager: SessionManager.inMemory(tempDir),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		}));

		await expect(session.setModel(deniedModel)).rejects.toThrow('Agent profile "driver" does not allow model');
		expect(session.model?.provider).toBe(driverModel.provider);
		expect(session.model?.id).toBe(driverModel.id);
		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("DRIVER CONSTITUTION");
	});

	it("rebuilds the prompt with the new model when includeModelInPrompt is enabled", async () => {
		const [modelA, modelB] = pickTwoModels();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(modelA, Settings.isolated({ "compaction.enabled": false }), async () => {
			rebuildCount++;
			const active = session?.model;
			return { systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`] };
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild a hidden-model prompt when the task policy stays the same", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameTaskPolicy();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds a hidden-model prompt when the task policy changes", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["policy changed"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["policy changed"]);
	});

	it("keeps the selected agent profile stable across hidden model changes", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameTaskPolicy();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["driver constitution"] };
			},
			"driver",
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agentProfileId).toBe("driver");
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});
});
