import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalToolDescription, getEvalToolManual } from "@oh-my-pi/pi-coding-agent/tools/kernel";

function makeSession(opts: {
	spawns?: string | null;
	backends?: Record<string, boolean>;
	xdev?: boolean;
}): ToolSession {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(opts.backends ?? {})) settings.set(key as never, value);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
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

describe("kernel tool description", () => {
	it("contract advertises agent() and the manual pointer when spawns are allowed", () => {
		const text = getEvalToolDescription({ py: true, js: true, spawns: true });
		expect(text).toContain("agent()");
		expect(text).toContain("xd://kernel");
	});

	it("omits agent() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// Neither doc may promise a helper that always throws.
		expect(getEvalToolDescription({ py: true, js: true, spawns: false })).not.toContain("agent(");
		expect(getEvalToolManual({ py: true, js: true, spawns: false })).not.toContain("agent(prompt");
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
		expect(slim.description).toContain("xd://kernel");
		expect(slim.description).not.toContain("display(value)");
		expect(slim.manual).toContain("display(value)");
		expect(slim.manual).toContain("agent(prompt");
		// No transport → the manual stays inline as the description (pre-split behavior).
		const inlined = new EvalTool(makeSession({ spawns: "*" }));
		expect(inlined.description).toContain("agent(prompt");
		const denied = new EvalTool(makeSession({ spawns: "" }));
		expect(denied.description).not.toContain("agent(prompt");
	});
});

describe("kernel tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS", "PI_RB", "PI_JL"] as const;
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

	it("hides rb/jl from the wire schema, summary, description, and examples by default", () => {
		const tool = new EvalTool(makeSession({}));
		const fields = wireCellFields(tool);
		// Default config: rb/jl off → the wire schema is byte-identical to the pre-feature py/js one.
		expect(fields.languages).toEqual(["js", "py"]);
		expect(fields.languageDescription).toBe('runtime: "py" for the IPython kernel, "js" for the persistent JS VM');
		expect(fields.codeDescription).toBe("code to run in this eval call, verbatim. Use top-level await freely.");
		expect(tool.summary).toBe("Execute Python or JavaScript code in an in-process eval backend");
		expect(tool.description).not.toMatch(/ruby|julia/i);
		// Examples must not advertise a disabled backend.
		const exampleLangs = tool.examples.map(ex => ("call" in ex ? ex.call.language : null));
		expect(exampleLangs).toEqual(["py", "py", "py"]);
		expect(tool.examples.some(ex => "call" in ex && ex.call.language === "rb")).toBe(false);
	});

	it("advertises rb/jl across enum, descriptions, summary, and prelude once enabled", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.rb": true, "eval.jl": true } }));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["jl", "js", "py", "rb"]);
		expect(fields.languageDescription).toBe(
			'runtime: "py" for the IPython kernel, "js" for the persistent JS VM, "rb" for the persistent Ruby kernel, "jl" for the persistent Julia kernel',
		);
		expect(fields.codeDescription).toContain(
			"code to run in this eval call, verbatim. Top-level `await` is available in py/js; rb/jl auto-display the last expression like a REPL.",
		);
		expect(tool.summary).toBe("Execute Python, JavaScript, Ruby, or Julia code in a persistent eval backend");
		expect(tool.description).toMatch(/ruby/i);
		expect(tool.description).toMatch(/julia/i);
		// Ruby examples appear once rb is enabled.
		const rbExampleLangs = tool.examples.filter(ex => "call" in ex && ex.call.language === "rb");
		expect(rbExampleLangs.length).toBe(2);
	});

	it("advertises only the enabled subset of optional backends", () => {
		const tool = new EvalTool(makeSession({ backends: { "eval.rb": true } }));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["js", "py", "rb"]);
		expect(tool.summary).toBe("Execute Python, JavaScript, or Ruby code in a persistent eval backend");
		expect(tool.description).toMatch(/ruby/i);
		expect(tool.description).not.toMatch(/julia/i);
	});
});
