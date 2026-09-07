import {
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	type SgrMouseEvent,
	Text,
	type TUI,
	wrapTextWithAnsi,
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
import { bottomBorder, divider, row, topBorder } from "./overlay-box";

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

/** Profile-derived rows; SettingsList owns navigation, filtering, and submenu lifetimes. */
export class IdentityHubComponent implements Component, Focusable {
	focused = false;
	#model: IdentityHubModel;
	#root: SettingsList;
	#busy = false;
	#notice: { text: string; error: boolean } | undefined;
	#input: Input | undefined;
	#terminalCursor = false;
	#contentY = 0;
	#contentRows = 0;

	constructor(
		private tui: TUI,
		model: IdentityHubModel,
		private callbacks: IdentityHubCallbacks,
	) {
		this.#model = model;
		this.#root = this.#settings(() => this.#items(), callbacks.onClose);
	}

	setUseTerminalCursor(enabled: boolean): void {
		this.#terminalCursor = enabled;
		this.#input?.setUseTerminalCursor(enabled);
	}

	pasteText(text: string): void {
		if (!this.#busy) this.#input?.pasteText(text);
	}

	render(width: number): readonly string[] {
		if (this.#input) this.#input.focused = this.focused;
		const identity = this.#model.identity;
		const out = [
			topBorder(width, "Identity"),
			row(
				theme.fg("dim", `Pinned: ${identity.profileId ?? "default"} · ${identity.role} · ${identity.principal}`),
				width,
			),
			row(
				theme.fg(
					"dim",
					"Restart OMP to apply · /new keeps this identity · global config (project/--config overrides win)",
				),
				width,
			),
		];
		const notice: string[] = [];
		if (this.#busy || this.#notice) {
			const text = this.#busy ? "Saving identity configuration…" : this.#notice!.text;
			const color = this.#notice?.error && !this.#busy ? "error" : "success";
			notice.push(
				...wrapTextWithAnsi(theme.fg(color, replaceTabs(text)), Math.max(1, width - 4))
					.slice(0, 3)
					.map(line => row(line, width)),
			);
		}
		this.#contentY = out.length;
		this.#contentRows = Math.max(3, this.tui.terminal.rows - out.length - notice.length - 3);
		const resize = (component: Component): void => {
			if (component instanceof SettingsList) {
				component.setMaxVisible(Math.max(3, this.#contentRows - 5));
				component.debugChildren.forEach(resize);
			} else if (component instanceof SelectList) component.setMaxVisible(Math.max(1, this.#contentRows - 1));
			else if (component instanceof Container) component.children.forEach(resize);
		};
		resize(this.#root);
		const body = this.#root.render(Math.max(1, width - 4));
		for (let i = 0; i < this.#contentRows; i++) out.push(row(body[i] ?? "", width));
		out.push(
			...notice,
			divider(width),
			row(
				theme.fg(
					"dim",
					this.#input
						? "Enter save · Esc cancel"
						: this.#root.hasOpenSubmenu()
							? "↑↓ navigate · Enter select · Esc back"
							: "Tab sections · ↑↓ navigate · Enter edit · type to search · Esc back/close",
				),
				width,
			),
			bottomBorder(width),
		);
		return out;
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				const line = event.row - this.#contentY;
				if (line >= 0 && line < this.#contentRows) this.#mouse(this.#root, event, line, event.col - 2);
				return true;
			});
		} else if (!this.#root.hasOpenSubmenu() && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			this.#root.toggleSectionFocus();
		} else this.#root.handleInput(data);
		this.callbacks.requestRender();
	}

	#mouse(list: SettingsList, event: SgrMouseEvent, line: number, col: number): void {
		if (list.hasOpenSubmenu()) {
			list.routeSubmenuMouse(event, line, col);
			return;
		}
		if (event.wheel !== null) {
			list.handleWheelAt(event.wheel, line, col);
			return;
		}
		const item = list.hoverTest(line, col);
		if (event.motion) list.setHoverItem(item ?? null);
		else if (event.leftClick) {
			const id = item ?? list.hitTest(line, col);
			if (id === undefined) return;
			const selected = list.getSelectedItem()?.id === id;
			list.selectItem(id);
			if (selected && item !== undefined) list.handleInput("\n");
		}
	}

	#settings(items: () => SettingItem[], close: () => void): SettingsList {
		const list = new SettingsList(
			items(),
			12,
			getSettingsListTheme(),
			(id, value) => {
				const [, profileId, field] = id.split(":"); // Validated profile IDs cannot contain colons.
				const operation: PromptProfileOperation =
					value === "default"
						? { type: "restoreField", profileId, field: field as PromptProfileField }
						: { type: "setField", profileId, field: field as PromptProfileField, value };
				void this.#apply(
					operation,
					() => list.setItems(items()),
					() => list.setItems(items()),
				);
			},
			close,
			{ hint: "", sidebarWidth: 19 },
		);
		return Object.assign(list, {
			routeMouse: (event: SgrMouseEvent, line: number, col: number) => this.#mouse(list, event, line, col),
		});
	}

	async #apply(
		operation: PromptProfileOperation | (() => Promise<PromptProfileOperation | undefined>),
		done: () => void,
		restore?: () => void,
	): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		this.#notice = undefined;
		this.callbacks.requestRender();
		try {
			const resolved = typeof operation === "function" ? await operation() : operation;
			if (resolved !== undefined) {
				const receipt = await this.callbacks.onApply(resolved);
				this.#model = { ...this.#model, ...receipt.configuration };
				this.#notice = { text: receipt.message, error: false };
				// Creating or removing a profile changes which rows exist, so a row
				// filter aimed at the old set would hide the result of the edit.
				if (resolved.type === "createProfile" || resolved.type === "removeProfile") this.#root.clearSearch();
				this.#root.setItems(this.#items());
				done();
			}
		} catch (error) {
			this.#notice = { text: errorMessage(error), error: true };
			this.#root.setItems(this.#items());
			restore?.();
		} finally {
			this.#busy = false;
			this.callbacks.requestRender();
		}
	}

	#items(): SettingItem[] {
		const ids = Object.keys(this.#model.profiles).sort();
		const items: SettingItem[] = [];
		for (const kind of ["main", "sub"] as const) {
			const assigned = this.#model.routes.find(route => isUnconditionalProfileRoute(route, kind));
			const profileId = assigned?.deny === true ? undefined : assigned?.profile;
			items.push(
				{ id: kind, label: kind === "main" ? "Main" : "Subagents", currentValue: "", heading: true },
				{
					id: `route:${kind}`,
					label: "Profile",
					currentValue: profileId ?? "No unconditional assignment",
					warning:
						"Assignment inserts a kind-wide rule first and can override model-specific or deny rules. Applies to future sessions.",
					submenu: (_value, done) =>
						this.#choices(
							[
								...ids.map(id => ({
									value: id,
									label: id,
									description: id === profileId ? "assigned" : undefined,
								})),
								{ value: "", label: "Clear assignment", description: "Let remaining ordered rules decide" },
							],
							value =>
								void this.#apply(
									value
										? { type: "assignRoute", agentKind: kind, profileId: value }
										: { type: "clearRoute", agentKind: kind },
									done,
								),
							done,
							profileId,
						),
				},
			);
			if (profileId !== undefined)
				items.push(...this.#fields(profileId, () => this.#root.setItems(this.#items()), kind));
		}
		items.push({ id: "profiles", label: "All profiles", currentValue: "", heading: true });
		items.push(
			...ids.map(id => ({
				id: `profile:${id}`,
				label: id,
				currentValue: id === this.#model.identity.profileId ? "Active session" : "Configured",
				submenu: (_value: string, done: () => void) => this.#profile(id, done),
			})),
		);
		items.push({
			id: "create",
			label: "Create profile",
			currentValue: "",
			submenu: (_value, done) =>
				this.#textInput(
					"",
					"Profile ID: letters, numbers, dot, dash, underscore.",
					value => ({ type: "createProfile", profileId: value }),
					done,
				),
		});
		items.push({ id: "routes", label: "Routing", currentValue: "", heading: true });
		items.push(
			...this.#model.routes.map((route, index) => ({
				id: `rule:${index}`,
				label: `${index + 1}`,
				currentValue: formatProfileRoute(route, index),
				description: "First matching rule wins. Model-qualified and deny rules are configured in config.yml.",
			})),
		);
		if (this.#model.routes.length === 0)
			items.push({
				id: "no-routes",
				label: "No routes",
				currentValue: "Maintained prompt",
				description: "No profile is selected unless an ordered route matches.",
			});
		return items;
	}

	#profile(profileId: string, close: () => void): SettingsList {
		const build = (): SettingItem[] => [
			...this.#fields(profileId, () => list.setItems(build())),
			{
				id: "remove",
				label: "Remove profile",
				currentValue: profileId,
				warning: "Referenced profiles cannot be removed; clear their routes first.",
				submenu: (_value, done) =>
					this.#choices(
						[{ value: "remove", label: "Remove permanently" }],
						() =>
							void this.#apply({ type: "removeProfile", profileId }, () => {
								done();
								close();
							}),
						done,
					),
			},
		];
		const list = this.#settings(build, close);
		return list;
	}

	#fields(profileId: string, refresh: () => void, prefix = "field"): SettingItem[] {
		const profile = this.#model.profiles[profileId] ?? {};
		return PROMPT_PROFILE_FIELD_DEFINITIONS.map(definition => {
			const value = profile[definition.field];
			const item: SettingItem = {
				id: `${prefix}:${profileId}:${definition.field}`,
				label: definition.label,
				currentValue: "default",
			};
			if (definition.input === "toggle") {
				item.currentValue = typeof value === "boolean" ? (value ? "on" : "off") : "default";
				item.values = ["default", "on", "off"];
				item.description = `Default: ${definition.default ? "on" : "off"}. Editing affects every future session routed to ${profileId}.`;
			} else if (definition.input === "constitution") {
				item.currentValue = profile.constitution ?? "default";
				item.values = ["default", "fable"];
			} else {
				const source = "file" in definition ? profile[definition.file] : undefined;
				item.currentValue =
					source !== undefined
						? shortenPath(source)
						: typeof value === "string"
							? `inline (${value.length} chars)`
							: definition.field === "prompt"
								? "Maintained prompt"
								: "Not configured";
				item.submenu = (_value, done) =>
					this.#markdown(profileId, definition, () => {
						refresh();
						done();
					});
			}
			return item;
		});
	}

	#markdown(profileId: string, definition: MarkdownField, done: () => void): Component {
		const profile = this.#model.profiles[profileId] ?? {};
		const source = "file" in definition ? profile[definition.file] : undefined;
		const content = profile[definition.field];
		const openPath =
			source ??
			(content === undefined && definition.field === "prompt" ? this.#model.maintainedPromptFile : undefined);
		const actions: SelectItem[] = [
			{
				value: "edit",
				label:
					openPath === undefined
						? "Edit inline Markdown"
						: source === undefined
							? "Open maintained Markdown"
							: "Open Markdown",
				description: openPath === undefined ? undefined : shortenPath(openPath),
			},
		];
		if ("file" in definition)
			actions.push({
				value: "path",
				label: source === undefined ? "Use Markdown file" : "Change Markdown file",
				description: "Existing file, relative to the session workspace or absolute",
			});
		if (source !== undefined || content !== undefined) actions.push({ value: "restore", label: "Restore default" });
		const menu = new Container();
		const picker = this.#choices(
			actions,
			choice => {
				if (choice === "path" && "file" in definition) {
					menu.clear();
					menu.addChild(
						this.#textInput(
							source ?? "",
							"Markdown file path",
							value => ({ type: "setField", profileId, field: definition.file, value }),
							done,
						),
					);
				} else if (choice === "restore") {
					void this.#apply(
						{
							type: "restoreField",
							profileId,
							field: source !== undefined && "file" in definition ? definition.file : definition.field,
						},
						done,
					);
				} else {
					void this.#apply(async () => {
						if (openPath !== undefined) {
							await this.callbacks.onOpenMarkdownFile(openPath);
							return;
						}
						const edited = await this.callbacks.onEditMarkdown(content ?? "");
						return edited == null
							? undefined
							: { type: "setField", profileId, field: definition.field, value: edited };
					}, done);
				}
			},
			done,
		);
		menu.addChild(picker);
		return Object.assign(menu, {
			handleInput: (data: string) => menu.children[0]?.handleInput?.(data),
			routeMouse: (event: SgrMouseEvent, line: number, col: number) => {
				if (menu.children[0] === picker) picker.routeMouse(event, line, col);
			},
		});
	}

	#choices(items: SelectItem[], select: (value: string) => void, close: () => void, current?: string): SelectList {
		const picker = new SelectList(items, 12, getSelectListTheme());
		const selected = items.findIndex(item => item.value === current);
		if (selected >= 0) picker.setSelectedIndex(selected);
		picker.onSelect = item => select(item.value);
		picker.onCancel = close;
		return picker;
	}

	#textInput(
		value: string,
		hint: string,
		operation: (value: string) => PromptProfileOperation,
		done: () => void,
	): Component {
		const input = new Input();
		input.setValue(value);
		input.setUseTerminalCursor(this.#terminalCursor);
		this.#input = input;
		const close = () => {
			this.#input = undefined;
			done();
		};
		input.onSubmit = text => void this.#apply(operation(text), close);
		input.onEscape = close;
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", hint), 0, 0));
		container.addChild(input);
		return Object.assign(container, { handleInput: (data: string) => input.handleInput(data) });
	}
}
