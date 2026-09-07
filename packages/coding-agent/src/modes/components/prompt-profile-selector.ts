import { errorMessage } from "../../slash-commands/helpers/parse";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	replaceTabs,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@oh-my-pi/pi-tui";
import type {
	SystemPromptProfileAgentKind,
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "../../config/settings-schema";
import {
	PROMPT_PROFILE_FIELD_DEFINITIONS,
	PROMPT_PROFILE_FIELDS,
	type PromptProfileConfiguration,
	type PromptProfileField,
	type PromptProfileFieldDefinition,
	type PromptProfileOperation,
	type PromptProfileSelectorFieldDefinition,
	type PromptProfileUpdateReceipt,
} from "../../slash-commands/helpers/prompt-profile";
import { shortenPath } from "../../tools/render-utils";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface PromptProfileSelectorIdentity {
	readonly role: SystemPromptProfileAgentKind;
	readonly profileId: string | undefined;
	readonly principal: string;
	readonly source: string;
}

export interface PromptProfileSelectorModel extends PromptProfileConfiguration {
	readonly identity: PromptProfileSelectorIdentity;
	readonly maintainedPromptFile?: string;
}

export interface PromptProfileSelectorCallbacks {
	readonly onApply: (operation: PromptProfileOperation) => Promise<PromptProfileUpdateReceipt>;
	readonly onEditMarkdown: (content: string) => Promise<string | null | undefined>;
	readonly onOpenMarkdownFile: (source: string) => Promise<boolean | undefined>;
	readonly onClose: () => void;
	readonly requestRender: () => void;
}

type PromptProfileFileDefinition = Extract<PromptProfileFieldDefinition, { readonly input: "file" }>;
type PromptProfileMarkdownDefinition = Extract<PromptProfileSelectorFieldDefinition, { readonly input: "markdown" }>;

type PromptProfileSelectorScreen =
	| { readonly type: "home" }
	| { readonly type: "profile"; readonly profileId: string }
	| { readonly type: "field"; readonly profileId: string; readonly definition: PromptProfileSelectorFieldDefinition }
	| {
			readonly type: "editPath";
			readonly profileId: string;
			readonly definition: PromptProfileFileDefinition;
			readonly owner: PromptProfileMarkdownDefinition;
			readonly value: string;
	  }
	| { readonly type: "create"; readonly value: string }
	| { readonly type: "route"; readonly agentKind: SystemPromptProfileAgentKind }
	| { readonly type: "remove"; readonly profileId: string };

type PromptProfileSelectorNotice =
	| { readonly type: "success"; readonly message: string }
	| { readonly type: "error"; readonly message: string };

interface PromptProfileSelectorState {
	readonly model: PromptProfileSelectorModel;
	readonly screen: PromptProfileSelectorScreen;
	readonly notice: PromptProfileSelectorNotice | undefined;
	readonly busy: boolean;
}

interface SelectorAction extends SelectItem {
	readonly run: () => void;
}

function describeProfileField(
	profile: SystemPromptProfileSetting,
	definition: PromptProfileSelectorFieldDefinition,
): string {
	const value = profile[definition.field];
	switch (definition.input) {
		case "constitution":
			return profile.constitution === undefined ? "none (default)" : "Fable";
		case "toggle":
			return typeof value === "boolean" ? (value ? "on" : "off") : `${definition.default ? "on" : "off"} (default)`;
		case "markdown": {
			const source = "file" in definition ? profile[definition.file] : undefined;
			if (source !== undefined) return shortenPath(source);
			if (definition.field === "userTitle") return profile.userTitle ?? "the user (default)";
			return typeof value === "string"
				? `inline (${value.length} chars)`
				: definition.field === "prompt"
					? "maintained prompt (default)"
					: "none";
		}
	}
}

function unconditionalRouteProfile(
	routes: readonly SystemPromptProfileRouteSetting[],
	agentKind: SystemPromptProfileAgentKind,
): string | undefined {
	const route = routes.find(
		candidate => candidate.deny !== true && candidate.agentKind === agentKind && candidate.model === undefined,
	);
	return route?.deny === true ? undefined : route?.profile;
}

function profileRouteLabels(model: PromptProfileSelectorModel, profileId: string): string[] {
	return (["main", "sub"] as const)
		.filter(agentKind => unconditionalRouteProfile(model.routes, agentKind) === profileId)
		.map(agentKind => `${agentKind} route`);
}

function profileDescription(model: PromptProfileSelectorModel, profileId: string): string {
	const labels = [
		...(model.identity.profileId === profileId ? ["active session"] : []),
		...profileRouteLabels(model, profileId),
	];
	return labels.length === 0 ? "configured" : labels.join(", ");
}

function sortedProfileIds(model: PromptProfileSelectorModel): string[] {
	return Object.keys(model.profiles).sort((left, right) => {
		if (left === model.identity.profileId) return -1;
		if (right === model.identity.profileId) return 1;
		return left.localeCompare(right);
	});
}

function isProfileReferenced(model: PromptProfileSelectorModel, profileId: string): boolean {
	return model.routes.some(route => route.deny !== true && route.profile === profileId);
}

export class PromptProfileSelectorComponent extends Container implements Focusable {
	focused = false;
	#state: PromptProfileSelectorState;
	#interactive: SelectList | Input | undefined;
	#useTerminalCursor = false;
	#callbacks: PromptProfileSelectorCallbacks;

	constructor(model: PromptProfileSelectorModel, callbacks: PromptProfileSelectorCallbacks) {
		super();
		this.#callbacks = callbacks;
		this.#state = { model, screen: { type: "home" }, notice: undefined, busy: false };
		this.#renderState();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
		if (this.#interactive instanceof Input) this.#interactive.setUseTerminalCursor(useTerminalCursor);
	}

	override render(width: number): readonly string[] {
		if (this.#interactive instanceof Input) this.#interactive.focused = this.focused;
		return super.render(width);
	}

	handleInput(data: string): void {
		if (!this.#state.busy) this.#interactive?.handleInput(data);
	}

	pasteText(text: string): void {
		if (!this.#state.busy && this.#interactive instanceof Input) this.#interactive.pasteText(text);
	}

	#refresh(): void {
		this.#renderState();
		this.#callbacks.requestRender();
	}

	#navigate(screen: PromptProfileSelectorScreen): void {
		this.#state = { ...this.#state, screen, notice: undefined };
		this.#refresh();
	}
	async #apply(
		operation: PromptProfileOperation | (() => Promise<PromptProfileOperation | undefined>),
		successScreen: PromptProfileSelectorScreen,
		pendingScreen = this.#state.screen,
	): Promise<void> {
		this.#state = { ...this.#state, screen: pendingScreen, notice: undefined, busy: true };
		this.#refresh();
		try {
			const resolved = typeof operation === "function" ? await operation() : operation;
			if (resolved === undefined) {
				this.#state = { ...this.#state, screen: pendingScreen, busy: false };
			} else {
				const receipt = await this.#callbacks.onApply(resolved);
				this.#state = {
					model: { ...this.#state.model, ...receipt.configuration },
					screen: successScreen,
					notice: {
						type: "success",
						message:
							receipt.restartNotice === undefined
								? receipt.message
								: `${receipt.message}\n${receipt.restartNotice}`,
					},
					busy: false,
				};
			}
			this.#refresh();
		} catch (error) {
			this.#state = { ...this.#state, notice: { type: "error", message: errorMessage(error) }, busy: false };
			this.#refresh();
		}
	}

	#renderState(): void {
		this.clear();
		this.#interactive = undefined;
		[
			new DynamicBorder(),
			new Text(theme.fg("accent", this.#title()), 1, 0),
			...this.#identityLines(),
			...this.#noticeLines(),
			new Spacer(1),
			...(this.#state.busy
				? [new Text(theme.fg("dim", "Saving prompt profile configuration..."), 1, 0)]
				: this.#screenComponents()),
			new Spacer(1),
			new Text(theme.fg("dim", this.#footer()), 1, 0),
			new DynamicBorder(),
		].forEach(component => {
			this.addChild(component);
		});
	}

	#title(): string {
		switch (this.#state.screen.type) {
			case "home":
				return "System prompt profiles";
			case "profile":
				return `Profile: ${this.#state.screen.profileId}`;
			case "field":
				return `${this.#state.screen.profileId}: ${this.#state.screen.definition.label}`;
			case "editPath":
				return `${this.#state.screen.profileId}: ${this.#state.screen.owner.label}`;
			case "create":
				return "Create system prompt profile";
			case "route":
				return `${this.#state.screen.agentKind === "main" ? "Main" : "Subagent"} unconditional route`;
			case "remove":
				return `Remove profile: ${this.#state.screen.profileId}`;
		}
	}

	#identityLines(): Component[] {
		if (this.#state.screen.type !== "home") return [];
		const identity = this.#state.model.identity;
		return [
			new Text(
				theme.fg(
					"dim",
					`Active: ${identity.role} · ${identity.profileId ?? "default"} · ${identity.principal} (${identity.source})`,
				),
				1,
				0,
			),
		];
	}

	#noticeLines(): Component[] {
		const notice = this.#state.notice;
		if (notice === undefined) return [];
		return [
			new Spacer(1),
			new Text(theme.fg(notice.type === "error" ? "error" : "success", replaceTabs(notice.message)), 1, 0),
		];
	}

	#screenComponents(): Component[] {
		switch (this.#state.screen.type) {
			case "home":
				return [this.#homeSelector()];
			case "profile":
				return [this.#profileSelector(this.#state.screen.profileId)];
			case "field":
				return [this.#fieldSelector(this.#state.screen.profileId, this.#state.screen.definition)];
			case "editPath":
			case "create":
				return this.#inputScreen(this.#state.screen);
			case "route":
				return [this.#routeSelector(this.#state.screen.agentKind)];
			case "remove":
				return [this.#removeSelector(this.#state.screen.profileId)];
		}
	}

	#homeSelector(): SelectList {
		const profileActions = sortedProfileIds(this.#state.model).map<SelectorAction>(profileId => ({
			value: `profile:${profileId}`,
			label: profileId,
			description: profileDescription(this.#state.model, profileId),
			run: () => this.#navigate({ type: "profile", profileId }),
		}));
		return this.#actionSelector(
			[
				...profileActions,
				{
					value: "create",
					label: "Create profile",
					description: "Add a validated profile",
					run: () => this.#navigate({ type: "create", value: "" }),
				},
				{
					value: "route:main",
					label: "Main route",
					description: unconditionalRouteProfile(this.#state.model.routes, "main") ?? "default prompt",
					run: () => this.#navigate({ type: "route", agentKind: "main" }),
				},
				{
					value: "route:sub",
					label: "Subagent route",
					description: unconditionalRouteProfile(this.#state.model.routes, "sub") ?? "default prompt",
					run: () => this.#navigate({ type: "route", agentKind: "sub" }),
				},
				{ value: "close", label: "Close", run: this.#callbacks.onClose },
			],
			this.#callbacks.onClose,
		);
	}

	#profileSelector(profileId: string): SelectList {
		const profile = this.#state.model.profiles[profileId] ?? {};
		const fieldActions = PROMPT_PROFILE_FIELD_DEFINITIONS.map<SelectorAction>(definition => ({
			value: `field:${definition.field}`,
			label: definition.label,
			description: describeProfileField(profile, definition),
			run: () => this.#navigate({ type: "field", profileId, definition }),
		}));
		return this.#actionSelector(
			[
				...fieldActions,
				{
					value: "remove",
					label: "Remove profile",
					description: isProfileReferenced(this.#state.model, profileId)
						? "Referenced by a route; clear routes first"
						: "Requires confirmation",
					run: () => this.#navigate({ type: "remove", profileId }),
				},
				{ value: "back", label: "Back", run: () => this.#navigate({ type: "home" }) },
			],
			() => this.#navigate({ type: "home" }),
		);
	}

	#fieldSelector(profileId: string, definition: PromptProfileSelectorFieldDefinition): SelectList {
		const profile = this.#state.model.profiles[profileId] ?? {};
		const profileScreen = { type: "profile", profileId } as const;
		const fieldScreen = { type: "field", profileId, definition } as const;
		const back = () => this.#navigate(profileScreen);
		const save = (value: string) => {
			void this.#apply({ type: "setField", profileId, field: definition.field, value }, profileScreen);
		};
		const actions: SelectorAction[] = [];
		let configuredField: PromptProfileField | undefined = definition.field;
		switch (definition.input) {
			case "constitution":
				actions.push({
					value: "constitution:fable",
					label: "Fable",
					description: "Use the Fable worker constitution",
					run: () => save("fable"),
				});
				break;
			case "toggle":
				actions.push(
					...["on", "off"].map(value => ({
						value: value,
						label: value === "on" ? "On" : "Off",
						run: () => save(value),
					})),
				);
				break;
			case "markdown": {
				const fileDefinition = "file" in definition ? PROMPT_PROFILE_FIELDS[definition.file] : undefined;
				const source = fileDefinition === undefined ? undefined : profile[fileDefinition.field];
				const content = profile[definition.field];
				configuredField =
					source !== undefined && fileDefinition !== undefined
						? fileDefinition.field
						: content !== undefined
							? definition.field
							: undefined;
				const openPath =
					source ??
					(content === undefined && definition.field === "prompt"
						? this.#state.model.maintainedPromptFile
						: undefined);
				if (openPath !== undefined) {
					actions.push({
						value: "open",
						label: source === undefined ? "Open maintained Markdown" : "Open Markdown",
						description: shortenPath(openPath),
						run: () => {
							void this.#apply(
								async () => {
									await this.#callbacks.onOpenMarkdownFile(openPath);
									return undefined;
								},
								profileScreen,
								fieldScreen,
							);
						},
					});
				} else if (content !== undefined || fileDefinition === undefined) {
					actions.push({
						value: "open",
						label: "Open inline Markdown editor",
						description:
							content === undefined ? "Not configured" : `Stored in global config (${content.length} chars)`,
						run: () => {
							void this.#apply(
								async () => {
									const edited = await this.#callbacks.onEditMarkdown(content ?? "");
									return edited == null
										? undefined
										: { type: "setField", profileId, field: definition.field, value: edited };
								},
								profileScreen,
								fieldScreen,
							);
						},
					});
				}
				if (fileDefinition !== undefined) {
					actions.push({
						value: "path",
						label: source === undefined ? "Use Markdown file" : "Change file path",
						description: source === undefined ? "Configure an existing Markdown file" : shortenPath(source),
						run: () =>
							this.#navigate({
								type: "editPath",
								profileId,
								definition: fileDefinition,
								owner: definition,
								value: source ?? "",
							}),
					});
				}
				break;
			}
		}
		if (configuredField !== undefined) {
			const field = configuredField;
			actions.push({
				value: "restore",
				label: "Restore default",
				description: "Remove the configured value",
				run: () => {
					void this.#apply({ type: "restoreField", profileId, field }, profileScreen);
				},
			});
		}
		return this.#actionSelector([...actions, { value: "back", label: "Back", run: back }], back);
	}

	#inputScreen(screen: Extract<PromptProfileSelectorScreen, { type: "editPath" | "create" }>): Component[] {
		const input = new Input();
		input.setValue(screen.value);
		input.setUseTerminalCursor(this.#useTerminalCursor);
		input.onSubmit = value => {
			const operation: PromptProfileOperation =
				screen.type === "create"
					? { type: "createProfile", profileId: value }
					: { type: "setField", profileId: screen.profileId, field: screen.definition.field, value };
			void this.#apply(operation, { type: "profile", profileId: operation.profileId }, { ...screen, value });
		};
		input.onEscape = () =>
			this.#navigate(
				screen.type === "create"
					? { type: "home" }
					: { type: "field", profileId: screen.profileId, definition: screen.owner },
			);
		this.#interactive = input;
		const hint =
			screen.type === "create"
				? "Letters, numbers, dot, dash, and underscore."
				: "Enter the Markdown file path. Relative paths resolve from the working directory.";
		return [new Text(theme.fg("dim", hint), 1, 0), new Spacer(1), input];
	}

	#routeSelector(agentKind: SystemPromptProfileAgentKind): SelectList {
		const currentProfile = unconditionalRouteProfile(this.#state.model.routes, agentKind);
		const back = () => this.#navigate({ type: "home" });
		const profileActions = sortedProfileIds(this.#state.model).map<SelectorAction>(profileId => ({
			value: `profile:${profileId}`,
			label: profileId,
			description: profileId === currentProfile ? "current route" : undefined,
			run: () => {
				void this.#apply({ type: "assignRoute", agentKind, profileId }, { type: "home" });
			},
		}));
		return this.#actionSelector(
			[
				...profileActions,
				{
					value: "clear",
					label: "Clear route",
					description: "Use the default prompt when no specific route matches",
					run: () => {
						void this.#apply({ type: "clearRoute", agentKind }, { type: "home" });
					},
				},
				{ value: "back", label: "Back", run: back },
			],
			back,
			currentProfile,
		);
	}

	#removeSelector(profileId: string): SelectList {
		const back = () => this.#navigate({ type: "profile", profileId });
		return this.#actionSelector(
			[
				{
					value: "remove",
					label: "Remove permanently",
					description: "Only unreferenced profiles can be removed",
					run: () => {
						void this.#apply({ type: "removeProfile", profileId }, { type: "home" });
					},
				},
				{ value: "cancel", label: "Cancel", run: back },
			],
			back,
		);
	}

	#actionSelector(actions: readonly SelectorAction[], onCancel: () => void, selectedId?: string): SelectList {
		const selector = new SelectList(actions, Math.min(Math.max(actions.length, 1), 12), getSelectListTheme());
		const selectedIndex =
			selectedId === undefined ? -1 : actions.findIndex(action => action.value === `profile:${selectedId}`);
		if (selectedIndex >= 0) selector.setSelectedIndex(selectedIndex);
		selector.onSelect = item => actions.find(action => action.value === item.value)?.run();
		selector.onCancel = onCancel;
		this.#interactive = selector;
		return selector;
	}

	#footer(): string {
		if (this.#state.busy) return "saving...";
		switch (this.#state.screen.type) {
			case "home":
				return "↑↓ navigate  enter select  esc close";
			case "editPath":
			case "create":
				return "enter save  esc back";
			default:
				return "↑↓ navigate  enter select  esc back";
		}
	}
}
