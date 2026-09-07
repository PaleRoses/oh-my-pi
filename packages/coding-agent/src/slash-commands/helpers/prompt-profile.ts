import type {
	SystemPromptProfileAgentKind,
	SystemPromptProfileConstitution,
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "../../config/settings-schema";
import { createSystemPromptProfileResolver } from "../../system-prompt-profiles";
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SubcommandDef } from "../types";
import { commandConsumed, errorMessage } from "./parse";

export const PROMPT_PROFILE_RESTART_NOTICE =
	"Global config updated. Restart OMP to load the new prompt identity; /new keeps the current profile. Project and --config overrides still take precedence.";

export const PROMPT_PROFILE_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "status", description: "Show active identity, configured profiles, and routes" },
	{ name: "show", description: "Show every element of one profile", usage: "<profile>" },
	{ name: "use", description: "Route an agent kind to a profile", usage: "<profile> [main|sub]" },
	{ name: "unroute", description: "Remove the unconditional route for an agent kind", usage: "[main|sub]" },
	{
		name: "set",
		description: "Set one profile element; creates the profile when absent",
		usage: "<profile> <field> <value>",
	},
	{ name: "unset", description: "Restore one profile element to its default", usage: "<profile> <field>" },
	{ name: "remove", description: "Remove an unreferenced profile", usage: "<profile>" },
	{ name: "help", description: "Show prompt profile command usage" },
];

export type PromptProfileField = keyof SystemPromptProfileSetting;

export type PromptProfileFieldDefinition = { readonly label: string; readonly aliases?: readonly string[] } & (
	| { readonly field: "constitution"; readonly input: "constitution" }
	| {
			readonly field: "prompt" | "instructions";
			readonly input: "markdown";
			readonly file: "promptFile" | "instructionsFile";
	  }
	| { readonly field: "userTitle" | "compactionIdentity"; readonly input: "markdown" }
	| {
			readonly field: "promptFile" | "instructionsFile";
			readonly input: "file";
			readonly inline: "prompt" | "instructions";
	  }
	| {
			readonly field: "projectContextOnly" | "memory" | "mcpServerInstructions";
			readonly input: "toggle";
			readonly default: boolean;
	  }
	| { readonly field: "contextImages" | "tools"; readonly input: "list" }
);

export const PROMPT_PROFILE_FIELDS = {
	constitution: { field: "constitution", label: "Constitution", input: "constitution" },
	prompt: { field: "prompt", label: "Base prompt", input: "markdown", file: "promptFile" },
	promptFile: { field: "promptFile", label: "Base prompt file", input: "file", inline: "prompt" },
	instructions: {
		field: "instructions",
		label: "Appended instructions",
		input: "markdown",
		file: "instructionsFile",
		aliases: ["append"],
	},
	instructionsFile: {
		field: "instructionsFile",
		label: "Appended instructions file",
		input: "file",
		inline: "instructions",
		aliases: ["appendfile"],
	},
	projectContextOnly: {
		field: "projectContextOnly",
		label: "Project context only",
		input: "toggle",
		default: false,
		aliases: ["context"],
	},
	memory: { field: "memory", label: "Memory", input: "toggle", default: true },
	mcpServerInstructions: {
		field: "mcpServerInstructions",
		label: "MCP server instructions",
		input: "toggle",
		default: true,
		aliases: ["mcpinstructions"],
	},
	contextImages: { field: "contextImages", label: "Context images", input: "list", aliases: ["images"] },
	userTitle: { field: "userTitle", label: "User title", input: "markdown", aliases: ["user"] },
	compactionIdentity: {
		field: "compactionIdentity",
		label: "Compaction identity",
		input: "markdown",
		aliases: ["identity"],
	},
	tools: { field: "tools", label: "Tools", input: "list" },
} satisfies { [Field in PromptProfileField]: PromptProfileFieldDefinition & { readonly field: Field } };

