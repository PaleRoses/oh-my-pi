import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = type({
	query: type("string").describe("natural language search query"),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const memory = this.session.getMemoryRuntime?.();
			if (!memory) throw new Error("Memory backend is not initialised for this session.");
			const result = await memory.recall(params.query, { signal });
			if (result.count === 0) {
				return {
					content: [{ type: "text", text: "No relevant memories found." }],
					details: { backend: result.backend, message: result.message },
					useless: true,
				};
			}
			const noun = result.count === 1 ? "memory" : "memories";
			const heading = result.asOf
				? `Found ${result.count} relevant ${noun} (as of ${result.asOf} UTC):`
				: `Found ${result.count} relevant ${noun}:`;
			return {
				content: [{ type: "text", text: `${heading}\n\n${result.rendered}` }],
				details: { backend: result.backend, items: result.items },
			};
		});
	}
}
