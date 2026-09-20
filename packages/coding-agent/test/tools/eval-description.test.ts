import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalToolDescription, getEvalToolManual } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(opts: {
	spawns?: string | null;
	backends?: Record<string, boolean>;
	xdev?: boolean;
	preludes?: () => readonly EvalPreludeDefinition[];
	taskDepth?: number;
	maxRecursionDepth?: number;
}): ToolSession {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(opts.backends ?? {})) settings.set(key as never, value);
	if (opts.maxRecursionDepth !== undefined) settings.set("task.maxRecursionDepth", opts.maxRecursionDepth);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		taskDepth: opts.taskDepth,
		...(opts.preludes ? { getEvalPreludes: opts.preludes } : {}),
		settings,
		...(opts.xdev
			? { xdev: { tools: new Map(), mountedNames: new Set(), builtInNames: new Set(), isActive: () => false } }
			: {}),
	} as unknown as ToolSession;
}

/** Pull the model-facing cell-schema fields (sorted `language` enum + descriptions) from the flat wire schema. */
function wireCellFields(tool: EvalTool): {
	languages: string[];
	languageDescription?: string;
	codeDescription?: string;
} {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		properties?: {
			language?: { enum?: string[]; const?: string; description?: string };
			code?: { description?: string };
		};
	};
	const props = wire.properties;
	const language = props?.language;
	const languages = Array.isArray(language?.enum)
		? [...language.enum].sort()
		: typeof language?.const === "string"
			? [language.const]
			: [];
	return {
		languages,
		languageDescription: language?.description,
		codeDescription: props?.code?.description,
	};
}

describe("eval tool description", () => {
	it("contract advertises agent() and the manual pointer when spawns are allowed", () => {
		const text = getEvalToolDescription({ py: true, js: true, spawns: true });
		expect(text).toContain("agent()");
		expect(text).toContain("xd://eval");
	});

	it("omits spawning helpers but keeps wait() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// Neither doc may promise a helper that always throws; wait() stays
		// usable with completion() handles.
		const contract = getEvalToolDescription({ py: true, js: true, spawns: false });
		expect(contract).not.toContain("agent(");
		expect(contract).not.toContain("workpool(");
		expect(contract).toContain("wait(handles");
		const manual = getEvalToolManual({ py: true, js: true, spawns: false });
		expect(manual).not.toContain("agent(prompt");
		expect(manual).toContain("wait(handles");
	});

	it("manual carries the full prelude signatures", () => {
		const text = getEvalToolManual({ py: true, js: true, spawns: true });
		expect(text).toContain("agent(prompt");
		expect(text).toContain("display(value)");
		expect(text).toContain("<dag>");
	});

	it("EvalTool docs reflect spawn policy and transport availability", () => {
		// xd:// transport present → slim contract on the wire, full manual on demand.
		const slim = new EvalTool(makeSession({ spawns: "*", xdev: true }));
		expect(slim.description).toContain("xd://eval");
		expect(slim.description).not.toContain("display(value)");
		expect(slim.manual).toContain("display(value)");
		expect(slim.manual).toContain("agent(prompt");
		// No transport → the manual stays inline as the description (pre-split behavior).
		const inlined = new EvalTool(makeSession({ spawns: "*" }));
		expect(inlined.description).toContain("agent(prompt");
		const denied = new EvalTool(makeSession({ spawns: "" }));
		expect(denied.description).not.toContain("agent(prompt");
	});

	it("omits spawning helpers but keeps wait() when recursion depth is exhausted", () => {
		const belowCap = new EvalTool(makeSession({ taskDepth: 1, maxRecursionDepth: 2 })).description;
		const atCap = new EvalTool(makeSession({ taskDepth: 2, maxRecursionDepth: 2 })).description;
		const spawningDisabled = new EvalTool(makeSession({ taskDepth: 0, maxRecursionDepth: 0 })).description;

		expect(belowCap).toContain("agent(prompt");
		for (const description of [atCap, spawningDisabled]) {
			expect(description).not.toContain("agent(prompt");
			expect(description).not.toContain("workpool(");
			expect(description).toContain("wait(handles");
		}
	});

	it("hides eval-defined tool guidance when eval.tools.enabled is off", () => {
		// The maintained fork splits the inline contract from the full manual;
		// `@tool` guidance lives in the manual served at `xd://eval`.
		const enabled = getEvalToolManual({ evalTools: true });
		const disabled = getEvalToolManual({ evalTools: false });
		expect(enabled).toContain("@tool");
		expect(enabled).toContain("tools?=None");
		expect(disabled).not.toContain("@tool");
		expect(disabled).not.toContain("tools?=None");
	});

	it("composes only current enabled prelude documentation", () => {
		let enabled = true;
		const prelude: EvalPreludeDefinition = {
			name: "fixture",
			documentation: "CURRENT PRELUDE DOCUMENTATION",
			javascript: "",
			python: "",
			exports: [],
			enabled: () => enabled,
			async invoke() {
				return { content: [] };
			},
		};
		const tool = new EvalTool(makeSession({ preludes: () => [prelude] }));
		expect(tool.description).toContain("CURRENT PRELUDE DOCUMENTATION");
		enabled = false;
		expect(tool.description).not.toContain("CURRENT PRELUDE DOCUMENTATION");
	});
});

describe("eval tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS"] as const;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const flag of EVAL_ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});
	afterEach(() => {
		for (const flag of EVAL_ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("advertises exactly py and js in the wire schema", () => {
		const tool = new EvalTool(makeSession({}));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["js", "py"]);
		expect(fields.languageDescription).toBe('runtime: "py" for the IPython kernel, "js" for the persistent JS VM');
		expect(fields.codeDescription).toBe("code to run in this eval call, verbatim. Use top-level await freely.");
		expect(tool.summary).toBe("Execute Python or JavaScript code in an in-process eval backend");
		expect(tool.description).not.toMatch(/ruby|julia/i);
		const exampleLangs = tool.examples.map(ex => ("call" in ex ? ex.call.language : null));
		expect(exampleLangs).toEqual(["py", "py", "py"]);
	});
});