export const PROMPT_PROFILE_FIELD_DEFINITIONS = (
	[
		"prompt",
		"instructions",
		"projectContextOnly",
		"memory",
		"mcpServerInstructions",
		"userTitle",
		"constitution",
	] as const
).map(field => PROMPT_PROFILE_FIELDS[field]);

export type PromptProfileSelectorFieldDefinition = (typeof PROMPT_PROFILE_FIELD_DEFINITIONS)[number];

const PROFILE_FIELD_NAMES = new Map(
	Object.values(PROMPT_PROFILE_FIELDS).flatMap(definition =>
		[definition.field, ...("aliases" in definition ? definition.aliases : [])].map(
			name => [name.toLowerCase(), definition.field] as const,
		),
	),
);

const PROMPT_USAGE = [
	"Prompt profile commands:",
	...PROMPT_PROFILE_SUBCOMMANDS.filter(command => command.name !== "help").map(
		command => "  /prompt " + command.name + (command.usage ? " " + command.usage : ""),
	),
	"",
	"Fields: " + Object.keys(PROMPT_PROFILE_FIELDS).join(", "),
].join("\n");

export type PromptProfileOperation =
	| { readonly type: "createProfile"; readonly profileId: string }
	| {
			readonly type: "setField";
			readonly profileId: string;
			readonly field: PromptProfileField;
			readonly value: string;
	  }
	| { readonly type: "restoreField"; readonly profileId: string; readonly field: PromptProfileField }
	| {
			readonly type: "assignRoute";
			readonly agentKind: SystemPromptProfileAgentKind;
			readonly profileId: string;
	  }
	| { readonly type: "clearRoute"; readonly agentKind: SystemPromptProfileAgentKind }
	| { readonly type: "removeProfile"; readonly profileId: string };

export interface PromptProfileConfiguration {
	readonly profiles: Record<string, SystemPromptProfileSetting>;
	readonly routes: readonly SystemPromptProfileRouteSetting[];
}

export interface PromptProfileUpdateReceipt {
	readonly configuration: PromptProfileConfiguration;
	readonly message: string;
	readonly restartNotice?: string;
}

export type PromptProfileConfigurationRuntime = Pick<SlashCommandRuntime, "cwd" | "settings" | "notifyConfigChanged">;

type PromptProfileCommandRuntime = PromptProfileConfigurationRuntime & Pick<SlashCommandRuntime, "session" | "output">;

function normalizeField(raw: string): PromptProfileField {
	const field = PROFILE_FIELD_NAMES.get(raw.replaceAll(/[-_]/g, "").toLowerCase());
	if (field === undefined) throw new Error(`Unknown profile field "${raw}".\n${PROMPT_USAGE}`);
	return field;
}

function parseAgentKind(raw: string | undefined, fallback: SystemPromptProfileAgentKind): SystemPromptProfileAgentKind {
	if (raw === undefined || raw === "") return fallback;
	const normalized = raw.toLowerCase();
	if (normalized === "main" || normalized === "sub") return normalized;
	throw new Error(`Agent kind must be main or sub, received "${raw}".`);
}

function parseToggle(raw: string, field: PromptProfileField): boolean {
	switch (raw.toLowerCase()) {
		case "true":
		case "on":
		case "yes":
		case "1":
			return true;
		case "false":
		case "off":
		case "no":
		case "0":
			return false;
		default:
			throw new Error(`${field} expects on or off, received "${raw}".`);
	}
}

function parseConstitution(raw: string): SystemPromptProfileConstitution {
	switch (raw.toLowerCase()) {
		case "fable":
			return "fable";
		default:
			throw new Error(`constitution expects fable, received "${raw}".`);
	}
}

function omitProfileField(profile: SystemPromptProfileSetting, field: PromptProfileField): SystemPromptProfileSetting {
	const next = { ...profile };
	delete next[field];
	return next;
}

