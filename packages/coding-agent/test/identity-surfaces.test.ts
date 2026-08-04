import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FooterComponent } from "@oh-my-pi/pi-coding-agent/modes/components/footer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	createEffectiveSessionIdentity,
	type EffectivePromptSource,
	formatAgentIdentityBadge,
	formatAgentIdentityReport,
	snapshotAgentIdentity,
} from "@oh-my-pi/pi-coding-agent/session/identity";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { visibleWidth } from "@oh-my-pi/pi-tui";

interface SessionStubOptions {
	role?: "main" | "sub";
	promptProfile?: string;
	promptSource?: EffectivePromptSource;
	memoryEnabled?: boolean;
	model?: { provider: string; id: string; contextWindow: number };
	memoryBackend?: "off" | "local" | "hindsight" | "mnemopi";
	hindsight?: {
		bankId: string;
		projectLabel: string;
		config: { scoping: "global" | "per-project" | "per-project-tagged" };
		retainTags?: string[];
		recallTags?: string[];
	};
}

function sessionStub(options: SessionStubOptions = {}): AgentSession {
	const model = options.model;
	const effectiveIdentity = createEffectiveSessionIdentity({
		role: options.role ?? "main",
		promptSource: options.promptSource ?? (options.promptProfile ? "system-prompt-profile" : "maintained-omp-prompt"),
		memoryEnabled: options.memoryEnabled ?? true,
		...(options.promptProfile ? { profileId: options.promptProfile } : {}),
	});
	return {
		effectiveIdentity,
		model,
		sessionId: "session-01",
		settings: {
			get: (path: string) => (path === "memory.backend" ? (options.memoryBackend ?? "off") : undefined),
		},
		getHindsightSessionState: () => options.hindsight,
		state: { model },
		sessionManager: { getEntries: () => [] },
		getContextUsage: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
		isAutoThinking: false,
	} as unknown as AgentSession;
}
beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("canonical agent identity surfaces", () => {
	test("registers only /identity and emits the canonical derived report", async () => {
		const session = sessionStub({
			role: "sub",
			promptProfile: "fable",
			model: { provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000 },
			memoryBackend: "hindsight",
			hindsight: {
				bankId: "pale-meridian",
				projectLabel: "pale-meridian",
				config: { scoping: "per-project-tagged" },
				retainTags: ["project:pale-meridian", "agent:fable"],
				recallTags: ["project:pale-meridian"],
			},
		});
		const snapshot = snapshotAgentIdentity(session);
		const report = formatAgentIdentityReport(snapshot);
		const identity = lookupBuiltinSlashCommand("identity");
		const output = vi.fn(async (_text: string) => undefined);

		expect(identity?.name).toBe("identity");
		expect(identity?.aliases ?? []).not.toContain("whoami");
		expect(lookupBuiltinSlashCommand("whoami")).toBeUndefined();
		expect(report).toContain("Role: sub");
		expect(report).toContain("Prompt principal: prompt-profile:fable");
		expect(report).toContain("Prompt profile: fable");
		expect(report).toContain("Prompt source: system-prompt-profile");
		expect(report).toContain("Model: anthropic/claude-opus-5");
		expect(report).toContain("Session ID: session-01");
		expect(report).toContain("Memory backend: hindsight");
		expect(report).toContain("Active Hindsight bank: pale-meridian");
		expect(report).toContain("Project: pale-meridian");
		expect(report).toContain("Scope: per-project-tagged");
		expect(report).toContain("Tags: agent:fable, project:pale-meridian");
		expect(formatAgentIdentityBadge(snapshot)).toBe("prompt-profile:fable@pale-meridian/project:pale-meridian");

		await identity?.handle?.({ name: "identity", args: "", text: "/identity" }, {
			session,
			output,
		} as unknown as SlashCommandRuntime);
		expect(output).toHaveBeenCalledWith(report);
		const footer = new FooterComponent(session);
		const lines = footer.render(160);
		expect(lines).toHaveLength(2);
		expect(stripVTControlCharacters(lines[1] ?? "")).toContain(formatAgentIdentityBadge(snapshot));
		expect(stripVTControlCharacters(lines[1] ?? "")).toContain("anthropic/claude-opus-5");
	});

	test("distinguishes policy denial, backend disablement, and a configured backend not yet started", () => {
		const disabled = snapshotAgentIdentity(sessionStub());
		const configured = snapshotAgentIdentity(sessionStub({ memoryBackend: "hindsight" }));
		const denied = snapshotAgentIdentity(
			sessionStub({
				promptProfile: "isolated",
				memoryEnabled: false,
				memoryBackend: "hindsight",
			}),
		);

		expect(disabled.memory.hindsight).toEqual({ status: "disabled" });
		expect(formatAgentIdentityReport(disabled)).toContain("Memory backend: off (disabled)");
		expect(formatAgentIdentityReport(disabled)).toContain("Active Hindsight bank: disabled");
		expect(formatAgentIdentityReport(disabled)).toContain("Model: unavailable");
		expect(formatAgentIdentityBadge(disabled)).toBe("maintained-omp-prompt@disabled");
		expect(formatAgentIdentityReport(disabled)).toContain("Prompt source: maintained-omp-prompt");
		expect(configured.memory.hindsight).toEqual({ status: "configured-not-started" });
		expect(formatAgentIdentityReport(configured)).toContain("Active Hindsight bank: configured-not-started");
		expect(formatAgentIdentityReport(configured)).toContain("Scope: configured-not-started");
		expect(formatAgentIdentityReport(configured)).toContain("Project: configured-not-started");
		expect(formatAgentIdentityReport(configured)).toContain("Tags: configured-not-started");
		expect(denied.memory.hindsight).toEqual({ status: "disabled-by-profile" });
		expect(formatAgentIdentityReport(denied)).toContain("Memory permission: disabled by prompt profile isolated");
		expect(formatAgentIdentityReport(denied)).toContain("Active Hindsight bank: disabled-by-profile");
	});

	test("keeps the existing footer rows and every line bounded at narrow widths", () => {
		const session = sessionStub({
			promptProfile: "long-prompt-profile",
			model: { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 128_000 },
			memoryBackend: "hindsight",
			hindsight: {
				bankId: "long-hindsight-bank-name",
				projectLabel: "pale-meridian",
				config: { scoping: "global" },
			},
		});
		const footer = new FooterComponent(session);
		footer.setExtensionStatus("zeta", "second\nstatus");
		footer.setExtensionStatus("alpha", "first\tstatus");

		const width = 24;
		const lines = footer.render(width);
		expect(lines).toHaveLength(3);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		expect(stripVTControlCharacters(lines[2] ?? "")).not.toMatch(/[\n\t]/);
		expect(stripVTControlCharacters(lines[2] ?? "")).toStartWith("first status second");
	});
});
