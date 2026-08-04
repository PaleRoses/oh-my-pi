/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";
import { parseCommandArgs } from "./command-args";

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

export function getFileEditorCommand(): string | undefined {
	return getEditorCommand() ?? (process.platform === "darwin" ? "/usr/bin/open" : undefined);
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

export async function openFileInEditor(
	editorCmd: string,
	filePath: string,
	options?: OpenFileInEditorOptions,
): Promise<boolean> {
	const [editor, ...editorArgs] = parseCommandArgs(editorCmd);
	if (editor === undefined) return false;
	const stdio = options?.stdio ?? ["inherit", "inherit", "inherit"];
	const child = spawn(editor, [...editorArgs, filePath], { stdio, shell: process.platform === "win32" });
	const { promise, reject, resolve } = Promise.withResolvers<number>();
	child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
	child.once("error", error => reject(error));
	return (await promise) === 0;
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
