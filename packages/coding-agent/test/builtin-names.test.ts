import { describe, expect, it } from "bun:test";
import { normalizeToolName } from "../src/tools/builtin-names";

describe("normalizeToolName", () => {
	it("maps legacy builtin aliases without touching plugin case", () => {
		expect(normalizeToolName("search")).toBe("grep");
		expect(normalizeToolName("Read")).toBe("read");
		expect(normalizeToolName("CaseAdd")).toBe("CaseAdd");
		expect(normalizeToolName("Constructor")).toBe("Constructor");
	});

	it("does not remap eval to kernel", () => {
		expect(normalizeToolName("eval")).toBe("eval");
		expect(normalizeToolName("kernel")).toBe("kernel");
	});
});
