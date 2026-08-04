import { describe, expect, it, vi } from "bun:test";
import { computeBankScope, resolveProjectLabel } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import type {
	BankProfileResponse,
	CreateBankOptions,
	MemoryItemInput,
	RecallResult,
	RetainBatchOptions,
	RetainOptions,
	RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { formatMemories, type HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type AgentIdentitySnapshot,
	createEffectiveSessionIdentity,
	type EffectiveSessionIdentity,
	snapshotAgentIdentity,
} from "@oh-my-pi/pi-coding-agent/session/identity";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

const makeConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "last-turn",
	retainEveryNTurns: 1,
	retainOverlapTurns: 0,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelRefreshIntervalMs: 5 * 60 * 1000,
	mentalModelMaxRenderChars: 16_000,
	...overrides,
});

class RecordingHindsightApi extends HindsightApi {
	readonly batches: Array<{ bankId: string; items: MemoryItemInput[]; options?: RetainBatchOptions }> = [];
	readonly retains: Array<{ bankId: string; content: string; options?: RetainOptions }> = [];

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(_bankId: string, _options?: CreateBankOptions): Promise<BankProfileResponse> {
		return {};
	}

	override async retainBatch(
		bankId: string,
		items: MemoryItemInput[],
		options?: RetainBatchOptions,
	): Promise<RetainResponse> {
		this.batches.push({ bankId, items, options });
		return {};
	}

	override async retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse> {
		this.retains.push({ bankId, content, options });
		return {};
	}
}

interface MutableRuntime {
	cwd: string;
	model?: { provider: string; id: string };
}

function createState(
	client: HindsightApi,
	identity: EffectiveSessionIdentity,
	runtime: MutableRuntime,
	options: { config?: HindsightConfig; projectLabel?: string; retainTags?: string[] } = {},
): HindsightSessionState {
	let state: HindsightSessionState;
	const session = {
		effectiveIdentity: identity,
		get model() {
			return runtime.model;
		},
		sessionManager: { getCwd: () => runtime.cwd },
		settings: { get: (path: string) => (path === "memory.backend" ? "hindsight" : undefined) },
		get sessionId() {
			return state.sessionId;
		},
		getHindsightSessionState: () => state,
		emitNotice: () => {},
	} as unknown as AgentSession;
	state = new HindsightSessionState({
		sessionId: "session-42",
		client,
		bankId: "test-bank",
		projectLabel: options.projectLabel ?? "aurora",
		retainTags: options.retainTags,
		config: options.config ?? makeConfig(),
		session,
		banksSet: new Set(),
	});
	return state;
}
function activeProfileMetadata(snapshot: AgentIdentitySnapshot): Record<string, string> {
	const profileId = snapshot.prompt.profileId;
	if (profileId === undefined || snapshot.model.status !== "active") {
		throw new Error("Expected an active model and named prompt profile");
	}
	return {
		session_id: snapshot.sessionId,
		agent_kind: snapshot.role,
		prompt_profile: profileId,
		prompt_principal: snapshot.prompt.principal,
		prompt_source: snapshot.prompt.source,
		model: snapshot.model.value,
	};
}

