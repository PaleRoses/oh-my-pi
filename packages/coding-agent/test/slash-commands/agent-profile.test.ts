import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(profileId: string | undefined = "driver") {
	const handleAgentProfileCommand = vi.fn(async (_target?: string) => {});
	const setText = vi.fn();
	const ctx = {
		session: { agentProfileId: profileId },
		editor: { setText },
		handleAgentProfileCommand,
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, handleAgentProfileCommand, setText };
}

describe("/agent-profile", () => {
	it("forwards an explicit profile to the interactive transition owner", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/agent-profile worker", harness.runtime)).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleAgentProfileCommand).toHaveBeenCalledWith("worker");
	});

	it("opens profile selection when no id is supplied", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/agent-profile", harness.runtime)).toBe(true);
		expect(harness.handleAgentProfileCommand).toHaveBeenCalledWith(undefined);
	});

	it("surfaces the active profile in command autocomplete", () => {
		const harness = createRuntime("reviewer");
		const command = buildTuiBuiltinSlashCommands(harness.runtime).find(item => item.name === "agent-profile");

		expect(command?.getAutocompleteDescription?.()).toBe("Agent profile: reviewer");
		expect(command?.getInlineHint?.("")).toBe("[id] [provider/model]");
	});
});
