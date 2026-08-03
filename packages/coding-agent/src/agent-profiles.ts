import * as os from "node:os";
import * as path from "node:path";
import { type } from "arktype";
import type { AgentProfileAgentKind, AgentProfileRouteSetting } from "./config/settings-schema";
import type { BankScope, RecallTagsMatch } from "./hindsight/bank";

export interface AgentProfile {
	readonly id: string;
	/** Constitution layered over the selected harness base; absent for `useDefaultPrompt`. */
	readonly prompt?: string;
	readonly hindsight: BankScope;
	readonly models?: readonly string[];
	readonly tools?: readonly string[];
	readonly projectContextOnly: boolean;
}

export type AgentProfileDecision =
	| { type: "default" }
	| { type: "profile"; profile: AgentProfile }
	| { type: "denied"; reason: string };

export interface AgentProfileContext {
	agentKind: AgentProfileAgentKind;
	model: string | undefined;
}

export interface AgentProfileResolver {
	resolveInitial(context: AgentProfileContext): AgentProfileDecision;
	listProfiles(): readonly AgentProfile[];
	resolveProfile(profileId: string): AgentProfile;
	assertModelAllowed(profile: AgentProfile | undefined, model: string | undefined): void;
}

const hindsightSchema = type({
	"+": "reject",
	bankId: "string",
	"retainTags?": "string[]",
	"recallTags?": "string[]",
	"recallTagsMatch?": "'any' | 'all' | 'any_strict' | 'all_strict'",
});
const agentProfileSchema = type({
	"+": "reject",
	"prompt?": "string",
	"promptFile?": "string",
	"useDefaultPrompt?": "true",
	hindsight: hindsightSchema,
	"models?": "string[]",
	"tools?": "string[]",
	"projectContextOnly?": "boolean",
});
const agentProfilesSchema = type({ "[string]": agentProfileSchema });
const profileRouteSchema = type({
	"+": "reject",
	profile: "string",
	"agentKind?": "'main' | 'sub'",
	"model?": "string",
});
const deniedRouteSchema = type({
	"+": "reject",
	deny: "true",
	"reason?": "string",
	"agentKind?": "'main' | 'sub'",
	"model?": "string",
});
const routesSchema = profileRouteSchema.or(deniedRouteSchema).array();

type CompiledProfile = {
	profile: AgentProfile;
	allowsModel(model: string): boolean;
};

type CompiledRoute = {
	matches(context: AgentProfileContext): boolean;
	decision: Exclude<AgentProfileDecision, { type: "default" }>;
};

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function requireProfileId(value: unknown, label: string): string {
	const profileId = requireNonEmptyString(value, label);
	if (!PROFILE_ID.test(profileId)) {
		throw new Error(`${label} must match ${PROFILE_ID}`);
	}
	return profileId;
}

function normalizeStrings(values: string[] | undefined, label: string): string[] | undefined {
	if (values === undefined) return undefined;
	return [...new Set(values.map((value, index) => requireNonEmptyString(value, `${label}[${index}]`)))];
}

async function loadPromptFile(profileId: string, source: string, cwd: string): Promise<string> {
	const expanded =
		source === "~" ? os.homedir() : source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
	const profilePath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	try {
		const prompt = await Bun.file(profilePath).text();
		if (prompt.trim().length === 0) {
			throw new Error(`Agent profile "${profileId}" prompt file is empty: ${profilePath}`);
		}
		return prompt;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Agent profile")) throw error;
		throw new Error(`Could not read agent profile "${profileId}" prompt from ${profilePath}`, { cause: error });
	}
}

function compileModelMatcher(pattern: string, label: string): (model: string | undefined) => boolean {
	const normalized = requireNonEmptyString(pattern, label).toLowerCase();
	if (normalized === "*") return model => model !== undefined;
	let glob: Bun.Glob;
	try {
		glob = new Bun.Glob(normalized);
	} catch (error) {
		throw new Error(`${label} is not a valid glob: ${pattern}`, { cause: error });
	}
	return model => model !== undefined && glob.match(model.toLowerCase());
}

