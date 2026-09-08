/**
 * Backend behavioural contract tests.
 *
 * These exercise hindsightBackend.start / preCompactionContext / clear without
 * a real AgentSession by passing a fake session that exposes a `subscribe`
 * method we can drive manually. The HindsightApi is spied via
 * `vi.spyOn(HindsightApi.prototype, ...)` per AGENTS.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	hindsightBackend,
	rebindMemoryBackendForCwd,
	reloadMentalModelsForSession,
} from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightRetainQueue, type HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionMemory } from "@oh-my-pi/pi-coding-agent/session/session-memory";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";

interface FakeSessionDeps {
	sessionId: string | null;
	cwd?: string;
	entries?: Array<{ role: "user" | "assistant"; text: string }>;
	settings?: Settings;
	memoryBinding?: { principal: string; bankId: string };
}

function makeFakeSession(deps: FakeSessionDeps) {
	const listeners = new Set<AgentSessionEventListener>();
	const entries = deps.entries ?? [];
	let hindsightState: HindsightSessionState | undefined;
	let memoryTransition: Promise<void> = Promise.resolve();
	const session = {
		sessionId: deps.sessionId,
		effectiveIdentity: {
			role: "main",
			prompt: { profileId: undefined, principal: "maintained-omp-prompt", source: "maintained-omp-prompt" },
			memory: { status: "enabled", memoryBinding: deps.memoryBinding },
		},
		model: undefined,
		settings: deps.settings ?? Settings.isolated(),
		sessionManager: {
			getEntries: () =>
				entries.map((e, i) => ({
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					timestamp: new Date(0).toISOString(),
					type: "message" as const,
					message:
						e.role === "user"
							? {
									role: "user" as const,
									content: e.text,
									timestamp: 0,
								}
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: e.text }],
									model: "x",
									provider: "x",
									api: "x",
									stopReason: "end_turn" as const,
									timestamp: 0,
								},
				})),
			getCwd: () => deps.cwd ?? "/tmp",
			getSessionFile: () => null,
			getSessionId: () => deps.sessionId ?? "",
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		emitNotice: vi.fn(),
		getHindsightSessionState: () => hindsightState,
		setHindsightSessionState(state: HindsightSessionState | undefined) {
			const previous = hindsightState;
			hindsightState = state;
			return previous;
		},
		async applyMemoryBackend() {
			const transition = memoryTransition.then(async () => {
				const previous = hindsightState;
				await previous?.retireRetainQueue();
				hindsightState = undefined;
				previous?.dispose();
				await hindsightBackend.start({
					session: session as never,
					settings: session.settings,
					modelRegistry: {} as never,
					agentDir: "/tmp",
					taskDepth: 0,
				});
			});
			memoryTransition = transition.then(
				() => undefined,
				() => undefined,
			);
			await transition;
		},
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const l of [...listeners]) l(event);
		},
		listenerCount: () => listeners.size,
	};
	return session;
}

describe("hindsightBackend.start", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does nothing when memory.backend is hindsight but apiUrl is empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const session = makeFakeSession({ sessionId: "s1" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});

	it("registers per-session state and subscribes to agent events when configured", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s2" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeDefined();
		expect(session.getHindsightSessionState()?.bankId).toBeTruthy();
	});

	it("rekeys state when the same AgentSession gets a new session id (resume/switch)", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s-before" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		(session as { sessionId: string | null }).sessionId = "s-after";
		session.getHindsightSessionState()?.setSessionId("s-after");
		expect(session.getHindsightSessionState()?.sessionId).toBe("s-after");
		expect(session.getHindsightSessionState()?.bankId).toBeTruthy();
	});

	it("retains every Nth user turn on agent_end and skips intermediate turns", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 2,
		});
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const entries: Array<{ role: "user" | "assistant"; text: string }> = [];
		const session = makeFakeSession({ sessionId: "s3", entries });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		// Turn 1: not enough turns yet
		entries.push({ role: "user", text: "first user message that is long enough" });
		entries.push({ role: "assistant", text: "first assistant reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(0);

		// Turn 2: hits the threshold
		entries.push({ role: "user", text: "second user message that is long enough" });
		entries.push({ role: "assistant", text: "second reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0]?.[2]?.timestamp).toBeInstanceOf(Date);
	});

	it("aliases parent state on subagent runs (taskDepth > 0) so tools share the parent bank", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});

		// Register a primary (top-level) state first.
		const parentSession = makeFakeSession({ sessionId: "parent" });
		await hindsightBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const parentState = parentSession.getHindsightSessionState();

		// Subagent runs with taskDepth > 0 should alias the parent.
		const subSession = makeFakeSession({ sessionId: "sub" });
		await hindsightBackend.start({
			session: subSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parentState,
		});
		const subState = subSession.getHindsightSessionState();
		expect(subState?.aliasOf).toBe(parentState);
		expect(subState?.bankId).toBe(parentState?.bankId);
		expect(subState?.client).toBe(parentState?.client);
		expect(subState?.banksSet).toBe(parentState?.banksSet);
		// Aliases must not subscribe to session events — the parent owns auto-recall/auto-retain.
		expect(subState?.unsubscribe).toBeUndefined();
		// hasRecalledForFirstTurn=true suppresses beforeAgentStartPrompt auto-recall on the sub.
		expect(subState?.hasRecalledForFirstTurn).toBe(true);
	});

	it("retires a child's previous alias when a direct parent reference is stale", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const parentSession = makeFakeSession({ sessionId: "stale-direct-parent" });
		await hindsightBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const staleParent = parentSession.getHindsightSessionState();
		const childSession = makeFakeSession({ sessionId: "stale-direct-child" });
		await hindsightBackend.start({
			session: childSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: staleParent,
		});
		const previous = childSession.getHindsightSessionState()!;
		const retire = vi.spyOn(previous, "retireRetainQueue");
		const dispose = vi.spyOn(previous, "dispose");

		await hindsightBackend.clear("/tmp", "/tmp", parentSession as never);
		await expect(
			hindsightBackend.start({
				session: childSession as never,
				settings,
				modelRegistry: {} as never,
				agentDir: "/tmp",
				taskDepth: 1,
				parentHindsightSessionState: staleParent,
			}),
		).resolves.toBeUndefined();
		expect(childSession.getHindsightSessionState()).toBeUndefined();
		expect(retire).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("retires a grandchild's previous alias when its nested parent alias is stale", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const primarySession = makeFakeSession({ sessionId: "stale-nested-primary" });
		await hindsightBackend.start({
			session: primarySession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const parentSession = makeFakeSession({ sessionId: "stale-nested-parent" });
		await hindsightBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: primarySession.getHindsightSessionState(),
		});
		const staleParentAlias = parentSession.getHindsightSessionState();
		const grandchildSession = makeFakeSession({ sessionId: "stale-nested-grandchild" });
		await hindsightBackend.start({
			session: grandchildSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 2,
			parentHindsightSessionState: staleParentAlias,
		});
		const previous = grandchildSession.getHindsightSessionState()!;
		const retire = vi.spyOn(previous, "retireRetainQueue");
		const dispose = vi.spyOn(previous, "dispose");

		await hindsightBackend.clear("/tmp", "/tmp", primarySession as never);
		await expect(
			hindsightBackend.start({
				session: grandchildSession as never,
				settings,
				modelRegistry: {} as never,
				agentDir: "/tmp",
				taskDepth: 2,
				parentHindsightSessionState: staleParentAlias,
			}),
		).resolves.toBeUndefined();
		expect(grandchildSession.getHindsightSessionState()).toBeUndefined();
		expect(retire).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("returns silently for subagent runs when no primary state has been registered", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "orphan-sub" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});
});

describe("hindsightBackend.preCompactionContext", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns undefined when no apiUrl is configured", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings);
		expect(ctx).toBeUndefined();
	});

	it("returns a <memories> block when recall yields results", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s5" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "remembered fact" }],
		} as never);

		const messages: AgentMessage[] = [{ role: "user", content: "What did we decide?", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings, session as never);
		expect(ctx).toContain("<memories>");
		expect(ctx).toContain("remembered fact");
	});

	it("returns undefined when recall finds nothing", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s6" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const messages: AgentMessage[] = [{ role: "user", content: "anything", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings, session as never);
		expect(ctx).toBeUndefined();
	});
});

describe("hindsightBackend first-turn injection", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns a tagged block for the current first turn before agent_start", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({
			sessionId: "s8",
			entries: [{ role: "assistant", text: "previous assistant context" }],
		});
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "Can prefers concise communication" }],
		} as never);

		const block = await hindsightBackend.beforeAgentStartPrompt?.(
			session as never,
			"What do I know about this user?",
		);
		expect(block).toContain("<memories>");
		expect(block).toContain("Can prefers concise communication");
		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(true);
		expect(session.getHindsightSessionState()?.lastRecallSnippet).toBe(block);
	});

	it("does not let agent_start preempt first-turn recall injection", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({
			sessionId: "s-race",
			entries: [{ role: "user", text: "What is the canary phrase?" }],
		});
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "The canary phrase is PURPLE-OTTER-9931." }],
		} as never);

		// The agent loop fires agent_start once the turn begins. This must NOT run
		// its own recall: doing so consumed the shared first-turn flag and left
		// injection to a racing background prompt rebuild that a fast turn outran,
		// dropping recalled memory from the model's prompt (#7568).
		session.emit({ type: "agent_start" });
		for (let i = 0; i < 50; i++) await Promise.resolve();

		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(false);

		// beforeAgentStartPrompt is the sole, awaited injection path.
		const block = await hindsightBackend.beforeAgentStartPrompt?.(session as never, "What is the canary phrase?");
		expect(block).toContain("PURPLE-OTTER-9931");
		expect(session.getHindsightSessionState()?.hasRecalledForFirstTurn).toBe(true);
	});

	it("keeps the <memories> wrapper in buildDeveloperInstructions", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s9" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const state = session.getHindsightSessionState();
		state!.lastRecallSnippet = "<memories>\nremembered fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(prompt).toContain("<memories>");
		expect(prompt).toContain("</memories>");
		expect(prompt).toContain("remembered fact");
	});

	it("places the <mental_models> block above the <memories> recall block in developer instructions", async () => {
		// Stable, curated semantic memory must come first so the LLM's prior is
		// anchored on it; the volatile per-turn recall block follows. Ordering
		// is part of the integration's behavioural contract.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		const session = makeFakeSession({ sessionId: "s-order" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();
		state!.mentalModelsSnippet = "<mental_models>\n# User Preferences\nprefers tabs\n</mental_models>";
		state!.lastRecallSnippet = "<memories>\nrecalled fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		// `<memories>` and `<mental_models>` are mentioned in STATIC_INSTRUCTIONS
		// bullets too. Match the actual injected block opener (tag + newline)
		// to disambiguate documentation prose from the injected payloads.
		const mmIdx = prompt!.indexOf("<mental_models>\n");
		const memIdx = prompt!.indexOf("<memories>\n");
		expect(mmIdx).toBeGreaterThanOrEqual(0);
		expect(memIdx).toBeGreaterThanOrEqual(0);
		expect(mmIdx).toBeLessThan(memIdx);
	});

	it("reloadMentalModelsForSession refreshes the cached snippet and base prompt", async () => {
		// Defends the TTL/manual reload contract: a fresh `listMentalModels`
		// must update both `mentalModelsSnippet` and `mentalModelsLoadedAt`,
		// and call `refreshBaseSystemPrompt` so the next turn picks up the
		// new content.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		const session = makeFakeSession({ sessionId: "s-ttl" });
		// Initial start may issue its own listMentalModels (read-only by default);
		// stub it to return nothing so the initial snippet is undefined.
		const listSpy = vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		// Wait for the kicked-off load to settle.
		await session.getHindsightSessionState()?.mentalModelsLoadPromise;
		const state = session.getHindsightSessionState();
		expect(state!.mentalModelsSnippet).toBeUndefined();
		expect(state!.mentalModelsLoadedAt).toBeDefined();
		const initialLoadedAt = state!.mentalModelsLoadedAt!;
		const refreshSpy = session.refreshBaseSystemPrompt;
		const callsBefore = refreshSpy.mock.calls.length;

		// Now publish content and trigger a reload.
		listSpy.mockResolvedValue({
			items: [
				{
					id: "user-preferences",
					bank_id: state!.bankId,
					name: "User Preferences",
					content: "prefers concise prose",
				},
			],
		} as never);
		// Force the loadedAt timestamp to differ so the next assertion is meaningful.
		state!.mentalModelsLoadedAt = initialLoadedAt - 1000;

		const ok = await reloadMentalModelsForSession(session as never);
		expect(ok).toBe(true);
		expect(state!.mentalModelsSnippet).toContain("# User Preferences");
		expect(state!.mentalModelsSnippet).toContain("prefers concise prose");
		expect(state!.mentalModelsLoadedAt).toBeGreaterThan(initialLoadedAt - 1000);
		expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsBefore);
	});

	it("reloadMentalModelsForSession returns false on subagent aliases", async () => {
		// Aliases delegate to the parent; reloads on an alias must no-op so
		// the parent's cache is the single source of truth.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		const parent = makeFakeSession({ sessionId: "alias-parent" });
		await hindsightBackend.start({
			session: parent as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const child = makeFakeSession({ sessionId: "alias-child" });
		await hindsightBackend.start({
			session: child as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: parent.getHindsightSessionState(),
		});
		const ok = await reloadMentalModelsForSession(child as never);
		expect(ok).toBe(false);
	});
});

describe("hindsightBackend.clear", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops every registered session state", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s7" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()).toBeDefined();

		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		expect(session.getHindsightSessionState()).toBeUndefined();
	});

	it("does not delete server-side mental models on /memory clear (server-side state is sacred)", async () => {
		// `/memory clear` is documented to wipe only the local recall cache.
		// Mental models persist on the Hindsight server across sessions and
		// must not be silently deleted by a local clear command — operators
		// who actually want to drop server-side state use the Hindsight UI or
		// `/memory mm delete <id>` explicitly.
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
		});
		vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
		const deleteSpy = vi.spyOn(HindsightApi.prototype, "deleteMentalModel").mockResolvedValue(true);
		const session = makeFakeSession({ sessionId: "s-clear-mm" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		expect(deleteSpy).not.toHaveBeenCalled();
	});
});

describe("hindsightBackend live bank routing", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression for issue #1902: changing `hindsight.bankId` during a live
	// session used to leave the active `HindsightSessionState` pinned to the
	// bank that was selected when the session started, so subsequent retains
	// kept landing in the stale bank ("omp") instead of the new one
	// ("Minigames"). The bank-routing settings must re-resolve on `set`.
	it("rebuilds the primary state when hindsight.bankId changes mid-session", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "global",
		});
		// Seed bankId via `set` (not `isolated` overrides), otherwise the
		// follow-up `set` writes to `#global` while `get` keeps returning the
		// `#overrides` value — exactly the precedence the live settings UI
		// does NOT have, since real config writes land in `#global`.
		settings.set("hindsight.bankId", "omp");
		const session = makeFakeSession({ sessionId: "s-rebuild", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("omp");

		settings.set("hindsight.bankId", "Minigames");
		// Hook is sync but the rebuild is async; yield once so the handler runs.
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("Minigames");
		// Must be a brand-new state — the old one was disposed.
		expect(next).not.toBe(initial);
	});

	it("keeps a cwd move pending until the old retain route drains and the new route is installed", async () => {
		const retainGate = Promise.withResolvers<void>();
		const firstBatchStarted = Promise.withResolvers<void>();
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockImplementation(async () => {
			firstBatchStarted.resolve();
			await retainGate.promise;
			return {} as never;
		});
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "per-project",
		});
		const deps: FakeSessionDeps = { sessionId: "cwd-route-gate", cwd: "/work/cwd-old", settings };
		const session = makeFakeSession(deps);
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = session.getHindsightSessionState()!;
		const initialBank = initial.bankId;
		initial.enqueueRetain("accepted before cwd move");
		const oldFlush = initial.flushRetainQueue();
		await firstBatchStarted.promise;

		deps.cwd = "/work/cwd-new";
		await settings.reloadForCwd(deps.cwd);
		let moveSettled = false;
		const routeRebound = rebindMemoryBackendForCwd(session as never).then(() => {
			moveSettled = true;
		});
		await Bun.sleep(0);
		expect(moveSettled).toBe(false);
		expect(session.getHindsightSessionState()).toBe(initial);

		retainGate.resolve();
		await Promise.all([oldFlush, routeRebound]);
		const next = session.getHindsightSessionState()!;
		expect(next).not.toBe(initial);
		expect(next.bankId).not.toBe(initialBank);

		next.enqueueRetain("accepted after cwd move");
		await next.flushRetainQueue();
		expect(retainBatchSpy.mock.calls.map(([bankId]) => bankId)).toEqual([initialBank, next.bankId]);
	});

	it("moves live subagent aliases with the parent while preserving queued retain routes", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "global",
		});
		settings.set("hindsight.bankId", "omp");
		const parentSession = makeFakeSession({ sessionId: "parent-live-route", settings });
		await hindsightBackend.start({
			session: parentSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = parentSession.getHindsightSessionState();
		expect(initial?.bankId).toBe("omp");

		const childSession = makeFakeSession({ sessionId: "child-live-route", settings });
		await hindsightBackend.start({
			session: childSession as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentHindsightSessionState: initial,
		});
		const alias = childSession.getHindsightSessionState();
		expect(alias?.aliasOf).toBe(initial);
		alias!.enqueueRetain("queued before parent route change");

		settings.set("hindsight.bankId", "Minigames");
		await Bun.sleep(0);

		const next = parentSession.getHindsightSessionState();
		expect(next).toBeDefined();
		expect(next).not.toBe(initial);
		expect(alias?.aliasOf).toBe(next);
		expect(alias?.bankId).toBe("Minigames");
		expect(alias?.client).toBe(next?.client);
		expect(alias?.config).toBe(next?.config);
		expect(alias?.banksSet).toBe(next?.banksSet);

		alias!.enqueueRetain("queued after parent route change");
		await alias!.flushRetainQueue();

		const retainedByBank = new Map(
			retainBatchSpy.mock.calls.map(([bankId, items]) => [bankId, items.map(item => item.content)]),
		);
		expect(retainedByBank.get("omp")).toEqual(["queued before parent route change"]);
		expect(retainedByBank.get("Minigames")).toEqual(["queued after parent route change"]);
	});

	// Same regression, exercising the `hindsight.scoping` axis: switching
	// scope mode also reshapes the bank id / tag filters and must rebuild.
	it("rebuilds the primary state when hindsight.scoping changes mid-session", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "global");
		const session = makeFakeSession({ sessionId: "s-scoping", cwd: "/work/proj", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("omp");
		expect(initial?.retainTags).toBeUndefined();

		settings.set("hindsight.scoping", "per-project");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("omp-proj");
		expect(next).not.toBe(initial);
	});

	// Same setting written with the same value MUST NOT rebuild — a rebuild
	// would reset `lastRetainedTurn` / `hasRecalledForFirstTurn` and force a
	// fresh mental-model bootstrap for no observable reason.
	it("does not rebuild when the bank-routing setting is rewritten with the same value", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.bankId", "omp");
		const session = makeFakeSession({ sessionId: "s-noop", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const initial = session.getHindsightSessionState();
		settings.set("hindsight.bankId", "omp"); // unchanged
		await Bun.sleep(0);

		expect(session.getHindsightSessionState()).toBe(initial);
	});

	// Same regression flipped: resetting `hindsight.bankId` back to blank /
	// default after a non-empty value MUST also rebuild and route subsequent
	// retains to the default bank. The Codex-flagged follow-up was that the
	// fix had to be bidirectional — set→value AND value→reset. We defend the
	// reset direction end-to-end by enqueuing a retain after the reset and
	// asserting the batch call hits the recomputed bank, not the previous one.
	it("rebuilds when hindsight.bankId is reset to blank after a non-empty value", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "per-project");
		settings.set("hindsight.bankId", "Minigames");
		const session = makeFakeSession({ sessionId: "s-reset", cwd: "/work/_NEW_XenGameKit", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("Minigames-_new_xengamekit");

		// Operator clears the bankId via the TUI — `settings.set(path, "")` is
		// the same call shape `#setSettingValue` uses for an empty text input.
		settings.set("hindsight.bankId", "");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next).not.toBe(initial);
		// With scoping=per-project the base falls back to the default ("omp"),
		// so the reset bank id picks up the project suffix from cwd.
		expect(next?.bankId).toBe("omp-_new_xengamekit");

		next!.enqueueRetain("post-reset fact", "reset routing");
		await next!.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(retainBatchSpy.mock.calls[0][0]).toBe("omp-_new_xengamekit");
	});

	// Companion case: when `hindsight.scoping` is `global`, clearing the
	// non-empty bankId should restore the bare `omp` default — the operator's
	// stated expectation in the live repro from #1902.
	it("routes future retains to the bare omp bank when bankId is cleared in global scoping", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "global");
		settings.set("hindsight.bankId", "Minigames-_NEW_XenGameKit");
		const session = makeFakeSession({ sessionId: "s-reset-global", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()?.bankId).toBe("Minigames-_NEW_XenGameKit");

		settings.set("hindsight.bankId", "");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("omp");

		next!.enqueueRetain("post-reset global fact");
		await next!.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(retainBatchSpy.mock.calls[0][0]).toBe("omp");
	});

	it("coalesces synchronous routing hooks so rebuilt states do not leak agent listeners", async () => {
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 1,
		});
		settings.set("hindsight.bankId", "omp");
		settings.set("hindsight.scoping", "global");
		const entries = [
			{ role: "user" as const, text: "remember this routing coalesce fact" },
			{ role: "assistant" as const, text: "acknowledged routing coalesce fact" },
		];
		const session = makeFakeSession({ sessionId: "s-coalesce", cwd: "/work/proj", entries, settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.listenerCount()).toBe(1);

		// Mirrors `Settings.#fireAllHooks()` during cwd reload: all three
		// Hindsight routing hooks can fire synchronously before the first async
		// queue flush continuation resumes. They must collapse into one rebuild.
		settings.set("hindsight.bankIdPrefix", "live");
		settings.set("hindsight.bankId", "Minigames");
		settings.set("hindsight.scoping", "per-project");
		await Bun.sleep(0);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("live-Minigames-proj");
		expect(session.listenerCount()).toBe(1);

		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0][0]).toBe("live-Minigames-proj");
	});

	// Regression for issue #1902 fix #2: mental-model auto-seed used to POST
	// `createMentalModel` against a bank the server never saw, because the
	// old `ensureBankMission` skipped creation entirely when `bankMission`
	// was blank. The bank MUST be PUT (created) before any mental-model POST.
	it("creates the bank before mental-model bootstrap even when bankMission is blank", async () => {
		const callOrder: string[] = [];
		const createBankSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockImplementation(async () => {
			callOrder.push("createBank");
			return {} as never;
		});
		const listMentalSpy = vi.spyOn(HindsightApi.prototype, "listMentalModels").mockImplementation(async () => {
			callOrder.push("listMentalModels");
			return { items: [] } as never;
		});
		const createMentalModelSpy = vi
			.spyOn(HindsightApi.prototype, "createMentalModel")
			.mockImplementation(async () => {
				callOrder.push("createMentalModel");
				return {} as never;
			});

		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": true,
			"hindsight.mentalModelAutoSeed": true,
			"hindsight.bankMission": "",
		});
		const session = makeFakeSession({ sessionId: "s-bank-first", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		await session.getHindsightSessionState()?.mentalModelsLoadPromise;

		expect(createBankSpy).toHaveBeenCalled();
		// First call must be `createBank`. Otherwise the mental-model POST
		// lands against a never-created bank and the server FK-fails it.
		expect(callOrder[0]).toBe("createBank");
		// Mental-model POSTs are allowed but they MUST come after the bank
		// is on the server.
		if (createMentalModelSpy.mock.calls.length > 0) {
			const bankIdx = callOrder.indexOf("createBank");
			const mmIdx = callOrder.indexOf("createMentalModel");
			expect(bankIdx).toBeLessThan(mmIdx);
		}
		void listMentalSpy;
	});
});

describe("hindsightBackend bound memory owner", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const BINDING = { principal: "alpha", bankId: "private-alpha" };

	// The bound bank is the owner's, so the global bank selectors are not route
	// selectors for it: editing them must neither move the bank nor churn the
	// live state (a rebuild resets recall/retain progress for no reason).
	it("uses the owner bank verbatim and stays immune to global bank edits", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "global",
		});
		settings.set("hindsight.bankId", "omp");
		const session = makeFakeSession({ sessionId: "s-bound", settings, memoryBinding: BINDING });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("private-alpha");

		settings.set("hindsight.bankId", "Minigames");
		settings.set("hindsight.bankIdPrefix", "live");
		// Drain the rebuild the hooks queued instead of racing it on a timer.
		await rebindMemoryBackendForCwd(session as never);

		expect(session.getHindsightSessionState()).toBe(initial);
		initial!.enqueueRetain("bound fact");
		await initial!.flushRetainQueue();
		expect(retainBatchSpy.mock.calls[0][0]).toBe("private-alpha");
		expect(retainBatchSpy.mock.calls[0][1][0]?.tags).toEqual(["principal:alpha"]);
	});

	// A project layer that repoints the service would put the owner's bank on a
	// different server, under different credentials — a different owner.
	it("refuses a live Hindsight service change and keeps serving the owner bank", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "global",
		});
		const session = makeFakeSession({ sessionId: "s-bound-refuse", settings, memoryBinding: BINDING });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("private-alpha");

		settings.override("hindsight.apiUrl", "http://localhost:9999");
		await rebindMemoryBackendForCwd(session as never);

		expect(session.getHindsightSessionState()).toBe(initial);
		expect(session.emitNotice).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining("Memory stays bound to bank private-alpha"),
			"Hindsight",
		);
	});

	// The live `memory.backend` edit reaches the runtime through the session's
	// backend owner, not the Hindsight scope hooks, so the refusal has to hold
	// at that chokepoint — before it drains and disposes the bound route.
	it("refuses a live backend switch that would move the bound owner", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated();
		settings.set("hindsight.apiUrl", "http://localhost:8888");
		settings.set("hindsight.scoping", "global");
		// `set`, not an isolated override: an override would shadow the later
		// backend edit and the switch under test would never be seen.
		settings.set("memory.backend", "hindsight");
		const session = makeFakeSession({ sessionId: "s-bound-backend", settings, memoryBinding: BINDING });
		const memory = new SessionMemory(
			{
				agent: { sessionId: "s-bound-backend" } as never,
				settings,
				modelRegistry: {} as never,
				isDisposed: () => false,
				memoryEnabled: () => true,
				memoryBackendSession: () => session as never,
				getHindsightSessionState: () => session.getHindsightSessionState(),
				setHindsightSessionState: state => {
					session.setHindsightSessionState(state);
				},
				getMnemopiSessionState: () => undefined,
				takeMnemopiSessionState: () => undefined,
				setBaseSystemPrompt: () => {},
				refreshBaseSystemPrompt: async () => {},
				replaceMemoryTools: async () => {},
			},
			{ memoryAgentDir: "/tmp" },
		);

		await memory.applyMemoryBackend();
		const initial = session.getHindsightSessionState();
		expect(initial?.bankId).toBe("private-alpha");

		settings.set("memory.backend", "mnemopi");
		await memory.applyMemoryBackend();

		expect(session.getHindsightSessionState()).toBe(initial);
		expect(session.emitNotice).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining("the mnemopi memory backend needs a fresh session"),
			"Hindsight",
		);

		settings.set("memory.backend", "off");
		await memory.applyMemoryBackend();
		expect(session.getHindsightSessionState()).toBeUndefined();
		settings.set("memory.backend", "mnemopi");
		const otherBackend = await resolveMemoryBackend(settings);
		if (!otherBackend) throw new Error("Missing test backend");
		const foreignStart = vi.spyOn(otherBackend, "start").mockImplementation(() => {});
		await memory.applyMemoryBackend();
		settings.set("memory.backend", "hindsight");
		settings.set("hindsight.apiUrl", "http://other-service.invalid");
		await memory.applyMemoryBackend();
		expect({
			foreignStarts: foreignStart.mock.calls.length,
			foreignService: session.getHindsightSessionState()?.config.hindsightApiUrl,
		}).toEqual({ foreignStarts: 0, foreignService: undefined });
		settings.set("hindsight.apiUrl", "http://localhost:8888");
		await memory.applyMemoryBackend();
		expect(session.getHindsightSessionState()?.bankId).toBe(BINDING.bankId);
	});

	// Project tagging scopes retrieval inside the owner's bank, so a cwd move
	// re-derives the tags — but never the bank.
	it("re-tags a moved bound session without moving its bank", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "per-project-tagged",
		});
		const deps: FakeSessionDeps = {
			sessionId: "s-bound-move",
			cwd: "/work/source",
			settings,
			memoryBinding: BINDING,
		};
		const session = makeFakeSession(deps);

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()?.retainTags).toEqual(["project:source"]);

		deps.cwd = "/work/destination";
		await rebindMemoryBackendForCwd(session as never);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("private-alpha");
		expect(next?.retainTags).toEqual(["project:destination"]);
		expect(next?.recallTags).toEqual(["project:destination"]);
	});

	// Sharding one owner across a bank per checkout contradicts one bank per
	// owner: refuse instead of writing its memories somewhere else.
	it("refuses to start a bound session under per-project bank splitting", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.scoping": "per-project",
		});
		const session = makeFakeSession({
			sessionId: "s-bound-split",
			cwd: "/work/proj",
			settings,
			memoryBinding: BINDING,
		});

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(session.getHindsightSessionState()).toBeUndefined();
	});
});

describe("hindsightBackend cwd rebind", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// A cwd move used to leave the rebuild queued as a bare microtask, so the
	// prompt that follows `/move` could still recall and retain against the
	// source project's bank. `rebindMemoryBackendForCwd` must have installed
	// the destination route by the time it resolves — no extra yields.
	it("routes the destination project's bank before the move completes", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "per-project");
		// The fake session reads `deps.cwd` on every `getCwd()`, so moving the
		// session manager's cwd is a mutation of this object.
		const deps: FakeSessionDeps = { sessionId: "s-cwd-move", cwd: "/work/source", settings };
		const session = makeFakeSession(deps);

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(session.getHindsightSessionState()?.bankId).toBe("omp-source");

		deps.cwd = "/work/destination";
		await rebindMemoryBackendForCwd(session as never);

		const next = session.getHindsightSessionState();
		expect(next?.bankId).toBe("omp-destination");

		next!.enqueueRetain("fact from the destination project");
		await next!.flushRetainQueue();
		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(retainBatchSpy.mock.calls[0][0]).toBe("omp-destination");
	});

	it.each(["hindsight.bankMission", "hindsight.retainMission"] as const)(
		"updates a confirmed bank when %s changes",
		async missionSetting => {
			const createBank = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
			vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
			const settings = Settings.isolated({
				"memory.backend": "hindsight",
				"hindsight.apiUrl": "http://localhost:8888",
				"hindsight.scoping": "global",
				"hindsight.bankMission": "original reflect mission",
				"hindsight.retainMission": "original retain mission",
				"hindsight.mentalModelsEnabled": false,
			});
			const session = makeFakeSession({ sessionId: "mission-move", cwd: "/work/source", settings });
			try {
				await hindsightBackend.start({
					session: session as never,
					settings,
					modelRegistry: {} as never,
					agentDir: "/tmp",
					taskDepth: 0,
				});
				const initial = session.getHindsightSessionState();
				if (!initial) throw new Error("Hindsight fixture did not start");
				initial.enqueueRetain("source fact");
				await initial.flushRetainQueue();
				expect(createBank).toHaveBeenCalledTimes(1);

				settings.override(missionSetting, "destination mission");
				await rebindMemoryBackendForCwd(session as never);
				const rebound = session.getHindsightSessionState();
				if (!rebound) throw new Error("Hindsight fixture lost its state");
				rebound.enqueueRetain("destination fact");
				await rebound.flushRetainQueue();

				expect(createBank).toHaveBeenCalledTimes(2);
				expect(createBank).toHaveBeenLastCalledWith(initial.bankId, {
					reflectMission:
						missionSetting === "hindsight.bankMission" ? "destination mission" : "original reflect mission",
					retainMission:
						missionSetting === "hindsight.retainMission" ? "destination mission" : "original retain mission",
				});
			} finally {
				session.getHindsightSessionState()?.dispose();
			}
		},
	);

	// The rebuild loop is the only owner of queued rebuild requests, so a
	// request that arrives while one is mid-flight must still be applied —
	// otherwise the move settles on the route of the superseded request.
	it("honors a rebuild requested while the previous one is still in flight", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const parked = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let flushes = 0;
		vi.spyOn(HindsightRetainQueue.prototype, "flush").mockImplementation(async () => {
			flushes++;
			if (flushes > 1) return;
			parked.resolve();
			await gate.promise;
		});
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		settings.set("hindsight.scoping", "global");
		const deps: FakeSessionDeps = { sessionId: "s-cwd-inflight", cwd: "/work/source", settings };
		const session = makeFakeSession(deps);

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		settings.set("hindsight.bankId", "first");
		// The first rebuild is now parked inside the outgoing state's flush.
		await parked.promise;
		settings.set("hindsight.bankId", "second");
		gate.resolve();

		await rebindMemoryBackendForCwd(session as never);

		expect(session.getHindsightSessionState()?.bankId).toBe("second");

		const settledState = session.getHindsightSessionState();
		vi.spyOn(session, "getHindsightSessionState").mockImplementationOnce(() => {
			// Queue after the no-op loop exits, but before its completion settles.
			queueMicrotask(() => queueMicrotask(() => settings.set("hindsight.bankId", "third")));
			return settledState;
		});
		await rebindMemoryBackendForCwd(session as never);
		expect(session.getHindsightSessionState()?.bankId).toBe("third");
		session.getHindsightSessionState()?.dispose();
	});

	// A preserved failure must not be sticky either: when the request that
	// coalesced onto the failed attempt does complete the transition, the
	// session really is rebound and the move has to report success.
	it("clears a failed attempt once a coalesced retry completes the transition", async () => {
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const parked = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let flushes = 0;
		vi.spyOn(HindsightRetainQueue.prototype, "flush").mockImplementation(async () => {
			flushes++;
			if (flushes > 1) return;
			parked.resolve();
			await gate.promise;
			// Fails before the outgoing state is replaced, so the destination
			// route is still unbuilt when the next request runs.
			throw new Error("outgoing flush failed");
		});
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.mentalModelsEnabled": false,
		});
		settings.set("hindsight.scoping", "global");
		const session = makeFakeSession({ sessionId: "s-cwd-retry", cwd: "/work/source", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		try {
			settings.set("hindsight.bankId", "destination");
			await parked.promise;
			// Requested while the doomed attempt is still in flight, so it
			// coalesces onto the same task and inherits its failure.
			const move = rebindMemoryBackendForCwd(session as never);
			gate.resolve();
			await move;

			expect(session.getHindsightSessionState()?.bankId).toBe("destination");
		} finally {
			session.getHindsightSessionState()?.dispose();
		}
	});
});

describe("hindsightBackend retain queue flush on session teardown", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression for issue #1902 fix #3: `AgentSession.dispose` used to clear
	// `#hindsightSessionState` BEFORE draining the retain queue, so the
	// spliced batch was dropped instead of reaching the server. The fix flips
	// the order: the drain MUST complete before the session detaches the
	// state. We defend the contract end-to-end by enqueuing a tool-initiated
	// retain, then calling `retireRetainQueue` in the order
	// `AgentSession.dispose` uses (retire → clear → state.dispose).
	it("flushes the retain queue to the server before the session pointer clears", async () => {
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.bankId": "omp",
		});
		const session = makeFakeSession({ sessionId: "s-dispose-flush", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();

		state!.enqueueRetain("durable fact", "test context");

		// AgentSession.dispose retires intake, drains accepted items, then detaches state.
		await state!.retireRetainQueue();
		session.setHindsightSessionState(undefined);
		state!.dispose();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		const [bankId, items] = retainBatchSpy.mock.calls[0];
		expect(bankId).toBe("omp");
		expect(items).toHaveLength(1);
		expect(items[0].content).toBe("durable fact");
		expect(items[0].timestamp).toBeInstanceOf(Date);
	});

	// Companion contract test: retirement closes intake in the same
	// synchronous step that starts the terminal drain, so a retain accepted
	// before retirement still reaches the server while a later one is
	// refused outright instead of being stranded behind the drain.
	it("atomically closes intake before the terminal retain drain", async () => {
		const flushStarted = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockImplementation(async () => {
			flushStarted.resolve();
			await releaseFlush.promise;
			return {} as never;
		});
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s-atomic-retire", settings });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = session.getHindsightSessionState();
		state!.enqueueRetain("accepted before retirement");

		const retiring = state!.retireRetainQueue();
		await flushStarted.promise;
		expect(() => state!.enqueueRetain("too late")).toThrow("Hindsight retain queue is closed.");
		releaseFlush.resolve();
		await retiring;
		session.setHindsightSessionState(undefined);
		state!.dispose();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		expect(retainBatchSpy.mock.calls[0]?.[1].map(item => item.content)).toEqual(["accepted before retirement"]);
	});
});

describe("direct mental-model command dispatch", () => {
	it("routes /memory mm to Hindsight state without a generic runtime", async () => {
		const showError = vi.fn();
		const controller = new CommandController({
			settings: Settings.isolated({ "memory.backend": "hindsight" }),
			session: { getHindsightSessionState: () => undefined },
			showError,
		} as never);

		await controller.handleMemoryCommand("/memory mm list");

		expect(showError).toHaveBeenCalledWith("Hindsight backend is not active for this session.");
	});
});
