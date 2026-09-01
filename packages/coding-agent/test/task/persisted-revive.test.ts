import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function createRef(sessionFile: string, id = "persisted-restricted"): AgentRef {
	return {
		id,
		displayName: "Persisted Restricted",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	};
}

type IrcWakeObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface RevivedSessionHandle {
	session: AgentSession;
	observer: () => IrcWakeObserver | undefined;
}

function createRevivedSession(activeToolNames: string[][], extensionRunner?: unknown): RevivedSessionHandle {
	let observer: IrcWakeObserver | undefined;
	const session = {
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		setIrcWakeTurnObserver: (next: IrcWakeObserver | undefined) => {
			observer = next;
		},
		subscribeRunState: () => () => {},
		getLastAssistantMessage: () => undefined,
		extensionRunner,
	} as unknown as AgentSession;
	return { session, observer: () => observer };
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	modelRole?: string,
	advisor?: string,
	contract?: { tools?: string[]; readOnly?: boolean },
	systemPromptProfile?: string,
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.pinSystemPromptProfile(systemPromptProfile);
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: contract?.tools ?? ["read", "yield"],
		restrictToolNames,
		modelRole,
		resolvedModel: modelRole ? "anthropic/claude-sonnet-4-5" : undefined,
		advisor,
		readOnly: contract?.readOnly,
	});
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.close();
	return sessionFile;
}

