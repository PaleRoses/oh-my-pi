import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("parseArgs — --prompt-profile flag", () => {
	it("parses the separated and equals forms without eating the message", () => {
		const separated = parseArgs(["--prompt-profile", "astra-memory", "--print", "hello"]);
		const equals = parseArgs(["--prompt-profile=astra-memory", "--print", "hello"]);

		expect(separated.promptProfile).toBe("astra-memory");
		expect(separated.messages).toEqual(["hello"]);
		expect(equals.promptProfile).toBe("astra-memory");
		expect(equals.messages).toEqual(["hello"]);
		expect(equals.unrecognizedFlags).toEqual([]);
	});

	it("selects the profile for the session the CLI creates", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-profile-");
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const argv = ["--prompt-profile=astra-memory", "--print", "hello"];
		const parsed = parseArgs(argv);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, argv, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}

		expect(observedOptions?.systemPromptProfile).toBe("astra-memory");
	});
});
