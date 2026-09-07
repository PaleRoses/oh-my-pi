import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { IdentityHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/identity-hub";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme();
});

interface HubFixture {
	readonly profiles: Record<string, SystemPromptProfileSetting>;
	readonly routes: readonly SystemPromptProfileRouteSetting[];
	readonly editMarkdown?: (content: string) => Promise<string | null | undefined>;
	readonly openMarkdownFile?: (filePath: string) => Promise<boolean | undefined>;
}

/** Mount the hub the way bare `/identity` does and expose the host state it drives. */
function openHub(fixture: HubFixture) {
	const editor = { id: "editor" };
	const editorContainer = {
		children: [editor] as unknown[],
		clear(): void {
			this.children = [];
		},
		addChild(child: unknown): void {
			this.children.push(child);
		},
	};
	const hide = vi.fn();
	const setFocus = vi.fn();
	const setSetting = vi.fn();
	const editMarkdown = vi.fn(fixture.editMarkdown ?? (async () => null));
	const openMarkdownFile = vi.fn(fixture.openMarkdownFile ?? (async () => true));
	// Renders are the hub's own repaint requests; awaiting the next one is the
	// signal that an async round-trip (save, external editor) has settled,
	// with no wall-clock waiting.
	const renderWaiters: Array<() => void> = [];
	const requestRender = vi.fn(() => {
		for (const resolve of renderWaiters.splice(0)) resolve();
	});
	let hub: IdentityHubComponent | undefined;
	const ctx = {
		editor,
		editorContainer,
		editMarkdown,
		openMarkdownFile,
		ui: {
			showOverlay: vi.fn(component => {
				hub = component as IdentityHubComponent;
				return { hide, setHidden: vi.fn(), isHidden: () => false };
			}),
			setFocus,
			requestRender,
			terminal: { rows: 40, columns: 120 },
		},
		settings: {
			get: (key: string) => (key === "systemPromptProfiles" ? fixture.profiles : fixture.routes),
			set: setSetting,
			flush: async () => {},
		},
		sessionManager: { getCwd: () => "/workspace" },
		session: {
			effectiveIdentity: {
				role: "main",
				prompt: {
					profileId: "driver",
					principal: "prompt-profile:driver",
					source: "system-prompt-profile",
				},
			},
		},
	} as unknown as InteractiveModeContext;

	new SelectorController(ctx).showIdentityHub();
	if (hub === undefined) throw new Error("the identity hub was not mounted as a fullscreen overlay");
	return {
		hub,
		hide,
		setFocus,
		setSetting,
		editMarkdown,
		openMarkdownFile,
		editor,
		editorContainer,
		nextRender: () => new Promise<void>(resolve => renderWaiters.push(resolve)),
	};
}

/** Reach a row the way a user does: type its label into the hub search, then confirm. */
function confirmRow(hub: IdentityHubComponent, label: string): void {
	for (const character of label) hub.handleInput(character);
	hub.handleInput("\n");
}

describe("SelectorController identity hub", () => {
	it("hands focus back to whatever owns the editor slot when the hub closes", () => {
		const host = openHub({ profiles: { driver: {} }, routes: [{ agentKind: "main", profile: "driver" }] });
		// A hook approval prompt replaced the editor while the hub covered the
		// screen (issue #3349). Closing must focus the prompt that is actually
		// visible; a close path pinned to `ctx.editor` routes keystrokes to an
		// unmounted component instead.
		const approvalPrompt = { id: "approval-prompt" };
		host.editorContainer.clear();
		host.editorContainer.addChild(approvalPrompt);

		host.hub.handleInput("\x1b");

		expect(host.hide).toHaveBeenCalledTimes(1);
		expect(host.setFocus).toHaveBeenLastCalledWith(approvalPrompt);
		expect(host.setFocus).not.toHaveBeenCalledWith(host.editor);
	});

	it("resolves a profile's Markdown file against the session cwd before the editor owner sees it", async () => {
		const opened = Promise.withResolvers<void>();
		const host = openHub({
			profiles: { driver: { instructionsFile: "prompts/driver.md" } },
			routes: [{ agentKind: "main", profile: "driver" }],
			openMarkdownFile: async () => {
				opened.resolve();
				return true;
			},
		});

		confirmRow(host.hub, "Appended instructions");
		host.hub.handleInput("\n");
		await opened.promise;

		expect(host.openMarkdownFile).toHaveBeenCalledWith(path.resolve("/workspace", "prompts/driver.md"));
	});

	it("leaves the stored configuration untouched when the Markdown editor is canceled", async () => {
		const editorSession = Promise.withResolvers<string | null>();
		const opened = Promise.withResolvers<void>();
		const host = openHub({
			profiles: { driver: { instructions: "Stay terse." } },
			routes: [{ agentKind: "main", profile: "driver" }],
			editMarkdown: () => {
				opened.resolve();
				return editorSession.promise;
			},
		});

		confirmRow(host.hub, "Appended instructions");
		host.hub.handleInput("\n");
		await opened.promise;
		const settled = host.nextRender();
		// Editor exited without saving.
		editorSession.resolve(null);
		await settled;

		expect(host.editMarkdown).toHaveBeenCalledWith("Stay terse.");
		expect(host.setSetting).not.toHaveBeenCalled();
		expect(host.hide).not.toHaveBeenCalled();
	});
});
