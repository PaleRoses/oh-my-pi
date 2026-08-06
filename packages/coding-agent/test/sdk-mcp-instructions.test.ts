import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	BOUNDED_GUIDANCE_MODE,
	BOUNDED_GUIDANCE_TOOL_COUNT,
	CONTEXT_MODE_NO_INSTRUCTIONS_MODE,
	SERVER_INSTRUCTIONS,
	TOOL_RESULT,
} from "./fixtures/instructions-mcp";

// Contract: a deferred interactive (`hasUI`) session runs MCP discovery off the
// first-paint path. Mounted MCP tools are presented solely through the xd://
// device catalog (overflow one-liners carrying the mount path and the
// server/tool label under the default `builtins` docs mode); a server that
// supplies optional `instructions` triggers a prompt rebuild that folds them
// into their separately framed section, while an instruction-less server stays
// notice-only and leaves the system prompt byte-stable.
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const MCP_TOOL_NAME = "mcp__instr_do_thing";
const MCP_CATALOG_LINE = "- xd://mcp__instr_do_thing (instr/do`thing) — ";
const CONTEXT_MODE_CATALOG_LINE = "- xd://mcp__context_mode_ctx_execute";
const CONTEXT_MODE_MCP_TOOL_NAME = "mcp__context_mode_ctx_execute";