function setProfileField(
	profile: SystemPromptProfileSetting,
	field: PromptProfileField,
	rawValue: string,
): SystemPromptProfileSetting {
	const value = rawValue.trim();
	if (value.length === 0) throw new Error(`${field} requires a non-empty value.`);
	const definition = PROMPT_PROFILE_FIELDS[field];
	const next = { ...profile };
	switch (definition.input) {
		case "constitution":
			next.constitution = parseConstitution(value);
			break;
		case "toggle":
			next[definition.field] = parseToggle(value, field);
			break;
		case "list":
			next[definition.field] = value
				.split(",")
				.map(entry => entry.trim())
				.filter(Boolean);
			break;
		case "markdown":
			if ("file" in definition) delete next[definition.file];
			next[definition.field] = value;
			break;
		case "file":
			delete next[definition.inline];
			next[definition.field] = value;
	}
	return next;
}

function describeInline(value: string | undefined): string {
	return value === undefined ? "none" : `inline (${value.length} chars)`;
}

function describeProfile(profileId: string, profile: SystemPromptProfileSetting): string {
	const base = profile.promptFile
		? `file ${profile.promptFile}`
		: profile.prompt
			? describeInline(profile.prompt)
			: "maintained";
	const appended = profile.instructionsFile
		? `file ${profile.instructionsFile}`
		: describeInline(profile.instructions);
	return `${profileId}: constitution=${profile.constitution ?? "none"}; base=${base}; append=${appended}; context=${profile.projectContextOnly ? "project" : "all"}; memory=${profile.memory === false ? "off" : "on"}; mcp=${profile.mcpServerInstructions === false ? "off" : "on"}; images=${profile.contextImages?.length ?? 0}; user=${profile.userTitle ?? "default"}; identity=${profile.compactionIdentity === undefined ? "default" : "set"}; tools=${profile.tools?.length ? profile.tools.join(",") : "all"}`;
}

function formatRoute(route: SystemPromptProfileRouteSetting, index: number): string {
	const selector = `${route.agentKind ?? "*"} · ${route.model ?? "*"}`;
	const target = route.deny === true ? `deny${route.reason ? ` (${route.reason})` : ""}` : route.profile;
	return `${index + 1}. ${selector} -> ${target}`;
}

function formatPromptStatus(runtime: PromptProfileCommandRuntime): string {
	const identity = runtime.session.effectiveIdentity;
	const profiles = runtime.settings.get("systemPromptProfiles");
	const routes = runtime.settings.get("systemPromptProfileRoutes");
	const profileLines = Object.entries(profiles)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([profileId, profile]) => `  ${describeProfile(profileId, profile)}`);
	const routeLines = routes.map((route, index) => `  ${formatRoute(route, index)}`);
	return [
		"System prompt profiles",
		`Active: role=${identity.role}; profile=${identity.prompt.profileId ?? "default"}; principal=${identity.prompt.principal}; source=${identity.prompt.source}`,
		"Profiles:",
		...(profileLines.length > 0 ? profileLines : ["  none"]),
		"Routes (first match wins):",
		...(routeLines.length > 0 ? routeLines : ["  none"]),
		"Use /prompt help for the compact mutation form.",
	].join("\n");
}

function formatProfileDetails(profileId: string, profile: SystemPromptProfileSetting): string {
	return [
		`System prompt profile: ${profileId}`,
		`constitution: ${profile.constitution ?? "none (default)"}`,
		`prompt: ${describeInline(profile.prompt)}`,
		`promptFile: ${profile.promptFile ?? "none"}`,
		`instructions: ${describeInline(profile.instructions)}`,
		`instructionsFile: ${profile.instructionsFile ?? "none"}`,
		`projectContextOnly: ${profile.projectContextOnly === true ? "on" : "off"}`,
		`memory: ${profile.memory === false ? "off" : "on (default)"}`,
		`mcpServerInstructions: ${profile.mcpServerInstructions === false ? "off" : "on (default)"}`,
		`contextImages: ${profile.contextImages?.length ? profile.contextImages.join(", ") : "none"}`,
		`userTitle: ${profile.userTitle ?? "the user (default)"}`,
		`compactionIdentity: ${profile.compactionIdentity ?? "none (generic summarizer prompt)"}`,
		`tools: ${profile.tools?.length ? profile.tools.join(", ") : "all (default)"}`,
	].join("\n");
}

