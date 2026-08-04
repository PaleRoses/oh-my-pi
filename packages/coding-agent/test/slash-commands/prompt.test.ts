import { describe, expect, it, vi } from "bun:test";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";

interface PromptSettingsStore {
	systemPromptProfiles: Record<string, SystemPromptProfileSetting>;
	systemPromptProfileRoutes: SystemPromptProfileRouteSetting[];
}

function createRuntime(overrides: Partial<PromptSettingsStore> = {}) {
	const store: PromptSettingsStore = {
		systemPromptProfiles: {
			driver: {},
			worker: {
				instructions: "WORKER",
				projectContextOnly: true,
				memory: false,
				mcpServerInstructions: false,
			},
		},
		systemPromptProfileRoutes: [
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		],
		...overrides,
	};
	const get = vi.fn((path: keyof PromptSettingsStore) => store[path]);
	const set = vi.fn(<P extends keyof PromptSettingsStore>(path: P, value: PromptSettingsStore[P]) => {
		store[path] = value;
	});
	const flush = vi.fn(async () => {});
	const output = vi.fn();
	const notifyConfigChanged = vi.fn();
	const runtime = {
		cwd: process.cwd(),
		settings: { get, set, flush },
		session: {
			effectiveIdentity: {
				role: "main",
				prompt: {
					profileId: "driver",
					principal: "maintained-omp-prompt",
					source: "maintained-omp-prompt",
				},
				memory: { status: "enabled" },
			},
		},
		output,
		notifyConfigChanged,
	} as unknown as SlashCommandRuntime;
	return { flush, notifyConfigChanged, output, runtime, set, store };
}

describe("/prompt slash command", () => {
	it("shows the active immutable identity and complete configured surface", async () => {
		const harness = createRuntime();

		expect(await executeAcpBuiltinSlashCommand("/prompt", harness.runtime)).toEqual({ consumed: true });
		expect(harness.output).toHaveBeenCalledWith(
			expect.stringContaining(
				"Active: role=main; profile=driver; principal=maintained-omp-prompt; source=maintained-omp-prompt",
			),
		);
		expect(harness.output).toHaveBeenCalledWith(expect.stringContaining("driver: base=maintained"));
		expect(harness.output).toHaveBeenCalledWith(expect.stringContaining("1. main · * -> driver"));
		expect(harness.set).not.toHaveBeenCalled();
	});

	it("sets file-backed instructions, preserves sibling profiles, and flushes before reporting", async () => {
		const dir = TempDir.createSync("@prompt-command-");
		try {
			const instructionsPath = dir.join("driver instructions.md");
			await Bun.write(instructionsPath, "DRIVER INSTRUCTIONS");
			const harness = createRuntime();

			await executeAcpBuiltinSlashCommand(
				`/prompt set driver instructionsFile "${instructionsPath}"`,
				harness.runtime,
			);

			expect(harness.store.systemPromptProfiles.driver).toEqual({ instructionsFile: instructionsPath });
			expect(harness.store.systemPromptProfiles.worker?.instructions).toBe("WORKER");
			expect(harness.flush).toHaveBeenCalledTimes(1);
			expect(harness.notifyConfigChanged).toHaveBeenCalledTimes(1);
			expect(harness.output).toHaveBeenCalledWith(
				"Saved driver.instructionsFile.\nGlobal config updated. Restart OMP to load the new prompt identity; /new keeps the current profile. Project and --config overrides still take precedence.",
			);
		} finally {
			dir.removeSync();
		}
	});

	it("keeps prompt and promptFile mutually exclusive", async () => {
		const dir = TempDir.createSync("@prompt-command-source-");
		try {
			const promptPath = dir.join("driver.md");
			await Bun.write(promptPath, "DRIVER PROMPT");
			const harness = createRuntime({
				systemPromptProfiles: { driver: { prompt: "INLINE" }, worker: {} },
			});

			await executeAcpBuiltinSlashCommand(`/prompt set driver promptFile "${promptPath}"`, harness.runtime);

			expect(harness.store.systemPromptProfiles.driver).toEqual({ promptFile: promptPath });
		} finally {
			dir.removeSync();
		}
	});

	it("preserves quoted inline prompt whitespace", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand('/prompt set driver instructions "Keep  exact   spacing"', harness.runtime);

		expect(harness.store.systemPromptProfiles.driver).toEqual({
			instructions: "Keep  exact   spacing",
		});
	});

	it("edits boolean elements through concise on and off values", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/prompt set driver memory off", harness.runtime);
		await executeAcpBuiltinSlashCommand("/prompt set driver project-context-only on", harness.runtime);

		expect(harness.store.systemPromptProfiles.driver).toEqual({ memory: false, projectContextOnly: true });
		expect(harness.flush).toHaveBeenCalledTimes(2);
	});

	it("rejects invalid values without mutating settings", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/prompt set driver memory perhaps", harness.runtime);

		expect(harness.set).not.toHaveBeenCalled();
		expect(harness.output).toHaveBeenCalledWith(
			'Prompt profile error: memory expects on or off, received "perhaps".',
		);
	});

	it("routes all new sessions of one agent kind without disturbing the other kind", async () => {
		const harness = createRuntime({
			systemPromptProfiles: { driver: {}, researcher: {}, worker: {} },
			systemPromptProfileRoutes: [
				{ agentKind: "main", model: "anthropic/*", profile: "researcher" },
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		await executeAcpBuiltinSlashCommand("/prompt use researcher main", harness.runtime);

		expect(harness.store.systemPromptProfileRoutes).toEqual([
			{ agentKind: "main", profile: "researcher" },
			{ agentKind: "main", model: "anthropic/*", profile: "researcher" },
			{ agentKind: "sub", profile: "worker" },
		]);
		expect(harness.output).toHaveBeenCalledWith(
			"Set the global unconditional main prompt route to researcher.\nGlobal config updated. Restart OMP to load the new prompt identity; /new keeps the current profile. Project and --config overrides still take precedence.",
		);
	});

	it("restores a field default and refuses to remove a routed profile", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/prompt unset worker memory", harness.runtime);
		expect(harness.store.systemPromptProfiles.worker).toEqual({
			instructions: "WORKER",
			projectContextOnly: true,
			mcpServerInstructions: false,
		});

		harness.set.mockClear();
		await executeAcpBuiltinSlashCommand("/prompt remove worker", harness.runtime);
		expect(harness.set).not.toHaveBeenCalled();
		expect(harness.output).toHaveBeenLastCalledWith(
			'Prompt profile error: System prompt profile "worker" is still referenced by a route.',
		);
	});

	it("removes an unconditional route while retaining model-specific policy", async () => {
		const harness = createRuntime({
			systemPromptProfileRoutes: [
				{ agentKind: "main", model: "openai-codex/*", profile: "driver" },
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		await executeAcpBuiltinSlashCommand("/prompt unroute main", harness.runtime);

		expect(harness.store.systemPromptProfileRoutes).toEqual([
			{ agentKind: "main", model: "openai-codex/*", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		]);
	});
});
