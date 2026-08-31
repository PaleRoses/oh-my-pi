import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRetainSchema = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

export type MemoryRetainParams = typeof memoryRetainSchema.infer;
export class MemoryRetainTool implements AgentTool<typeof memoryRetainSchema> {
	readonly name = "retain";
	readonly approval = "read" as const;
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = memoryRetainSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult> {
		const memory = this.session.getMemoryRuntime?.();
		if (!memory) throw new Error("Memory backend is not initialised for this session.");
		const result = await memory.retain({ items: params.items });
		const noun = result.accepted === 1 ? "memory" : "memories";
		const disposition = result.queued ? "queued" : "stored";
		return {
			content: [{ type: "text", text: `${result.accepted} ${noun} ${disposition}.` }],
			details: { count: result.accepted, backend: result.backend, queued: result.queued },
		};
	}
}
