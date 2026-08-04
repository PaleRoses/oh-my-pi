import { beforeAll, describe, expect, it, vi } from "bun:test";
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
});
