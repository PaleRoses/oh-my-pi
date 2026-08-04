import type {
	SystemPromptProfileAgentKind,
	SystemPromptProfileRouteSetting,
	SystemPromptProfileSetting,
} from "../../config/settings-schema";
import { createSystemPromptProfileResolver } from "../../system-prompt-profiles";
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SubcommandDef } from "../types";
import { commandConsumed, errorMessage } from "./parse";

export const PROMPT_PROFILE_RESTART_NOTICE =
	"Global config updated. Restart OMP to load the new prompt identity; /new keeps the current profile. Project and --config overrides still take precedence.";
const PROMPT_USAGE = [
	"Prompt profile commands:",
	"  /prompt status",
	"  /prompt show <profile>",
	"  /prompt use <profile> [main|sub]",
	"  /prompt unroute [main|sub]",
	"  /prompt set <profile> <field> <value>",
	"  /prompt unset <profile> <field>",
	"  /prompt remove <profile>",
	"",
	"Fields: prompt, promptFile, instructions, instructionsFile, projectContextOnly, memory, mcpServerInstructions",
].join("\n");

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

export type PromptProfileFieldDefinition =
	| {
			readonly field: "prompt" | "instructions";
			readonly label: string;
			readonly input: "markdown";
	  }
	| {
			readonly field: "promptFile" | "instructionsFile";
			readonly label: string;
			readonly input: "file";
	  }
	| {
			readonly field: "projectContextOnly" | "memory" | "mcpServerInstructions";
			readonly label: string;
			readonly input: "toggle";
	  };

export const PROMPT_PROFILE_FIELD_DEFINITIONS: readonly PromptProfileFieldDefinition[] = [
	{ field: "prompt", label: "Base prompt", input: "markdown" },
	{ field: "promptFile", label: "Base prompt file", input: "file" },
	{ field: "instructions", label: "Appended instructions", input: "markdown" },
	{ field: "instructionsFile", label: "Appended instructions file", input: "file" },
	{ field: "projectContextOnly", label: "Project context only", input: "toggle" },
	{ field: "memory", label: "Memory", input: "toggle" },
	{ field: "mcpServerInstructions", label: "MCP server instructions", input: "toggle" },
];

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
	const normalized = raw.replaceAll(/[-_]/g, "").toLowerCase();
	switch (normalized) {
		case "prompt":
			return "prompt";
		case "promptfile":
			return "promptFile";
		case "instructions":
		case "append":
			return "instructions";
		case "instructionsfile":
		case "appendfile":
			return "instructionsFile";
		case "projectcontextonly":
		case "context":
			return "projectContextOnly";
		case "memory":
			return "memory";
		case "mcpinstructions":
		case "mcpserverinstructions":
			return "mcpServerInstructions";
		default:
			throw new Error(`Unknown profile field "${raw}".\n${PROMPT_USAGE}`);
	}
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

function omitProfileField(profile: SystemPromptProfileSetting, field: PromptProfileField): SystemPromptProfileSetting {
	return Object.fromEntries(Object.entries(profile).filter(([key]) => key !== field)) as SystemPromptProfileSetting;
}

