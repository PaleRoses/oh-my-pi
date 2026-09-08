import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	getEditorCommand,
	getFileEditorCommand,
	openFileInEditor,
	openInEditor,
	resolveEditorSpawnCommand,
} from "../src/utils/external-editor";

interface MutableProcess {
	platform: NodeJS.Platform;
}

function setPlatform(value: NodeJS.Platform): void {
	(process as unknown as MutableProcess).platform = value;
}

describe("getEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
	});

	it("prefers $VISUAL over $EDITOR and the platform default", () => {
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		setPlatform("win32");
		expect(getEditorCommand()).toBe("nvim");
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		delete Bun.env.VISUAL;
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nano");
	});

	it("trims whitespace so an accidentally padded value still works", () => {
		Bun.env.VISUAL = "  code --wait  ";
		delete Bun.env.EDITOR;
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("treats a whitespace-only $VISUAL as unset and consults $EDITOR", () => {
		Bun.env.VISUAL = "   ";
		Bun.env.EDITOR = "vim";
		expect(getEditorCommand()).toBe("vim");
	});

	it("defaults to notepad on Windows when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("win32");
		expect(getEditorCommand()).toBe("notepad");
	});

	it("returns undefined on POSIX when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("linux");
		expect(getEditorCommand()).toBeUndefined();
	});
});

const VSCODE_BUNDLE = "Visual Studio Code.app";
const isWindows = process.platform === "win32";

/**
 * Argv the editor process actually receives: the production `sh -c` template, word-split by a real
 * shell, so the assertions read the launch the way the editor does.
 */
async function editorArgv(editorCmd: string, filePath: string): Promise<string[]> {
	const script = resolveEditorSpawnCommand(editorCmd, filePath, "darwin").cmd[2];
	const child = Bun.spawn(
		["/bin/sh", "-c", `set -- ${script}\nfor arg in "$@"; do printf '%s\\0' "$arg"; done`, "sh", filePath],
		{ stdout: "pipe", stderr: "inherit" },
	);
	const printed = await new Response(child.stdout).text();
	return printed.split("\0").slice(0, -1);
}

describe("getFileEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;
	const originalPath = Bun.env.PATH;
	const actualExists = fs.existsSync;
	let filesystem: { mockRestore(): void } | undefined;
	let homeDirectory: { mockRestore(): void } | undefined;
	let root: TempDir | undefined;

	afterEach(async () => {
		filesystem?.mockRestore();
		homeDirectory?.mockRestore();
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
		if (originalPath === undefined) delete Bun.env.PATH;
		else Bun.env.PATH = originalPath;
		await root?.remove();
		root = undefined;
	});

	/** Fixture machine: `applications` holds app bundles and `Code CLI` is the whole of `$PATH`. */
	function machine(installed?: { vscodeApp?: boolean; codeCli?: boolean }): {
		applications: string;
		codePath: string;
		target: string;
	} {
		root = TempDir.createSync("@omp-file-editor-");
		const home = path.join(root.path(), "Rosalia's Home");
		homeDirectory = spyOn(os, "homedir").mockReturnValue(home);
		const applications = path.join(home, "Applications");
		const fixtureRoot = root.path();
		filesystem = spyOn(fs, "existsSync").mockImplementation(
			file => String(file).startsWith(fixtureRoot) && actualExists(file),
		);
		const bin = path.join(root.path(), "Code CLI");
		fs.mkdirSync(applications, { recursive: true });
		fs.mkdirSync(bin, { recursive: true });
		if (installed?.vscodeApp) fs.mkdirSync(path.join(applications, VSCODE_BUNDLE));
		const codePath = path.join(bin, "code");
		if (installed?.codeCli) {
			fs.writeFileSync(codePath, "#!/bin/sh\nexit 0\n");
			fs.chmodSync(codePath, 0o755);
		}
		Bun.env.PATH = bin;
		setPlatform("darwin");
		return { applications, codePath, target: path.join(root.path(), "system prompt.md") };
	}

	it("keeps an explicit editor preference over an installed GUI editor", () => {
		machine({ vscodeApp: true, codeCli: true });
		Bun.env.VISUAL = "nvim";
		delete Bun.env.EDITOR;

		expect(getFileEditorCommand()).toBe("nvim");
	});

	// The macOS fallbacks are read back through a POSIX shell, so the launch is observable there only.
	it.skipIf(isWindows)("launches an installed Visual Studio Code app bundle when its CLI is absent", async () => {
		const { applications, target } = machine({ vscodeApp: true });
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;

		const command = getFileEditorCommand();
		expect(command).toBeDefined();
		const argv = await editorArgv(command ?? "", target);

		// The bundle reaches the launcher as one argument despite the spaces in its path.
		expect(argv.filter(arg => arg.includes(VSCODE_BUNDLE))).toEqual([path.join(applications, VSCODE_BUNDLE)]);
		expect(argv.at(-1)).toBe(target);
	});

	it.skipIf(isWindows)("prefers the code CLI on PATH over the app bundle", async () => {
		const { codePath, target } = machine({ vscodeApp: true, codeCli: true });
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;

		const command = getFileEditorCommand();
		expect(command).toBeDefined();

		expect(await editorArgv(command ?? "", target)).toEqual([codePath, target]);
	});

	it.skipIf(isWindows)("opens the default text editor instead of the file type's viewer app", async () => {
		const { target } = machine();
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;

		const command = getFileEditorCommand();
		expect(command).toBeDefined();

		// A bare `open <file>` hands a `.md` file to whichever app claims the extension — often a
		// viewer that cannot edit it. `-t` asks for the default text editor instead.
		expect(await editorArgv(command ?? "", target)).toEqual(["/usr/bin/open", "-t", target]);
	});

	it("stays undefined off macOS so the caller can nudge for $VISUAL", () => {
		machine({ vscodeApp: true, codeCli: true });
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("linux");

		expect(getFileEditorCommand()).toBeUndefined();
	});
});

