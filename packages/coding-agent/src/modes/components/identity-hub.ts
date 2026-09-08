/**
 * Fullscreen identity editor: a persistent scope sidebar beside one content
 * pane. Nested screens stay in the pane; documents open directly. Configuration
 * writes go through onApply and never change the session's pinned identity.
 */
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

export interface IdentityHubModel extends PromptProfileConfiguration {
	readonly identity: {
		readonly role: SystemPromptProfileAgentKind;
		readonly profileId: string | undefined;
		readonly principal: string;
		readonly source: string;
	};
	readonly maintainedPromptFile?: string;
}

export interface IdentityHubCallbacks {
	readonly onApply: (operation: PromptProfileOperation) => Promise<PromptProfileUpdateReceipt>;
	readonly onEditMarkdown: (content: string) => Promise<string | null | undefined>;
	readonly onOpenMarkdownFile: (source: string) => Promise<boolean | undefined>;
	readonly onClose: () => void;
	readonly requestRender: () => void;
}

type MarkdownField = Extract<PromptProfileSelectorFieldDefinition, { input: "markdown" }>;

type IdentityScope = "main" | "sub" | "profiles" | "routes";

interface ScopeEntry {
	readonly id: IdentityScope;
	readonly label: string;
	/** Resolved lazily: the theme is a live binding installed by `initTheme`. */
	readonly icon: () => string;
}

/** Sidebar order is fixed: the two agent kinds, then the library, then the rules. */
const SCOPES: readonly ScopeEntry[] = [
	{ id: "main", label: "Main", icon: () => theme.icon.session },
	{ id: "sub", label: "Subagents", icon: () => theme.icon.agents },
	{ id: "profiles", label: "All profiles", icon: () => theme.icon.extensionPrompt },
	{ id: "routes", label: "Routing", icon: () => theme.icon.branch },
];

/** Breadcrumb and selected value (or a spacer on wider panes). */
const PANE_HEADER_ROWS = 2;

const SIDEBAR_MIN_WIDTH = 18;
const SIDEBAR_MAX_WIDTH = 28;
const PANE_MIN_WIDTH = 37;

const ROUTE_WARNING =
	"Assignment inserts a kind-wide rule first and can override model-specific or deny rules. Applies to future sessions.";

const SCOPE_NOTE = "Restart OMP to apply · /new keeps this identity · project and --config overrides win";

/** One level of the content pane. Level 0 is the scope's own view and is rebuilt whenever the scope changes. */
interface Screen {
	/** Breadcrumb segment for this level. */
	readonly label: string;
	readonly component: Component;
	/** Rebuild rows from the current model after a write. */
	readonly refresh?: () => void;
	/** Present while a text entry owns Left/Right and printable input. */
	readonly input?: Input;
}

/** Where one Markdown-valued field currently gets its content, and what can be done to it. */
interface DocumentTarget {
	/** File primary activation opens; undefined routes to the inline editor. */
	readonly openPath: string | undefined;
	readonly content: string | undefined;
	readonly source: string | undefined;
	/** Primary row value: the path, the inline size, or the declared default. */
	readonly value: string;
	/** Secondary row value: which of file/inline/maintained is in effect. */
	readonly origin: string;
	readonly actions: SelectItem[];
}

/**
 * A row activated by Enter rather than cycled: `SettingsList` reports the id of
 * a single-value list when it "cycles" it, so activation arrives in `onChange`
 * without a submenu owning the pane.
 */
function actionRow(id: string, label: string, value: string, extra: Partial<SettingItem> = {}): SettingItem {
	return { ...extra, id, label, currentValue: value, values: [value] };
}

