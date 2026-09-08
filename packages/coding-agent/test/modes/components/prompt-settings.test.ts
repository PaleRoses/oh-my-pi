import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { PromptSettingsComponent } from "@oh-my-pi/pi-coding-agent/modes/components/prompt-settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { applyPromptProfileOperation } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/prompt-profile";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => initTheme());
const temporary: TempDir[] = [];
afterEach(() => temporary.splice(0).forEach(dir => dir.removeSync()));

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESCAPE = "\x1b";

function createHub(
	options: {
		profiles?: Record<string, SystemPromptProfileSetting>;
		routes?: SystemPromptProfileRouteSetting[];
		edit?: (content: string) => Promise<string | null | undefined>;
		open?: (file: string) => Promise<boolean | undefined>;
		failSave?: () => boolean;
		columns?: number;
		rows?: number;
	} = {},
) {
	const dir = TempDir.createSync("@prompt-settings-");
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
	const terminal = { rows: options.rows ?? 32, columns: options.columns ?? 120 };
	let startedEffect = false;
	let closes = 0;
	const renders: Array<() => void> = [];
	const track = <T>(promise: Promise<T>): Promise<T> => {
		startedEffect = true;
		return promise;
	};
	const hub = new PromptSettingsComponent(
		{ terminal } as TUI,
		{
			profiles: settings.get("systemPromptProfiles"),
			routes: settings.get("systemPromptProfileRoutes"),
			sessionProfileId: "driver",
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
			onClose: () => {
				closes += 1;
			},
			requestRender: () => renders.splice(0).forEach(resolve => resolve()),
		},
	);
	hub.focused = true;
	const frame = () => hub.render(terminal.columns).map(line => Bun.stripANSI(line));
	// Only split-pane cells: receipts and footer text cannot masquerade as rows.
	const pane = () => {
		const lines = frame();
		const border = theme.boxRound.vertical;
		const header = lines.find(line => line.startsWith(border));
		const divider = header?.indexOf(border, border.length) ?? -1;
		return lines.flatMap(line => {
			if (divider < 0 || !line.startsWith(border) || !line.startsWith(border, divider)) return [];
			// Input cursor markers can make stripANSI consume the trailing frame border.
			const end = line.lastIndexOf(border);
			return [line.slice(divider + border.length, end > divider ? end : undefined).trim()];
		});
	};
	const selected = () => pane().find(line => line.startsWith(`${theme.nav.cursor} `)) ?? "";
	const rowLabel = (line: string) =>
		line
			.replace(`${theme.nav.cursor} `, "")
			.split(/\s{2,}/)[0]
			.replace(` ${theme.status.warning}`, "");
	const select = (label: string) => {
		hub.handleInput(RIGHT);
		const visited = new Set<string>();
		while (rowLabel(selected()) !== label) {
			const current = selected();
			if (visited.has(current)) throw new Error(`No selectable row named ${label}`);
			visited.add(current);
			hub.handleInput(DOWN);
		}
	};
	return {
		hub,
		settings,
		dir,
		closes: () => closes,
		frame,
		render: () => frame().join("\n"),
		pane: () => pane().join("\n"),
		row: (label: string) => pane().find(line => rowLabel(line) === label) ?? "",
		selected,
		select,
		search: (label: string) => {
			for (const character of label) hub.handleInput(character);
			select(label);
		},
		clickScope: (label: string) => {
			const lines = frame();
			const row = lines.findIndex(line => line.split(theme.boxRound.vertical)[1]?.includes(` ${label} `));
			if (row < 0) throw new Error(`No sidebar scope named ${label}`);
			const col = lines[row].indexOf(label);
			hub.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
		},
		key: async (data: string) => {
			startedEffect = false;
			hub.handleInput(data);
			if (startedEffect) await new Promise<void>(resolve => renders.push(resolve));
		},
	};
}

