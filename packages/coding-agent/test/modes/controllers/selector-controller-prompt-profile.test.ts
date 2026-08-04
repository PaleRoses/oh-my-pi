import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { PromptProfileSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/prompt-profile-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController prompt profiles", () => {
	it("mounts the compact selector and restores the editor when it closes", () => {
		const editor = { id: "editor" };
		const children: unknown[] = [editor];
		const setFocus = vi.fn();
		const ctx = {
			editor,
			editorContainer: {
				children,
				clear: () => children.splice(0),
				addChild: (child: unknown) => children.push(child),
			},
			ui: { setFocus, requestRender: vi.fn() },
			settings: {
				get: (path: string) => (path === "systemPromptProfiles" ? { driver: {} } : []),
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
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showPromptProfileSelector();

		expect(children[0]).toBeInstanceOf(PromptProfileSelectorComponent);
		expect(setFocus).toHaveBeenLastCalledWith(children[0]);

		(children[0] as PromptProfileSelectorComponent).handleInput("\x1b");

		expect(children).toEqual([editor]);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
	});

	it("resolves and opens configured Markdown through the interactive editor owner", async () => {
		const editor = { id: "editor" };
		const children: unknown[] = [editor];
		const opened = Promise.withResolvers<void>();
		const openMarkdownFile = vi.fn(async () => {
			opened.resolve();
			return false;
		});
		const ctx = {
			editMarkdown: vi.fn(),
			openMarkdownFile,
			editor,
			editorContainer: {
				children,
				clear: () => children.splice(0),
				addChild: (child: unknown) => children.push(child),
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			settings: {
				get: (settingPath: string) =>
					settingPath === "systemPromptProfiles" ? { driver: { instructionsFile: "prompts/driver.md" } } : [],
			},
			sessionManager: { getCwd: () => "/workspace" },
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
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.showPromptProfileSelector();
		const selector = children[0] as PromptProfileSelectorComponent;
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\n");
		await opened.promise;

		expect(openMarkdownFile).toHaveBeenCalledWith(path.resolve("/workspace", "prompts/driver.md"));
	});
});