function setProfileField(
	profile: SystemPromptProfileSetting,
	field: PromptProfileField,
	rawValue: string,
): SystemPromptProfileSetting {
	const value = rawValue.trim();
	if (value.length === 0) throw new Error(`${field} requires a non-empty value.`);
	switch (field) {
		case "prompt":
			return { ...omitProfileField(profile, "promptFile"), prompt: value };
		case "promptFile":
			return { ...omitProfileField(profile, "prompt"), promptFile: value };
		case "instructions":
			return { ...omitProfileField(profile, "instructionsFile"), instructions: value };
		case "instructionsFile":
			return { ...omitProfileField(profile, "instructions"), instructionsFile: value };
		case "projectContextOnly":
			return { ...profile, projectContextOnly: parseToggle(value, field) };
		case "memory":
			return { ...profile, memory: parseToggle(value, field) };
		case "mcpServerInstructions":
			return { ...profile, mcpServerInstructions: parseToggle(value, field) };
	}
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
	return `${profileId}: base=${base}; append=${appended}; context=${profile.projectContextOnly ? "project" : "all"}; memory=${profile.memory === false ? "off" : "on"}; mcp=${profile.mcpServerInstructions === false ? "off" : "on"}`;
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
		`prompt: ${describeInline(profile.prompt)}`,
		`promptFile: ${profile.promptFile ?? "none"}`,
		`instructions: ${describeInline(profile.instructions)}`,
		`instructionsFile: ${profile.instructionsFile ?? "none"}`,
		`projectContextOnly: ${profile.projectContextOnly === true ? "on" : "off"}`,
		`memory: ${profile.memory === false ? "off" : "on (default)"}`,
		`mcpServerInstructions: ${profile.mcpServerInstructions === false ? "off" : "on (default)"}`,
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

function currentConfiguration(runtime: PromptProfileConfigurationRuntime): PromptProfileConfiguration {
	return {
		profiles: runtime.settings.get("systemPromptProfiles"),
		routes: runtime.settings.get("systemPromptProfileRoutes"),
	};
}

function hasProfile(profiles: Record<string, SystemPromptProfileSetting>, profileId: string): boolean {
	return Object.hasOwn(profiles, profileId);
}

function isUnconditionalProfileRoute(
	route: SystemPromptProfileRouteSetting,
	agentKind: SystemPromptProfileAgentKind,
): boolean {
	return route.deny !== true && route.agentKind === agentKind && route.model === undefined;
}

function assignUnconditionalRoute(
	routes: readonly SystemPromptProfileRouteSetting[],
	agentKind: SystemPromptProfileAgentKind,
	profileId: string,
): SystemPromptProfileRouteSetting[] {
	const nextRoute: SystemPromptProfileRouteSetting = { agentKind, profile: profileId };
	const retainedRoutes = routes.filter(route => !isUnconditionalProfileRoute(route, agentKind));
	return [nextRoute, ...retainedRoutes];
}

export async function applyPromptProfileOperation(
	runtime: PromptProfileConfigurationRuntime,
	operation: PromptProfileOperation,
): Promise<PromptProfileUpdateReceipt> {
	const profiles = runtime.settings.get("systemPromptProfiles");
	const routes = runtime.settings.get("systemPromptProfileRoutes");
	switch (operation.type) {
		case "createProfile": {
			if (hasProfile(profiles, operation.profileId)) {
				throw new Error(`System prompt profile "${operation.profileId}" already exists.`);
			}
			return persistConfiguration(
				runtime,
				{ profiles: { ...profiles, [operation.profileId]: {} } },
				`Created system prompt profile ${operation.profileId}.`,
			);
		}
		case "setField": {
			const profile = hasProfile(profiles, operation.profileId) ? profiles[operation.profileId] : {};
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
			if (!hasProfile(profiles, operation.profileId) || profile === undefined) {
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
			if (!hasProfile(profiles, operation.profileId)) {
				throw new Error(`Unknown system prompt profile "${operation.profileId}".`);
			}
			return persistConfiguration(
				runtime,
				{ routes: assignUnconditionalRoute(routes, operation.agentKind, operation.profileId) },
				`Set the global unconditional ${operation.agentKind} prompt route to ${operation.profileId}.`,
			);
		}
		case "clearRoute": {
			const nextRoutes = routes.filter(route => !isUnconditionalProfileRoute(route, operation.agentKind));
			if (nextRoutes.length === routes.length) {
				return {
					configuration: currentConfiguration(runtime),
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
			if (!hasProfile(profiles, operation.profileId)) {
				throw new Error(`Unknown system prompt profile "${operation.profileId}".`);
			}
			const referenced = routes.some(route => route.deny !== true && route.profile === operation.profileId);
			if (referenced)
				throw new Error(`System prompt profile "${operation.profileId}" is still referenced by a route.`);
			const nextProfiles = Object.fromEntries(
				Object.entries(profiles).filter(([candidateId]) => candidateId !== operation.profileId),
			);
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

async function handleSet(args: readonly string[], runtime: PromptProfileCommandRuntime): Promise<SlashCommandResult> {
	const [profileId, rawField, ...valueParts] = args;
	if (!profileId || !rawField || valueParts.length === 0) return outputMessage(runtime, PROMPT_USAGE);
	return outputUpdate(runtime, {
		type: "setField",
		profileId,
		field: normalizeField(rawField),
		value: valueParts.join(" "),
	});
}

async function handleUnset(args: readonly string[], runtime: PromptProfileCommandRuntime): Promise<SlashCommandResult> {
	const [profileId, rawField, ...extra] = args;
	if (!profileId || !rawField || extra.length > 0) return outputMessage(runtime, PROMPT_USAGE);
	return outputUpdate(runtime, { type: "restoreField", profileId, field: normalizeField(rawField) });
}

async function handleUse(args: readonly string[], runtime: PromptProfileCommandRuntime): Promise<SlashCommandResult> {
	const [profileId, rawKind, ...extra] = args;
	if (!profileId || extra.length > 0) return outputMessage(runtime, PROMPT_USAGE);
	return outputUpdate(runtime, {
		type: "assignRoute",
		profileId,
		agentKind: parseAgentKind(rawKind, runtime.session.effectiveIdentity.role),
	});
}

async function handleUnroute(
	args: readonly string[],
	runtime: PromptProfileCommandRuntime,
): Promise<SlashCommandResult> {
	const [rawKind, ...extra] = args;
	if (extra.length > 0) return outputMessage(runtime, PROMPT_USAGE);
	return outputUpdate(runtime, {
		type: "clearRoute",
		agentKind: parseAgentKind(rawKind, runtime.session.effectiveIdentity.role),
	});
}

async function handleRemove(
	args: readonly string[],
	runtime: PromptProfileCommandRuntime,
): Promise<SlashCommandResult> {
	const [profileId, ...extra] = args;
	if (!profileId || extra.length > 0) return outputMessage(runtime, PROMPT_USAGE);
	return outputUpdate(runtime, { type: "removeProfile", profileId });
}

async function handlePromptProfileCommandInner(
	command: ParsedSlashCommand,
	runtime: PromptProfileCommandRuntime,
): Promise<SlashCommandResult> {
	const [rawVerb, ...restTokens] = parseCommandArgs(command.args);
	const verb = rawVerb?.toLowerCase() ?? "status";
	switch (verb) {
		case "status":
		case "list":
			await runtime.output(formatPromptStatus(runtime));
			return commandConsumed();
		case "show": {
			const [profileId, ...extra] = restTokens;
			if (!profileId || extra.length > 0) return outputMessage(runtime, PROMPT_USAGE);
			const profile = runtime.settings.get("systemPromptProfiles")[profileId];
			if (!profile) throw new Error(`Unknown system prompt profile "${profileId}".`);
			await runtime.output(formatProfileDetails(profileId, profile));
			return commandConsumed();
		}
		case "use":
			return handleUse(restTokens, runtime);
		case "unroute":
			return handleUnroute(restTokens, runtime);
		case "set":
			return handleSet(restTokens, runtime);
		case "unset":
			return handleUnset(restTokens, runtime);
		case "remove":
			return handleRemove(restTokens, runtime);
		case "help":
			await runtime.output(PROMPT_USAGE);
			return commandConsumed();
		default:
			return outputMessage(runtime, PROMPT_USAGE);
	}
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
