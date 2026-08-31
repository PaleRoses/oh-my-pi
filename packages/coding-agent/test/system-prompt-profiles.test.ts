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
	it("routes the constitutional profile before generic main routes without model-name selection", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: {
				driver: {},
				"fable-driver": { constitution: "fable" },
				worker: { prompt: "WORKER CONSTITUTION" },
			},
			routes: [
				{ agentKind: "main", model: "mock/constitutional-*", profile: "fable-driver" },
				{ agentKind: "main", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
			],
		});

		const fableMain = resolver.resolveInitial({ agentKind: "main", model: "mock/constitutional-main" });
		expect(selectedProfileId(fableMain)).toBe("fable-driver");
		if (fableMain.type !== "profile") throw new Error("Expected Fable driver profile");
		expect(fableMain.profile.constitution).toBe("fable");

		const genericMain = resolver.resolveInitial({ agentKind: "main", model: "mock/fable-in-name" });
		expect(selectedProfileId(genericMain)).toBe("driver");
		if (genericMain.type !== "profile") throw new Error("Expected generic driver profile");
		expect(genericMain.profile.constitution).toBeUndefined();

		const fableSub = resolver.resolveInitial({ agentKind: "sub", model: "mock/fable-in-name" });
		expect(selectedProfileId(fableSub)).toBe("worker");
		if (fableSub.type !== "profile") throw new Error("Expected worker profile");
		expect(fableSub.profile.constitution).toBeUndefined();
	});

	it("rejects unknown constitution values", async () => {
		await expect(
			createSystemPromptProfileResolver({
				cwd: "/tmp",
				profiles: { driver: { constitution: "unknown" } },
				routes: [{ agentKind: "main", profile: "driver" }],
			}),
		).rejects.toThrow("constitution");
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

	it("pins model transitions to the selected constitution profile", async () => {
		const resolver = await createSystemPromptProfileResolver({
			cwd: "/tmp",
			profiles: {
				driver: { prompt: "DRIVER" },
				"fable-driver": { constitution: "fable", prompt: "FABLE DRIVER" },
			},
			routes: [
				{ agentKind: "main", model: "mock/constitutional-*", profile: "fable-driver" },
				{ agentKind: "main", profile: "driver" },
			],
		});

		expect(() =>
			resolver.assertCompatible("fable-driver", { agentKind: "main", model: "mock/constitutional-main" }),
		).not.toThrow();
		expect(() =>
			resolver.assertCompatible("fable-driver", { agentKind: "main", model: "mock/default-main" }),
		).toThrow('pinned to system prompt profile "fable-driver"');
		expect(() =>
			resolver.assertCompatible("driver", { agentKind: "main", model: "mock/default-main" }),
		).not.toThrow();
	});
});
