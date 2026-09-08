import type { HindsightMemoryBinding, SystemPromptProfileAgentKind } from "../config/settings-schema";
import type { MemoryBackendId } from "../memory-backend/types";
import type { AgentSession } from "./agent-session";

export type EffectivePromptSource =
	| "maintained-omp-prompt"
	| "discovered-system-prompt"
	| "explicit-system-prompt"
	| "system-prompt-profile";

/** How the active prompt profile was selected: a configured route, or a per-process request. */
export type ProfileSelectionSource = "route" | "explicit";

/**
 * Memory permission of a session, plus the memory owner it acts for.
 *
 * `memoryBinding` names the owner and its one bank. Permission is independent:
 * a disabled worker still acts for its inherited owner but cannot access memory.
 * An enabled, unbound session follows the global bank derivation.
 */
export type EffectiveMemoryCapability =
	| { readonly status: "enabled"; readonly memoryBinding?: HindsightMemoryBinding }
	| {
			readonly status: "disabled-by-profile";
			readonly profileId: string;
			readonly memoryBinding?: HindsightMemoryBinding;
	  };

export interface EffectiveSessionIdentity {
	readonly role: SystemPromptProfileAgentKind;
	readonly prompt: {
		readonly profileId: string | undefined;
		readonly principal: string;
		readonly source: EffectivePromptSource;
		readonly profileSource?: ProfileSelectionSource;
	};
	readonly memory: EffectiveMemoryCapability;
}

export function createEffectiveSessionIdentity(options: {
	readonly role: SystemPromptProfileAgentKind;
	readonly promptSource: EffectivePromptSource;
	readonly profileId?: string;
	readonly memoryEnabled: boolean;
	readonly profileSource?: ProfileSelectionSource;
	readonly memoryBinding?: HindsightMemoryBinding;
}): EffectiveSessionIdentity {
	if (options.promptSource === "system-prompt-profile" && options.profileId === undefined) {
		throw new Error("A system-prompt-profile identity requires a profile id.");
	}
	const prompt = Object.freeze({
		profileId: options.profileId,
		principal:
			options.promptSource === "system-prompt-profile"
				? `prompt-profile:${options.profileId}`
				: options.promptSource,
		source: options.promptSource,
		profileSource: options.profileSource,
	});
	let memory: EffectiveMemoryCapability;
	if (options.memoryEnabled) {
		memory = Object.freeze({ status: "enabled", memoryBinding: options.memoryBinding });
	} else if (options.profileId === undefined) {
		throw new Error("A profile-disabled memory capability requires a profile id.");
	} else {
		memory = Object.freeze({
			status: "disabled-by-profile",
			profileId: options.profileId,
			memoryBinding: options.memoryBinding,
		});
	}
	return Object.freeze({
		role: options.role,
		prompt,
		memory,
	});
}
export function formatIdentityModel(
	model: { readonly provider: string; readonly id: string } | undefined,
): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

interface HindsightMemoryFacts {
	readonly bank: string;
	readonly project: string;
	readonly scope: "global" | "per-project" | "per-project-tagged";
	readonly tags: readonly string[];
}

type MemoryProviderIdentity =
	| { readonly backend: "off"; readonly status: "disabled" }
	| { readonly backend: "local" | "sharpshooter"; readonly status: "active" }
	| { readonly backend: "mnemopi"; readonly status: "configured-not-started" | "active" }
	| { readonly backend: "hindsight"; readonly status: "configured-not-started" }
	| ({ readonly backend: "hindsight"; readonly status: "active" } & HindsightMemoryFacts)
	| { readonly backend: "unavailable"; readonly status: "not-started" };

const MEMORY_NOT_STARTED: MemoryProviderIdentity = { backend: "unavailable", status: "not-started" };

export interface AgentIdentitySnapshotInput {
	readonly effectiveIdentity: EffectiveSessionIdentity;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly sessionId: string;
	readonly memoryIdentity?: MemoryProviderIdentity;
}

export interface AgentIdentitySnapshot extends EffectiveSessionIdentity {
	readonly sessionId: string;
	readonly model: { readonly status: "active"; readonly value: string } | { readonly status: "unavailable" };
	readonly memory: EffectiveMemoryCapability & {
		readonly backend: MemoryProviderIdentity["backend"];
		readonly providerStatus: MemoryProviderIdentity["status"];
		readonly hindsight:
			| { readonly status: "disabled-by-profile" | "disabled" | "configured-not-started" }
			| ({ readonly status: "active" } & HindsightMemoryFacts);
	};
}

function configuredMemoryIdentity(session: AgentSession): MemoryProviderIdentity {
	if (session.effectiveIdentity.memory.status !== "enabled") return MEMORY_NOT_STARTED;
	// A live Hindsight route is the truth even when the selector has since been
	// pointed elsewhere: a bound session refuses to follow that edit, so the
	// bank it is still writing to must be what this reports.
	const state = session.getHindsightSessionState();
	const primary = state?.isAlias ? state.aliasOf : state;
	if (primary) {
		return {
			backend: "hindsight",
			status: "active",
			bank: primary.bankId,
			project: primary.projectLabel,
			scope: primary.config.scoping,
			tags: primary.retainTags ?? [],
		};
	}
	const backend: MemoryBackendId = session.settings.get("memory.backend") ?? "off";
	switch (backend) {
		case "off":
			return { backend, status: "disabled" };
		case "local":
		case "sharpshooter":
			return { backend, status: "active" };
		case "mnemopi":
			return { backend, status: session.getMnemopiSessionState() ? "active" : "configured-not-started" };
		case "hindsight":
			return { backend, status: "configured-not-started" };
	}
}

