import { beforeAll, describe, expect, it, vi } from "bun:test";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { PromptProfileSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/prompt-profile-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	applyPromptProfileOperation,
	type PromptProfileConfigurationRuntime,
	type PromptProfileOperation,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/prompt-profile";

interface PromptSettingsStore {
	systemPromptProfiles: Record<string, SystemPromptProfileSetting>;
	systemPromptProfileRoutes: SystemPromptProfileRouteSetting[];
}

beforeAll(async () => {
	await initTheme();
});

function pressDown(component: PromptProfileSelectorComponent, count: number): void {
	if (count <= 0) return;
	component.handleInput("\x1b[B");
	pressDown(component, count - 1);
}

function render(component: PromptProfileSelectorComponent): string {
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

async function settleOperation(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

function createHarness(overrides: Partial<PromptSettingsStore> = {}) {
	const store: PromptSettingsStore = {
		systemPromptProfiles: { driver: {}, worker: {} },
		systemPromptProfileRoutes: [
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		],
		...overrides,
	};
	const set = vi.fn(<P extends keyof PromptSettingsStore>(path: P, value: PromptSettingsStore[P]) => {
		store[path] = value;
	});
	const flush = vi.fn(async () => {});
	const runtime = {
		cwd: process.cwd(),
		settings: {
			get: (path: keyof PromptSettingsStore) => store[path],
			set,
			flush,
		},
	} as unknown as PromptProfileConfigurationRuntime;
	const onApply = vi.fn((operation: PromptProfileOperation) => applyPromptProfileOperation(runtime, operation));
	const onClose = vi.fn();
	const requestRender = vi.fn();
	const component = new PromptProfileSelectorComponent(
		{
			profiles: store.systemPromptProfiles,
			routes: store.systemPromptProfileRoutes,
			identity: {
				role: "main",
				profileId: "driver",
				principal: "maintained-omp-prompt",
				source: "maintained-omp-prompt",
			},
		},
		{ onApply, onClose, requestRender },
	);
	return { component, flush, onApply, onClose, requestRender, set, store };
}

describe("PromptProfileSelectorComponent", () => {
	it("inspects the active identity and edits every supported profile field through keyboard navigation", async () => {
		const harness = createHarness();

		expect(render(harness.component)).toContain("Active: main · driver · maintained-omp-prompt");
		harness.component.handleInput("\n");
		const profileScreen = render(harness.component);
		expect(profileScreen).toContain("Base prompt");
		expect(profileScreen).toContain("Base prompt file");
		expect(profileScreen).toContain("Appended instructions");
		expect(profileScreen).toContain("Appended instructions file");
		expect(profileScreen).toContain("Project context only");
		expect(profileScreen).toContain("Memory");
		expect(profileScreen).toContain("MCP server instructions");

		pressDown(harness.component, 5);
		harness.component.handleInput("\n");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfiles.driver).toEqual({ memory: false });
		expect(harness.flush).toHaveBeenCalledTimes(1);
		expect(render(harness.component)).toContain("Restart OMP to load the new prompt identity");
	});

	it("edits and restores text fields through the same mutual-exclusion persistence owner", async () => {
		const harness = createHarness({
			systemPromptProfiles: { driver: { promptFile: "/stale/driver.md" }, worker: {} },
		});

		harness.component.handleInput("\n");
		harness.component.handleInput("\n");
		harness.component.handleInput("\n");
		harness.component.pasteText("INLINE DRIVER");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfiles.driver).toEqual({ prompt: "INLINE DRIVER" });

		harness.component.handleInput("\n");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfiles.driver).toEqual({});
		expect(harness.flush).toHaveBeenCalledTimes(2);
	});

	it("cancels profile creation without persistence, then creates and selects a validated profile", async () => {
		const harness = createHarness({
			systemPromptProfiles: { driver: {} },
			systemPromptProfileRoutes: [{ agentKind: "main", profile: "driver" }],
		});

		pressDown(harness.component, 1);
		harness.component.handleInput("\n");
		harness.component.pasteText("cancelled");
		harness.component.handleInput("\x1b");

		expect(harness.onApply).not.toHaveBeenCalled();
		expect(harness.set).not.toHaveBeenCalled();
		expect(render(harness.component)).toContain("System prompt profiles");

		pressDown(harness.component, 1);
		harness.component.handleInput("\n");
		harness.component.pasteText("researcher");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfiles.researcher).toEqual({});
		expect(render(harness.component)).toContain("Profile: researcher");
		expect(render(harness.component)).toContain("Base prompt");
	});

	it("assigns and clears unconditional routes while preserving specific and deny policy order", async () => {
		const retainedRoutes: SystemPromptProfileRouteSetting[] = [
			{ agentKind: "main", model: "anthropic/*", profile: "driver" },
			{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		];
		const harness = createHarness({ systemPromptProfileRoutes: retainedRoutes });

		pressDown(harness.component, 3);
		harness.component.handleInput("\n");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfileRoutes).toEqual([
			{ agentKind: "main", profile: "worker" },
			{ agentKind: "main", model: "anthropic/*", profile: "driver" },
			{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
			{ agentKind: "sub", profile: "worker" },
		]);

		pressDown(harness.component, 3);
		harness.component.handleInput("\n");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfileRoutes).toEqual([
			{ agentKind: "main", model: "anthropic/*", profile: "driver" },
			{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
			{ agentKind: "sub", profile: "worker" },
		]);
	});

	it("surfaces referenced-profile and profile-id validation errors without persistence", async () => {
		const harness = createHarness();

		harness.component.handleInput("\n");
		pressDown(harness.component, 7);
		harness.component.handleInput("\n");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(render(harness.component)).toContain('System prompt profile "driver" is still referenced by a route.');
		expect(harness.set).not.toHaveBeenCalled();

		harness.component.handleInput("\x1b");
		harness.component.handleInput("\x1b");
		pressDown(harness.component, 2);
		harness.component.handleInput("\n");
		harness.component.pasteText("invalid profile");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(render(harness.component)).toContain("must match");
		expect(harness.set).not.toHaveBeenCalled();
	});

	it("closes from the home screen without applying configuration", () => {
		const harness = createHarness();

		harness.component.handleInput("\x1b");

		expect(harness.onClose).toHaveBeenCalledTimes(1);
		expect(harness.onApply).not.toHaveBeenCalled();
		expect(harness.set).not.toHaveBeenCalled();
	});
});
