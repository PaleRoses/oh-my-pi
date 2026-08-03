import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfileResolver } from "@oh-my-pi/pi-coding-agent/agent-profiles";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("agent profile routing", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-profiles-"));
		fs.writeFileSync(path.join(tempDir, "driver.md"), "DRIVER CONSTITUTION");
		fs.writeFileSync(path.join(tempDir, "worker.md"), "WORKER CONSTITUTION");
	});

	afterEach(() => removeSyncWithRetries(tempDir));

	const profiles = () => ({
		driver: {
			promptFile: "driver.md",
			hindsight: { bankId: "omp-fable" },
			models: ["anthropic/claude-fable-*"],
		},
		worker: {
			promptFile: "worker.md",
			hindsight: {
				bankId: "omp-worker",
				retainTags: ["mind:worker"],
				recallTags: ["mind:worker"],
				recallTagsMatch: "all_strict",
			},
			tools: ["read", "grep"],
		},
		reviewer: {
			prompt: "REVIEWER CONSTITUTION",
			hindsight: { bankId: "omp-reviewer" },
		},
		defaulted: {
			useDefaultPrompt: true,
			hindsight: { bankId: "omp-defaulted" },
		},
	});

	it("selects one of multiple profiles by ordered model and agent-kind routes", async () => {
		const resolver = await createAgentProfileResolver({
			cwd: tempDir,
			profiles: profiles(),
			routes: [
				{ agentKind: "main", model: "anthropic/claude-fable-*", profile: "driver" },
				{ agentKind: "sub", profile: "worker" },
				{ profile: "reviewer" },
			],
		});

		expect(resolver.resolveInitial({ agentKind: "main", model: "anthropic/claude-fable-5" })).toEqual({
			type: "profile",
			profile: {
				id: "driver",
				projectContextOnly: false,
				prompt: "DRIVER CONSTITUTION",
				hindsight: { bankId: "omp-fable" },
				models: ["anthropic/claude-fable-*"],
				tools: undefined,
			},
		});
		expect(resolver.resolveInitial({ agentKind: "sub", model: "anthropic/claude-fable-5" })).toMatchObject({
			type: "profile",
			profile: {
				id: "worker",
				prompt: "WORKER CONSTITUTION",
				hindsight: {
					bankId: "omp-worker",
					retainTags: ["mind:worker"],
					recallTags: ["mind:worker"],
					recallTagsMatch: "all_strict",
				},
				tools: ["read", "grep"],
			},
		});
		expect(resolver.resolveInitial({ agentKind: "main", model: "openai/gpt-5.6-sol" })).toMatchObject({
			type: "profile",
			profile: { id: "reviewer", prompt: "REVIEWER CONSTITUTION" },
		});
	});

	it("resolves profiles explicitly and enforces their model policy", async () => {
		const resolver = await createAgentProfileResolver({ cwd: tempDir, profiles: profiles(), routes: [] });
		const driver = resolver.resolveProfile("driver");
		const reviewer = resolver.resolveProfile("reviewer");
		expect(resolver.listProfiles().map(profile => profile.id)).toEqual(["driver", "worker", "reviewer", "defaulted"]);

		expect(driver.id).toBe("driver");
		expect(reviewer.id).toBe("reviewer");
		expect(() => resolver.assertModelAllowed(driver, "anthropic/claude-fable-5")).not.toThrow();
		expect(() => resolver.assertModelAllowed(driver, "anthropic/claude-opus-5")).toThrow(
			'Agent profile "driver" does not allow model anthropic/claude-opus-5',
		);
		expect(resolver.resolveProfile("defaulted").prompt).toBeUndefined();
	});

	it("falls back to the bundled prompt when no route matches", async () => {
		const resolver = await createAgentProfileResolver({
			cwd: tempDir,
			profiles: profiles(),
			routes: [{ model: "anthropic/claude-fable-*", profile: "driver" }],
		});

		expect(resolver.resolveInitial({ agentKind: "main", model: "openai/gpt-5.6-sol" })).toEqual({
			type: "default",
		});
	});

	it("returns an explicit initial-route denial", async () => {
		const resolver = await createAgentProfileResolver({
			cwd: tempDir,
			profiles: profiles(),
			routes: [{ agentKind: "main", model: "anthropic/*", deny: true, reason: "Driver model required" }],
		});

		expect(resolver.resolveInitial({ agentKind: "main", model: "anthropic/claude-opus-5" })).toEqual({
			type: "denied",
			reason: "Driver model required",
		});
	});

	it("rejects unknown profiles and malformed definitions at the boundary", async () => {
		const resolver = await createAgentProfileResolver({ cwd: tempDir, profiles: profiles(), routes: [] });
		expect(() => resolver.resolveProfile("missing")).toThrow('Unknown agent profile "missing"');
		await expect(
			createAgentProfileResolver({
				cwd: tempDir,
				profiles: {
					broken: {
						prompt: "one",
						promptFile: "driver.md",
						hindsight: { bankId: "broken" },
					},
				},
				routes: [],
			}),
		).rejects.toThrow('must contain exactly one of "prompt", "promptFile", or "useDefaultPrompt"');
		await expect(
			createAgentProfileResolver({
				cwd: tempDir,
				profiles: profiles(),
				routes: [{ profile: "driver", deny: true }],
			}),
		).rejects.toThrow("Invalid agentProfileRoutes");
	});
});
