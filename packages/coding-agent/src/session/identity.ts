import type { SystemPromptProfileAgentKind } from "../config/settings-schema";
import type { HindsightScoping } from "../hindsight/config";
import type { MemoryBackendId } from "../memory-backend/types";

export type EffectivePromptSource =
	| "maintained-omp-prompt"
	| "discovered-system-prompt"
	| "explicit-system-prompt"
	| "system-prompt-profile";

export type EffectiveMemoryCapability =
	| { readonly status: "enabled" }
	| { readonly status: "disabled-by-profile"; readonly profileId: string };

export interface EffectiveSessionIdentity {
	readonly role: SystemPromptProfileAgentKind;
	readonly prompt: {
		readonly profileId: string | undefined;
		readonly principal: string;
		readonly source: EffectivePromptSource;
	};
	readonly memory: EffectiveMemoryCapability;
}

export function createEffectiveSessionIdentity(options: {
	readonly role: SystemPromptProfileAgentKind;
	readonly promptSource: EffectivePromptSource;
	readonly profileId?: string;
	readonly memoryEnabled: boolean;
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
	});
	let memory: EffectiveMemoryCapability;
	if (options.memoryEnabled) {
		memory = Object.freeze({ status: "enabled" });
	} else {
		if (options.profileId === undefined) {
			throw new Error("A profile-disabled memory capability requires a profile id.");
		}
		memory = Object.freeze({
			status: "disabled-by-profile",
			profileId: options.profileId,
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

export interface AgentIdentityHindsightView {
	readonly bankId: string;
	readonly projectLabel: string;
	readonly config: { readonly scoping: HindsightScoping };
	readonly retainTags?: readonly string[];
	readonly recallTags?: readonly string[];
}

interface AgentIdentityView {
	readonly effectiveIdentity: EffectiveSessionIdentity;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly sessionId: string;
	readonly settings: { get(path: "memory.backend"): MemoryBackendId };
	getHindsightSessionState(): AgentIdentityHindsightView | undefined;
}

export interface AgentIdentitySnapshotInput {
	readonly effectiveIdentity: EffectiveSessionIdentity;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly sessionId: string;
	readonly memoryBackend: MemoryBackendId;
	readonly hindsight?: AgentIdentityHindsightView;
}

export interface AgentIdentitySnapshot extends EffectiveSessionIdentity {
	readonly sessionId: string;
	readonly model: { readonly status: "active"; readonly value: string } | { readonly status: "unavailable" };
	readonly memory: EffectiveMemoryCapability & {
		readonly backend: MemoryBackendId;
		readonly hindsight:
			| { readonly status: "disabled-by-profile" }
			| { readonly status: "disabled" }
			| { readonly status: "configured-not-started" }
			| {
					readonly status: "active";
					readonly bank: string;
					readonly project: string;
					readonly scope: HindsightScoping;
					readonly tags: readonly string[];
			  };
	};
}

export function deriveAgentIdentitySnapshot(input: AgentIdentitySnapshotInput): AgentIdentitySnapshot {
	const identity = input.effectiveIdentity;
	const modelValue = formatIdentityModel(input.model);
	const model = modelValue ? ({ status: "active", value: modelValue } as const) : ({ status: "unavailable" } as const);
	const hindsightState =
		identity.memory.status === "enabled" && input.memoryBackend === "hindsight" ? input.hindsight : undefined;
	const hindsight =
		identity.memory.status === "disabled-by-profile"
			? ({ status: "disabled-by-profile" } as const)
			: input.memoryBackend !== "hindsight"
				? ({ status: "disabled" } as const)
				: hindsightState
					? ({
							status: "active",
							bank: hindsightState.bankId,
							project: hindsightState.projectLabel,
							scope: hindsightState.config.scoping,
							tags: Array.from(
								new Set([...(hindsightState.retainTags ?? []), ...(hindsightState.recallTags ?? [])]),
							).sort(),
						} as const)
					: ({ status: "configured-not-started" } as const);
	return {
		...identity,
		model,
		sessionId: input.sessionId,
		memory: {
			...identity.memory,
			backend: input.memoryBackend,
			hindsight,
		},
	};
}

export function snapshotAgentIdentity(session: AgentIdentityView): AgentIdentitySnapshot {
	return deriveAgentIdentitySnapshot({
		effectiveIdentity: session.effectiveIdentity,
		model: session.model,
		sessionId: session.sessionId,
		memoryBackend: session.settings.get("memory.backend"),
		hindsight: session.getHindsightSessionState(),
	});
}

function formatMemoryPermission(snapshot: AgentIdentitySnapshot): string {
	return snapshot.memory.status === "enabled" ? "enabled" : `disabled by prompt profile ${snapshot.memory.profileId}`;
}

export function formatAgentIdentityReport(snapshot: AgentIdentitySnapshot): string {
	const hindsight = snapshot.memory.hindsight;
	return [
		"OMP identity",
		`Role: ${snapshot.role}`,
		`Prompt principal: ${snapshot.prompt.principal}`,
		`Prompt profile: ${snapshot.prompt.profileId ?? "default"}`,
		`Prompt source: ${snapshot.prompt.source}`,
		`Model: ${snapshot.model.status === "active" ? snapshot.model.value : "unavailable"}`,
		`Session ID: ${snapshot.sessionId}`,
		`Memory permission: ${formatMemoryPermission(snapshot)}`,
		`Memory backend: ${snapshot.memory.backend === "off" ? "off (disabled)" : snapshot.memory.backend}`,
		`Active Hindsight bank: ${hindsight.status === "active" ? hindsight.bank : hindsight.status}`,
		`Project: ${hindsight.status === "active" ? hindsight.project : hindsight.status}`,
		`Scope: ${hindsight.status === "active" ? hindsight.scope : hindsight.status}`,
		`Tags: ${
			hindsight.status === "active"
				? hindsight.tags.length > 0
					? hindsight.tags.join(", ")
					: "none"
				: hindsight.status
		}`,
	].join("\n");
}

export function formatAgentIdentityBadge(snapshot: AgentIdentitySnapshot): string {
	const hindsight = snapshot.memory.hindsight;
	const bank = hindsight.status === "active" ? hindsight.bank : hindsight.status;
	const project = hindsight.status === "active" ? `/project:${hindsight.project}` : "";
	return `${snapshot.prompt.principal}@${bank}${project}`;
}

export function formatAgentIdentitySystemPrompt(snapshot: AgentIdentitySnapshot): string {
	const hindsight = snapshot.memory.hindsight;
	const memoryIdentity =
		snapshot.memory.status === "disabled-by-profile"
			? hindsight.status
			: snapshot.memory.backend === "hindsight"
				? hindsight.status === "active"
					? `bank=${hindsight.bank}; scope=${hindsight.scope}; project=${hindsight.project}; tags=${
							hindsight.tags.length > 0 ? hindsight.tags.join(",") : "none"
						}`
					: hindsight.status
				: snapshot.memory.backend;
	return [
		"<agent-identity>",
		`Role: ${snapshot.role}`,
		`Prompt principal: ${snapshot.prompt.principal}`,
		`Prompt profile: ${snapshot.prompt.profileId ?? "default"}`,
		`Prompt source: ${snapshot.prompt.source}`,
		`Model: ${snapshot.model.status === "active" ? snapshot.model.value : "unavailable"}`,
		`Memory permission: ${formatMemoryPermission(snapshot)}`,
		`Memory backend: ${snapshot.memory.backend}`,
		`Memory identity: ${memoryIdentity}`,
		"</agent-identity>",
	].join("\n");
}
