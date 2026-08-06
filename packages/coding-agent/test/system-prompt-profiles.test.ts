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
	it("routes the same Fable model by agent kind", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: {
				driver: {},
				worker: { prompt: "WORKER CONSTITUTION" },
			},
			routes: [
				{ agentKind: "main", model: "anthropic/claude-fable-*", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		expect(selectedProfileId(resolver.resolveInitial({ agentKind: "main", model: "anthropic/claude-fable-5" }))).toBe(
			"driver",
		);
		expect(selectedProfileId(resolver.resolveInitial({ agentKind: "sub", model: "anthropic/claude-fable-5" }))).toBe(
			"worker",
		);
		expect(selectedProfileId(resolver.resolveInitial({ agentKind: "sub", model: "openai-codex/gpt-5.6-sol" }))).toBe(
			"worker",
		);
		expect(resolver.resolveInitial({ agentKind: "main", model: "openai-codex/gpt-5.6-sol" })).toEqual({
			type: "default",
		});
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
			const decision = resolver.resolveInitial({ agentKind: "sub", model: "anthropic/claude-fable-5" });

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

	it("resolves contextImages to absolute paths and rejects missing files", async () => {
		const dir = TempDir.createSync("@system-prompt-profile-images-");
		try {
			await Bun.write(dir.join("portrait.webp"), "not-a-real-image-but-exists");
			const resolver = await createSystemPromptProfileResolver({
				cwd: dir.path(),
				profiles: { driver: { contextImages: ["portrait.webp"] } },
				routes: [{ agentKind: "main", profile: "driver" }],
			});
			const decision = resolver.resolveInitial({ agentKind: "main", model: "anthropic/claude-fable-5" });
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
			profiles: { rlm: { tools: ["Kernel", "write", "kernel", "read"] } },
			routes: [{ agentKind: "main", profile: "rlm" }],
		});
		const decision = resolver.resolveInitial({ agentKind: "main", model: "anthropic/claude-fable-5" });
		expect(decision.type).toBe("profile");
		if (decision.type !== "profile") throw new Error("Expected rlm profile");
		expect(decision.profile.tools).toEqual(["kernel", "write", "read"]);

		await expect(
			createSystemPromptProfileResolver({
				cwd: process.cwd(),
				profiles: { rlm: { tools: ["kernel", "  "] } },
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
				{ agentKind: "main", model: "anthropic/claude-fable-*", deny: true, reason: "driver unavailable" },
				{ agentKind: "sub", profile: "worker" },
			],
		});
		expect(resolver.resolveInitial({ agentKind: "main", model: "anthropic/claude-fable-5" })).toEqual({
			type: "denied",
			reason: "driver unavailable",
		});
		expect(() =>
			resolver.assertCompatible(undefined, { agentKind: "main", model: "anthropic/claude-fable-5" }),
		).toThrow("driver unavailable");
	});

	it("accepts only model transitions that retain the pinned profile", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: {
				driver: { prompt: "DRIVER" },
				worker: { prompt: "WORKER" },
			},
			routes: [
				{ agentKind: "main", model: "anthropic/claude-fable-*", profile: "driver" },
				{ agentKind: "main", model: "openai-codex/*", profile: "worker" },
			],
		});

		expect(() =>
			resolver.assertCompatible("driver", { agentKind: "main", model: "anthropic/claude-fable-5" }),
		).not.toThrow();
		expect(() =>
			resolver.assertCompatible("driver", { agentKind: "main", model: "openai-codex/gpt-5.6-sol" }),
		).toThrow('pinned to system prompt profile "driver"');
		expect(() =>
			resolver.assertCompatible(undefined, { agentKind: "main", model: "google/gemini-3.5" }),
		).not.toThrow();
	});
});
