import { describe, expect, it, vi } from "bun:test";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { applyPromptProfileOperation } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/prompt-profile";
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
			model: { provider: "anthropic", id: "claude-fable-5" },
			sessionId: "session-identity",
			settings: { get },
			getHindsightSessionState: () => undefined,
			getMnemopiSessionState: () => undefined,
		},
		output,
		notifyConfigChanged,
	} as unknown as SlashCommandRuntime;
	return { flush, notifyConfigChanged, output, runtime, set, store };
}

describe("/identity slash command", () => {
	it("preserves an explicit owner/bank pair and rejects contradictory edits before saving", async () => {
		const harness = createRuntime();
		await executeAcpBuiltinSlashCommand(
			'/identity set driver memoryBinding alpha "Archive::Personal Memory"',
			harness.runtime,
		);
		const configured = harness.store.systemPromptProfiles.driver;
		expect(configured.memoryBinding).toEqual({ principal: "alpha", bankId: "Archive::Personal Memory" });
		await executeAcpBuiltinSlashCommand('/identity set driver memoryBinding "beta owner" archive', harness.runtime);
		expect(harness.store.systemPromptProfiles.driver).toEqual(configured);
		await executeAcpBuiltinSlashCommand("/identity set driver memory off", harness.runtime);
		expect(harness.store.systemPromptProfiles.driver).toEqual(configured);
		await executeAcpBuiltinSlashCommand("/identity unset driver memoryBinding", harness.runtime);
		expect(harness.store.systemPromptProfiles.driver.memoryBinding).toBeUndefined();
	});

	it("sets file-backed instructions, preserves sibling profiles, and persists configuration", async () => {
		const dir = TempDir.createSync("@identity-command-");
		try {
			const instructionsPath = dir.join("driver instructions.md");
			await Bun.write(instructionsPath, "DRIVER INSTRUCTIONS");
			const harness = createRuntime();

			await executeAcpBuiltinSlashCommand(
				`/identity set driver instructionsFile "${instructionsPath}"`,
				harness.runtime,
			);

			expect(harness.store.systemPromptProfiles.driver).toEqual({ instructionsFile: instructionsPath });
			expect(harness.store.systemPromptProfiles.worker?.instructions).toBe("WORKER");
			expect(harness.flush).toHaveBeenCalledTimes(1);
			expect(harness.notifyConfigChanged).toHaveBeenCalledTimes(1);
		} finally {
			dir.removeSync();
		}
	});

	it.each([
		["rolePrompt", "rolePromptFile"],
		["prompt", "promptFile"],
		["instructions", "instructionsFile"],
	] as const)("switches %s sources exclusively and restores either source", async (inline, file) => {
		const dir = TempDir.createSync("@identity-command-source-");
		try {
			const source = dir.join("driver.md");
			await Bun.write(source, "# File document");
			const harness = createRuntime({
				systemPromptProfiles: { driver: { [inline]: "INLINE", memory: false }, worker: {} },
			});

			await executeAcpBuiltinSlashCommand(`/identity set driver ${file} "${source}"`, harness.runtime);
			expect(harness.store.systemPromptProfiles.driver).toEqual({ [file]: source, memory: false });
			await executeAcpBuiltinSlashCommand(`/identity unset driver ${file}`, harness.runtime);
			expect(harness.store.systemPromptProfiles.driver).toEqual({ memory: false });

			await executeAcpBuiltinSlashCommand(`/identity set driver ${file} "${source}"`, harness.runtime);
			await executeAcpBuiltinSlashCommand(`/identity set driver ${inline} "REPLACEMENT"`, harness.runtime);
			expect(harness.store.systemPromptProfiles.driver).toEqual({ [inline]: "REPLACEMENT", memory: false });
			await executeAcpBuiltinSlashCommand(`/identity unset driver ${inline}`, harness.runtime);
			expect(harness.store.systemPromptProfiles.driver).toEqual({ memory: false });
		} finally {
			dir.removeSync();
		}
	});

	it("preserves quoted role instructions whitespace and template-looking text", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand(
			'/identity set driver rolePrompt "Keep  {{literal}}   spacing"',
			harness.runtime,
		);

		expect(harness.store.systemPromptProfiles.driver).toEqual({
			rolePrompt: "Keep  {{literal}}   spacing",
		});
	});

	it("edits boolean elements through concise on and off values", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/identity set driver memory off", harness.runtime);
		await executeAcpBuiltinSlashCommand("/identity set driver project-context-only on", harness.runtime);

		expect(harness.store.systemPromptProfiles.driver).toEqual({ memory: false, projectContextOnly: true });
		expect(harness.flush).toHaveBeenCalledTimes(2);
	});

	it("summarizes role instructions sources without exposing document prose", async () => {
		const rolePrompt = "# Private role\nKeep {{document}} literal.";
		const source = "roles/researcher.md";
		const harness = createRuntime({
			systemPromptProfiles: { driver: { rolePrompt }, worker: { rolePromptFile: source } },
		});

		await executeAcpBuiltinSlashCommand("/identity status", harness.runtime);
		const status = harness.output.mock.calls.at(-1)?.[0] as string;
		expect(status).toContain(`rolePrompt=inline (${rolePrompt.length} chars)`);
		expect(status).toContain(`rolePrompt=file ${source}`);
		expect(status).not.toContain(rolePrompt);

		await executeAcpBuiltinSlashCommand("/identity show driver", harness.runtime);
		const inlineDetails = harness.output.mock.calls.at(-1)?.[0] as string;
		expect(inlineDetails).toContain(`rolePrompt: inline (${rolePrompt.length} chars)`);
		expect(inlineDetails).not.toContain(rolePrompt);
		await executeAcpBuiltinSlashCommand("/identity show worker", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(expect.stringContaining(`rolePromptFile: ${source}`));
		expect(harness.set).not.toHaveBeenCalled();
	});

	it("rejects missing, empty and conflicting role instructions documents before writing", async () => {
		const dir = TempDir.createSync("@identity-command-invalid-");
		try {
			const source = dir.join("role-instructions.md");
			const harness = createRuntime({
				systemPromptProfiles: { driver: { rolePrompt: "Original role" }, worker: {} },
			});
			const replaceFile = () =>
				applyPromptProfileOperation(harness.runtime, {
					type: "setField",
					profileId: "driver",
					field: "rolePromptFile",
					value: source,
				});
			await expect(replaceFile()).rejects.toThrow();
			await Bun.write(source, "   ");
			await expect(replaceFile()).rejects.toThrow();
			await expect(
				applyPromptProfileOperation(harness.runtime, {
					type: "setField",
					profileId: "driver",
					field: "rolePrompt",
					value: "   ",
				}),
			).rejects.toThrow();
			expect(harness.store.systemPromptProfiles.driver).toEqual({ rolePrompt: "Original role" });
			expect(harness.set).not.toHaveBeenCalled();
			expect(harness.flush).not.toHaveBeenCalled();
			expect(harness.notifyConfigChanged).not.toHaveBeenCalled();

			await Bun.write(source, "# Valid file role");
			const conflicting = createRuntime({
				systemPromptProfiles: { driver: {}, worker: { rolePrompt: "Role", rolePromptFile: source } },
			});
			await expect(
				applyPromptProfileOperation(conflicting.runtime, {
					type: "setField",
					profileId: "driver",
					field: "memory",
					value: "off",
				}),
			).rejects.toThrow();
			expect(conflicting.set).not.toHaveBeenCalled();
			expect(conflicting.flush).not.toHaveBeenCalled();
		} finally {
			dir.removeSync();
		}
	});

	it("rejects invalid values without mutating settings", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/identity set driver memory perhaps", harness.runtime);

		expect(harness.set).not.toHaveBeenCalled();
		expect(harness.output).toHaveBeenCalledWith('Identity error: memory expects on or off, received "perhaps".');
	});

	it("validates UI-created profiles and file-backed fields through the canonical resolver before persistence", async () => {
		const harness = createRuntime();

		await applyPromptProfileOperation(harness.runtime, { type: "createProfile", profileId: "researcher" });

		expect(harness.store.systemPromptProfiles.researcher).toEqual({});
		expect(harness.flush).toHaveBeenCalledTimes(1);

		harness.set.mockClear();
		await expect(
			applyPromptProfileOperation(harness.runtime, { type: "createProfile", profileId: "invalid profile" }),
		).rejects.toThrow("must match");
		expect(harness.set).not.toHaveBeenCalled();

		await executeAcpBuiltinSlashCommand(
			"/identity set driver promptFile /definitely/missing/system-prompt.md",
			harness.runtime,
		);
		expect(harness.set).not.toHaveBeenCalled();
		expect(harness.output).toHaveBeenLastCalledWith(
			expect.stringContaining('Could not read system prompt profile "driver"'),
		);
	});

	it("puts the unconditional route first while preserving model-specific and deny route order", async () => {
		const harness = createRuntime({
			systemPromptProfiles: { driver: {}, researcher: {}, worker: {} },
			systemPromptProfileRoutes: [
				{ agentKind: "main", model: "anthropic/*", profile: "researcher" },
				{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
				{ agentKind: "sub", model: "openai/*", deny: true },
			],
		});

		await executeAcpBuiltinSlashCommand("/identity use researcher main", harness.runtime);

		expect(harness.store.systemPromptProfileRoutes).toEqual([
			{ agentKind: "main", profile: "researcher" },
			{ agentKind: "main", model: "anthropic/*", profile: "researcher" },
			{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
			{ agentKind: "sub", profile: "worker" },
			{ agentKind: "sub", model: "openai/*", deny: true },
		]);
	});

	it("restores a field default and refuses to remove a routed profile", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/identity unset worker memory", harness.runtime);
		expect(harness.store.systemPromptProfiles.worker).toEqual({
			instructions: "WORKER",
			projectContextOnly: true,
			mcpServerInstructions: false,
		});

		harness.set.mockClear();
		await executeAcpBuiltinSlashCommand("/identity remove worker", harness.runtime);
		expect(harness.set).not.toHaveBeenCalled();
		expect(harness.output).toHaveBeenLastCalledWith(
			'Identity error: System prompt profile "worker" is still referenced by a route.',
		);
	});

	it("removes an unconditional route while retaining model-specific policy", async () => {
		const harness = createRuntime({
			systemPromptProfileRoutes: [
				{ agentKind: "main", model: "openai-codex/*", profile: "driver" },
				{ agentKind: "main", deny: true, reason: "main disabled" },
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		await executeAcpBuiltinSlashCommand("/identity unroute main", harness.runtime);

		expect(harness.store.systemPromptProfileRoutes).toEqual([
			{ agentKind: "main", model: "openai-codex/*", profile: "driver" },
			{ agentKind: "main", deny: true, reason: "main disabled" },
			{ agentKind: "sub", profile: "worker" },
		]);
	});
	it("rejects inherited object names but permits explicitly configured profiles with those names", async () => {
		const harness = createRuntime();
		await executeAcpBuiltinSlashCommand("/identity show toString", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(
			expect.stringContaining('Unknown system prompt profile "toString"'),
		);
		await executeAcpBuiltinSlashCommand("/identity set toString instructions explicit", harness.runtime);
		expect(Object.hasOwn(harness.store.systemPromptProfiles, "toString")).toBe(true);
		await executeAcpBuiltinSlashCommand("/identity show toString", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(expect.stringContaining("System prompt profile: toString"));
	});
});