export function deriveAgentIdentitySnapshot(input: AgentIdentitySnapshotInput): AgentIdentitySnapshot {
	const identity = input.effectiveIdentity;
	const modelValue = formatIdentityModel(input.model);
	const model = modelValue ? ({ status: "active", value: modelValue } as const) : ({ status: "unavailable" } as const);
	const memoryIdentity = input.memoryIdentity ?? MEMORY_NOT_STARTED;
	const hindsight =
		identity.memory.status === "disabled-by-profile"
			? ({ status: "disabled-by-profile" } as const)
			: memoryIdentity.backend !== "hindsight"
				? ({ status: "disabled" } as const)
				: memoryIdentity.status === "active"
					? ({
							status: "active",
							bank: memoryIdentity.bank,
							project: memoryIdentity.project,
							scope: memoryIdentity.scope,
							tags: memoryIdentity.tags,
						} as const)
					: ({ status: "configured-not-started" } as const);
	return {
		...identity,
		model,
		sessionId: input.sessionId,
		memory: {
			...identity.memory,
			backend: memoryIdentity.backend,
			providerStatus: memoryIdentity.status,
			hindsight,
		},
	};
}

export function snapshotAgentIdentity(session: AgentSession): AgentIdentitySnapshot {
	return deriveAgentIdentitySnapshot({
		effectiveIdentity: session.effectiveIdentity,
		model: session.model,
		sessionId: session.sessionId,
		memoryIdentity: configuredMemoryIdentity(session),
	});
}

function formatMemoryPermission(snapshot: AgentIdentitySnapshot): string {
	return snapshot.memory.status === "enabled" ? "enabled" : `disabled by prompt profile ${snapshot.memory.profileId}`;
}

/**
 * Memory owner this session acts for. The bound bank is reported alongside the
 * principal because it is declared by the binding, so it is the truth even
 * before (or without) a live Hindsight route.
 */
function formatMemoryOwner(snapshot: AgentIdentitySnapshot): string {
	const binding = snapshot.memory.memoryBinding;
	return binding ? `${binding.principal} (bank ${binding.bankId})` : "unbound";
}

export function formatAgentIdentityReport(snapshot: AgentIdentitySnapshot): string {
	const hindsight = snapshot.memory.hindsight;
	const tags =
		hindsight.status !== "active" ? hindsight.status : hindsight.tags.length > 0 ? hindsight.tags.join(", ") : "none";
	return [
		"OMP identity",
		`Role: ${snapshot.role}`,
		`Prompt principal: ${snapshot.prompt.principal}`,
		`Prompt profile: ${snapshot.prompt.profileId ?? "default"}`,
		`Prompt source: ${snapshot.prompt.source}`,
		...(snapshot.prompt.profileSource ? [`Profile selection: ${snapshot.prompt.profileSource}`] : []),
		`Model: ${snapshot.model.status === "active" ? snapshot.model.value : "unavailable"}`,
		`Session ID: ${snapshot.sessionId}`,
		`Memory permission: ${formatMemoryPermission(snapshot)}`,
		`Memory owner: ${formatMemoryOwner(snapshot)}`,
		`Memory backend: ${snapshot.memory.backend} (${snapshot.memory.providerStatus})`,
		`Active Hindsight bank: ${hindsight.status === "active" ? hindsight.bank : hindsight.status}`,
		`Project: ${hindsight.status === "active" ? hindsight.project : hindsight.status}`,
		`Scope: ${hindsight.status === "active" ? hindsight.scope : hindsight.status}`,
		`Tags: ${tags}`,
	].join("\n");
}

export function formatAgentIdentityBadge(snapshot: AgentIdentitySnapshot): string {
	const hindsight = snapshot.memory.hindsight;
	const bank = hindsight.status === "active" ? hindsight.bank : hindsight.status;
	const project = hindsight.status === "active" ? `/project:${hindsight.project}` : "";
	return `${snapshot.prompt.principal}@${bank}${project}`;
}

export function formatAgentIdentitySystemPrompt(
	snapshot: AgentIdentitySnapshot,
	options?: { includeModel?: boolean },
): string {
	const hindsight = snapshot.memory.hindsight;
	const memoryIdentity =
		hindsight.status === "active"
			? `bank=${hindsight.bank}; scope=${hindsight.scope}; project=${hindsight.project}; tags=${
					hindsight.tags.length > 0 ? hindsight.tags.join(",") : "none"
				}`
			: snapshot.memory.status === "disabled-by-profile" || snapshot.memory.backend === "hindsight"
				? hindsight.status
				: `${snapshot.memory.backend}:${snapshot.memory.providerStatus}`;
	return [
		"<agent-identity>",
		`Role: ${snapshot.role}`,
		`Prompt principal: ${snapshot.prompt.principal}`,
		`Prompt profile: ${snapshot.prompt.profileId ?? "default"}`,
		`Prompt source: ${snapshot.prompt.source}`,
		...(snapshot.prompt.profileSource ? [`Profile selection: ${snapshot.prompt.profileSource}`] : []),
		// `includeModelInPrompt: false` withholds the model here too — the
		// workstation block and this block must agree on visibility.
		...(options?.includeModel === false
			? []
			: [`Model: ${snapshot.model.status === "active" ? snapshot.model.value : "unavailable"}`]),
		`Memory permission: ${formatMemoryPermission(snapshot)}`,
		`Memory owner: ${formatMemoryOwner(snapshot)}`,
		`Memory backend: ${snapshot.memory.backend}`,
		`Memory identity: ${memoryIdentity}`,
		"</agent-identity>",
	].join("\n");
}
