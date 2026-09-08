import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	applyPromptProfileOperation,
	type PromptProfileOperation,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/prompt-profile";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

interface PromptSettingsStore {
	systemPromptProfiles: Record<string, SystemPromptProfileSetting>;
	systemPromptProfileRoutes: SystemPromptProfileRouteSetting[];
}

function createRuntime(overrides: Partial<PromptSettingsStore> = {}) {
	const settings = Settings.isolated();
	settings.set(
		"systemPromptProfiles",
		overrides.systemPromptProfiles ?? {
			driver: {},
			worker: {
				instructions: "WORKER",
				projectContextOnly: true,
				memory: false,
				mcpServerInstructions: false,
			},
		},
	);
	settings.set(
		"systemPromptProfileRoutes",
		overrides.systemPromptProfileRoutes ?? [
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		],
	);
	return runtimeForSettings(settings);
}

function runtimeForSettings(settings: Settings, notifyConfigChanged?: () => void | Promise<void>) {
	const output = vi.fn();
	const runtime = {
		cwd: settings.getCwd(),
		settings,
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
			settings,
			getHindsightSessionState: () => undefined,
			getMnemopiSessionState: () => undefined,
		},
		output,
		notifyConfigChanged,
	} as unknown as SlashCommandRuntime;
	return { output, runtime, settings };
}