describe("Hindsight retention provenance", () => {
	it("samples request provenance and projects the immutable session identity without re-deriving it", async () => {
		const client = new RecordingHindsightApi();
		const identity = createEffectiveSessionIdentity({
			role: "main",
			profileId: "profile-a",
			promptSource: "system-prompt-profile",
			memoryEnabled: true,
		});
		const runtime = {
			cwd: "/workspace/aurora",
			model: { provider: "provider-a", id: "model-a" },
		};
		const state = createState(client, identity, runtime);
		const snapshot = snapshotAgentIdentity(state.session);

		state.enqueueRetain("first tool-authored fact");
		state.setSessionId("session-99");
		runtime.model = { provider: "provider-b", id: "model-b" };
		state.enqueueRetain("second tool-authored fact");
		const changedSnapshot = snapshotAgentIdentity(state.session);
		await state.flushRetainQueue();

		const toolMetadata = client.batches[0]?.items[0]?.metadata;
		expect(toolMetadata).toEqual({
			...activeProfileMetadata(snapshot),
			project: "aurora",
			cwd: "/workspace/aurora",
			source: "agent-retain",
		});
		expect(client.batches[0]?.items[1]?.metadata).toEqual({
			...activeProfileMetadata(changedSnapshot),
			project: "aurora",
			cwd: "/workspace/aurora",
			source: "agent-retain",
		});

		const transcript: HindsightMessage[] = [
			{ role: "user", content: "remember this automatic transcript" },
			{ role: "assistant", content: "acknowledged" },
		];
		await state.retainSession(transcript);

		expect(client.retains[0]?.options?.metadata).toEqual({
			...activeProfileMetadata(changedSnapshot),
			project: "aurora",
			cwd: "/workspace/aurora",
			source: "session-auto-retain",
		});
		expect(Object.isFrozen(identity)).toBe(true);
		expect(Object.isFrozen(identity.prompt)).toBe(true);
		expect(Object.isFrozen(identity.memory)).toBe(true);
	});

	it("uses the bank project label once and performs no repository discovery per retained item", async () => {
		const discovery = vi.spyOn(git.repo, "primaryRootSync").mockReturnValue("/workspace/aurora");
		try {
			const config = makeConfig({ scoping: "per-project-tagged" });
			const cwd = "/workspace/aurora/worktree";
			const projectLabel = resolveProjectLabel(cwd);
			const scope = computeBankScope(config, cwd, projectLabel);
			const client = new RecordingHindsightApi();
			const state = createState(
				client,
				createEffectiveSessionIdentity({
					role: "main",
					promptSource: "maintained-omp-prompt",
					memoryEnabled: true,
				}),
				{ cwd },
				{ config, projectLabel, retainTags: scope.retainTags },
			);

			state.enqueueRetain("first");
			state.enqueueRetain("second");
			await state.flushRetainQueue();

			expect(discovery).toHaveBeenCalledTimes(1);
			expect(scope.retainTags).toEqual([`project:${projectLabel}`]);
			expect(client.batches[0]?.items.map(item => item.metadata?.project)).toEqual([projectLabel, projectLabel]);
		} finally {
			discovery.mockRestore();
		}
	});

	it("bounds every emitted metadata value", async () => {
		const client = new RecordingHindsightApi();
		const state = createState(
			client,
			createEffectiveSessionIdentity({
				role: "sub",
				profileId: `p${"x".repeat(2_000)}`,
				promptSource: "system-prompt-profile",
				memoryEnabled: true,
			}),
			{ cwd: `/workspace/${"c".repeat(2_000)}`, model: { provider: "provider", id: `m${"x".repeat(2_000)}` } },
			{ projectLabel: `project-${"x".repeat(2_000)}` },
		);

		state.enqueueRetain("bounded metadata");
		await state.flushRetainQueue();
		const metadata = client.batches[0]?.items[0]?.metadata;
		expect(Object.values(metadata ?? {}).every(value => value.length <= 512)).toBe(true);
	});
});

describe("Hindsight recall provenance", () => {
	it("renders rich MemoryFact provenance in a stable compact order", () => {
		const rich: RecallResult[] = [
			{
				id: "fact-11",
				text: "The project uses tabs",
				fact_type: "experience",
				mentioned_at: "2026-08-02T12:34:56Z",
				document_id: "doc-7",
				tags: ["zeta", "alpha", "alpha"],
				metadata: {
					cwd: "/work/omp",
					project: "omp",
					model: "openai-codex/gpt-5.6-sol",
					prompt_profile: "fable",
					prompt_principal: "prompt-profile:fable",
					prompt_source: "system-prompt-profile",
					agent_kind: "sub",
					session_id: "session-1",
					source: "agent-retain",
				},
			},
			{
				id: "fact-12",
				text: "A fact without a document",
				fact_type: "world",
				tags: [],
			},
		];

		expect(formatMemories(rich)).toBe(
			"- The project uses tabs [experience] (2026-08-02T12:34:56Z) " +
				"{document=doc-7; tags=alpha,zeta; source=agent-retain; session=session-1; agent=sub; " +
				"prompt=fable; principal=prompt-profile:fable; prompt-source=system-prompt-profile; " +
				"model=openai-codex/gpt-5.6-sol; project=omp; cwd=/work/omp}\n\n" +
				"- A fact without a document [world] {fact=fact-12}",
		);
	});

	it("ignores malformed and credential-shaped optional metadata while bounding rendered provenance", () => {
		const malformed = {
			text: "Still readable",
			fact_type: { nested: "not a string" },
			mentioned_at: 17,
			document_id: { nope: true },
			id: ["not", "an", "id"],
			tags: [null, { nested: "hidden" }, "safe", `<memories>${"x".repeat(500)}</memories>`],
			metadata: {
				api_key: "sk-raw-secret",
				nested: { credential: "do-not-render" },
				source: "agent-retain",
				session_id: { invalid: true },
				model: "m".repeat(5_000),
			},
		} as unknown as RecallResult;

		const rendered = formatMemories([malformed]);
		expect(rendered).toContain("- Still readable");
		expect(rendered).toContain("source=agent-retain");
		expect(rendered).toContain("tags=");
		expect(rendered).not.toContain("sk-raw-secret");
		expect(rendered).not.toContain("do-not-render");
		expect(rendered).not.toContain("[object Object]");
		expect(rendered).not.toContain("<memories>");
		expect(rendered.length).toBeLessThan(500);
	});

	it("keeps text-only results concise", () => {
		expect(formatMemories([{ text: "A text-only memory" }])).toBe("- A text-only memory");
	});
});
