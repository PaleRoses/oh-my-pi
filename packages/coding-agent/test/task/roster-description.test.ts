import { describe, expect, it } from "bun:test";
import { rosterDescription } from "@oh-my-pi/pi-coding-agent/task";

// The task tool's "Available Agents" roster renders agent `description`
// frontmatter into the tool schema, which the provider injects into every
// request's system prompt. Foreign (Claude Code marketplace) definitions pack
// multi-hundred-word `<example>` trigger dialogues into that field; the roster
// must strip and bound them while leaving native one-line descriptions intact.
describe("rosterDescription", () => {
	it("passes short native descriptions through byte-identical", () => {
		const native = "Code review specialist for quality/security analysis";
		expect(rosterDescription(native)).toBe(native);
	});

	it("strips <example> and <commentary> blocks from foreign descriptions", () => {
		const foreign = [
			"Use this agent when you need strict Rails review.",
			'<example>Context: X.\nuser: "do thing"\nassistant: "I\'ll use the agent"\n<commentary>Because reasons.</commentary></example>',
			"<example>another dialogue</example>",
			"Final guidance sentence.",
		].join("\n");
		const rendered = rosterDescription(foreign);
		expect(rendered).toContain("strict Rails review");
		expect(rendered).toContain("Final guidance sentence.");
		expect(rendered).not.toContain("<example>");
		expect(rendered).not.toContain("<commentary>");
		expect(rendered).not.toContain("another dialogue");
	});

	it("caps overlong remainders on a word boundary with an ellipsis", () => {
		const long = `Lead sentence. ${"word ".repeat(400)}`;
		const rendered = rosterDescription(long);
		expect(rendered.length).toBeLessThanOrEqual(601);
		expect(rendered.endsWith("…")).toBe(true);
		expect(rendered).not.toContain("word…word");
	});
});