type PromptConfigurationUpdate =
	| { readonly profiles: Record<string, SystemPromptProfileSetting>; readonly routes?: never }
	| { readonly profiles?: never; readonly routes: SystemPromptProfileRouteSetting[] };

async function persistConfiguration(
	runtime: PromptProfileConfigurationRuntime,
	update: PromptConfigurationUpdate,
	message: string,
): Promise<PromptProfileUpdateReceipt> {
	const profiles = update.profiles ?? runtime.settings.get("systemPromptProfiles");
	const routes = update.routes ?? runtime.settings.get("systemPromptProfileRoutes");
	await createSystemPromptProfileResolver({ profiles, routes, cwd: runtime.cwd });
	if (update.profiles !== undefined) {
		runtime.settings.set("systemPromptProfiles", update.profiles);
	} else {
		runtime.settings.set("systemPromptProfileRoutes", update.routes);
	}
	await runtime.settings.flush();
	await runtime.notifyConfigChanged?.();
	return {
		configuration: { profiles, routes },
		message,
		restartNotice: PROMPT_PROFILE_RESTART_NOTICE,
	};
}

function isUnconditionalProfileRoute(
	route: SystemPromptProfileRouteSetting,
	agentKind: SystemPromptProfileAgentKind,
): boolean {
	return route.deny !== true && route.agentKind === agentKind && route.model === undefined;
}

export async function applyPromptProfileOperation(
	runtime: PromptProfileConfigurationRuntime,
	operation: PromptProfileOperation,
): Promise<PromptProfileUpdateReceipt> {
	const profiles = runtime.settings.get("systemPromptProfiles");
	const routes = runtime.settings.get("systemPromptProfileRoutes");
	switch (operation.type) {
		case "createProfile": {
			if (Object.hasOwn(profiles, operation.profileId)) {
				throw new Error(`System prompt profile "${operation.profileId}" already exists.`);
			}
			return persistConfiguration(
				runtime,
				{ profiles: { ...profiles, [operation.profileId]: {} } },
				`Created system prompt profile ${operation.profileId}.`,
			);
		}
		case "setField": {
			const profile = Object.hasOwn(profiles, operation.profileId) ? profiles[operation.profileId] : {};
			const nextProfiles = {
				...profiles,
				[operation.profileId]: setProfileField(profile ?? {}, operation.field, operation.value),
			};
			return persistConfiguration(
				runtime,
				{ profiles: nextProfiles },
				`Saved ${operation.profileId}.${operation.field}.`,
			);
		}
		case "restoreField": {
			const profile = profiles[operation.profileId];
			if (!Object.hasOwn(profiles, operation.profileId) || profile === undefined) {
				throw new Error(`Unknown system prompt profile "${operation.profileId}".`);
			}
			return persistConfiguration(
				runtime,
				{
					profiles: {
						...profiles,
						[operation.profileId]: omitProfileField(profile, operation.field),
					},
				},
				`Restored ${operation.profileId}.${operation.field} to its default.`,
			);
		}
		case "assignRoute": {
			if (!Object.hasOwn(profiles, operation.profileId)) {
				throw new Error(`Unknown system prompt profile "${operation.profileId}".`);
			}
			return persistConfiguration(
				runtime,
				{
					routes: [
						{ agentKind: operation.agentKind, profile: operation.profileId },
						...routes.filter(route => !isUnconditionalProfileRoute(route, operation.agentKind)),
					],
				},
				`Set the global unconditional ${operation.agentKind} prompt route to ${operation.profileId}.`,
			);
		}
		case "clearRoute": {
			const nextRoutes = routes.filter(route => !isUnconditionalProfileRoute(route, operation.agentKind));
			if (nextRoutes.length === routes.length) {
				return {
					configuration: { profiles, routes },
					message: `No unconditional ${operation.agentKind} prompt route is configured.`,
				};
			}
			return persistConfiguration(
				runtime,
				{ routes: nextRoutes },
				`Removed the global unconditional ${operation.agentKind} prompt route.`,
			);
		}
		case "removeProfile": {
			if (!Object.hasOwn(profiles, operation.profileId)) {
				throw new Error(`Unknown system prompt profile "${operation.profileId}".`);
			}
			const referenced = routes.some(route => route.deny !== true && route.profile === operation.profileId);
			if (referenced)
				throw new Error(`System prompt profile "${operation.profileId}" is still referenced by a route.`);
			const nextProfiles = { ...profiles };
			delete nextProfiles[operation.profileId];
			return persistConfiguration(
				runtime,
				{ profiles: nextProfiles },
				`Removed system prompt profile ${operation.profileId}.`,
			);
		}
	}
}

