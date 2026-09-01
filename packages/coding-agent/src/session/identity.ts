import type { SystemPromptProfileAgentKind } from "../config/settings-schema";
import type { MemoryBackendId } from "../memory-backend/types";
import type { AgentSession } from "./agent-session";

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

type MemoryProviderIdentity =
	| { readonly backend: "off"; readonly status: "disabled" }
	| { readonly backend: "local" | "sharpshooter"; readonly status: "active" }
	| { readonly backend: "mnemopi"; readonly status: "configured-not-started" | "active" }
	| { readonly backend: "hindsight"; readonly status: "configured-not-started" }
	| {
			readonly backend: "hindsight";
			readonly status: "active";
			readonly bank: string;
			readonly project: string;
			readonly scope: "global" | "per-project" | "per-project-tagged";
			readonly tags: readonly string[];
	  }
	| { readonly backend: "unavailable"; readonly status: "not-started" };

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
			| { readonly status: "disabled-by-profile" }
			| { readonly status: "disabled" }
			| { readonly status: "configured-not-started" }
			| {
					readonly status: "active";
					readonly bank: string;
					readonly project: string;
					readonly scope: "global" | "per-project" | "per-project-tagged";
					readonly tags: readonly string[];
			  };
	};
}

function configuredMemoryIdentity(session: AgentSession): MemoryProviderIdentity {
	if (session.effectiveIdentity.memory.status !== "enabled") {
		return { backend: "unavailable", status: "not-started" };
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
		case "hindsight": {
			const state = session.getHindsightSessionState();
			const primary = state?.isAlias ? state.aliasOf : state;
			if (!primary) return { backend, status: "configured-not-started" };
			return {
				backend,
				status: "active",
				bank: primary.bankId,
				project: primary.projectLabel,
				scope: primary.config.scoping,
				tags: primary.retainTags ?? [],
			};
		}
	}
}

export function deriveAgentIdentitySnapshot(input: AgentIdentitySnapshotInput): AgentIdentitySnapshot {
	const identity = input.effectiveIdentity;
	const modelValue = formatIdentityModel(input.model);
	const model = modelValue ? ({ status: "active", value: modelValue } as const) : ({ status: "unavailable" } as const);
	const memoryIdentity: MemoryProviderIdentity = input.memoryIdentity ?? {
		backend: "unavailable",
		status: "not-started",
	};
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
		`Memory backend: ${snapshot.memory.backend} (${snapshot.memory.providerStatus})`,
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

export function formatAgentIdentitySystemPrompt(
	snapshot: AgentIdentitySnapshot,
	options?: { includeModel?: boolean },
): string {
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
				: `${snapshot.memory.backend}:${snapshot.memory.providerStatus}`;
	return [
		"<agent-identity>",
		`Role: ${snapshot.role}`,
		`Prompt principal: ${snapshot.prompt.principal}`,
		`Prompt profile: ${snapshot.prompt.profileId ?? "default"}`,
		`Prompt source: ${snapshot.prompt.source}`,
		// `includeModelInPrompt: false` withholds the model here too — the
		// workstation block and this block must agree on visibility.
		...(options?.includeModel === false
			? []
			: [`Model: ${snapshot.model.status === "active" ? snapshot.model.value : "unavailable"}`]),
		`Memory permission: ${formatMemoryPermission(snapshot)}`,
		`Memory backend: ${snapshot.memory.backend}`,
		`Memory identity: ${memoryIdentity}`,
		"</agent-identity>",
	].join("\n");
}
