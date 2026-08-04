import { describe, expect, it, vi } from "bun:test";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

interface PromptSettingsStore {
	systemPromptProfiles: Record<string, SystemPromptProfileSetting>;
	systemPromptProfileRoutes: SystemPromptProfileRouteSetting[];
}

function createRuntime() {
	const store: PromptSettingsStore = {
		systemPromptProfiles: { driver: {}, worker: {} },
		systemPromptProfileRoutes: [
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		],
	};
	const setText = vi.fn();
	const showPromptProfileSelector = vi.fn();
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText },
			showPromptProfileSelector,
			showStatus,
			settings: {
				get: (path: keyof PromptSettingsStore) => store[path],
			},
			sessionManager: { getCwd: () => process.cwd() },
			session: {
				effectiveIdentity: {
					role: "main",
					prompt: {
						profileId: "driver",
						principal: "maintained-omp-prompt",
						source: "maintained-omp-prompt",
					},
				},
			},
		},
	} as unknown as BuiltinSlashCommandRuntime;
	return { runtime, setText, showPromptProfileSelector, showStatus };
}

describe("/prompt TUI dispatch", () => {
	it.each(["/prompt", "/prompts"])(
		"opens the interactive selector for bare %s and clears the slash draft",
		async command => {
			const harness = createRuntime();

			expect(await executeBuiltinSlashCommand(command, harness.runtime)).toBe(true);
			expect(harness.setText).toHaveBeenCalledWith("");
			expect(harness.showPromptProfileSelector).toHaveBeenCalledTimes(1);
			expect(harness.showStatus).not.toHaveBeenCalled();
		},
	);

	it("keeps non-empty prompt commands on the textual TUI path", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/prompt status", harness.runtime)).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showPromptProfileSelector).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("System prompt profiles"));
		expect(harness.showStatus).toHaveBeenCalledWith(expect.stringContaining("Active: role=main; profile=driver"));
	});
});
