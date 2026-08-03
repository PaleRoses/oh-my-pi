import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function modelName(model: Model): string {
	return `${model.provider}/${model.id}`;
}

describe("InteractiveMode agent-profile transition", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let driverModel: Model;
	let workerModel: Model;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-agent-profile-switch-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const models = modelRegistry.getAll();
		driverModel = models[0];
		workerModel = models.find(model => model.provider !== driverModel.provider || model.id !== driverModel.id)!;
		if (!driverModel || !workerModel) throw new Error("Expected two bundled models");
		authStorage.setRuntimeApiKey(driverModel.provider, "test-key");
		authStorage.setRuntimeApiKey(workerModel.provider, "test-key");
		const isolatedSettings = Settings.isolated({
			agentProfiles: {
				driver: {
					prompt: "DRIVER CONSTITUTION",
					hindsight: { bankId: "driver-bank" },
					models: [modelName(driverModel)],
				},
				worker: {
					prompt: "WORKER CONSTITUTION",
					hindsight: { bankId: "worker-bank" },
					models: [modelName(workerModel)],
				},
			},
			agentProfileRoutes: [],
		});
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: driverModel, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: isolatedSettings,
			modelRegistry,
			agentProfileId: "driver",
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("records a fresh-session request with an explicit target model", async () => {
		const input = mode.getUserInput();
		const targetThinking = session.resolveTemporaryModelThinkingLevel(workerModel);

		await mode.handleAgentProfileCommand(`worker ${modelName(workerModel)}`);

		expect((await input).customType).toBe("agent-profile-switch");
		expect(mode.takeAgentProfileSwitchRequest()).toMatchObject({
			profileId: "worker",
			model: workerModel,
			thinkingLevel: targetThinking,
			cwd: tempDir.path(),
		});
	});

	it("selects the target profile's sole compatible model before teardown", async () => {
		const input = mode.getUserInput();

		await mode.handleAgentProfileCommand("worker");

		expect((await input).customType).toBe("agent-profile-switch");
		expect(mode.takeAgentProfileSwitchRequest()).toMatchObject({
			profileId: "worker",
			model: workerModel,
		});
		expect(mode.takeAgentProfileSwitchRequest()).toBeUndefined();
	});

	it("fails closed while a background job is running", async () => {
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});
		Object.defineProperty(session, "asyncJobManager", {
			value: { getRunningJobs: () => [{ status: "running" }] },
		});

		await mode.handleAgentProfileCommand("worker");

		expect(showWarning).toHaveBeenCalledWith("Wait for or stop background jobs before switching agent profiles.");
		expect(mode.takeAgentProfileSwitchRequest()).toBeUndefined();
	});

	it("does not mutate or wake the loop when the active profile is requested", async () => {
		const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		void mode.getUserInput();

		await mode.handleAgentProfileCommand("driver");

		expect(showStatus).toHaveBeenCalledWith('Agent profile "driver" is already active.');
		expect(mode.takeAgentProfileSwitchRequest()).toBeUndefined();
	});
});
