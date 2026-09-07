import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { getProjectAgentDir, getProjectDir, setProjectDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
	it.each(["hindsight", "mnemopi"] as const)("keeps %s disabled in restricted sessions after /move", async backend => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-restricted-memory-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");
		await Promise.all(
			[cwdA, cwdB].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend },
						hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
						mnemopi: { noEmbeddings: true, llmMode: "none" },
					}),
				),
			),
		);
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			restrictToolNames: true,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		const originalProjectDir = getProjectDir();
		try {
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			const output: string[] = [];
			await executeAcpBuiltinSlashCommand("/move " + cwdB, {
				session,
				sessionManager,
				settings,
				cwd: cwdA,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
			expect(output.join("\n")).toContain("Moved to ");
			expect(sessionManager.getCwd()).toBe(cwdB);
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			// Explicit backend reapplication must preserve the same startup policy.
			await session.applyMemoryBackend();
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			setProjectDir(originalProjectDir);
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
