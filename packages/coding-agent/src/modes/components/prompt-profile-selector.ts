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

const PROMPT_PROFILE_FILE_DEFINITIONS = {
	prompt: { field: "promptFile", label: "Base prompt file", input: "file" },
	instructions: { field: "instructionsFile", label: "Appended instructions file", input: "file" },
} as const satisfies Record<"prompt" | "instructions", PromptProfileFileDefinition>;

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

type PromptProfileSelectorEvent =
	| { readonly type: "navigate"; readonly screen: PromptProfileSelectorScreen }
	| { readonly type: "operationStarted"; readonly screen: PromptProfileSelectorScreen }
	| { readonly type: "operationCancelled"; readonly screen: PromptProfileSelectorScreen }
	| {
			readonly type: "operationSucceeded";
			readonly receipt: PromptProfileUpdateReceipt;
			readonly screen: PromptProfileSelectorScreen;
	  }
	| { readonly type: "operationFailed"; readonly message: string };

interface SelectorAction {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly run: () => void;
}

function reducePromptProfileSelectorState(
	state: PromptProfileSelectorState,
	event: PromptProfileSelectorEvent,
): PromptProfileSelectorState {
	switch (event.type) {
		case "navigate":
			return { ...state, screen: event.screen, notice: undefined };
		case "operationStarted":
			return { ...state, screen: event.screen, notice: undefined, busy: true };
		case "operationCancelled":
			return { ...state, screen: event.screen, busy: false };
		case "operationSucceeded":
			return {
				model: { ...state.model, ...event.receipt.configuration },
				screen: event.screen,
				notice: {
					type: "success",
					message:
						event.receipt.restartNotice === undefined
							? event.receipt.message
							: `${event.receipt.message}\n${event.receipt.restartNotice}`,
				},
				busy: false,
			};
		case "operationFailed":
			return { ...state, notice: { type: "error", message: event.message }, busy: false };
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function profileFieldValue(
	profile: SystemPromptProfileSetting,
	field: PromptProfileField,
): string | boolean | readonly string[] | undefined {
	return profile[field];
}

function defaultToggleValue(field: PromptProfileField): boolean {
	return field !== "projectContextOnly";
}

function describeProfileField(profile: SystemPromptProfileSetting, field: PromptProfileField): string {
	const value = profileFieldValue(profile, field);
	switch (field) {
		case "prompt":
			return profile.promptFile !== undefined
				? shortenPath(profile.promptFile)
				: typeof value === "string"
					? `inline (${value.length} chars)`
					: "maintained prompt (default)";
		case "promptFile":
			return typeof value === "string" ? shortenPath(value) : "none";
		case "instructions":
			return profile.instructionsFile !== undefined
				? shortenPath(profile.instructionsFile)
				: typeof value === "string"
					? `inline (${value.length} chars)`
					: "none";
		case "instructionsFile":
			return typeof value === "string" ? shortenPath(value) : "none";
		case "projectContextOnly":
		case "memory":
		case "mcpServerInstructions":
			return typeof value === "boolean"
				? value
					? "on"
					: "off"
				: `${defaultToggleValue(field) ? "on" : "off"} (default)`;
		case "contextImages":
			return Array.isArray(value) && value.length > 0
				? value.map(entry => shortenPath(String(entry))).join(", ")
				: "none";
		case "userTitle":
			return typeof value === "string" ? value : "the user (default)";
		case "tools":
			return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : "all (default)";
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

	render(width: number): readonly string[] {
		if (this.#interactive instanceof Input) this.#interactive.focused = this.focused;
		return super.render(width);
	}

	handleInput(data: string): void {
		if (!this.#state.busy) this.#interactive?.handleInput(data);
	}

	pasteText(text: string): void {
		if (!this.#state.busy && this.#interactive instanceof Input) this.#interactive.pasteText(text);
	}

	#dispatch(event: PromptProfileSelectorEvent): void {
		this.#state = reducePromptProfileSelectorState(this.#state, event);
		this.#renderState();
		this.#callbacks.requestRender();
	}

	#navigate(screen: PromptProfileSelectorScreen): void {
		this.#dispatch({ type: "navigate", screen });
	}

	async #apply(
		operation: PromptProfileOperation,
		successScreen: PromptProfileSelectorScreen,
		pendingScreen = this.#state.screen,
	): Promise<void> {
		this.#dispatch({ type: "operationStarted", screen: pendingScreen });
		try {
			const receipt = await this.#callbacks.onApply(operation);
			this.#dispatch({ type: "operationSucceeded", receipt, screen: successScreen });
		} catch (error) {
			this.#dispatch({ type: "operationFailed", message: errorText(error) });
		}
	}

	async #editAndApply(
		screen: Extract<PromptProfileSelectorScreen, { type: "field" }>,
		edit: () => Promise<PromptProfileOperation | undefined>,
	): Promise<void> {
		this.#dispatch({ type: "operationStarted", screen });
		try {
			const operation = await edit();
			if (operation === undefined) {
				this.#dispatch({ type: "operationCancelled", screen });
				return;
			}
			const receipt = await this.#callbacks.onApply(operation);
			this.#dispatch({
				type: "operationSucceeded",
				receipt,
				screen: { type: "profile", profileId: screen.profileId },
			});
		} catch (error) {
			this.#dispatch({ type: "operationFailed", message: errorText(error) });
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
				return this.#pathInput(this.#state.screen);
			case "create":
				return this.#createInput(this.#state.screen.value);
			case "route":
				return [this.#routeSelector(this.#state.screen.agentKind)];
			case "remove":
				return [this.#removeSelector(this.#state.screen.profileId)];
		}
	}

	#homeSelector(): SelectList {
		const profileActions = sortedProfileIds(this.#state.model).map<SelectorAction>(profileId => ({
			id: `profile:${profileId}`,
			label: profileId,
			description: profileDescription(this.#state.model, profileId),
			run: () => this.#navigate({ type: "profile", profileId }),
		}));
		return this.#actionSelector(
			[
				...profileActions,
				{
					id: "create",
					label: "Create profile",
					description: "Add a validated profile",
					run: () => this.#navigate({ type: "create", value: "" }),
				},
				{
					id: "route:main",
					label: "Main route",
					description: unconditionalRouteProfile(this.#state.model.routes, "main") ?? "default prompt",
					run: () => this.#navigate({ type: "route", agentKind: "main" }),
				},
				{
					id: "route:sub",
					label: "Subagent route",
					description: unconditionalRouteProfile(this.#state.model.routes, "sub") ?? "default prompt",
					run: () => this.#navigate({ type: "route", agentKind: "sub" }),
				},
				{ id: "close", label: "Close", run: this.#callbacks.onClose },
			],
			this.#callbacks.onClose,
		);
	}

	#profileSelector(profileId: string): SelectList {
		const profile = this.#state.model.profiles[profileId] ?? {};
		const fieldActions = PROMPT_PROFILE_FIELD_DEFINITIONS.map<SelectorAction>(definition => ({
			id: `field:${definition.field}`,
			label: definition.label,
			description: describeProfileField(profile, definition.field),
			run: () => this.#navigate({ type: "field", profileId, definition }),
		}));
		return this.#actionSelector(
			[
				...fieldActions,
				{
					id: "remove",
					label: "Remove profile",
					description: isProfileReferenced(this.#state.model, profileId)
						? "Referenced by a route; clear routes first"
						: "Requires confirmation",
					run: () => this.#navigate({ type: "remove", profileId }),
				},
				{
					id: "back",
					label: "Back",
					run: () => this.#navigate({ type: "home" }),
				},
			],
			() => this.#navigate({ type: "home" }),
		);
	}

	#fieldSelector(profileId: string, definition: PromptProfileSelectorFieldDefinition): SelectList {
		const profile = this.#state.model.profiles[profileId] ?? {};
		const back = () => this.#navigate({ type: "profile", profileId });
		const fieldScreen = { type: "field", profileId, definition } as const;
		const restore = (field: PromptProfileField): SelectorAction => ({
			id: "restore",
			label: "Restore default",
			description: "Remove the configured value",
			run: () => {
				void this.#apply({ type: "restoreField", profileId, field }, { type: "profile", profileId });
			},
		});
		switch (definition.input) {
			case "markdown": {
				const fileDefinition =
					definition.field === "userTitle" ? undefined : PROMPT_PROFILE_FILE_DEFINITIONS[definition.field];
				const source = fileDefinition === undefined ? undefined : profile[fileDefinition.field];
				const content = profile[definition.field];
				const maintainedPromptFile = this.#state.model.maintainedPromptFile;
				const configuredField =
					source !== undefined && fileDefinition !== undefined
						? fileDefinition.field
						: content !== undefined
							? definition.field
							: undefined;
				const openAction: SelectorAction[] =
					source !== undefined
						? [
								{
									id: "open",
									label: "Open Markdown",
									description: shortenPath(source),
									run: () => {
										void this.#editAndApply(fieldScreen, async () => {
											await this.#callbacks.onOpenMarkdownFile(source);
											return undefined;
										});
									},
								},
							]
						: content !== undefined || fileDefinition === undefined
							? [
									{
										id: "open",
										label: "Open inline Markdown editor",
										description:
											content === undefined
												? "Not configured"
												: `Stored in global config (${content.length} chars)`,
										run: () => {
											void this.#editAndApply(fieldScreen, async () => {
												const edited = await this.#callbacks.onEditMarkdown(content ?? "");
												if (edited === null || edited === undefined) return undefined;
												return { type: "setField", profileId, field: definition.field, value: edited };
											});
										},
									},
								]
							: definition.field === "prompt" && maintainedPromptFile !== undefined
								? [
										{
											id: "open",
											label: "Open maintained Markdown",
											description: shortenPath(maintainedPromptFile),
											run: () => {
												void this.#editAndApply(fieldScreen, async () => {
													await this.#callbacks.onOpenMarkdownFile(maintainedPromptFile);
													return undefined;
												});
											},
										},
									]
								: [];
				const pathAction: SelectorAction[] =
					fileDefinition === undefined
						? []
						: [
								{
									id: "path",
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
								},
							];
				return this.#actionSelector(
					[
						...openAction,
						...pathAction,
						...(configuredField === undefined ? [] : [restore(configuredField)]),
						{ id: "back", label: "Back", run: back },
					],
					back,
				);
			}
			case "toggle":
				return this.#actionSelector(
					[
						{
							id: "on",
							label: "On",
							run: () => {
								void this.#apply(
									{ type: "setField", profileId, field: definition.field, value: "on" },
									{ type: "profile", profileId },
								);
							},
						},
						{
							id: "off",
							label: "Off",
							run: () => {
								void this.#apply(
									{ type: "setField", profileId, field: definition.field, value: "off" },
									{ type: "profile", profileId },
								);
							},
						},
						restore(definition.field),
						{ id: "back", label: "Back", run: back },
					],
					back,
				);
		}
	}

	#pathInput(screen: Extract<PromptProfileSelectorScreen, { type: "editPath" }>): Component[] {
		const input = new Input();
		input.setValue(screen.value);
		input.setUseTerminalCursor(this.#useTerminalCursor);
		input.onSubmit = value => {
			void this.#apply(
				{ type: "setField", profileId: screen.profileId, field: screen.definition.field, value },
				{ type: "profile", profileId: screen.profileId },
				{ ...screen, value },
			);
		};
		input.onEscape = () => this.#navigate({ type: "field", profileId: screen.profileId, definition: screen.owner });
		this.#interactive = input;
		return [
			new Text(
				theme.fg("dim", "Enter the Markdown file path. Relative paths resolve from the working directory."),
				1,
				0,
			),
			new Spacer(1),
			input,
		];
	}

	#createInput(value: string): Component[] {
		const input = new Input();
		input.setValue(value);
		input.setUseTerminalCursor(this.#useTerminalCursor);
		input.onSubmit = profileId => {
			void this.#apply(
				{ type: "createProfile", profileId },
				{ type: "profile", profileId },
				{ type: "create", value: profileId },
			);
		};
		input.onEscape = () => this.#navigate({ type: "home" });
		this.#interactive = input;
		return [new Text(theme.fg("dim", "Letters, numbers, dot, dash, and underscore."), 1, 0), new Spacer(1), input];
	}

	#routeSelector(agentKind: SystemPromptProfileAgentKind): SelectList {
		const currentProfile = unconditionalRouteProfile(this.#state.model.routes, agentKind);
		const back = () => this.#navigate({ type: "home" });
		const profileActions = sortedProfileIds(this.#state.model).map<SelectorAction>(profileId => ({
			id: `profile:${profileId}`,
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
					id: "clear",
					label: "Clear route",
					description: "Use the default prompt when no specific route matches",
					run: () => {
						void this.#apply({ type: "clearRoute", agentKind }, { type: "home" });
					},
				},
				{ id: "back", label: "Back", run: back },
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
					id: "remove",
					label: "Remove permanently",
					description: "Only unreferenced profiles can be removed",
					run: () => {
						void this.#apply({ type: "removeProfile", profileId }, { type: "home" });
					},
				},
				{ id: "cancel", label: "Cancel", run: back },
			],
			back,
		);
	}

	#actionSelector(actions: readonly SelectorAction[], onCancel: () => void, selectedId?: string): SelectList {
		const items: SelectItem[] = actions.map(action => ({
			value: action.id,
			label: action.label,
			description: action.description,
		}));
		const selector = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
		const selectedIndex =
			selectedId === undefined ? -1 : actions.findIndex(action => action.id === `profile:${selectedId}`);
		if (selectedIndex >= 0) selector.setSelectedIndex(selectedIndex);
		selector.onSelect = item => actions.find(action => action.id === item.value)?.run();
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