describe("/identity slash command", () => {
	it("preserves an explicit owner/bank pair and rejects contradictory edits before saving", async () => {
		const harness = createRuntime();
		await executeAcpBuiltinSlashCommand(
			'/identity set driver memoryBinding alpha "Archive::Personal Memory"',
			harness.runtime,
		);
		const configured = harness.settings.get("systemPromptProfiles").driver;
		expect(configured.memoryBinding).toEqual({ principal: "alpha", bankId: "Archive::Personal Memory" });
		await executeAcpBuiltinSlashCommand('/identity set driver memoryBinding "beta owner" archive', harness.runtime);
		expect(harness.settings.get("systemPromptProfiles").driver).toEqual(configured);
		await executeAcpBuiltinSlashCommand("/identity set driver memory off", harness.runtime);
		expect(harness.settings.get("systemPromptProfiles").driver).toEqual(configured);
		await executeAcpBuiltinSlashCommand("/identity unset driver memoryBinding", harness.runtime);
		expect(harness.settings.get("systemPromptProfiles").driver.memoryBinding).toBeUndefined();
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

			expect(harness.settings.get("systemPromptProfiles").driver).toEqual({ instructionsFile: instructionsPath });
			expect(harness.settings.get("systemPromptProfiles").worker?.instructions).toBe("WORKER");
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
			expect(harness.settings.get("systemPromptProfiles").driver).toEqual({ [file]: source, memory: false });
			await executeAcpBuiltinSlashCommand(`/identity unset driver ${file}`, harness.runtime);
			expect(harness.settings.get("systemPromptProfiles").driver).toEqual({ memory: false });

			await executeAcpBuiltinSlashCommand(`/identity set driver ${file} "${source}"`, harness.runtime);
			await executeAcpBuiltinSlashCommand(`/identity set driver ${inline} "REPLACEMENT"`, harness.runtime);
			expect(harness.settings.get("systemPromptProfiles").driver).toEqual({
				[inline]: "REPLACEMENT",
				memory: false,
			});
			await executeAcpBuiltinSlashCommand(`/identity unset driver ${inline}`, harness.runtime);
			expect(harness.settings.get("systemPromptProfiles").driver).toEqual({ memory: false });
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

		expect(harness.settings.get("systemPromptProfiles").driver).toEqual({
			rolePrompt: "Keep  {{literal}}   spacing",
		});
	});

	it("edits boolean elements through concise on and off values", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/identity set driver memory off", harness.runtime);
		await executeAcpBuiltinSlashCommand("/identity set driver project-context-only on", harness.runtime);

		expect(harness.settings.get("systemPromptProfiles").driver).toEqual({ memory: false, projectContextOnly: true });
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
			expect(harness.settings.get("systemPromptProfiles").driver).toEqual({ rolePrompt: "Original role" });

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
		} finally {
			dir.removeSync();
		}
	});

	it("rejects invalid values without mutating settings", async () => {
		const harness = createRuntime();

		await executeAcpBuiltinSlashCommand("/identity set driver memory perhaps", harness.runtime);

		expect(harness.settings.getGlobal("systemPromptProfiles").driver).toEqual({});
	});

	it("validates UI-created profiles and file-backed fields through the canonical resolver before persistence", async () => {
		const harness = createRuntime();

		await applyPromptProfileOperation(harness.runtime, { type: "createProfile", profileId: "researcher" });

		expect(harness.settings.get("systemPromptProfiles").researcher).toEqual({});
		const configured = harness.settings.getGlobal("systemPromptProfiles");
		await expect(
			applyPromptProfileOperation(harness.runtime, { type: "createProfile", profileId: "invalid profile" }),
		).rejects.toThrow("must match");
		expect(harness.settings.getGlobal("systemPromptProfiles")).toEqual(configured);

		await executeAcpBuiltinSlashCommand(
			"/identity set driver promptFile /definitely/missing/system-prompt.md",
			harness.runtime,
		);
		expect(harness.settings.getGlobal("systemPromptProfiles")).toEqual(configured);
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

		expect(harness.settings.get("systemPromptProfileRoutes")).toEqual([
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
		expect(harness.settings.get("systemPromptProfiles").worker).toEqual({
			instructions: "WORKER",
			projectContextOnly: true,
			mcpServerInstructions: false,
		});

		await executeAcpBuiltinSlashCommand("/identity remove worker", harness.runtime);
		expect(harness.settings.getGlobal("systemPromptProfiles").worker).toEqual({
			instructions: "WORKER",
			projectContextOnly: true,
			mcpServerInstructions: false,
		});
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

		expect(harness.settings.get("systemPromptProfileRoutes")).toEqual([
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
		expect(Object.hasOwn(harness.settings.get("systemPromptProfiles"), "toString")).toBe(true);
		await executeAcpBuiltinSlashCommand("/identity show toString", harness.runtime);
		expect(harness.output).toHaveBeenLastCalledWith(expect.stringContaining("System prompt profile: toString"));
	});
});

function foreignProfileOperations(profileId: string): PromptProfileOperation[] {
	return [
		{ type: "createProfile", profileId },
		{ type: "setField", profileId, field: "userTitle", value: "Copied" },
		{ type: "setMemoryBinding", profileId, binding: { principal: "alpha", bankId: "archive" } },
		{ type: "restoreField", profileId, field: "instructions" },
		{ type: "assignRoute", profileId, agentKind: "main" },
		{ type: "removeProfile", profileId },
	];
}

describe("global profile layer ownership", () => {
	let state: SettingsTestState | undefined;
	let dir: TempDir;
	beforeEach(() => {
		state = beginSettingsTest();
		dir = TempDir.createSync("@identity-layers-");
		process.env.HOME = dir.join("home");
		delete process.env.PI_CONFIG_FILES;
		fs.mkdirSync(process.env.HOME, { recursive: true });
	});
	afterEach(() => {
		AgentStorage.close();
		restoreSettingsTestState(state);
		dir.removeSync();
	});

	async function persisted(layer: "global" | "project" | "config", higherDriver: SystemPromptProfileSetting = {}) {
		const agentDir = dir.join("agent");
		const cwd = dir.join("workspace");
		const otherCwd = dir.join("other");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(dir.join("workspace", ".omp"), { recursive: true });
		fs.mkdirSync(otherCwd, { recursive: true });
		const configPath = dir.join("agent", "config.yml");
		const higherPath = layer === "project" ? dir.join("workspace", ".omp", "config.yml") : dir.join("overlay.yml");
		const global: PromptSettingsStore = {
			systemPromptProfiles: { driver: { userTitle: "Global" }, worker: { instructions: "WORKER" } },
			systemPromptProfileRoutes: [
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		};
		const higher: PromptSettingsStore = {
			systemPromptProfiles: {
				driver: { userTitle: "Higher", ...higherDriver },
				localOnly: { instructions: "PRIVATE" },
			},
			systemPromptProfileRoutes: [{ agentKind: "main", profile: "localOnly" }],
		};
		await Bun.write(configPath, YAML.stringify(global));
		if (layer !== "global") await Bun.write(higherPath, YAML.stringify(higher));
		const options = { agentDir, cwd, configFiles: layer === "config" ? [higherPath] : [] };
		const settings = await Settings.loadIsolated(options);
		return { ...runtimeForSettings(settings), settings, options, configPath, higherPath, otherCwd, global, higher };
	}

	it.each(["global", "project", "config"] as const)(
		"edits only global defaults beneath %s settings and returns effective readback",
		async layer => {
			const h = await persisted(layer);
			const receipt = await applyPromptProfileOperation(h.runtime, {
				type: "setField",
				profileId: "driver",
				field: "userTitle",
				value: "Edited",
			});
			const expectedGlobal = {
				driver: { userTitle: "Edited" },
				worker: { instructions: "WORKER" },
			};
			expect(h.settings.getGlobal("systemPromptProfiles")).toEqual(expectedGlobal);
			expect(YAML.parse(await Bun.file(h.configPath).text())).toMatchObject({
				systemPromptProfiles: expectedGlobal,
			});
			expect(receipt.configuration.profiles).toEqual(h.settings.get("systemPromptProfiles"));
			expect(receipt.configuration.profiles.driver.userTitle).toBe(layer === "global" ? "Edited" : "Higher");
			if (layer !== "global") {
				const saved = await Bun.file(h.configPath).text();
				for (const operation of foreignProfileOperations("localOnly")) {
					await expect(applyPromptProfileOperation(h.runtime, operation)).rejects.toThrow();
				}
				expect(await Bun.file(h.configPath).text()).toBe(saved);
				expect(h.settings.getGlobal("systemPromptProfiles")).toEqual(expectedGlobal);
			}
			const elsewhere = await Settings.loadReadOnly({ agentDir: h.options.agentDir, cwd: h.otherCwd });
			expect(elsewhere.get("systemPromptProfiles")).toEqual(expectedGlobal);

			const cleared = await applyPromptProfileOperation(h.runtime, { type: "clearRoute", agentKind: "main" });
			expect(h.settings.getGlobal("systemPromptProfileRoutes")).toEqual([{ agentKind: "sub", profile: "worker" }]);
			expect(cleared.configuration.routes).toEqual(h.settings.get("systemPromptProfileRoutes"));
			const reloaded = await Settings.loadReadOnly(h.options);
			expect(cleared.configuration).toEqual({
				profiles: reloaded.get("systemPromptProfiles"),
				routes: reloaded.get("systemPromptProfileRoutes"),
			});
			const saved = await Bun.file(h.configPath).text();
			const noOp = await applyPromptProfileOperation(h.runtime, { type: "clearRoute", agentKind: "main" });
			expect(noOp.configuration).toEqual(cleared.configuration);
			expect(noOp.restartNotice).toBeUndefined();
			expect(await Bun.file(h.configPath).text()).toBe(saved);
			if (layer !== "global") expect(await Bun.file(h.higherPath).text()).toBe(YAML.stringify(h.higher));
		},
	);

	it.each(["project", "config"] as const)(
		"validates masked sources and hidden routes under %s without writing rejected candidates",
		async layer => {
			const source = dir.join("role.md");
			await Bun.write(source, "Valid role");
			const h = await persisted(layer, { rolePromptFile: source });
			const before = h.settings.get("systemPromptProfiles");
			const saved = await Bun.file(h.configPath).text();
			const invalid: PromptProfileOperation[] = [
				// Effective source is valid, but the authored global file is not.
				{ type: "setField", profileId: "driver", field: "rolePromptFile", value: dir.join("missing.md") },
				// Authored source is valid, but the merged inline/file pair conflicts.
				{ type: "setField", profileId: "driver", field: "rolePrompt", value: "Conflicting inline" },
				// The project route list hides this global reference.
				{ type: "removeProfile", profileId: "worker" },
			];
			for (const operation of invalid) {
				await expect(applyPromptProfileOperation(h.runtime, operation)).rejects.toThrow();
				expect(h.settings.get("systemPromptProfiles")).toEqual(before);
				expect(await Bun.file(h.configPath).text()).toBe(saved);
			}
			// Existing global policy may deliberately select a project-owned name.
			h.settings.set("systemPromptProfileRoutes", [{ agentKind: "sub", profile: "localOnly" }]);
			await h.settings.flush();
			await applyPromptProfileOperation(h.runtime, {
				type: "setField",
				profileId: "driver",
				field: "memory",
				value: "off",
			});
			expect(h.settings.getGlobal("systemPromptProfiles").driver).toEqual({ userTitle: "Global", memory: false });
			expect(Object.hasOwn(h.settings.getGlobal("systemPromptProfiles"), "localOnly")).toBe(false);
		},
	);

	it("refuses every runtime-only profile mutation and reads state after notification", async () => {
		const h = await persisted("global");
		h.settings.override("systemPromptProfiles", { runtimeOnly: { instructions: "PRIVATE" } });
		const saved = await Bun.file(h.configPath).text();
		for (const operation of foreignProfileOperations("runtimeOnly")) {
			await expect(applyPromptProfileOperation(h.runtime, operation)).rejects.toThrow();
		}
		expect(await Bun.file(h.configPath).text()).toBe(saved);
		expect(h.settings.getGlobal("systemPromptProfiles")).toEqual(h.global.systemPromptProfiles);
		const notified = runtimeForSettings(h.settings, async () => {
			h.settings.override("systemPromptProfiles", { driver: { userTitle: "After notification" } });
			h.settings.override("systemPromptProfileRoutes", [{ agentKind: "main", profile: "worker" }]);
		});
		const receipt = await applyPromptProfileOperation(notified.runtime, {
			type: "setField",
			profileId: "driver",
			field: "userTitle",
			value: "Authored",
		});
		expect(h.settings.getGlobal("systemPromptProfiles").driver.userTitle).toBe("Authored");
		expect(receipt.configuration).toEqual({
			profiles: { driver: { userTitle: "After notification" }, worker: { instructions: "WORKER" } },
			routes: [{ agentKind: "main", profile: "worker" }],
		});
	});
});