describe("openFileInEditor", () => {
	it("hands the exact file path to the editor, spaces and shell metacharacters intact", async () => {
		const root = TempDir.createSync("@omp-external-editor-");
		// `&` and `;` are shell metacharacters on POSIX *and* under cmd.exe; both must stay literal.
		const target = path.join(root.path(), "pro mpt $HOME `tick` 'quote' & ; .md");
		const editorDir = path.join(root.path(), "Editor App");
		const editor = path.join(editorDir, "editor.ts");
		try {
			await fs.promises.mkdir(editorDir);
			await Bun.write(target, "before\n");
			await Bun.write(
				editor,
				"const file = Bun.file(Bun.argv.at(-1)!);\nawait Bun.write(file, (await file.text()) + 'edited\\n');\n",
			);

			expect(await openFileInEditor(`"${process.execPath}" "${editor}"`, target)).toBe(true);
			expect(await Bun.file(target).text()).toBe("before\nedited\n");
		} finally {
			await root.remove();
		}
	});
});

describe("openInEditor", () => {
	it("passes the cmd.exe command line verbatim on Windows", () => {
		const tmpFile = String.raw`C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md`;

		expect(resolveEditorSpawnCommand('"C:\\Program Files\\Code.exe" --wait', tmpFile, "win32")).toEqual({
			cmd: [
				"cmd.exe",
				"/d",
				"/s",
				"/c",
				String.raw`""C:\Program Files\Code.exe" --wait "C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md""`,
			],
			windowsVerbatimArguments: true,
		});
	});

	it.skipIf(isWindows)("supports quoted editor paths containing spaces", async () => {
		const tempDir = TempDir.createSync("@external-editor-");
		try {
			const editorPath = path.join(tempDir.path(), "My Editor", "edit");
			fs.mkdirSync(path.dirname(editorPath), { recursive: true });
			await Bun.write(editorPath, '#!/bin/sh\nprintf "edited" > "$1"\n');
			fs.chmodSync(editorPath, 0o755);

			const result = await openInEditor(`"${editorPath}"`, "original");

			expect(result).toBe("edited");
		} finally {
			await tempDir.remove();
		}
	});
});