export class IdentityHubComponent implements Component, Focusable {
	focused = false;
	#model: IdentityHubModel;
	#scope: IdentityScope = "main";
	/** Arrow ownership: `scope` hops the sidebar (default), `content` drives the pane. */
	#focus: "scope" | "content" = "scope";
	#screens: Screen[] = [];
	#busy = false;
	#notice: { text: string; error: boolean } | undefined;
	#terminalCursor = false;
	#sidebarHover: number | null = null;
	// Frame geometry from the last render, for mouse hit-testing (a fullscreen
	// overlay paints from screen row 0, so mouse rows map 1:1).
	#contentRowStart = 1;
	#contentRows = 0;
	#sidebarWidth = SIDEBAR_MIN_WIDTH;

	constructor(
		private tui: TUI,
		model: IdentityHubModel,
		private callbacks: IdentityHubCallbacks,
	) {
		this.#model = model;
		this.#openScope("main");
	}

	setUseTerminalCursor(enabled: boolean): void {
		this.#terminalCursor = enabled;
		this.#top().input?.setUseTerminalCursor(enabled);
	}

	pasteText(text: string): void {
		if (!this.#busy && this.#focus === "content") this.#top().input?.pasteText(text);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	render(width: number): readonly string[] {
		const sidebarWidth = this.#measureSidebar(width);
		this.#sidebarWidth = sidebarWidth;
		const rows = Math.max(8, (this.tui.terminal?.rows ?? 40) - 5);
		this.#contentRows = rows;
		const body = this.#renderPane(splitBodyWidth(width, sidebarWidth), rows);
		const sidebar = this.#renderSidebar(sidebarWidth);
		const out = [topBorderSplit(width, "Identity", sidebarWidth)];
		this.#contentRowStart = out.length;
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
			// Cursor, icon, label and the gap before the annotation.
			const row = visibleWidth(entry.icon()) + visibleWidth(entry.label) + visibleWidth(this.#annotation(entry.id));
			longest = Math.max(longest, row + 5);
		}
		// Keep document labels and Back readable at 62 columns; annotations yield first.
		return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest, width - 7 - PANE_MIN_WIDTH));
	}

	/** Right-aligned scope annotation: the assigned profile, or how many entries the view holds. */
	#annotation(scope: IdentityScope): string {
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
			const active = entry.id === this.#scope;
			// The active scope is state, not a cursor: it stays accented while
			// the pane owns the arrows, and only then loses the cursor glyph.
			const cursor = active && this.#focus === "scope" ? theme.fg("accent", theme.nav.cursor) : " ";
			const label = active ? theme.bold(theme.fg("accent", entry.label)) : entry.label;
			const left = `${cursor} ${theme.fg(active ? "accent" : "muted", entry.icon())} ${label}`;
			const leftWidth = visibleWidth(left);
			// A long assigned-profile annotation is clipped, never dropped.
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
		// The list's aligned label column leaves little room for values in a narrow pane.
		const detail = width < 50 && selected ? theme.fg("muted", truncateToWidth(selected.currentValue, width)) : "";
		const lines = [this.#breadcrumb(width), detail];
		const budget = Math.max(3, rows - PANE_HEADER_ROWS);
		// SettingsList reserves 5 rows below its viewport (blank, three
		// description rows, search status); SelectList reserves its status row.
		if (screen.component instanceof SettingsList) screen.component.setMaxVisible(budget - 5);
		else if (screen.component instanceof SelectList) screen.component.setMaxVisible(budget - 1);
		if (screen.input) screen.input.focused = this.focused && this.#focus === "content";
		lines.push(...screen.component.render(width));
		return lines;
	}

	/** Scope trail plus the session's pinned identity, which no edit here can change. */
	#breadcrumb(width: number): string {
		const trail = this.#screens.map(screen => screen.label).join(` ${theme.nav.expand} `);
		const left = theme.bold(theme.fg("accent", visibleWidth(trail) <= width ? trail : this.#top().label));
		const identity = this.#model.identity;
		const right = theme.fg(
			"dim",
			`Pinned: ${identity.profileId ?? "default"} · ${identity.role} · ${identity.principal}`,
		);
		const gap = width - visibleWidth(left) - visibleWidth(right);
		return gap >= 2 ? left + padding(gap) + right : truncateToWidth(left, width);
	}

	/** One stable row: the in-flight write, the last receipt or failure, else the standing caveat. */
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

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		// A write is in flight: rows and text entries stay inert until it settles.
		if (this.#busy) return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				this.#mouse(event);
				return true;
			});
			this.callbacks.requestRender();
			return;
		}
		const screen = this.#top();
		if (matchesSelectCancel(data)) {
			this.#escape();
			this.callbacks.requestRender();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "content" : "scope";
			this.callbacks.requestRender();
			return;
		}
		// Left/Right belong to the caret only while the text entry has focus.
		if (screen.input === undefined || this.#focus === "scope") {
			if (matchesKey(data, "left")) {
				this.#focus = "scope";
				this.callbacks.requestRender();
				return;
			}
			if (matchesKey(data, "right")) {
				this.#focus = "content";
				this.callbacks.requestRender();
				return;
			}
		}
		if (this.#focus === "scope") {
			const confirm =
				matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space");
			const printable = extractPrintableText(data);
			if (matchesSelectUp(data)) {
				this.#moveScope(-1);
			} else if (matchesSelectDown(data)) {
				this.#moveScope(1);
			} else if (confirm) {
				this.#focus = "content";
			} else if (printable !== undefined && printable.trim().length > 0) {
				this.#focus = "content";
				screen.component.handleInput?.(data);
			}
			this.callbacks.requestRender();
			return;
		}
		screen.component.handleInput?.(data);
		this.callbacks.requestRender();
	}

	/** One predictable ladder: cancel the entry, leave the nested screen, drop the search, park on the sidebar, close. */
	#escape(): void {
		if (this.#screens.length > 1) {
			this.#screens.pop();
			return;
		}
		const root = this.#top().component;
		if (root instanceof SettingsList && root.hasSearchQuery()) {
			root.clearSearch();
			return;
		}
		if (this.#focus === "content") {
			this.#focus = "scope";
			return;
		}
		this.callbacks.onClose();
	}

	#moveScope(delta: -1 | 1): void {
		const index = SCOPES.findIndex(entry => entry.id === this.#scope);
		const next = SCOPES[Math.max(0, Math.min(index + delta, SCOPES.length - 1))];
		if (next.id !== this.#scope) this.#openScope(next.id);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#mouse(event: SgrMouseEvent): void {
		const line = event.row - this.#contentRowStart;
		if (line < 0 || line >= this.#contentRows) return;
		if (event.col < this.#sidebarWidth + 2) {
			const entry = SCOPES[line];
			if (event.motion) this.#sidebarHover = entry ? line : null;
			else if (event.leftClick && entry) {
				// A scope click outranks the pane, including an open text entry:
				// the entry is discarded, never silently written.
				this.#openScope(entry.id);
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
		if (screen.input) {
			if (event.leftClick && line >= 0) this.#focus = "content";
			return;
		}
		const component = screen.component;
		if (component instanceof SelectList) {
			if (event.leftClick) this.#focus = "content";
			component.routeMouse(event, line, col);
			return;
		}
		if (!(component instanceof SettingsList)) return;
		if (event.wheel !== null) {
			component.handleWheelAt(event.wheel, line, col);
			return;
		}
		const hit = component.hoverTest(line, col);
		if (event.motion) {
			component.setHoverItem(hit ?? null);
			return;
		}
		if (!event.leftClick || hit === undefined) return;
		this.#focus = "content";
		// First click selects, a second on the same row activates it.
		const activate = component.getSelectedItem()?.id === hit;
		component.selectItem(hit);
		if (activate) component.handleInput("\n");
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Screens
	// ═══════════════════════════════════════════════════════════════════════

	#top(): Screen {
		return this.#screens[this.#screens.length - 1];
	}

	/** Scope changes discard nested screens and unsaved input. */
	#openScope(scope: IdentityScope): void {
		this.#scope = scope;
		this.#screens = [
			scope === "profiles"
				? this.#libraryScreen()
				: scope === "routes"
					? this.#routesScreen()
					: this.#kindScreen(scope),
		];
	}

	#push(screen: Screen): void {
		this.#screens.push(screen);
		this.#focus = "content";
	}

	/** Drop every screen above `depth`, returning to the level that opened them. */
	#unwind(depth: number): void {
		if (depth >= 1 && this.#screens.length > depth) this.#screens.length = depth;
	}

	#listScreen(label: string, build: () => SettingItem[], activate: (id: string, value: string) => void): Screen {
		const list = new SettingsList(build(), 12, getSettingsListTheme(), activate, () => this.#escape(), {
			layout: "flat",
			hint: "",
		});
		return { label, component: list, refresh: () => list.setItems(build()) };
	}

	#pickerScreen(
		label: string,
		items: SelectItem[],
		current: string | undefined,
		select: (value: string) => void,
	): Screen {
		const picker = new SelectList(items, 12, getSelectListTheme());
		const selected = items.findIndex(item => item.value === current);
		if (selected >= 0) picker.setSelectedIndex(selected);
		picker.onSelect = item => select(item.value);
		picker.onCancel = () => this.#escape();
		return { label, component: picker };
	}

	/**
	 * Text entry. A rejected value keeps the screen open with its text so the
	 * user can correct it; only a saved value unwinds to `returnTo`.
	 */
	#textScreen(
		label: string,
		value: string,
		hint: string,
		operation: (text: string) => PromptProfileOperation,
		returnTo?: number,
	): Screen {
		const depth = returnTo ?? this.#screens.length;
		const input = new Input();
		input.setValue(value);
		input.setUseTerminalCursor(this.#terminalCursor);
		input.onSubmit = text =>
			void this.#task(
				() => this.#mutate(operation(text)),
				() => this.#unwind(depth),
			);
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", hint), 0, 0));
		container.addChild(input);
		return {
			label,
			component: Object.assign(container, { handleInput: (data: string) => input.handleInput(data) }),
			input,
		};
	}

	/** Main/Subagents: the kind's assignment plus the assigned profile's own fields, and nothing from the other kind. */
	#kindScreen(kind: SystemPromptProfileAgentKind): Screen {
		const build = (): SettingItem[] => {
			const profileId = this.#assigned(kind);
			const items = [
				actionRow(`route:${kind}`, "Profile", profileId ?? "No unconditional assignment", {
					warning: ROUTE_WARNING,
					description: `Profile ${kind === "main" ? "top-level sessions" : "subagents"} start with.`,
					changed: profileId !== undefined,
				}),
			];
			if (profileId === undefined)
				items.push({
					id: "unassigned",
					label: "No profile assigned",
					currentValue: "Maintained prompt",
					description: "Without a kind-wide rule, this kind falls back to a model rule or the maintained prompt.",
				});
			else items.push(...this.#fieldItems(profileId));
			return items;
		};
		return this.#listScreen(kind === "main" ? "Main" : "Subagents", build, (id, value) => this.#activate(id, value));
	}

	#libraryScreen(): Screen {
		const build = (): SettingItem[] => {
			const items = Object.keys(this.#model.profiles)
				.sort()
				.map(id =>
					actionRow(`profile:${id}`, id, id === this.#model.identity.profileId ? "Active session" : "Configured", {
						description: this.#profileSummary(id),
					}),
				);
			items.push(actionRow("create", "Create profile", "", { description: "Add a profile to the library." }));
			return items;
		};
		return this.#listScreen("All profiles", build, (id, value) => this.#activate(id, value));
	}

	#profileSummary(profileId: string): string {
		const count = Object.keys(this.#model.profiles[profileId] ?? {}).length;
		const kinds = (["main", "sub"] as const)
			.filter(kind => this.#assigned(kind) === profileId)
			.map(kind => (kind === "main" ? "Main" : "Subagents"));
		const fields = count === 0 ? "No fields set" : `${count} field${count === 1 ? "" : "s"} set`;
		return `${fields} · ${kinds.length > 0 ? `assigned to ${kinds.join(" and ")}` : "no kind-wide assignment"}`;
	}

	#routesScreen(): Screen {
		const build = (): SettingItem[] => {
			if (this.#model.routes.length === 0)
				return [
					{
						id: "no-routes",
						label: "No routes",
						currentValue: "Maintained prompt",
						description: "No profile is selected unless an ordered route matches.",
					},
				];
			return this.#model.routes.map((route, index) => ({
				id: `rule:${index}`,
				label: `${index + 1}`,
				currentValue: formatProfileRoute(route, index),
				description: "First matching rule wins. Model-qualified and deny rules are configured in config.yml.",
			}));
		};
		return this.#listScreen("Routing", build, () => {});
	}

	/** A library profile, opened inside the pane so the scope sidebar stays reachable. */
	#profileScreen(profileId: string): Screen {
		const build = (): SettingItem[] => [
			actionRow("back", "Back to All profiles", "Esc"),
			...this.#fieldItems(profileId),
			actionRow(`remove:${profileId}`, "Remove profile", profileId, {
				warning: "Referenced profiles cannot be removed; clear their routes first.",
			}),
		];
		return this.#listScreen(profileId, build, (id, value) => this.#activate(id, value));
	}

	#routePicker(kind: SystemPromptProfileAgentKind): Screen {
		const assigned = this.#assigned(kind);
		const depth = this.#screens.length;
		const items: SelectItem[] = [
			...Object.keys(this.#model.profiles)
				.sort()
				.map(id => ({
					value: `profile:${id}`,
					label: id,
					description: id === assigned ? "assigned" : undefined,
				})),
			{ value: "clear", label: "Clear assignment", description: "Let the remaining ordered rules decide" },
			{ value: "back", label: "Back", description: "Esc" },
		];
		return this.#pickerScreen("Profile", items, assigned && `profile:${assigned}`, value => {
			if (value === "back") {
				this.#screens.pop();
				return;
			}
			const operation: PromptProfileOperation =
				value === "clear"
					? { type: "clearRoute", agentKind: kind }
					: { type: "assignRoute", agentKind: kind, profileId: value.slice("profile:".length) };
			void this.#task(
				() => this.#mutate(operation),
				() => this.#unwind(depth),
			);
		});
	}

	#removeScreen(profileId: string): Screen {
		return this.#pickerScreen(
			"Remove",
			[
				{ value: "remove", label: `Remove ${profileId} permanently` },
				{ value: "back", label: "Back", description: "Esc" },
			],
			undefined,
			value => {
				if (value === "back") {
					this.#screens.pop();
					return;
				}
				// The removed profile's own screen goes with it: unwind to the library.
				void this.#task(
					() => this.#mutate({ type: "removeProfile", profileId }),
					() => this.#unwind(1),
				);
			},
		);
	}

	/** Secondary document controls, visible as their own row: point the field at a file, or restore its default. */
	#documentScreen(profileId: string, definition: MarkdownField): Screen {
		const document = this.#document(profileId, definition);
		const depth = this.#screens.length;
		return this.#pickerScreen(
			`${definition.label} options`,
			[...document.actions, { value: "back", label: "Back", description: "Esc" }],
			undefined,
			value => {
				if (value === "back") {
					this.#screens.pop();
					return;
				}
				if (value === "file" && "file" in definition) {
					this.#push(
						this.#textScreen(
							"Markdown file",
							document.source ?? "",
							"Markdown file path: existing file, relative to the session workspace or absolute.",
							text => ({ type: "setField", profileId, field: definition.file, value: text }),
							depth,
						),
					);
					return;
				}
				const field = document.source !== undefined && "file" in definition ? definition.file : definition.field;
				void this.#task(
					() => this.#mutate({ type: "restoreField", profileId, field }),
					() => this.#unwind(depth),
				);
			},
		);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rows and activation
	// ═══════════════════════════════════════════════════════════════════════

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
			if (definition.input === "constitution") {
				items.push({
					id: `toggle:${profileId}:constitution`,
					label: definition.label,
					currentValue: profile.constitution ?? "default",
					values: ["default", "fable"],
					changed: profile.constitution !== undefined,
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

	#document(profileId: string, definition: MarkdownField): DocumentTarget {
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

	/** Row activation for every list screen: ids carry their own target, so one dispatcher serves all levels. */
	#activate(id: string, value: string): void {
		const [kind, ...rest] = id.split(":"); // Validated profile IDs cannot contain colons.
		const target = rest[0] ?? "";
		switch (kind) {
			case "back":
				this.#screens.pop();
				return;
			case "toggle": {
				const field = rest[1] as PromptProfileField;
				void this.#task(() =>
					this.#mutate(
						value === "default"
							? { type: "restoreField", profileId: target, field }
							: { type: "setField", profileId: target, field, value },
					),
				);
				return;
			}
			case "doc":
			case "src": {
				const definition = PROMPT_PROFILE_FIELD_DEFINITIONS.find(
					(candidate): candidate is MarkdownField => candidate.input === "markdown" && candidate.field === rest[1],
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
				this.#push(this.#profileScreen(target));
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
				this.#push(this.#removeScreen(target));
				return;
			default:
				return;
		}
	}

	/** Documents open directly; only fields without a file use the inline editor. */
	#openDocument(profileId: string, definition: MarkdownField): void {
		const document = this.#document(profileId, definition);
		const openPath = document.openPath;
		if (openPath !== undefined) {
			void this.#task(async () => {
				const opened = await this.callbacks.onOpenMarkdownFile(openPath);
				return opened === true
					? { text: `Opened ${shortenPath(openPath)}.` }
					: {
							text: `Could not open ${shortenPath(openPath)}. Set $VISUAL or $EDITOR and try again.`,
							error: true,
						};
			});
			return;
		}
		void this.#task(async () => {
			const edited = await this.callbacks.onEditMarkdown(document.content ?? "");
			if (edited == null) return { text: `${definition.label} left unchanged.` };
			return this.#mutate({ type: "setField", profileId, field: definition.field, value: edited });
		});
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Writes
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Run one hub action under the busy flag with a single notice and rebuilt
	 * rows. `settle` runs only when the action completed, so a rejected value
	 * leaves its screen open for a retry; a file open reports its own outcome
	 * without touching the configuration.
	 */
	async #task(run: () => Promise<{ text: string; error?: boolean }>, settle?: () => void): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#notice = undefined;
		this.callbacks.requestRender();
		try {
			const notice = await run();
			this.#notice = { text: notice.text, error: notice.error === true };
			settle?.();
		} catch (error) {
			this.#notice = { text: errorMessage(error), error: true };
		} finally {
			// Rows come back from the configuration either way, which also
			// restores a value SettingsList cycled optimistically before a
			// failed save.
			for (const screen of this.#screens) screen.refresh?.();
			this.#busy = false;
			this.callbacks.requestRender();
		}
	}

	/** The canonical configuration write; its receipt becomes the model. */
	async #mutate(operation: PromptProfileOperation): Promise<{ text: string }> {
		const receipt = await this.callbacks.onApply(operation);
		this.#model = { ...this.#model, ...receipt.configuration };
		// Creating or removing a profile changes which rows exist, so a filter
		// aimed at the old set would hide the result of the edit.
		if (operation.type === "createProfile" || operation.type === "removeProfile") {
			for (const screen of this.#screens) {
				if (screen.component instanceof SettingsList) screen.component.clearSearch();
			}
		}
		return { text: receipt.message };
	}
}