describe("createAgentSession MCP server instructions (deferred UI)", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config through the process-global agent
	// directory. Redirect both that path and os.homedir() so the test connects
	// only to the fixture and never spawns the developer's real MCP servers.
	let originalAgentDir: string;
	let isolatedHome: string;
	let isolatedAgentDir: string;

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		isolatedHome = path.join(os.tmpdir(), `pi-sdk-mcp-instr-home-${Snowflake.next()}`);
		fs.mkdirSync(isolatedHome, { recursive: true });
		isolatedAgentDir = path.join(isolatedHome, ".omp", "agent");
		fs.mkdirSync(isolatedAgentDir, { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(isolatedAgentDir);
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		for (const dir of [registryDir, isolatedHome]) {
			if (dir && fs.existsSync(dir)) {
				removeSyncWithRetries(dir);
			}
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-instr-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		mock.restore();
	});

	it("folds server instructions into the prompt once deferred discovery connects", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			// First paint: discovery is still in flight, so the server's
			// instructions are not yet present.
			expect(session.systemPrompt.join("\n")).not.toContain(SERVER_INSTRUCTIONS);

			// Background connect + `refreshMCPTools` rebuild must surface the
			// instructions. This is a genuine integration wait: discovery spawns
			// the fixture as a real subprocess and connects asynchronously, and
			// the SDK fires that work fire-and-forget with no completion promise
			// or event exposed to await — so fake timers cannot drive it and we
			// poll the live prompt with a generous ceiling, exiting the instant
			// the rebuilt prompt carries the instructions.
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			// The instructions are framed under the MCP section, and the mounted
			// tool is listed in the xd:// device catalog with its server/tool
			// label alongside the exact normalized mount path.
			expect(prompt).toContain("MCP Server Instructions");
			expect(prompt).toContain(MCP_CATALOG_LINE);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("omits server instructions when the selected system prompt profile disables them", async () => {
		const settings = Settings.isolated({
			systemPromptProfiles: {
				worker: { mcpServerInstructions: false },
			},
			systemPromptProfileRoutes: [{ agentKind: "sub", profile: "worker" }],
		});
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			agentKind: "sub",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: false,
		});
		try {
			const prompt = session.systemPrompt.join("\n");

			expect(prompt).toContain(MCP_CATALOG_LINE);
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain("MCP Server Instructions");
		} finally {
			await session.dispose();
		}
	});

	it("lists a mounted Context Mode tool in the xd:// catalog when initialize omits instructions", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"context-mode": {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, CONTEXT_MODE_NO_INSTRUCTIONS_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			// Context Mode advertises mounted MCP tools but currently supplies no
			// `connection.instructions`. The first post-discovery apply seeds the
			// applied-tool signature baseline, so the prompt rebuilds once and the
			// xd:// device catalog — the sole owner of MCP tool presentation —
			// lists the mounted tool; no separate route section is rendered. The
			// real child-process handshake exposes no completion signal, so poll
			// until the catalog line becomes visible.
			let prompt = session.systemPrompt.join("\n");
			expect(prompt).not.toContain(CONTEXT_MODE_CATALOG_LINE);
			const deadline = Date.now() + 12_000;
			while (!prompt.includes(CONTEXT_MODE_CATALOG_LINE) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(CONTEXT_MODE_CATALOG_LINE);
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(CONTEXT_MODE_MCP_TOOL_NAME);
			expect(session.getActiveToolNames()).not.toContain(CONTEXT_MODE_MCP_TOOL_NAME);
			expect(prompt).not.toContain("## MCP Tool Routes");
			expect(prompt).not.toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain("## MCP Server Instructions");
			expect(prompt).not.toContain("### context-mode");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("bounds mounted route guidance deterministically and points to the live xd:// inventory", async () => {
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					instr: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH, BOUNDED_GUIDANCE_MODE],
					},
				},
			}),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
		});
		try {
			// Deferred discovery is a real child-process handshake with no
			// completion signal exposed to this integration harness; fake timers
			// cannot advance it, so retain the established polling bounds above.
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}

			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			// Every mounted fixture tool is listed in the xd:// device catalog —
			// the catalog is the sole owner of MCP tool presentation, with no
			// separate bounded route section.
			const catalogLines = prompt.split("\n").filter(line => line.startsWith("- xd://mcp__instr_row_"));
			expect(catalogLines).toHaveLength(BOUNDED_GUIDANCE_TOOL_COUNT);
			expect(catalogLines[0]).toStartWith("- xd://mcp__instr_row_aa (instr/row_aa) — ");
			expect(catalogLines[BOUNDED_GUIDANCE_TOOL_COUNT - 1]).toStartWith(
				"- xd://mcp__instr_row_cm (instr/row_cm) — ",
			);
			expect(prompt).not.toContain("## MCP Tool Routes");
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps deferred MCP tools top-level when CLI tool filtering grants read but not write", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["read"],
		});
		try {
			expect(session.getActiveToolNames()).toContain("read");

			// The xd:// transport rides BOTH halves: `read xd://` discovers and
			// `write xd://<tool>` executes. A session granted read but not write
			// never allocates xdev state, so deferred discovery must surface MCP
			// tools top-level instead of auto-granting the denied write transport.
			const deadline = Date.now() + 12_000;
			let activeNames = session.getActiveToolNames();
			while (!activeNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(50);
				activeNames = session.getActiveToolNames();
			}

			expect(activeNames).toContain("read");
			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(activeNames).not.toContain("write");
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
			const mcpTool = session.getToolByName(MCP_TOOL_NAME);
			expect(mcpTool).toBeDefined();
			const result = await mcpTool!.execute("deferred-mcp-call", {});
			expect(result.content.find(part => part.type === "text")?.text).toBe(TOOL_RESULT);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps an explicitly requested deferred MCP tool top-level after connection", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["read", MCP_TOOL_NAME],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}
			const activeNames = session.getActiveToolNames();

			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
			expect(prompt).toContain("## MCP Server Instructions");
			expect(prompt).toContain(SERVER_INSTRUCTIONS);
			expect(prompt).not.toContain(`xd://${MCP_TOOL_NAME}`);
		} finally {
			await session.dispose();
		}
	}, 20_000);

	it("keeps deferred tools top-level when an explicit session omitted read", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			enableMCP: true,
			hasUI: true,
			toolNames: ["bash"],
		});
		try {
			const deadline = Date.now() + 12_000;
			let prompt = session.systemPrompt.join("\n");
			while (!prompt.includes(SERVER_INSTRUCTIONS) && Date.now() < deadline) {
				await Bun.sleep(50);
				prompt = session.systemPrompt.join("\n");
			}
			let activeNames = session.getActiveToolNames();
			while (!activeNames.includes(MCP_TOOL_NAME) && Date.now() < deadline) {
				await Bun.sleep(50);
				activeNames = session.getActiveToolNames();
			}

			expect(activeNames).not.toContain("read");
			expect(activeNames).toContain(MCP_TOOL_NAME);
			expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(MCP_TOOL_NAME);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