describe("PromptSettingsComponent", () => {
	it("saves the complete memory binding atomically and discards an unfinished edit", async () => {
		const h = createHub();
		h.select("Memory binding");
		await h.key("\n");
		h.hub.pasteText("alpha");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memoryBinding).toBeUndefined();
		h.hub.pasteText("Archive::Personal Memory");
		await h.key("\n");
		const binding = { principal: "alpha", bankId: "Archive::Personal Memory" };
		expect(h.settings.get("systemPromptProfiles").driver.memoryBinding).toEqual(binding);
		h.select("Memory binding");
		await h.key("\n");
		await h.key("\x15");
		h.hub.pasteText("beta");
		await h.key("\n");
		await h.key(ESCAPE);
		expect(h.settings.get("systemPromptProfiles").driver.memoryBinding).toEqual(binding);
	});

	it("refuses an empty owner instead of reinterpreting the bank's words as an owner", async () => {
		const h = createHub();
		h.select("Memory binding");
		await h.key("\n");
		await h.key("\n");
		h.hub.pasteText("beta archive");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memoryBinding).toBeUndefined();
		expect(h.pane()).toContain("beta archive");
		await h.key(UP);
		h.hub.pasteText("alpha");
		await h.key("\n");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memoryBinding).toEqual({
			principal: "alpha",
			bankId: "beta archive",
		});
	});

	it("shows only the selected scope while keeping the sidebar reachable from a library profile", async () => {
		const h = createHub({
			profiles: {
				driver: { instructionsFile: "driver-only.md" },
				worker: { instructionsFile: "worker-only.md" },
			},
		});
		expect(h.row("Profile")).toContain("driver");
		expect(h.row("Appended instructions")).toContain("driver-only.md");
		expect(h.pane()).not.toContain("worker-only.md");
		expect(h.pane()).not.toContain("main · * -> driver");

		await h.key(DOWN); // Default arrow ownership is the sidebar.
		expect(h.row("Profile")).toContain("worker");
		expect(h.row("Appended instructions")).toContain("worker-only.md");
		expect(h.pane()).not.toContain("driver-only.md");

		await h.key(DOWN);
		await h.key("\t");
		h.search("driver");
		await h.key("\n");
		expect(h.row("Back to All profiles")).toContain("Esc");
		expect(h.row("Appended instructions")).toContain("driver-only.md");
		await h.key(LEFT);
		await h.key(UP);
		expect(h.row("Profile")).toContain("worker");
		expect(h.row("Appended instructions")).toContain("worker-only.md");
		expect(h.pane()).not.toContain("driver-only.md");

		await h.key(DOWN);
		await h.key(DOWN);
		expect(h.pane()).toContain("main · * -> driver");
		expect(h.pane()).toContain("sub · * -> worker");
		expect(h.row("Appended instructions")).toBe("");
	});

	it("returns from nested document options to Subagents rather than Main agent", async () => {
		const h = createHub({
			profiles: { driver: { rolePromptFile: "driver-only.md" }, worker: { rolePromptFile: "worker-only.md" } },
		});
		await h.key(DOWN);
		h.search("Role instructions options");
		await h.key("\n");
		expect(h.pane()).toContain("Change the Markdown file");
		h.select("Back");
		await h.key("\n");
		await h.key(ESCAPE); // Clear the root search, not the scope.
		expect(h.row("Profile")).toContain("worker");
		expect(h.row("Role instructions")).toContain("worker-only.md");
		expect(h.pane()).not.toContain("driver-only.md");
		expect(h.closes()).toBe(0);
	});

	it("switches scope by mouse from an unsaved Markdown path without changing configuration", async () => {
		const profiles = { driver: {}, worker: { rolePrompt: "Worker role" } };
		const h = createHub({ profiles });
		await h.key(DOWN);
		h.search("Role instructions options");
		await h.key("\n");
		h.select("Use a Markdown file");
		await h.key("\n");
		h.hub.pasteText("unsaved.md");
		expect(h.pane()).toContain("unsaved.md");

		h.clickScope("Main agent");

		expect(h.row("Profile")).toContain("driver");
		expect(h.pane()).not.toContain("unsaved.md");
		expect(h.settings.get("systemPromptProfiles")).toEqual(profiles);
		await h.key(DOWN);
		h.search("Role instructions options");
		await h.key("\n");
		h.select("Use a Markdown file");
		await h.key("\n");
		expect(h.pane()).toContain("Markdown file path");
		expect(h.pane()).not.toContain("unsaved.md");
	});

	it("steps Escape through nested screen, root search, sidebar, then close", async () => {
		const h = createHub();
		h.search("Profile");
		await h.key("\n");
		expect(h.pane()).toContain("Clear assignment");
		await h.key(ESCAPE);
		expect(h.pane()).not.toContain("Clear assignment");
		expect(h.pane()).toContain("Search: Profile");
		expect(h.closes()).toBe(0);
		await h.key(ESCAPE);
		expect(h.pane()).not.toContain("Search: Profile");
		expect(h.row("Appended instructions")).toContain("Not configured");
		expect(h.closes()).toBe(0);
		await h.key(ESCAPE); // pane -> sidebar
		expect(h.closes()).toBe(0);
		await h.key(ESCAPE); // sidebar -> close
		expect(h.closes()).toBe(1);
	});

	it("opens the maintained Markdown file on the first activation", async () => {
		const opened: string[] = [];
		const h = createHub({
			open: async file => {
				opened.push(file);
				return true;
			},
		});
		h.search("Base prompt");
		await h.key("\n");
		expect(opened).toEqual([path.join(h.dir.path(), "maintained.md")]);
		expect(h.render()).toContain("Opened ");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
	});

	it.each([false, undefined])("does not claim a Markdown file opened when the opener returns %s", async result => {
		const h = createHub({ open: async () => result });
		h.search("Base prompt");
		await h.key("\n");
		expect(h.render()).toContain("Could not open");
		expect(h.render()).not.toContain("Opened ");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
		expect(h.closes()).toBe(0);
	});

	it("edits appended instructions inline on the first activation and saves the result", async () => {
		const h = createHub({
			profiles: { driver: { instructions: "original" }, worker: {} },
			edit: async text => `${text} edited`,
		});
		h.search("Appended instructions");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.instructions).toBe("original edited");
	});

	it("validates role instructions paths, edits the file directly, and restores the file source", async () => {
		let workspace = "";
		const h = createHub({
			profiles: { driver: { rolePrompt: "original", instructions: "untouched" }, worker: {} },
			open: async source => {
				await Bun.write(path.resolve(workspace, source), "# Edited role");
				return true;
			},
		});
		workspace = h.dir.path();
		h.search("Role instructions options");
		await h.key("\n");
		h.select("Use a Markdown file");
		await h.key("\n");
		h.hub.pasteText("missing.md");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({
			rolePrompt: "original",
			instructions: "untouched",
		});
		// The rejected entry stays open with its text so it can be corrected.
		expect(h.pane()).toContain("missing.md");
		const source = path.join(workspace, "missing.md");
		await Bun.write(source, "# File role");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({
			rolePromptFile: "missing.md",
			instructions: "untouched",
		});

		await h.key(ESCAPE); // Clear the root search after returning from the path entry.
		h.search("Role instructions");
		await h.key("\n");
		expect(await Bun.file(source).text()).toBe("# Edited role");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({
			rolePromptFile: "missing.md",
			instructions: "untouched",
		});

		await h.key(ESCAPE);
		h.search("Role instructions options");
		await h.key("\n");
		h.select("Restore default");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({ instructions: "untouched" });
		expect(await Bun.file(source).text()).toBe("# Edited role");
	});

	it("restores a document default from the document options", async () => {
		const h = createHub({ profiles: { driver: { userTitle: "Rosalia" }, worker: {} } });
		await h.key(RIGHT);
		h.search("User title options");
		await h.key("\n");
		h.select("Restore default");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
		expect(h.render()).not.toContain("Restore default");
	});

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

	it("edits role instructions directly, preserves canceled or rejected edits, and restores inline content", async () => {
		let edited: string | null = null;
		let fail = true;
		const h = createHub({
			profiles: { driver: { rolePrompt: "original" }, worker: {} },
			edit: async () => edited,
			failSave: () => fail,
		});
		h.select("Role instructions");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({ rolePrompt: "original" });

		edited = "# New role\nKeep {{literal}} text.";
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({ rolePrompt: "original" });
		expect(h.render()).toContain("configuration is read-only");
		fail = false;
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({ rolePrompt: edited });
		expect(h.render()).not.toContain(edited);

		h.search("Role instructions options");
		await h.key("\n");
		h.select("Restore default");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
	});

	it("keeps role instructions options and Back reachable in a narrow, short terminal", async () => {
		const h = createHub({ columns: 62, rows: 18 });
		h.select("Role instructions options");
		expect(h.frame().every(line => visibleWidth(line) <= 62)).toBe(true);
		await h.key("\n");
		h.select("Back");
		expect(h.frame().every(line => visibleWidth(line) <= 62)).toBe(true);
		await h.key("\n");
		expect(h.selected()).toContain("Role instructions options");
		expect(h.frame().every(line => visibleWidth(line) <= 62)).toBe(true);
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
		expect(h.closes()).toBe(0);
	});

	it("cancels creation without saving, rejects an invalid id, then creates a valid profile", async () => {
		const h = createHub();
		await h.key(DOWN);
		await h.key(DOWN);
		await h.key(RIGHT);
		h.search("Create profile");
		await h.key("\n");
		h.hub.pasteText("cancelled");
		await h.key(ESCAPE);
		expect(h.settings.get("systemPromptProfiles").cancelled).toBeUndefined();
		await h.key("\n");
		h.hub.pasteText("invalid profile");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles")["invalid profile"]).toBeUndefined();
		await h.key(ESCAPE);
		await h.key("\n");
		h.hub.pasteText("researcher");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").researcher).toEqual({});
		// The row filter that found "Create profile" must not hide the new profile.
		expect(h.row("researcher")).toContain("Configured");
	});

	it("preserves qualified/deny order when assigning and clearing a kind-wide route", async () => {
		const policy: SystemPromptProfileRouteSetting[] = [
			{ agentKind: "main", model: "anthropic/*", profile: "driver" },
			{ agentKind: "main", model: "google/*", deny: true, reason: "blocked" },
			{ agentKind: "main", profile: "driver" },
			{ agentKind: "sub", profile: "worker" },
		];
		const h = createHub({ routes: policy });
		h.search("Profile");
		await h.key("\n");
		h.select("worker");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfileRoutes")).toEqual([
			{ agentKind: "main", profile: "worker" },
			policy[0],
			policy[1],
			policy[3],
		]);
		// The session's own profile is pinned and cannot move under a route edit.
		expect(h.pane()).toContain("Session profile: driver");
		await h.key("\n");
		h.select("Clear assignment");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfileRoutes")).toEqual([policy[0], policy[1], policy[3]]);
		expect(h.row("Profile")).toContain("No unconditional assignment");
	});

	it("refuses removal while referenced and removes an unreferenced profile", async () => {
		const h = createHub({ profiles: { driver: {}, worker: {}, spare: {} } });
		await h.key(DOWN);
		await h.key(DOWN);
		h.search("driver");
		await h.key("\n");
		h.search("Remove profile");
		await h.key("\n");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver).toEqual({});
		expect(h.render()).toContain("still referenced");

		const spare = createHub({ profiles: { driver: {}, worker: {}, spare: {} } });
		await spare.key(DOWN);
		await spare.key(DOWN);
		spare.search("spare");
		await spare.key("\n");
		spare.search("Remove profile");
		await spare.key("\n");
		await spare.key("\n");
		expect(spare.settings.get("systemPromptProfiles").spare).toBeUndefined();
		expect(spare.row("spare")).toBe("");
		expect(spare.row("driver")).toContain("Active session");
	});

	it("reverts a failed optimistic toggle, keeps the frame height, and permits retry", async () => {
		let fail = true;
		const h = createHub({ failSave: () => fail });
		const height = h.frame().length;
		h.search("Memory");
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBeUndefined();
		expect(h.row("Memory")).toContain("default");
		expect(h.render()).toContain("configuration is read-only");
		expect(h.frame().length).toBe(height);
		fail = false;
		await h.key("\n");
		expect(h.settings.get("systemPromptProfiles").driver.memory).toBe(true);
		expect(h.frame().length).toBe(height);
	});
});
