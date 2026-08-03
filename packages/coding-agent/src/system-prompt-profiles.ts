import * as os from "node:os";
import * as path from "node:path";
import { type } from "arktype";
import type { SystemPromptProfileAgentKind, SystemPromptProfileRouteSetting } from "./config/settings-schema";

export interface SystemPromptProfile {
	readonly id: string;
	readonly prompt?: string;
	readonly instructions?: string;
	readonly projectContextOnly: boolean;
	readonly memoryEnabled: boolean;
	readonly mcpServerInstructionsEnabled: boolean;
}

export type SystemPromptProfileDecision =
	| { readonly type: "default" }
	| { readonly type: "profile"; readonly profile: SystemPromptProfile }
	| { readonly type: "denied"; readonly reason: string };

export interface SystemPromptProfileContext {
	readonly agentKind: SystemPromptProfileAgentKind;
	readonly model: string | undefined;
}

export interface SystemPromptProfileResolver {
	resolveInitial(context: SystemPromptProfileContext): SystemPromptProfileDecision;
	resolveProfile(profileId: string): SystemPromptProfile;
	assertCompatible(profileId: string | undefined, context: SystemPromptProfileContext): void;
}

export function systemPromptProfileCacheKey(baseKey: string, profileId: string): string {
	return `${baseKey}:system-prompt-profile:${profileId}`;
}

const systemPromptProfileSchema = type({
	"+": "reject",
	"prompt?": "string",
	"promptFile?": "string",
	"instructions?": "string",
	"instructionsFile?": "string",
	"projectContextOnly?": "boolean",
	"memory?": "boolean",
	"mcpServerInstructions?": "boolean",
});
const systemPromptProfilesSchema = type({ "[string]": systemPromptProfileSchema });
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

interface CompiledRoute {
	matches(context: SystemPromptProfileContext): boolean;
	readonly decision: Exclude<SystemPromptProfileDecision, { type: "default" }>;
}

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

async function loadPromptFile(profileId: string, source: string, cwd: string): Promise<string> {
	const expanded =
		source === "~" ? os.homedir() : source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source;
	const profilePath = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	try {
		const prompt = await Bun.file(profilePath).text();
		if (prompt.trim().length === 0) {
			throw new Error(`System prompt profile "${profileId}" prompt file is empty: ${profilePath}`);
		}
		return prompt;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("System prompt profile")) throw error;
		throw new Error(`Could not read system prompt profile "${profileId}" from ${profilePath}`, { cause: error });
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
	raw: typeof systemPromptProfileSchema.infer,
	cwd: string,
): Promise<SystemPromptProfile> {
	const promptSources = [raw.prompt !== undefined, raw.promptFile !== undefined];
	if (promptSources.filter(Boolean).length > 1) {
		throw new Error(`systemPromptProfiles.${profileId} may contain only one of "prompt" or "promptFile"`);
	}
	const instructionSources = [raw.instructions !== undefined, raw.instructionsFile !== undefined];
	if (instructionSources.filter(Boolean).length > 1) {
		throw new Error(`systemPromptProfiles.${profileId} may contain only one of "instructions" or "instructionsFile"`);
	}
	const prompt =
		raw.prompt !== undefined
			? requireNonEmptyString(raw.prompt, `systemPromptProfiles.${profileId}.prompt`)
			: raw.promptFile !== undefined
				? await loadPromptFile(
						profileId,
						requireNonEmptyString(raw.promptFile, `systemPromptProfiles.${profileId}.promptFile`),
						cwd,
					)
				: undefined;
	const instructions =
		raw.instructions !== undefined
			? requireNonEmptyString(raw.instructions, `systemPromptProfiles.${profileId}.instructions`)
			: raw.instructionsFile !== undefined
				? await loadPromptFile(
						profileId,
						requireNonEmptyString(raw.instructionsFile, `systemPromptProfiles.${profileId}.instructionsFile`),
						cwd,
					)
				: undefined;
	return {
		id: profileId,
		prompt,
		instructions,
		projectContextOnly: raw.projectContextOnly === true,
		memoryEnabled: raw.memory !== false,
		mcpServerInstructionsEnabled: raw.mcpServerInstructions !== false,
	};
}

