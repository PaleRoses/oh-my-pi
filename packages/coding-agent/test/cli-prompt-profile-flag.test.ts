import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — --prompt-profile flag", () => {
	it("parses the separated and equals forms without eating the message", () => {
		const separated = parseArgs(["--prompt-profile", "astra-memory", "--print", "hello"]);
		const equals = parseArgs(["--prompt-profile=astra-memory", "--print", "hello"]);

		expect(separated.promptProfile).toBe("astra-memory");
		expect(separated.messages).toEqual(["hello"]);
		expect(equals.promptProfile).toBe("astra-memory");
		expect(equals.messages).toEqual(["hello"]);
		expect(equals.unrecognizedFlags).toEqual([]);
	});
});