async function compileProfile(
	profileId: string,
	raw: typeof agentProfileSchema.infer,
	cwd: string,
): Promise<CompiledProfile> {
	const promptSources = [raw.prompt !== undefined, raw.promptFile !== undefined, raw.useDefaultPrompt === true];
	if (promptSources.filter(Boolean).length !== 1) {
		throw new Error(
			`agentProfiles.${profileId} must contain exactly one of "prompt", "promptFile", or "useDefaultPrompt"`,
		);
	}
	const prompt =
		raw.prompt !== undefined
			? requireNonEmptyString(raw.prompt, `agentProfiles.${profileId}.prompt`)
			: raw.promptFile !== undefined
				? await loadPromptFile(
						profileId,
						requireNonEmptyString(raw.promptFile, `agentProfiles.${profileId}.promptFile`),
						cwd,
					)
				: undefined;
	const models = normalizeStrings(raw.models, `agentProfiles.${profileId}.models`);
	const tools = normalizeStrings(raw.tools, `agentProfiles.${profileId}.tools`);
	const retainTags = normalizeStrings(raw.hindsight.retainTags, `agentProfiles.${profileId}.hindsight.retainTags`);
	const recallTags = normalizeStrings(raw.hindsight.recallTags, `agentProfiles.${profileId}.hindsight.recallTags`);
	const hindsight: BankScope = {
		bankId: requireNonEmptyString(raw.hindsight.bankId, `agentProfiles.${profileId}.hindsight.bankId`),
		retainTags,
		recallTags,
		recallTagsMatch: raw.hindsight.recallTagsMatch as RecallTagsMatch | undefined,
	};
	const matchers = models?.map((pattern, index) =>
		compileModelMatcher(pattern, `agentProfiles.${profileId}.models[${index}]`),
	);
	return {
		profile: {
			id: profileId,
			prompt,
			hindsight,
			models,
			tools,
			projectContextOnly: raw.projectContextOnly === true,
		},
		allowsModel: model => matchers === undefined || matchers.some(matches => matches(model)),
	};
}

function compileRoute(
	raw: AgentProfileRouteSetting,
	index: number,
	profiles: ReadonlyMap<string, CompiledProfile>,
): CompiledRoute {
	const agentKind = raw.agentKind;
	const matchesModel =
		raw.model === undefined ? () => true : compileModelMatcher(raw.model, `agentProfileRoutes[${index}].model`);
	const matches = (context: AgentProfileContext): boolean =>
		(agentKind === undefined || context.agentKind === agentKind) && matchesModel(context.model);

	if (raw.deny === true) {
		const reason =
			raw.reason === undefined
				? `Agent profile route ${index} denies this agent/model combination`
				: requireNonEmptyString(raw.reason, `agentProfileRoutes[${index}].reason`);
		return { matches, decision: { type: "denied", reason } };
	}

	const profileId = requireProfileId(raw.profile, `agentProfileRoutes[${index}].profile`);
	const compiled = profiles.get(profileId);
	if (compiled === undefined) {
		throw new Error(`agentProfileRoutes[${index}] references unknown agent profile "${profileId}"`);
	}
	return { matches, decision: { type: "profile", profile: compiled.profile } };
}

export async function createAgentProfileResolver(options: {
	profiles: unknown;
	routes: unknown;
	cwd: string;
}): Promise<AgentProfileResolver> {
	const profileSettings = agentProfilesSchema(options.profiles);
	if (profileSettings instanceof type.errors) {
		throw new Error(`Invalid agentProfiles: ${profileSettings.summary}`);
	}
	const routeSettings = routesSchema(options.routes);
	if (routeSettings instanceof type.errors) {
		throw new Error(`Invalid agentProfileRoutes: ${routeSettings.summary}`);
	}

	const profileEntries = await Promise.all(
		Object.entries(profileSettings).map(async ([rawProfileId, rawProfile]) => {
			const profileId = requireProfileId(rawProfileId, "agentProfiles profile id");
			return [profileId, await compileProfile(profileId, rawProfile, options.cwd)] as const;
		}),
	);
	const profiles = new Map(profileEntries);
	const routes = routeSettings.map((route, index) => compileRoute(route, index, profiles));
	const resolveProfile = (rawProfileId: string): AgentProfile => {
		const profileId = requireProfileId(rawProfileId, "agent profile id");
		const compiled = profiles.get(profileId);
		if (compiled === undefined) throw new Error(`Unknown agent profile "${profileId}"`);
		return compiled.profile;
	};
	const assertModelAllowed = (profile: AgentProfile | undefined, model: string | undefined): void => {
		if (profile === undefined || model === undefined) return;
		const compiled = profiles.get(profile.id);
		if (compiled?.allowsModel(model) !== false) return;
		throw new Error(`Agent profile "${profile.id}" does not allow model ${model}`);
	};

	return {
		listProfiles: () => [...profiles.values()].map(({ profile }) => profile),
		resolveInitial: context => routes.find(route => route.matches(context))?.decision ?? { type: "default" },
		resolveProfile,
		assertModelAllowed,
	};
}