function compileRoute(
	raw: SystemPromptProfileRouteSetting,
	index: number,
	profiles: ReadonlyMap<string, SystemPromptProfile>,
): CompiledRoute {
	const matchesModel =
		raw.model === undefined
			? () => true
			: compileModelMatcher(raw.model, `systemPromptProfileRoutes[${index}].model`);
	const matches = (context: SystemPromptProfileContext): boolean =>
		(raw.agentKind === undefined || raw.agentKind === context.agentKind) && matchesModel(context.model);

	if (raw.deny === true) {
		const reason =
			raw.reason === undefined
				? `System prompt profile route ${index} denies this agent/model combination`
				: requireNonEmptyString(raw.reason, `systemPromptProfileRoutes[${index}].reason`);
		return { matches, decision: { type: "denied", reason } };
	}

	const profileId = requireProfileId(raw.profile, `systemPromptProfileRoutes[${index}].profile`);
	const profile = profiles.get(profileId);
	if (profile === undefined) {
		throw new Error(`systemPromptProfileRoutes[${index}] references unknown system prompt profile "${profileId}"`);
	}
	return { matches, decision: { type: "profile", profile } };
}

function decisionProfileId(decision: SystemPromptProfileDecision): string | undefined {
	return decision.type === "profile" ? decision.profile.id : undefined;
}

export async function createSystemPromptProfileResolver(options: {
	readonly profiles: unknown;
	readonly routes: unknown;
	readonly cwd: string;
}): Promise<SystemPromptProfileResolver> {
	const profileSettings = systemPromptProfilesSchema(options.profiles);
	if (profileSettings instanceof type.errors) {
		throw new Error(`Invalid systemPromptProfiles: ${profileSettings.summary}`);
	}
	const routeSettings = routesSchema(options.routes);
	if (routeSettings instanceof type.errors) {
		throw new Error(`Invalid systemPromptProfileRoutes: ${routeSettings.summary}`);
	}

	const profileEntries = await Promise.all(
		Object.entries(profileSettings).map(async ([rawProfileId, rawProfile]) => {
			const profileId = requireProfileId(rawProfileId, "systemPromptProfiles profile id");
			return [profileId, await compileProfile(profileId, rawProfile, options.cwd)] as const;
		}),
	);
	const profiles = new Map(profileEntries);
	const routes = routeSettings.map((route, index) => compileRoute(route, index, profiles));
	const resolveInitial = (context: SystemPromptProfileContext): SystemPromptProfileDecision =>
		routes.find(route => route.matches(context))?.decision ?? { type: "default" };
	const resolveProfile = (rawProfileId: string): SystemPromptProfile => {
		const profileId = requireProfileId(rawProfileId, "system prompt profile id");
		const profile = profiles.get(profileId);
		if (profile === undefined) throw new Error(`Unknown system prompt profile "${profileId}"`);
		return profile;
	};

	return {
		resolveInitial,
		resolveProfile,
		assertCompatible: (profileId, context) => {
			const decision = resolveInitial(context);
			if (decision.type === "denied") throw new Error(decision.reason);
			const nextProfileId = decisionProfileId(decision);
			if (profileId === nextProfileId) return;
			const currentLabel = profileId === undefined ? "the default prompt" : `system prompt profile "${profileId}"`;
			const nextLabel =
				nextProfileId === undefined ? "the default prompt" : `system prompt profile "${nextProfileId}"`;
			throw new Error(
				`This session is pinned to ${currentLabel}; ${context.model ?? "the requested model"} routes to ${nextLabel}. Start a new session to change prompt identity.`,
			);
		},
	};
}
