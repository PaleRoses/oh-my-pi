import type { ExecutorBackend } from "../eval/backend";
import { defaultEvalSessionId } from "../eval/session-id";
import type { ToolSession } from ".";

export { CAPTURE_PARAM_DESCRIPTION } from "./capture-schema";

/**
 * Python names the hidden assignment cell may never use as a capture variable:
 * hard keywords plus the soft keywords (`match`/`case`/`type`) and the REPL
 * throwaway `_`, where an assignment would be legal but misleading.
 */
const PYTHON_RESERVED_NAMES: Record<string, true> = {
	False: true,
	None: true,
	True: true,
	and: true,
	as: true,
	assert: true,
	async: true,
	await: true,
	break: true,
	case: true,
	class: true,
	continue: true,
	def: true,
	del: true,
	elif: true,
	else: true,
	except: true,
	finally: true,
	for: true,
	from: true,
	global: true,
	if: true,
	import: true,
	in: true,
	is: true,
	lambda: true,
	match: true,
	nonlocal: true,
	not: true,
	or: true,
	pass: true,
	raise: true,
	return: true,
	try: true,
	type: true,
	while: true,
	with: true,
	yield: true,
	_: true,
};

const CAPTURE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Host-side budget for the hidden assignment cell (a read plus an assignment). */
const CAPTURE_CELL_TIMEOUT_MS = 30_000;

/** Number of preview lines the stub carries as an anchor. */
const CAPTURE_PREVIEW_LINES = 5;

export interface KernelCaptureOptions {
	/** Tool label for the artifact filename namespace (e.g. "bash", "grep", "read"). */
	toolLabel: string;
	/** Python variable name to bind the full output to. */
	captureName: string;
	/** The tool's full output text. */
	text: string;
}

export interface KernelCaptureResult {
	/**
	 * The text the tool should surface: the stub when captured, otherwise the
	 * original full output plus one warning line.
	 */
	content: string;
	captured: boolean;
}

function captureFailure(text: string, reason: string): KernelCaptureResult {
	return { content: `${text}\n[capture failed: ${reason}; full output retained]`, captured: false };
}

/** Count lines the way the streaming-output harness does: newlines plus one, minus the trailing-newline artifact. */
function countLines(text: string): number {
	if (text.length === 0) return 1;
	let count = 1;
	let pos = text.indexOf("\n");
	while (pos !== -1) {
		count++;
		pos = text.indexOf("\n", pos + 1);
	}
	return text.endsWith("\n") ? count - 1 : count;
}

/**
 * Build the compact transcript stub for a captured output:
 *
 * ```
 * [captured → <name>: <bytes> bytes, <lines> lines, artifact://<id>]
 * <first 5 lines>
 * …
 * ```
 *
 * The preview shows at most {@link CAPTURE_PREVIEW_LINES} lines; the trailing
 * `…` marks elision only when the output has more lines than the preview.
 */
export function buildCaptureStub(captureName: string, artifactUrl: string, text: string): string {
	const totalBytes = Buffer.byteLength(text, "utf-8");
	const totalLines = countLines(text);
	const previewLines = text.split("\n");
	if (previewLines[previewLines.length - 1] === "") previewLines.pop();
	const preview = previewLines.slice(0, CAPTURE_PREVIEW_LINES).join("\n");
	const lines = [`[captured → ${captureName}: ${totalBytes} bytes, ${totalLines} lines, ${artifactUrl}]`];
	if (preview.length > 0) lines.push(preview);
	if (totalLines > CAPTURE_PREVIEW_LINES) lines.push("…");
	return lines.join("\n");
}

/**
 * Bind a tool's full output to a variable in the session's persistent Python
 * eval kernel and replace the tool's result text with a compact stub.
 *
 * Mechanism: (1) the full output is saved to the session artifact store;
 * (2) ONE hidden cell `<name> = read("artifact://<id>")` runs on the session's
 * Python backend — the prelude's `read()` delegates `artifact://` to the host
 * read tool, so the payload never enters the cell code — and the cell's output
 * and displayOutputs are discarded (it is host-invoked, not a transcript
 * cell); (3) the result text becomes the stub. Every failure mode (invalid
 * name, artifact write failure, kernel unavailable, cell error) degrades to
 * the original output plus one warning line — the tool call itself never fails
 * because capture failed. Python only in v1.
 */
export async function applyKernelCapture(
	session: ToolSession,
	options: KernelCaptureOptions,
): Promise<KernelCaptureResult> {
	const { toolLabel, captureName, text } = options;

	if (!CAPTURE_NAME_PATTERN.test(captureName) || PYTHON_RESERVED_NAMES[captureName] === true) {
		return captureFailure(text, `invalid Python variable name "${captureName}"`);
	}

	// 1. Persist the full output so the kernel can load it without embedding
	//    the payload in code and the transcript keeps a lossless pointer.
	const alloc = await session.allocateOutputArtifact?.(toolLabel);
	if (!alloc?.path || !alloc.id) {
		return captureFailure(text, "artifact store unavailable");
	}
	const artifactUrl = `artifact://${alloc.id}`;
	try {
		await Bun.write(alloc.path, text);
	} catch {
		return captureFailure(text, "artifact write failed");
	}

	// 2. Resolve the session's Python backend exactly like the eval tool does
	//    (allowance + availability probe), so capture shares the live kernel.
	//    Loaded dynamically: this module is a leaf at module-graph time (tool
	//    schemas and renderers read its bindings during load), and ./kernel
	//    reaches the whole tools/index graph, which would cycle at load time.
	let backend: ExecutorBackend;
	try {
		const { resolveSessionPythonBackend } = await import("./kernel");
		backend = await resolveSessionPythonBackend(session);
	} catch {
		return captureFailure(text, "python kernel unavailable");
	}

	// 3. Run the hidden assignment cell with a modest host-side budget. Output
	//    and displayOutputs are deliberately discarded: this cell is host
	//    machinery, not a user-visible eval cell. The cell reads the artifact
	//    FILE by absolute path — not `read("artifact://…")`, whose host-side
	//    read tool windows long outputs at its default line limit and would
	//    silently bind a truncated value under a stub claiming full size.
	//    JSON.stringify produces a valid Python string literal for the path.
	const cellCode = `${captureName} = __import__("pathlib").Path(${JSON.stringify(alloc.path)}).read_text(encoding="utf-8")`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CAPTURE_CELL_TIMEOUT_MS);
	const execution = (async (): Promise<boolean> => {
		session.assertEvalExecutionAllowed?.();
		const result = await backend.execute(cellCode, {
			cwd: session.cwd,
			sessionId: session.getEvalSessionId?.() ?? defaultEvalSessionId(session),
			sessionFile: session.getSessionFile?.() ?? undefined,
			kernelOwnerId: session.getEvalKernelOwnerId?.() ?? undefined,
			signal: controller.signal,
			session,
			idleTimeoutMs: CAPTURE_CELL_TIMEOUT_MS,
			reset: false,
			onChunk: () => {
				// Discarded — see above.
			},
		});
		return !result.cancelled && result.exitCode === 0;
	})();
	let ok: boolean;
	try {
		ok = await (session.trackEvalExecution?.(execution, controller) ?? execution);
	} catch {
		ok = false;
	} finally {
		clearTimeout(timer);
	}
	if (!ok) {
		return captureFailure(text, "python kernel error");
	}

	return { content: buildCaptureStub(captureName, artifactUrl, text), captured: true };
}