function createFactory(
	cwd: string,
	eventBus?: EventBus,
	suppliedParentSession?: AgentSession,
	overrides?: { settings?: Settings; authStorage?: AuthStorage; modelRegistry?: ModelRegistry },
) {
	const parentSession =
		suppliedParentSession ??
		({
			sessionManager: {
				getCwd: () => cwd,
				getArtifactManager: () => undefined,
			},
			get sessionFile() {
				return path.join(cwd, "parent.jsonl");
			},
		} as unknown as AgentSession);
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: overrides?.authStorage ?? ({} as never),
		modelRegistry: overrides?.modelRegistry ?? ({ authStorage: {} } as ModelRegistry),
		settings: overrides?.settings ?? Settings.isolated(),
		enableLsp: true,
		eventBus,
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
	it("initializes the extension runtime on cold revival so tool_call handlers are not fail-closed blocked", async () => {
		const cwd = makeTempDir("@pi-revive-ext-init-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		const initialize = vi.fn();
		const onError = vi.fn();
		const emit = vi.fn(async () => undefined);
		const extensionRunner = { initialize, onError, emit };
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createRevivedSession([], extensionRunner).session }) as CreateAgentSessionResult,
		);

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(initialize).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith({ type: "session_start" });
	});

	it("cold-revives a restricted contract without loading hostile same-name capabilities", async () => {
		const cwd = makeTempDir("@pi-restricted-revive-");
		const sessionFile = await createPersistedSession(cwd, true);
		const hostileMcpGetTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileMcpGetTools } as unknown as MCPManager);
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		const attemptedDiscovery: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			if (options?.preloadedExtensionPaths === undefined) attemptedDiscovery.push("extension:read");
			if (options?.preloadedCustomToolPaths === undefined) attemptedDiscovery.push("custom:read");
			if (options?.mcpManager !== undefined || options?.customTools !== undefined)
				attemptedDiscovery.push("mcp:read");
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableIrc).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual([]);
		expect(capturedOptions?.preloadedCustomToolPaths).toEqual([]);
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(attemptedDiscovery).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("cold-revives a restricted Hindsight recall grant as the parent's runtime alias", async () => {
		const cwd = makeTempDir("@pi-restricted-memory-revive-");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.bankId": "memory-bank",
			"hindsight.mentalModelsEnabled": false,
			"hindsight.autoRecall": false,
			systemPromptProfiles: { driver: { memory: true }, worker: { memory: true } },
			systemPromptProfileRoutes: [
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		let parent: AgentSession | undefined;
		let revived: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled Anthropic model");
			({ session: parent } = await sdkModule.createAgentSession({
				cwd,
				agentDir: cwd,
				authStorage,
				modelRegistry,
				model,
				settings,
				sessionManager: SessionManager.inMemory(cwd),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
				workspaceTree: {
					rootPath: cwd,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
			}));
			const sessionFile = await createPersistedSession(
				cwd,
				true,
				"default",
				undefined,
				{ tools: ["recall", "yield"] },
				"worker",
			);
			const ref = AgentRegistry.global().register(createRef(sessionFile, "persisted-memory-alias"));
			const reviver = await createFactory(cwd, undefined, parent, {
				settings,
				authStorage,
				modelRegistry,
			})(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			revived = await reviver(ref);

			const parentState = parent.getHindsightSessionState();
			expect(parentState).toBeDefined();
			expect(revived.getHindsightSessionState()?.aliasOf).toBe(parentState);
			expect(revived.agent.state.tools.map(tool => tool.name)).toEqual(["recall", "yield"]);
		} finally {
			await revived?.dispose();
			await parent?.dispose();
			AgentRegistry.global().unregister("persisted-memory-alias");
			authStorage.close();
		}
	});

	it("strips synthetic write from legacy read-only cold revival", async () => {
		const cwd = makeTempDir("@pi-read-only-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: true,
		});
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.toolNames).toEqual(["read", "yield"]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves explicitly writable cold-revival contracts", async () => {
		const cwd = makeTempDir("@pi-write-revive-");
		const sessionFile = await createPersistedSession(cwd, undefined, undefined, undefined, {
			tools: ["read", "write", "yield"],
			readOnly: false,
		});
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.toolNames).toEqual(["read", "write", "yield"]);
		expect(activeToolNames).toEqual([["read", "write", "yield"]]);
	});

	it("preserves normal revival capability wiring for contracts without the marker", async () => {
		const cwd = makeTempDir("@pi-normal-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const hostileMcp = {
			getTools: () => [{ name: "mcp__server_read", label: "server/read" }],
		} as unknown as MCPManager;
		MCPManager.setInstance(hostileMcp);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBeUndefined();
		expect(capturedOptions?.enableLsp).toBe(true);
		expect(capturedOptions?.mcpManager).toBe(hostileMcp);
		expect(capturedOptions?.customTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
	});

	it("hands the owning live parent session to the revived runtime", async () => {
		const cwd = makeTempDir("@pi-parent-session-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const parentState = {} as HindsightSessionState;
		const parentSession = {
			sessionManager: {
				getCwd: () => cwd,
				getArtifactManager: () => undefined,
			},
			getHindsightSessionState: () => parentState,
		} as unknown as AgentSession;
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd, undefined, parentSession)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.parentHindsightSessionState).toBe(parentState);
	});

	it("restores the persisted per-agent advisor opt-in on cold revival", async () => {
		const cwd = makeTempDir("@pi-advisor-revive-");
		const advisedFile = await createPersistedSession(cwd, undefined, undefined, "moonshot/k3");
		const roleAdvisedFile = await createPersistedSession(cwd, undefined, undefined, "on");
		const unadvisedFile = await createPersistedSession(cwd);
		const captured: Settings[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options?.settings) captured.push(options.settings);
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const factory = createFactory(cwd);
		for (const sessionFile of [advisedFile, roleAdvisedFile, unadvisedFile]) {
			const ref = createRef(sessionFile);
			const reviver = await factory(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
		}

		const [advised, roleAdvised, unadvised] = captured;
		expect(advised.get("advisor.enabled")).toBe(true);
		expect(advised.getModelRole("advisor")).toBe("moonshot/k3");
		expect(roleAdvised.get("advisor.enabled")).toBe(true);
		expect(roleAdvised.getModelRole("advisor")).toBeUndefined();
		expect(unadvised.get("advisor.enabled")).toBe(false);
	});

	it("restores the persisted custom model role before reopening the session", async () => {
		const cwd = makeTempDir("@pi-custom-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "review-fast");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toEqual(["@review-fast", "anthropic/claude-sonnet-4-5"]);
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("pins the persisted concrete model when the default role is revived", async () => {
		const cwd = makeTempDir("@pi-default-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toBe("anthropic/claude-sonnet-4-5");
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const terminal = Promise.withResolvers<void>();
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") terminal.resolve();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd, eventBus)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume after resume",
			display: true,
			details: { id: "irc-1", from: "Main", message: "resume after resume" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		await finish?.();
		await terminal.promise;

		expect(frames[0]).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id: ref.id, status: "started" },
		});
		const last = frames.at(-1);
		expect(last?.type).toBe("subagent_lifecycle");
		if (last?.type !== "subagent_lifecycle") throw new Error("expected terminal lifecycle frame");
		expect(last.payload.id).toBe(ref.id);
		expect(last.payload.status).not.toBe("started");
		rpcRegistry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("preserves the completed output artifact when a revived subagent answers a hub message without yielding", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-artifact-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		// The completed first run already wrote its report to <artifactsDir>/<id>.md
		// (artifactsDir = parent sessionFile sans ".jsonl"; see createFactory).
		const artifactPath = path.join(cwd, "parent", `${ref.id}.md`);
		const completedReport = "# Completed report\n\nfull multi-paragraph body\n\nZZEND";
		await Bun.write(artifactPath, completedReport);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "thanks",
			display: true,
			details: { id: "irc-1", from: "Main", message: "thanks" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		// A wake turn answering a hub message never calls yield; finalization must
		// not clobber the authoritative completion artifact with a warning body.
		const finish = observer?.([record]);
		await finish?.();

		expect(await Bun.file(artifactPath).text()).toBe(completedReport);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
});
