import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import type { ExecutorBackendExecOptions } from "@oh-my-pi/pi-coding-agent/eval/backend";
import { disposeKernelSessionsByOwner } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const KERNEL_OWNER_ID = "capture-test";

let cwd: string;
let artifactsDir: string;
let artifactManager: ArtifactManager;
let session: ToolSession;
let unregisterArtifactsDir: () => void;
let readTool: ReadTool;

function makeSession(): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getSessionId: () => "capture-test-session",
		getEvalSessionId: () => "capture-test-session",
		getEvalKernelOwnerId: () => KERNEL_OWNER_ID,
		getArtifactsDir: () => artifactManager.dir,
		getArtifactManager: () => artifactManager,
		allocateOutputArtifact: async (toolType: string) => artifactManager.allocatePath(toolType),
	} as unknown as ToolSession;
}

/** Mirror of the execute options the capture helper passes to the backend. */
function execOpts(): ExecutorBackendExecOptions {
	return {
		cwd,
		sessionId: "capture-test-session",
		sessionFile: path.join(cwd, "session.jsonl"),
		kernelOwnerId: KERNEL_OWNER_ID,
		session,
		reset: false,
		onChunk: () => {},
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
			.map(block => block.text)
			.join("\n") || ""
	);
}

function captureHeader(text: string): { name: string; bytes: number; lines: number; artifactId: string } | null {
	const match = text.match(/^\[captured → ([A-Za-z_][A-Za-z0-9_]*): (\d+) bytes, (\d+) lines, artifact:\/\/(\d+)\]$/m);
	if (!match) return null;
	return { name: match[1]!, bytes: Number(match[2]), lines: Number(match[3]), artifactId: match[4]! };
}

describe("tool capture → Python kernel binding", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cwd = mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
		artifactsDir = mkdtempSync(path.join(os.tmpdir(), "capture-artifacts-"));
		artifactManager = new ArtifactManager(artifactsDir);
		unregisterArtifactsDir = registerArtifactsDir(artifactsDir);
		session = makeSession();
		// The Python kernel's `read("artifact://<id>")` delegates to the host read
		// tool through the tool bridge, which resolves tools via getToolByName.
		readTool = new ReadTool(session);
		(session as unknown as { getToolByName?: unknown }).getToolByName = (name: string) =>
			name === "read" ? readTool : undefined;
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await disposeKernelSessionsByOwner(KERNEL_OWNER_ID);
		unregisterArtifactsDir();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(artifactsDir, { recursive: true, force: true });
	});

	it("(a) bash capture binds the full output to a real Python kernel variable", async () => {
		const tool = new BashTool(session);
		const result = await tool.execute("call-bash-capture", {
			command: "printf 'line1\\nline2\\nline3\\n'",
			capture: "bash_out",
		});

		const text = textOf(result);
		const header = captureHeader(text);
		expect(header).not.toBeNull();
		expect(header!.name).toBe("bash_out");
		// 18 bytes = "line1\nline2\nline3\n"; the trailing newline is not a line.
		expect(header!.bytes).toBe(18);
		expect(header!.lines).toBe(3);
		expect(text).toBe(`[captured → bash_out: 18 bytes, 3 lines, artifact://${header!.artifactId}]\nline1\nline2\nline3`);

		// The artifact holds the full raw output.
		const artifactPath = await artifactManager.getPath(header!.artifactId);
		expect(artifactPath).not.toBeNull();
		const artifactContent = await Bun.file(artifactPath!).text();
		expect(artifactContent).toBe("line1\nline2\nline3\n");

		// The kernel variable holds the same text (real IPython subprocess).
		const followUp = await pythonBackend.execute(`print(len(bash_out))`, execOpts());
		expect(followUp.exitCode).toBe(0);
		expect(followUp.output.trim()).toBe(String(header!.bytes));
		const contentCheck = await pythonBackend.execute(`print(bash_out.startswith("line1\\nline2\\nline3"))`, execOpts());
		expect(contentCheck.output.trim()).toBe("True");
	});

	it("(b) invalid capture names degrade with a warning and keep the full output", async () => {
		const tool = new BashTool(session);
		for (const badName of ["1bad", "has space", "class"]) {
			const result = await tool.execute(`call-bash-bad-${badName}`, {
				command: "printf 'hello\\n'",
				capture: badName,
			});
			const text = textOf(result);
			expect(text).toContain("hello");
			expect(text).toContain(`[capture failed: invalid Python variable name "${badName}"; full output retained]`);
		}
	});

	it("(c) an unavailable Python backend degrades with a warning and keeps the full output", async () => {
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(false);
		const tool = new BashTool(session);
		const result = await tool.execute("call-bash-no-kernel", {
			command: "printf 'still-here\\n'",
			capture: "bash_out",
		});
		const text = textOf(result);
		expect(text).toContain("still-here");
		expect(text).toContain("[capture failed: python kernel unavailable; full output retained]");
		vi.restoreAllMocks();
	});

	it("(d) grep and read accept capture and bind their output in the same kernel", async () => {
		const filePath = path.join(cwd, "sample.txt");
		await Bun.write(filePath, "alpha\nbeta\ngamma\n");

		const grepTool = new GrepTool(session);
		const grepResult = await grepTool.execute("call-grep-capture", {
			pattern: "beta",
			path: filePath,
			capture: "grep_out",
		});
		const grepText = textOf(grepResult);
		const grepHeader = captureHeader(grepText);
		expect(grepHeader).not.toBeNull();
		expect(grepHeader!.name).toBe("grep_out");
		const grepArtifactPath = await artifactManager.getPath(grepHeader!.artifactId);
		expect(grepArtifactPath).not.toBeNull();
		expect(await Bun.file(grepArtifactPath!).text()).toContain("beta");
		const grepVar = await pythonBackend.execute(`print("beta" in grep_out)`, execOpts());
		expect(grepVar.output.trim()).toBe("True");

		const readResult = await readTool.execute("call-read-capture", {
			path: filePath,
			capture: "read_out",
		});
		const readText = textOf(readResult);
		const readHeader = captureHeader(readText);
		expect(readHeader).not.toBeNull();
		expect(readHeader!.name).toBe("read_out");
		const readArtifactPath = await artifactManager.getPath(readHeader!.artifactId);
		expect(readArtifactPath).not.toBeNull();
		const readArtifactContent = await Bun.file(readArtifactPath!).text();
		expect(readArtifactContent).toContain("alpha");
		// The kernel variable holds exactly what the artifact holds.
		const readLen = await pythonBackend.execute(`print(len(read_out))`, execOpts());
		expect(readLen.output.trim()).toBe(String(Buffer.byteLength(readArtifactContent, "utf-8")));
	});
});
