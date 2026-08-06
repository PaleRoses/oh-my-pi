import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
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
import { TempDir } from "@oh-my-pi/pi-utils";

interface PromptSettingsStore {
	systemPromptProfiles: Record<string, SystemPromptProfileSetting>;
	systemPromptProfileRoutes: SystemPromptProfileRouteSetting[];
}

interface PromptEditorResults {
	readonly editedMarkdown?: string | null;
	readonly openedMarkdownFile?: boolean;
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

function createHarness(overrides: Partial<PromptSettingsStore> = {}, editorResults: PromptEditorResults = {}) {
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
	const flushed = Promise.withResolvers<void>();
	const flush = vi.fn(async () => {
		flushed.resolve();
	});
	const runtime = {
		cwd: process.cwd(),
		settings: {
			get: (path: keyof PromptSettingsStore) => store[path],
			set,
			flush,
		},
	} as unknown as PromptProfileConfigurationRuntime;
	const onApply = vi.fn((operation: PromptProfileOperation) => applyPromptProfileOperation(runtime, operation));
	const onEditMarkdown = vi.fn(async () => editorResults.editedMarkdown);
	const onOpenMarkdownFile = vi.fn(async () => editorResults.openedMarkdownFile);
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
			maintainedPromptFile: "/omp/src/prompts/system/system-prompt.md",
		},
		{ onApply, onClose, onEditMarkdown, onOpenMarkdownFile, requestRender },
	);
	return {
		component,
		flush,
		flushed: flushed.promise,
		onApply,
		onClose,
		onEditMarkdown,
		onOpenMarkdownFile,
		requestRender,
		set,
		store,
	};
}

describe("PromptProfileSelectorComponent", () => {
	it("inspects the active identity and edits every supported profile field through keyboard navigation", async () => {
		const harness = createHarness();

		expect(render(harness.component)).toContain("Active: main · driver · maintained-omp-prompt");
		harness.component.handleInput("\n");
		const profileScreen = render(harness.component);
		expect(profileScreen).toContain("Base prompt");
		expect(profileScreen).toContain("Appended instructions");
		expect(profileScreen).not.toContain("Base prompt file");
		expect(profileScreen).not.toContain("Appended instructions file");
		expect(profileScreen).toContain("Project context only");
		expect(profileScreen).toContain("Memory");
		expect(profileScreen).toContain("MCP server instructions");

		pressDown(harness.component, 3);
		harness.component.handleInput("\n");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfiles.driver).toEqual({ memory: false });
		expect(harness.flush).toHaveBeenCalledTimes(1);
		expect(render(harness.component)).toContain("Restart OMP to load the new prompt identity");
	});

	it("edits explicitly inline Markdown externally and restores it through the persistence owner", async () => {
		const harness = createHarness(
			{
				systemPromptProfiles: { driver: { prompt: "OLD INLINE DRIVER" }, worker: {} },
			},
			{ editedMarkdown: "INLINE DRIVER" },
		);

		harness.component.handleInput("\n");
		harness.component.handleInput("\n");
		expect(render(harness.component)).toContain("Open inline Markdown editor");
		expect(render(harness.component)).not.toContain("Create inline Markdown");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.onEditMarkdown).toHaveBeenCalledWith("OLD INLINE DRIVER");
		expect(harness.store.systemPromptProfiles.driver).toEqual({ prompt: "INLINE DRIVER" });

		harness.component.handleInput("\n");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\x1b[B");
		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.store.systemPromptProfiles.driver).toEqual({});
		expect(harness.flush).toHaveBeenCalledTimes(2);
	});

	it("opens the maintained base prompt file instead of offering inline Markdown creation", async () => {
		const harness = createHarness({}, { openedMarkdownFile: true });

		harness.component.handleInput("\n");
		harness.component.handleInput("\n");
		const fieldScreen = render(harness.component);
		expect(fieldScreen).toContain("Open maintained Markdown");
		expect(fieldScreen).toContain("Use Markdown file");
		expect(fieldScreen).not.toContain("Create inline Markdown");
		expect(fieldScreen).not.toContain("Restore default");

		harness.component.handleInput("\n");
		await settleOperation();

		expect(harness.onOpenMarkdownFile).toHaveBeenCalledWith("/omp/src/prompts/system/system-prompt.md");
		expect(harness.onApply).not.toHaveBeenCalled();
		expect(harness.flush).not.toHaveBeenCalled();
	});

	it("opens a configured Markdown file and keeps path editing secondary", async () => {
		const root = TempDir.createSync("@omp-prompt-profile-");
		const instructionsFile = path.join(root.path(), "instructions.md");
		try {
			await Bun.write(instructionsFile, "# Worker\n");
			const harness = createHarness(
				{
					systemPromptProfiles: { driver: { instructionsFile }, worker: {} },
				},
				{ openedMarkdownFile: true },
			);

			harness.component.handleInput("\n");
			pressDown(harness.component, 1);
			harness.component.handleInput("\n");
			expect(render(harness.component)).toContain("Open Markdown");
			harness.component.handleInput("\n");
			await settleOperation();

			expect(harness.onOpenMarkdownFile).toHaveBeenCalledWith(instructionsFile);
			expect(harness.store.systemPromptProfiles.driver).toEqual({ instructionsFile });
			expect(harness.flush).not.toHaveBeenCalled();

			harness.component.handleInput("\x1b[B");
			harness.component.handleInput("\n");

			expect(render(harness.component)).toContain("Enter the Markdown file path");
			expect(harness.onOpenMarkdownFile).toHaveBeenCalledTimes(1);
		} finally {
			await root.remove();
		}
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
		pressDown(harness.component, 6);
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
