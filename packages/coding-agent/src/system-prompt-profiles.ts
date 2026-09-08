import { type } from "arktype";
import type { SystemPromptProfileAgentKind, SystemPromptProfileRouteSetting } from "./config/settings-schema";
import { resolvePath } from "./extensibility/utils";

export interface SystemPromptProfile {
	readonly id: string;
	/** Constitution text resolved once at profile compilation. */
	readonly constitution?: string;
	readonly prompt?: string;
	readonly instructions?: string;
	readonly projectContextOnly: boolean;
	readonly memoryEnabled: boolean;
	readonly mcpServerInstructionsEnabled: boolean;
	/** Absolute paths of standing context images injected into the message stream at conversation start. */
	readonly contextImages: readonly string[];
	/** Phrase substituted for "the user" in the maintained system prompt; undefined keeps the generic wording. */
	readonly userTitle?: string;
	/**
	 * Extra system-prompt paragraph appended to the compaction summarizer's system
	 * prompt (identity/naming for handover notes); undefined keeps the generic wording.
	 */
	readonly compactionIdentity?: string;
	/** Tool names forming the model-facing active set; empty keeps the full set. */
	readonly tools: readonly string[];
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
	"constitution?": "string",
	"constitutionFile?": "string",
	"prompt?": "string",
	"promptFile?": "string",
	"instructions?": "string",
	"instructionsFile?": "string",
	"projectContextOnly?": "boolean",
	"memory?": "boolean",
	"mcpServerInstructions?": "boolean",
	"contextImages?": "string[]",
	"userTitle?": "string",
	"compactionIdentity?": "string",
	"tools?": "string[]",
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
	const profilePath = resolvePath(source, cwd);
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

async function resolveContextImage(profileId: string, source: string, index: number, cwd: string): Promise<string> {
	const label = `systemPromptProfiles.${profileId}.contextImages[${index}]`;
	const imagePath = resolvePath(requireNonEmptyString(source, label), cwd);
	if (!(await Bun.file(imagePath).exists())) {
		throw new Error(`${label} does not exist: ${imagePath}`);
	}
	return imagePath;
}

function compileProfileTools(profileId: string, raw: readonly string[]): readonly string[] {
	const tools = new Set<string>();
	raw.forEach((name, index) =>
		tools.add(requireNonEmptyString(name, `systemPromptProfiles.${profileId}.tools[${index}]`).toLowerCase()),
	);
	return [...tools];
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

/** Resolves one profile text field from its inline spelling, else its `<field>File` spelling. */
async function resolveProfileText(
	profileId: string,
	raw: typeof systemPromptProfileSchema.infer,
	field: "prompt" | "instructions" | "constitution",
	cwd: string,
): Promise<string | undefined> {
	const inline = raw[field];
	const file = raw[`${field}File`];
	if (inline !== undefined && file !== undefined) {
		throw new Error(`systemPromptProfiles.${profileId} may contain only one of "${field}" or "${field}File"`);
	}
	const label = `systemPromptProfiles.${profileId}.${field}`;
	if (inline !== undefined) return requireNonEmptyString(inline, label);
	if (file === undefined) return undefined;
	return loadPromptFile(profileId, requireNonEmptyString(file, `${label}File`), cwd);
}

async function compileProfile(
	profileId: string,
	raw: typeof systemPromptProfileSchema.infer,
	cwd: string,
): Promise<SystemPromptProfile> {
	const prompt = await resolveProfileText(profileId, raw, "prompt", cwd);
	const instructions = await resolveProfileText(profileId, raw, "instructions", cwd);
	const constitution = (await resolveProfileText(profileId, raw, "constitution", cwd))?.trim();
	return {
		id: profileId,
		constitution,
		prompt,
		instructions,
		projectContextOnly: raw.projectContextOnly === true,
		memoryEnabled: raw.memory !== false,
		mcpServerInstructionsEnabled: raw.mcpServerInstructions !== false,
		contextImages:
			raw.contextImages === undefined
				? []
				: await Promise.all(
						raw.contextImages.map((source, index) => resolveContextImage(profileId, source, index, cwd)),
					),
		tools: raw.tools === undefined ? [] : compileProfileTools(profileId, raw.tools),
		userTitle:
			raw.userTitle === undefined
				? undefined
				: requireNonEmptyString(raw.userTitle, `systemPromptProfiles.${profileId}.userTitle`),
		compactionIdentity:
			raw.compactionIdentity === undefined
				? undefined
				: requireNonEmptyString(raw.compactionIdentity, `systemPromptProfiles.${profileId}.compactionIdentity`),
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
			const nextProfileId = decision.type === "profile" ? decision.profile.id : undefined;
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
