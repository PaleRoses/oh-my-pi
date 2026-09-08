import { describe, expect, it } from "bun:test";
import {
	createSystemPromptProfileResolver,
	type SystemPromptProfileDecision,
} from "@oh-my-pi/pi-coding-agent/system-prompt-profiles";
import { TempDir } from "@oh-my-pi/pi-utils";

function selectedProfileId(decision: SystemPromptProfileDecision): string | undefined {
	return decision.type === "profile" ? decision.profile.id : undefined;
}

describe("system prompt profiles", () => {
	it("routes the role-instruction profile before generic main routes without model-name selection", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: {
				driver: {},
				principal: { rolePrompt: "Keep the work grounded in evidence." },
				worker: { prompt: "WORKER CONSTITUTION" },
			},
			routes: [
				{ agentKind: "main", model: "mock/constitutional-*", profile: "principal" },
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		const main = resolver.resolveInitial({ agentKind: "main", model: "mock/constitutional-main" });
		expect(selectedProfileId(main)).toBe("principal");
		if (main.type !== "profile") throw new Error("Expected principal profile");
		expect(main.profile.rolePrompt).toBe("Keep the work grounded in evidence.");

		const genericMain = resolver.resolveInitial({ agentKind: "main", model: "mock/fable-in-name" });
		expect(selectedProfileId(genericMain)).toBe("driver");
		if (genericMain.type !== "profile") throw new Error("Expected generic driver profile");
		expect(genericMain.profile.rolePrompt).toBeUndefined();

		const sub = resolver.resolveInitial({ agentKind: "sub", model: "mock/constitutional-main" });
		expect(selectedProfileId(sub)).toBe("worker");
		if (sub.type !== "profile") throw new Error("Expected worker profile");
		expect(sub.profile.rolePrompt).toBeUndefined();
	});

	it("loads trailing profile instructions from a file while leaving the maintained prompt selected", async () => {
		const dir = TempDir.createSync("@system-prompt-profile-file-");
		try {
			await Bun.write(dir.join("worker.md"), "FILE WORKER CONSTITUTION");
			const resolver = await createSystemPromptProfileResolver({
				cwd: dir.path(),
				profiles: {
					worker: {
						instructionsFile: "worker.md",
						projectContextOnly: true,
						memory: false,
						mcpServerInstructions: false,
					},
				},
				routes: [{ agentKind: "sub", profile: "worker" }],
			});
			const decision = resolver.resolveInitial({ agentKind: "sub", model: "mock/worker-model" });

			expect(decision.type).toBe("profile");
			if (decision.type !== "profile") throw new Error("Expected worker profile");
			expect(decision.profile.prompt).toBeUndefined();
			expect(decision.profile.instructions).toBe("FILE WORKER CONSTITUTION");
			expect(decision.profile.projectContextOnly).toBe(true);
			expect(decision.profile.memoryEnabled).toBe(false);
			expect(decision.profile.mcpServerInstructionsEnabled).toBe(false);
		} finally {
			dir.removeSync();
		}
	});

	it("loads role instructions once, trimming only outer whitespace without selecting a prompt override", async () => {
		const dir = TempDir.createSync("@system-prompt-profile-role-prompt-");
		try {
			const rolePrompt = "# Charter\n\nKeep {{userTitle}} literal.\n  Indented continuation.";
			await Bun.write(dir.join("charter.md"), `\n${rolePrompt}\n`);
			const resolver = await createSystemPromptProfileResolver({
				cwd: dir.path(),
				profiles: {
					relative: { rolePromptFile: "charter.md" },
					absolute: { rolePromptFile: dir.join("charter.md") },
					inline: { rolePrompt: `\n${rolePrompt}\n` },
				},
				routes: [{ agentKind: "main", profile: "relative" }],
			});
			await Bun.write(dir.join("charter.md"), "Changed after compilation");

			expect(resolver.resolveProfile("relative").rolePrompt).toBe(rolePrompt);
			expect(resolver.resolveProfile("absolute").rolePrompt).toBe(rolePrompt);
			expect(resolver.resolveProfile("inline").rolePrompt).toBe(rolePrompt);
			expect(resolver.resolveProfile("relative").prompt).toBeUndefined();
		} finally {
			dir.removeSync();
		}
	});

	it("rejects missing or empty role-instruction files with the resolved path", async () => {
		const dir = TempDir.createSync("@system-prompt-profile-role-prompt-errors-");
		try {
			await expect(
				createSystemPromptProfileResolver({
					cwd: dir.path(),
					profiles: { driver: { rolePromptFile: "charter.md" } },
					routes: [],
				}),
			).rejects.toThrow(`Could not read system prompt profile "driver" from ${dir.join("charter.md")}`);
			await Bun.write(dir.join("charter.md"), " \n\t");
			await expect(
				createSystemPromptProfileResolver({
					cwd: dir.path(),
					profiles: { driver: { rolePromptFile: "charter.md" } },
					routes: [],
				}),
			).rejects.toThrow(`System prompt profile "driver" prompt file is empty: ${dir.join("charter.md")}`);
		} finally {
			dir.removeSync();
		}
	});

	it.each([{ rolePrompt: " \n" }, { rolePromptFile: " " }, { rolePromt: "Typo" }])(
		"rejects empty role-instruction sources and unknown fields: %j",
		async profile => {
			await expect(
				createSystemPromptProfileResolver({ cwd: "/tmp", profiles: { driver: profile }, routes: [] }),
			).rejects.toThrow();
		},
	);

	it("rejects legacy role-instruction keys instead of accepting or ignoring them", async () => {
		const dir = TempDir.createSync("@system-prompt-profile-legacy-role-keys-");
		try {
			await Bun.write(dir.join("role.md"), "Legacy role instructions.");
			for (const profile of [{ constitution: "Legacy role instructions." }, { constitutionFile: "role.md" }]) {
				await expect(
					createSystemPromptProfileResolver({ cwd: dir.path(), profiles: { driver: profile }, routes: [] }),
				).rejects.toThrow();
			}
		} finally {
			dir.removeSync();
		}
	});

	it("keeps a text field's inline and file spellings exclusive and names the offending key", async () => {
		await expect(
			createSystemPromptProfileResolver({
				cwd: "/tmp",
				profiles: { driver: { prompt: "INLINE", promptFile: "driver.md" } },
				routes: [],
			}),
		).rejects.toThrow('systemPromptProfiles.driver may contain only one of "prompt" or "promptFile"');

		await expect(
			createSystemPromptProfileResolver({
				cwd: "/tmp",
				profiles: { worker: { instructions: "INLINE", instructionsFile: "worker.md" } },
				routes: [],
			}),
		).rejects.toThrow('systemPromptProfiles.worker may contain only one of "instructions" or "instructionsFile"');

		await expect(
			createSystemPromptProfileResolver({
				cwd: "/tmp",
				profiles: { driver: { rolePrompt: "INLINE", rolePromptFile: "driver.md" } },
				routes: [],
			}),
		).rejects.toThrow('systemPromptProfiles.driver may contain only one of "rolePrompt" or "rolePromptFile"');

		await expect(
			createSystemPromptProfileResolver({
				cwd: "/tmp",
				profiles: { worker: { instructionsFile: "   " } },
				routes: [],
			}),
		).rejects.toThrow("systemPromptProfiles.worker.instructionsFile must be a non-empty string");
	});

	it("resolves contextImages to absolute paths and rejects missing files", async () => {
		const dir = TempDir.createSync("@system-prompt-profile-images-");
		try {
			await Bun.write(dir.join("portrait.webp"), "not-a-real-image-but-exists");
			const resolver = await createSystemPromptProfileResolver({
				cwd: dir.path(),
				profiles: { driver: { contextImages: ["portrait.webp"] } },
				routes: [{ agentKind: "main", profile: "driver" }],
			});
			const decision = resolver.resolveInitial({ agentKind: "main", model: "mock/driver-model" });
			expect(decision.type).toBe("profile");
			if (decision.type !== "profile") throw new Error("Expected driver profile");
			expect(decision.profile.contextImages).toEqual([dir.join("portrait.webp")]);

			await expect(
				createSystemPromptProfileResolver({
					cwd: dir.path(),
					profiles: { driver: { contextImages: ["absent.webp"] } },
					routes: [{ agentKind: "main", profile: "driver" }],
				}),
			).rejects.toThrow("systemPromptProfiles.driver.contextImages[0] does not exist");
		} finally {
			dir.removeSync();
		}
	});

	it("compiles tools lowercased and deduplicated, rejecting blank entries", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: process.cwd(),
			profiles: { rlm: { tools: ["Eval", "write", "eval", "read"] } },
			routes: [{ agentKind: "main", profile: "rlm" }],
		});
		const decision = resolver.resolveInitial({ agentKind: "main", model: "mock/rlm-model" });
		expect(decision.type).toBe("profile");
		if (decision.type !== "profile") throw new Error("Expected rlm profile");
		expect(decision.profile.tools).toEqual(["eval", "write", "read"]);

		await expect(
			createSystemPromptProfileResolver({
				cwd: process.cwd(),
				profiles: { rlm: { tools: ["eval", "  "] } },
				routes: [{ agentKind: "main", profile: "rlm" }],
			}),
		).rejects.toThrow("systemPromptProfiles.rlm.tools[1]");
	});

	it("fails construction for unknown profiles and denied routes", async () => {
		await expect(
			createSystemPromptProfileResolver({
				cwd: "/tmp",
				profiles: {},
				routes: [{ agentKind: "main", profile: "missing" }],
			}),
		).rejects.toThrow('unknown system prompt profile "missing"');

		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: { worker: { prompt: "WORKER" } },
			routes: [
				{ agentKind: "main", model: "mock/denied-model", deny: true, reason: "driver unavailable" },
				{ agentKind: "sub", profile: "worker" },
			],
		});
		expect(resolver.resolveInitial({ agentKind: "main", model: "mock/denied-model" })).toEqual({
			type: "denied",
			reason: "driver unavailable",
		});
		expect(() => resolver.assertCompatible(undefined, { agentKind: "main", model: "mock/denied-model" })).toThrow(
			"driver unavailable",
		);
	});

	it("pins model transitions to the selected role-instruction profile", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: {
				driver: { prompt: "DRIVER" },
				principal: { rolePrompt: "Keep the work grounded in evidence." },
			},
			routes: [
				{ agentKind: "main", model: "mock/constitutional-*", profile: "principal" },
				{ agentKind: "main", profile: "driver" },
			],
		});

		expect(() =>
			resolver.assertCompatible("principal", { agentKind: "main", model: "mock/constitutional-main" }),
		).not.toThrow();
		expect(() => resolver.assertCompatible("principal", { agentKind: "main", model: "mock/default-main" })).toThrow(
			'pinned to system prompt profile "principal"',
		);
		expect(() =>
			resolver.assertCompatible("driver", { agentKind: "main", model: "mock/default-main" }),
		).not.toThrow();
	});
});
