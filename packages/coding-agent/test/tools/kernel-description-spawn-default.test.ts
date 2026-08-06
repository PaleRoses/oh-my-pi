import { describe, expect, it } from "bun:test";
import { getEvalToolDescription, getEvalToolManual } from "../../src/tools/kernel";

describe("kernel tool manual", () => {
	it("advertises the first allowed spawn as the agent() default", () => {
		const manual = getEvalToolManual({ py: true, js: false, spawns: "fact-finder,oracle" });

		expect(manual).toContain('agent(prompt, agent?="fact-finder"');
		expect(manual).toContain("Allowed agents: `fact-finder`, `oracle`.");
	});

	it("omits agent() when spawning is disabled", () => {
		const manual = getEvalToolManual({ py: true, js: false, spawns: "" });
		expect(manual).not.toContain("agent(prompt");
		expect(manual).not.toContain("<dag>");

		const contract = getEvalToolDescription({ py: true, js: false, spawns: "" });
		expect(contract).not.toContain("agent(");
	});
});
