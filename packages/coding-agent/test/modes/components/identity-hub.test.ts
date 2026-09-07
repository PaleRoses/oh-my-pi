import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { IdentityHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/identity-hub";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { applyPromptProfileOperation } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/prompt-profile";
import type { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => initTheme());
const temporary: TempDir[] = [];
afterEach(() => temporary.splice(0).forEach(dir => dir.removeSync()));

function createHub(
	options: {
		profiles?: Record<string, SystemPromptProfileSetting>;
		routes?: SystemPromptProfileRouteSetting[];
		edit?: (content: string) => Promise<string | null | undefined>;
		open?: (file: string) => Promise<boolean | undefined>;
		failSave?: () => boolean;
	} = {},
) {
	const dir = TempDir.createSync("@identity-hub-");
	temporary.push(dir);
	const settings = Settings.isolated();
	settings.set("systemPromptProfiles", options.profiles ?? { driver: {}, worker: {} });
	settings.set(
		"systemPromptProfileRoutes",
		options.routes ?? [
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		],
	);
	const terminal = { rows: 32, columns: 120 };
	let startedEffect = false;
	const renders: Array<() => void> = [];
	const track = <T>(promise: Promise<T>): Promise<T> => {
		startedEffect = true;
		return promise;
	};
	const hub = new IdentityHubComponent(
		{ terminal } as TUI,
		{
			profiles: settings.get("systemPromptProfiles"),
			routes: settings.get("systemPromptProfileRoutes"),
			identity: {
				role: "main",
				profileId: "driver",
				principal: "prompt-profile:driver",
				source: "system-prompt-profile",
			},
			maintainedPromptFile: path.join(dir.path(), "maintained.md"),
		},
		{
			onApply: operation =>
				track(
					(async () => {
						if (options.failSave?.()) throw new Error("configuration is read-only");
						return applyPromptProfileOperation({ cwd: dir.path(), settings }, operation);
					})(),
				),
			onEditMarkdown: content => track(options.edit?.(content) ?? Promise.resolve(null)),
			onOpenMarkdownFile: file => track(options.open?.(file) ?? Promise.resolve(true)),
			onClose: () => {},
			requestRender: () => renders.splice(0).forEach(resolve => resolve()),
		},
	);
	hub.focused = true;
	return {
		hub,
		settings,
		dir,
		terminal,
		render: () =>
			hub
				.render(terminal.columns)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		search: (label: string) => {
			for (const character of label) hub.handleInput(character);
		},
		key: async (data: string) => {
			startedEffect = false;
			hub.handleInput(data);
			if (startedEffect) await new Promise<void>(resolve => renders.push(resolve));
		},
	};
}

describe("IdentityHubComponent", () => {
	it("cycles memory through explicit values and restores inheritance", async () => {
		const h = createHub();
		h.search("Memory");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBe(true);
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBe(false);
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBeUndefined();
	});

	it("sets and restores the constitution without a separate toggle screen", async () => {
		const h = createHub();
		h.search("Constitution");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.constitution).toBe("fable");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.constitution).toBeUndefined();
	});

	it("edits appended instructions externally and restores their default", async () => {
		const h = createHub({
			profiles: { driver: { instructions: "original" }, worker: {} },
			edit: async text => text + " edited",
		});
		h.search("Appended instructions");
		await h.key("\n");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.instructions).toBe("original edited");
		await h.key("\n");
		await h.key("\x1b[B");
		await h.key("\x1b[B");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.instructions).toBeUndefined();
	});

	it("opens maintained Markdown without creating an inline replacement", async () => {
		let opened: string | undefined;
		const h = createHub({
			open: async file => {
				opened = file;
				return true;
			},
		});
		h.search("Base prompt");
		await h.key("\n");
		await h.key("\n");
		expect(opened).toBe(path.join(h.dir.path(), "maintained.md"));
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
	});

	it("validates Markdown paths and atomically replaces the inline source", async () => {
		const h = createHub({ profiles: { driver: { instructions: "original" }, worker: {} } });
		h.search("Appended instructions");
		await h.key("\n");
		await h.key("\x1b[B");
		await h.key("\n");
		h.hub.pasteText("missing.md");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({ instructions: "original" });
		expect(h.render()).toContain("missing.md");
		await Bun.write(path.join(h.dir.path(), "missing.md"), "# File instructions\n");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({ instructionsFile: "missing.md" });
	});

	it("cancels creation without saving, rejects an invalid id, then creates a valid profile", async () => {
		const h = createHub();
		h.search("Create profile");
		await h.key("\n");
		h.hub.pasteText("cancelled");
		await h.key("\x1b");
		expect(h.settings.get("systemPromptProfiles").cancelled).toBeUndefined();
		await h.key("\n");
		h.hub.pasteText("invalid profile");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles")["invalid profile"]).toBeUndefined();
		await h.key("\x1b");
		await h.key("\n");
		h.hub.pasteText("researcher");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").researcher).toEqual({});
		// The row filter that found "Create profile" must not hide the new profile.
		expect(h.render()).toMatch(/researcher\s+Configured/);
	});

	it("preserves qualified/deny order when assigning and clearing a kind-wide route", async () => {
		const policy: SystemPromptProfileRouteSetting[] = [
			{ agentKind: "main", model: "anthropic/*", profile: "driver" },
			{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		];
		const h = createHub({ routes: policy });
		await h.key("\n");
		await h.key("\x1b[B");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfileRoutes")).toEqual([
			{ agentKind: "main", profile: "worker" },
			policy[0],
			policy[1],
			policy[3],
		]);
		expect(h.render()).toContain("prompt-profile:driver");
		await h.key("\n");
		await h.key("\x1b[B");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfileRoutes")).toEqual([policy[0], policy[1], policy[3]]);
	});

	it("refuses removal while referenced and removes an unreferenced profile", async () => {
		const h = createHub({ profiles: { driver: {}, worker: {}, spare: {} } });
		h.search("profile:driver");
		await h.key("\n");
		h.search("Remove profile");
		await h.key("\n");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
		expect(h.render()).toContain("still referenced");
		const spare = createHub({ profiles: { driver: {}, worker: {}, spare: {} } });
		spare.search("profile:spare");
		await spare.key("\n");
		spare.search("Remove profile");
		await spare.key("\n");
		await spare.key("\n");
		expect(spare.settings.get("systemPromptProfiles").spare).toBeUndefined();
		expect(spare.render()).toMatch(/driver\s+Active session/);
	});

	it("reverts a failed optimistic toggle and permits retry", async () => {
		let fail = true;
		const h = createHub({ failSave: () => fail });
		h.search("Memory");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBeUndefined();
		expect(h.render()).toContain("configuration is read-only");
		fail = false;
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBe(true);
	});
});
