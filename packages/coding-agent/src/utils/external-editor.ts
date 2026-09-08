/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

/** Open existing files in an editor, not their viewer association. Explicit
 * VISUAL/EDITOR wins; macOS otherwise prefers VS Code, then the default text editor. */
export function getFileEditorCommand(): string | undefined {
	const configured = getEditorCommand();
	if (configured) return configured;
	if (process.platform !== "darwin") return undefined;

	// VS Code's CLI shim is optional, so fall back to launching the app bundle itself.
	const cli = $which("code");
	if (cli) return `'${cli.replaceAll("'", `'\\''`)}'`;
	for (const dir of [path.join(os.homedir(), "Applications"), "/Applications"]) {
		const bundle = path.join(dir, "Visual Studio Code.app");
		if (existsSync(bundle)) return `/usr/bin/open -a '${bundle.replaceAll("'", `'\\''`)}'`;
	}
	return "/usr/bin/open -t";
}

export interface OpenFileInEditorOptions {
	/** Custom stdio configuration (default: all "inherit"). */
	stdio?: [number | "inherit", number | "inherit", number | "inherit"];
}

export interface OpenInEditorOptions extends OpenFileInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/** Subprocess argv and Windows quoting mode used to launch an external editor. */
export interface EditorSpawnCommand {
	cmd: string[];
	windowsVerbatimArguments: boolean;
}

/** Resolves shell argv without letting the host runtime re-quote the editor command. */
export function resolveEditorSpawnCommand(
	editorCmd: string,
	tmpFile: string,
	platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
	const windows = platform === "win32";
	// cmd.exe strips the outer /s /c quote pair; Bun must pass the embedded
	// editor/path quotes verbatim instead of applying argv escaping to them.
	const cmd = windows
		? ["cmd.exe", "/d", "/s", "/c", `"${editorCmd} "${tmpFile}""`]
		: [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile];
	return { cmd, windowsVerbatimArguments: windows };
}

export async function openFileInEditor(
	editorCmd: string,
	filePath: string,
	options?: OpenFileInEditorOptions,
): Promise<boolean> {
	const spawnCommand = resolveEditorSpawnCommand(editorCmd, filePath);
	const [stdin, stdout, stderr] = options?.stdio ?? ["inherit", "inherit", "inherit"];
	const child = Bun.spawn(spawnCommand.cmd, {
		stdin,
		stdout,
		stderr,
		windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
	});
	return (await child.exited) === 0;
}
/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const completed = await openFileInEditor(editorCmd, tmpFile, { stdio: options?.stdio });

		if (!completed) return null;
		const text = await Bun.file(tmpFile).text();
		if (options?.trimTrailingNewline === false) {
			return text;
		}
		return text.replace(/\n$/, "");
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
