import {
	type Component,
	Container,
	extractPrintableText,
	type Focusable,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { SystemPromptProfileAgentKind } from "../../config/settings-schema";
import { errorMessage } from "../../slash-commands/helpers/parse";
import {
	formatProfileRoute,
	isUnconditionalProfileRoute,
	PROMPT_PROFILE_FIELD_DEFINITIONS,
	type PromptProfileConfiguration,
	type PromptProfileField,
	type PromptProfileOperation,
	type PromptProfileSelectorFieldDefinition,
	type PromptProfileUpdateReceipt,
} from "../../slash-commands/helpers/prompt-profile";
import { shortenPath } from "../../tools/render-utils";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";

export interface PromptSettingsModel extends PromptProfileConfiguration {
	readonly sessionProfileId: string | undefined;
	readonly maintainedPromptFile?: string;
}

export interface PromptSettingsCallbacks {
	readonly onApply: (operation: PromptProfileOperation) => Promise<PromptProfileUpdateReceipt>;
	readonly onEditMarkdown: (content: string) => Promise<string | null | undefined>;
	readonly onOpenMarkdownFile: (source: string) => Promise<boolean | undefined>;
	readonly onClose: () => void;
	readonly requestRender: () => void;
}

type MarkdownField = Extract<PromptProfileSelectorFieldDefinition, { input: "markdown" }>;
// Icons resolve lazily: initTheme installs the live theme binding.
const SCOPES = [
	{ id: "main", label: "Main agent", icon: () => theme.icon.session },
	{ id: "sub", label: "Subagents", icon: () => theme.icon.agents },
	{ id: "profiles", label: "All profiles", icon: () => theme.icon.extensionPrompt },
	{ id: "routes", label: "Selection rules", icon: () => theme.icon.branch },
] as const;
type ScopeEntry = (typeof SCOPES)[number];
const PANE_HEADER_ROWS = 2;
const SIDEBAR_MIN_WIDTH = 18;
const SIDEBAR_MAX_WIDTH = 28;
const PANE_MIN_WIDTH = 37;
const ROUTE_WARNING =
	"Assignment inserts a kind-wide rule first and can override model-specific or deny rules. Applies to future sessions.";
const SCOPE_NOTE = "Restart OMP to apply · /new keeps this session profile · project and --config overrides win";

interface Screen {
	readonly label: string;
	readonly component: Component;
	readonly refresh?: () => void;
	readonly input?: Input;
}

// SettingsList cycles a single-value row through onChange, giving Enter activation without a submenu.
function actionRow(id: string, label: string, value: string, extra: Partial<SettingItem> = {}): SettingItem {
	return { ...extra, id, label, currentValue: value, values: [value] };
}

export class PromptSettingsComponent implements Component, Focusable {
	focused = false;
	#model: PromptSettingsModel;
	#scope: ScopeEntry = SCOPES[0];
	#focus: "scope" | "content" = "scope";
	#screens: Screen[] = [];
	#busy = false;
	#notice: { text: string; error: boolean } | undefined;
	#terminalCursor = false;
	#sidebarHover: number | null = null;
	// Last frame's geometry; the fullscreen overlay starts at terminal row 0.
	#contentRows = 0;
	#sidebarWidth = SIDEBAR_MIN_WIDTH;

	constructor(
		private tui: TUI,
		model: PromptSettingsModel,
		private callbacks: PromptSettingsCallbacks,
	) {
		this.#model = model;
		this.#openScope(SCOPES[0]);
	}

	setUseTerminalCursor(enabled: boolean): void {
		this.#terminalCursor = enabled;
		this.#top().input?.setUseTerminalCursor(enabled);
	}

	pasteText(text: string): void {
		if (!this.#busy && this.#focus === "content") this.#top().input?.pasteText(text);
	}

	render(width: number): readonly string[] {
		const sidebarWidth = this.#measureSidebar(width);
		this.#sidebarWidth = sidebarWidth;
		const rows = Math.max(8, (this.tui.terminal?.rows ?? 40) - 5);
		this.#contentRows = rows;
		const body = this.#renderPane(splitBodyWidth(width, sidebarWidth), rows);
		const sidebar = this.#renderSidebar(sidebarWidth);
		const out = [topBorderSplit(width, "Prompt settings", sidebarWidth)];
		for (let i = 0; i < rows; i++) out.push(splitRow(sidebar[i] ?? "", body[i] ?? "", width, sidebarWidth));
		out.push(
			dividerSplit(width, sidebarWidth),
			row(this.#status(width - 4), width),
			row(theme.fg("dim", this.#hint()), width),
			bottomBorder(width),
		);
		return out;
	}

	#measureSidebar(width: number): number {
		let longest = 0;
		for (const entry of SCOPES) {
			const row = visibleWidth(entry.icon()) + visibleWidth(entry.label) + visibleWidth(this.#annotation(entry.id));
			longest = Math.max(longest, row + 5);
		}
		// Keep document labels and Back readable at 62 columns; annotations yield first.
		return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest, width - 7 - PANE_MIN_WIDTH));
	}

	#annotation(scope: ScopeEntry["id"]): string {
		switch (scope) {
			case "main":
			case "sub":
				return this.#assigned(scope) ?? "none";
			case "profiles":
				return String(Object.keys(this.#model.profiles).length);
			case "routes":
				return String(this.#model.routes.length);
		}
	}

	#renderSidebar(width: number): string[] {
		return SCOPES.map((entry, index) => {
			const active = entry === this.#scope;
			const cursor = active && this.#focus === "scope" ? theme.fg("accent", theme.nav.cursor) : " ";
			const label = active ? theme.bold(theme.fg("accent", entry.label)) : entry.label;
			const left = `${cursor} ${theme.fg(active ? "accent" : "muted", entry.icon())} ${label}`;
			const leftWidth = visibleWidth(left);
			const annotation = truncateToWidth(this.#annotation(entry.id), Math.max(0, width - leftWidth - 1));
			const annotationWidth = visibleWidth(annotation);
			let line =
				leftWidth + annotationWidth < width
					? left + padding(width - leftWidth - annotationWidth) + theme.fg("dim", annotation)
					: truncateToWidth(left, width);
			if (index === this.#sidebarHover) line = theme.bg("selectedBg", line);
			return line;
		});
	}

	#renderPane(width: number, rows: number): string[] {
		const screen = this.#top();
		const selected = screen.component instanceof SettingsList ? screen.component.getSelectedItem() : undefined;
		// Narrow panes need a separate value row; both layouts reserve its geometry.
		const detail = width < 50 && selected ? theme.fg("muted", truncateToWidth(selected.currentValue, width)) : "";
		const lines = [this.#breadcrumb(width), detail];
		const budget = Math.max(3, rows - PANE_HEADER_ROWS);
		// SettingsList reserves five footer rows; SelectList reserves its status row.
		if (screen.component instanceof SettingsList) screen.component.setMaxVisible(budget - 5);
		else if (screen.component instanceof SelectList) screen.component.setMaxVisible(budget - 1);
		if (screen.input) screen.input.focused = this.focused && this.#focus === "content";
		lines.push(...screen.component.render(width));
		return lines;
	}

	#breadcrumb(width: number): string {
		const trail = this.#screens.map(screen => screen.label).join(` ${theme.nav.expand} `);
		const left = theme.bold(theme.fg("accent", visibleWidth(trail) <= width ? trail : this.#top().label));
		const right = theme.fg("dim", `Session profile: ${this.#model.sessionProfileId ?? "default"}`);
		const gap = width - visibleWidth(left) - visibleWidth(right);
		return gap >= 2 ? left + padding(gap) + right : truncateToWidth(left, width);
	}

	#status(width: number): string {
		if (this.#busy) return theme.fg("muted", "Working…");
		if (this.#notice) {
			const text = this.#notice.text.replace(/\s+/g, " ").trim();
			return truncateToWidth(theme.fg(this.#notice.error ? "error" : "success", text), width);
		}
		return theme.fg("dim", truncateToWidth(SCOPE_NOTE, width));
	}

	#hint(): string {
		if (this.#focus === "scope") return "↑↓ scopes · Tab/→ content · Esc back/close";
		if (this.#top().input) return "Enter save · Esc cancel · Tab scopes · click a scope";
		if (this.#screens.length > 1) return "↑↓ rows · Enter select · ← sidebar · Esc back";
		return "↑↓ rows · Enter edit · type search · ← scopes · Esc back";
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		const screen = this.#top();
		// Left/Right belong to the caret only while the text entry has focus.
		const paneNavigation = screen.input === undefined || this.#focus === "scope";
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				this.#mouse(event);
				return true;
			});
		} else if (matchesSelectCancel(data)) this.#escape();
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "content" : "scope";
		} else if (paneNavigation && matchesKey(data, "left")) this.#focus = "scope";
		else if (paneNavigation && matchesKey(data, "right")) this.#focus = "content";
		else if (this.#focus === "scope") {
			const confirm =
				matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space");
			const printable = extractPrintableText(data);
			if (matchesSelectUp(data)) this.#moveScope(-1);
			else if (matchesSelectDown(data)) this.#moveScope(1);
			else if (confirm) this.#focus = "content";
			else if (printable !== undefined && printable.trim().length > 0) {
				this.#focus = "content";
				screen.component.handleInput?.(data);
			}
		} else screen.component.handleInput?.(data);
		this.callbacks.requestRender();
	}

	#escape(): void {
		const root = this.#top().component;
		if (this.#screens.length > 1) this.#screens.pop();
		else if (root instanceof SettingsList && root.hasSearchQuery()) root.clearSearch();
		else if (this.#focus === "content") this.#focus = "scope";
		else this.callbacks.onClose();
	}

	#moveScope(delta: -1 | 1): void {
		const index = SCOPES.indexOf(this.#scope);
		const next = SCOPES[Math.max(0, Math.min(index + delta, SCOPES.length - 1))];
		if (next !== this.#scope) this.#openScope(next);
	}

	#mouse(event: SgrMouseEvent): void {
		const line = event.row - 1;
		if (line < 0 || line >= this.#contentRows) return;
		if (event.col < this.#sidebarWidth + 2) {
			const entry = SCOPES[line];
			if (event.motion) this.#sidebarHover = entry ? line : null;
			else if (event.leftClick && entry) {
				// Scope clicks discard an open entry without writing it.
				this.#openScope(entry);
				this.#focus = "scope";
			}
			return;
		}
		if (event.col < this.#sidebarWidth + 5) return;
		this.#sidebarHover = null;
		this.#paneMouse(event, line - PANE_HEADER_ROWS, event.col - (this.#sidebarWidth + 5));
	}

	#paneMouse(event: SgrMouseEvent, line: number, col: number): void {
		const screen = this.#top();
		const component = screen.component;
		if (screen.input) {
			if (event.leftClick && line >= 0) this.#focus = "content";
		} else if (component instanceof SelectList) {
			if (event.leftClick) this.#focus = "content";
			component.routeMouse(event, line, col);
		} else if (component instanceof SettingsList) {
			if (event.wheel !== null) component.handleWheelAt(event.wheel, line, col);
			else {
				const hit = component.hoverTest(line, col);
				if (event.motion) component.setHoverItem(hit ?? null);
				else if (event.leftClick && hit !== undefined) {
					this.#focus = "content";
					// First click selects; a second on the same row activates.
					const activate = component.getSelectedItem()?.id === hit;
					component.selectItem(hit);
					if (activate) component.handleInput("\n");
				}
			}
		}
	}

	#top(): Screen {
		return this.#screens[this.#screens.length - 1];
	}

	#openScope(scope: ScopeEntry): void {
		this.#scope = scope;
		this.#screens = [this.#listScreen(scope.label, () => this.#scopeItems(scope.id))];
	}

	#push(screen: Screen): void {
		this.#screens.push(screen);
		this.#focus = "content";
	}

	#listScreen(label: string, build: () => SettingItem[]): Screen {
		const list = new SettingsList(
			build(),
			12,
			getSettingsListTheme(),
			(id, value) => this.#activate(id, value),
			() => this.#escape(),
			{
				layout: "flat",
				hint: "",
			},
		);
		return { label, component: list, refresh: () => list.setItems(build()) };
	}

	#pickerScreen(
		label: string,
		items: SelectItem[],
		current: string | undefined,
		select: (value: string) => void,
	): Screen {
		items.push({ value: "back", label: "Back", description: "Esc" });
		const picker = new SelectList(items, 12, getSelectListTheme());
		const selected = items.findIndex(item => item.value === current);
		if (selected >= 0) picker.setSelectedIndex(selected);
		picker.onSelect = item => (item.value === "back" ? this.#escape() : select(item.value));
		picker.onCancel = () => this.#escape();
		return { label, component: picker };
	}

	#textScreen(
		label: string,
		value: string,
		hint: string,
		operation: (text: string) => PromptProfileOperation,
		returnTo = this.#screens.length,
	): Screen {
		const input = new Input();
		input.setValue(value);
		input.setUseTerminalCursor(this.#terminalCursor);
		input.onSubmit = text => void this.#task(operation(text), returnTo);
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", hint), 0, 0));
		container.addChild(input);
		return {
			label,
			component: Object.assign(container, { handleInput: (data: string) => input.handleInput(data) }),
			input,
		};
	}

	#scopeItems(scope: ScopeEntry["id"]): SettingItem[] {
		switch (scope) {
			case "main":
			case "sub": {
				const profileId = this.#assigned(scope);
				const items = [
					actionRow(`route:${scope}`, "Profile", profileId ?? "No unconditional assignment", {
						warning: ROUTE_WARNING,
						description: `Profile ${scope === "main" ? "top-level sessions" : "subagents"} start with.`,
						changed: profileId !== undefined,
					}),
				];
				if (profileId === undefined)
					items.push({
						id: "unassigned",
						label: "No profile assigned",
						currentValue: "Maintained prompt",
						description:
							"Without a kind-wide rule, this kind falls back to a model rule or the maintained prompt.",
					});
				else items.push(...this.#fieldItems(profileId));
				return items;
			}
			case "profiles": {
				const items = Object.keys(this.#model.profiles)
					.sort()
					.map(id =>
						actionRow(
							`profile:${id}`,
							id,
							id === this.#model.sessionProfileId ? "Active session" : "Configured",
							{
								description: this.#profileSummary(id),
							},
						),
					);
				items.push(actionRow("create", "Create profile", "", { description: "Add a profile to the library." }));
				return items;
			}
			case "routes":
				return this.#model.routes.length === 0
					? [
							{
								id: "no-routes",
								label: "No selection rules",
								currentValue: "Maintained prompt",
								description: "No profile is selected unless an ordered route matches.",
							},
						]
					: this.#model.routes.map((route, index) => ({
							id: `rule:${index}`,
							label: `${index + 1}`,
							currentValue: formatProfileRoute(route, index),
							description:
								"First matching rule wins. Model-qualified and deny rules are configured in config.yml.",
						}));
		}
	}

	#profileSummary(profileId: string): string {
		const count = Object.keys(this.#model.profiles[profileId] ?? {}).length;
		const kinds = SCOPES.filter(
			entry => (entry.id === "main" || entry.id === "sub") && this.#assigned(entry.id) === profileId,
		).map(entry => entry.label);
		const fields = count === 0 ? "No fields set" : `${count} field${count === 1 ? "" : "s"} set`;
		return `${fields} · ${kinds.length > 0 ? `assigned to ${kinds.join(" and ")}` : "no kind-wide assignment"}`;
	}

	#routePicker(kind: SystemPromptProfileAgentKind): Screen {
		const assigned = this.#assigned(kind);
		const depth = this.#screens.length;
		const items = Object.keys(this.#model.profiles)
			.sort()
			.map(id => ({
				value: `profile:${id}`,
				label: id,
				description: id === assigned ? "assigned" : undefined,
			}));
		items.push({ value: "clear", label: "Clear assignment", description: "Let the remaining ordered rules decide" });
		return this.#pickerScreen(
			"Profile",
			items,
			assigned && `profile:${assigned}`,
			value =>
				void this.#task(
					value === "clear"
						? { type: "clearRoute", agentKind: kind }
						: { type: "assignRoute", agentKind: kind, profileId: value.slice("profile:".length) },
					depth,
				),
		);
	}

	#documentScreen(profileId: string, definition: MarkdownField): Screen {
		const document = this.#document(profileId, definition);
		const depth = this.#screens.length;
		return this.#pickerScreen(`${definition.label} options`, document.actions, undefined, value => {
			if (value === "file" && "file" in definition)
				this.#push(
					this.#textScreen(
						"Markdown file",
						document.source ?? "",
						"Markdown file path: existing file, relative to the session workspace or absolute.",
						text => ({ type: "setField", profileId, field: definition.file, value: text }),
						depth,
					),
				);
			else {
				const field = document.source !== undefined && "file" in definition ? definition.file : definition.field;
				void this.#task({ type: "restoreField", profileId, field }, depth);
			}
		});
	}

	#assigned(kind: SystemPromptProfileAgentKind): string | undefined {
		return this.#model.routes.find(route => isUnconditionalProfileRoute(route, kind))?.profile;
	}

	#fieldItems(profileId: string): SettingItem[] {
		const profile = this.#model.profiles[profileId] ?? {};
		const items: SettingItem[] = [];
		for (const definition of PROMPT_PROFILE_FIELD_DEFINITIONS) {
			if (definition.input === "toggle") {
				const value = profile[definition.field];
				items.push({
					id: `toggle:${profileId}:${definition.field}`,
					label: definition.label,
					currentValue: typeof value === "boolean" ? (value ? "on" : "off") : "default",
					values: ["default", "on", "off"],
					changed: typeof value === "boolean",
					description: `Default ${definition.default ? "on" : "off"} · applies to future sessions routed to ${profileId}.`,
				});
				continue;
			}
			const document = this.#document(profileId, definition);
			items.push(
				actionRow(`doc:${profileId}:${definition.field}`, definition.label, document.value, {
					changed: document.source !== undefined || document.content !== undefined,
					description:
						document.openPath !== undefined
							? `Enter opens ${shortenPath(document.openPath)} in your editor.`
							: "Enter edits this Markdown inline in your editor.",
				}),
			);
			if (document.actions.length > 0)
				items.push(
					actionRow(`src:${profileId}:${definition.field}`, `${definition.label} options`, document.origin, {
						description: document.actions.map(action => action.label).join(" · "),
					}),
				);
		}
		return items;
	}

	#document(profileId: string, definition: MarkdownField) {
		const profile = this.#model.profiles[profileId] ?? {};
		const source = "file" in definition ? profile[definition.file] : undefined;
		const content = profile[definition.field];
		const maintained =
			definition.field === "prompt" && content === undefined ? this.#model.maintainedPromptFile : undefined;
		const actions: SelectItem[] = [];
		if ("file" in definition)
			actions.push({
				value: "file",
				label: source === undefined ? "Use a Markdown file" : "Change the Markdown file",
				description: "Existing file, relative to the session workspace or absolute",
			});
		if (source !== undefined || content !== undefined)
			actions.push({
				value: "restore",
				label: "Restore default",
				description:
					source !== undefined ? "Forget the file and inherit the default" : "Discard the inline Markdown",
			});
		return {
			openPath: source ?? maintained,
			content,
			source,
			value:
				source !== undefined
					? shortenPath(source)
					: content !== undefined
						? `inline (${content.length} chars)`
						: definition.field === "prompt"
							? "Maintained prompt"
							: "Not configured",
			origin:
				source !== undefined ? "file" : content !== undefined ? "inline" : maintained ? "maintained" : "not set",
			actions,
		};
	}

	#activate(id: string, value: string): void {
		const [kind, target = "", field] = id.split(":"); // Validated profile IDs cannot contain colons.
		switch (kind) {
			case "back":
				this.#escape();
				return;
			case "toggle":
				void this.#task(
					value === "default"
						? { type: "restoreField", profileId: target, field: field as PromptProfileField }
						: { type: "setField", profileId: target, field: field as PromptProfileField, value },
				);
				return;
			case "doc":
			case "src": {
				const definition = PROMPT_PROFILE_FIELD_DEFINITIONS.find(
					(candidate): candidate is MarkdownField => candidate.input === "markdown" && candidate.field === field,
				);
				if (definition === undefined) return;
				if (kind === "doc") this.#openDocument(target, definition);
				else this.#push(this.#documentScreen(target, definition));
				return;
			}
			case "route":
				this.#push(this.#routePicker(target === "sub" ? "sub" : "main"));
				return;
			case "profile":
				this.#push(
					this.#listScreen(target, () => [
						actionRow("back", "Back to All profiles", "Esc"),
						...this.#fieldItems(target),
						actionRow(`remove:${target}`, "Remove profile", target, {
							warning: "Referenced profiles cannot be removed; clear their routes first.",
						}),
					]),
				);
				return;
			case "create":
				this.#push(
					this.#textScreen("New profile", "", "Profile ID: letters, numbers, dot, dash, underscore.", text => ({
						type: "createProfile",
						profileId: text,
					})),
				);
				return;
			case "remove":
				// Remove the profile's own screen too, returning to its library.
				this.#push(
					this.#pickerScreen(
						"Remove",
						[{ value: "remove", label: `Remove ${target} permanently` }],
						undefined,
						() => void this.#task({ type: "removeProfile", profileId: target }, 1),
					),
				);
		}
	}

	#openDocument(profileId: string, definition: MarkdownField): void {
		const { openPath, content } = this.#document(profileId, definition);
		void this.#task(async () => {
			if (openPath !== undefined) {
				const opened = await this.callbacks.onOpenMarkdownFile(openPath);
				return opened === true
					? { text: `Opened ${shortenPath(openPath)}.` }
					: {
							text: `Could not open ${shortenPath(openPath)}. Set $VISUAL or $EDITOR and try again.`,
							error: true,
						};
			}
			const edited = await this.callbacks.onEditMarkdown(content ?? "");
			return edited == null
				? { text: `${definition.label} left unchanged.` }
				: this.#mutate({ type: "setField", profileId, field: definition.field, value: edited });
		});
	}

	// Only completed actions unwind; rejected saves keep the same input available for correction.
	async #task(
		action: PromptProfileOperation | (() => Promise<{ text: string; error?: boolean }>),
		depth?: number,
	): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#notice = undefined;
		this.callbacks.requestRender();
		try {
			const notice: { text: string; error?: boolean } = await (typeof action === "function"
				? action()
				: this.#mutate(action));
			this.#notice = { text: notice.text, error: notice.error === true };
			if (depth !== undefined && depth >= 1 && this.#screens.length > depth) this.#screens.length = depth;
		} catch (error) {
			this.#notice = { text: errorMessage(error), error: true };
		} finally {
			// Refresh also rolls back SettingsList's optimistic cycle after a failed save.
			for (const screen of this.#screens) screen.refresh?.();
			this.#busy = false;
			this.callbacks.requestRender();
		}
	}

	async #mutate(operation: PromptProfileOperation): Promise<{ text: string }> {
		// The canonical writer validates source-pair exclusivity; only configuration, never the session profile, changes.
		const receipt = await this.callbacks.onApply(operation);
		this.#model = { ...this.#model, ...receipt.configuration };
		// Only membership changes clear filters that could hide the edit's result.
		if (operation.type === "createProfile" || operation.type === "removeProfile") {
			for (const screen of this.#screens) {
				if (screen.component instanceof SettingsList) screen.component.clearSearch();
			}
		}
		return { text: receipt.message };
	}
}