async function outputUpdate(
	runtime: PromptProfileCommandRuntime,
	operation: PromptProfileOperation,
): Promise<SlashCommandResult> {
	const receipt = await applyPromptProfileOperation(runtime, operation);
	await runtime.output(
		receipt.restartNotice === undefined ? receipt.message : `${receipt.message}\n${receipt.restartNotice}`,
	);
	return commandConsumed();
}

async function outputMessage(runtime: PromptProfileCommandRuntime, message: string): Promise<SlashCommandResult> {
	await runtime.output(message);
	return commandConsumed();
}

async function handlePromptProfileCommandInner(
	command: ParsedSlashCommand,
	runtime: PromptProfileCommandRuntime,
): Promise<SlashCommandResult> {
	const [rawVerb, ...args] = parseCommandArgs(command.args);
	const [profileId, fieldOrKind, ...valueParts] = args;
	switch (rawVerb?.toLowerCase() ?? "status") {
		case "status":
		case "list":
			return outputMessage(runtime, formatPromptStatus(runtime));
		case "show": {
			if (!profileId || args.length !== 1) break;
			const profiles = runtime.settings.get("systemPromptProfiles");
			const profile = profiles[profileId];
			if (!Object.hasOwn(profiles, profileId) || profile === undefined)
				throw new Error(`Unknown system prompt profile "${profileId}".`);
			return outputMessage(runtime, formatProfileDetails(profileId, profile));
		}
		case "set":
			if (!profileId || !fieldOrKind || valueParts.length === 0) break;
			return outputUpdate(runtime, {
				type: "setField",
				profileId,
				field: normalizeField(fieldOrKind),
				value: valueParts.join(" "),
			});
		case "unset":
			if (!profileId || !fieldOrKind || args.length !== 2) break;
			return outputUpdate(runtime, { type: "restoreField", profileId, field: normalizeField(fieldOrKind) });
		case "use":
			if (!profileId || args.length > 2) break;
			return outputUpdate(runtime, {
				type: "assignRoute",
				profileId,
				agentKind: parseAgentKind(fieldOrKind, runtime.session.effectiveIdentity.role),
			});
		case "unroute":
			if (args.length > 1) break;
			return outputUpdate(runtime, {
				type: "clearRoute",
				agentKind: parseAgentKind(profileId, runtime.session.effectiveIdentity.role),
			});
		case "remove":
			if (!profileId || args.length !== 1) break;
			return outputUpdate(runtime, { type: "removeProfile", profileId });
	}
	return outputMessage(runtime, PROMPT_USAGE);
}

export async function handlePromptProfileCommand(
	command: ParsedSlashCommand,
	runtime: PromptProfileCommandRuntime,
): Promise<SlashCommandResult> {
	try {
		return await handlePromptProfileCommandInner(command, runtime);
	} catch (error) {
		return outputMessage(runtime, `Prompt profile error: ${errorMessage(error)}`);
	}
}
