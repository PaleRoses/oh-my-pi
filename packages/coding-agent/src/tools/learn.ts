import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";

const learnSchema = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": type({
		action: "'create' | 'update'",
		name: type("string").describe("kebab-case skill name"),
		description: type("string").describe("one-line description of when to use the skill"),
		body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
	}).describe("also create or enhance a managed skill in the same call"),
});

export type LearnParams = typeof learnSchema.infer;

/**
 * Orchestrating "learn" tool: persists a lesson through the selected backend
 * and, given a `skill` payload, mints/enhances a managed skill via the shared
 * `writeManagedSkill` primitive.
 */
export class LearnTool implements AgentTool<typeof learnSchema> {
	readonly name = "learn";
	readonly approval = (args: unknown) =>
		(args as Partial<LearnParams>).skill || this.session.settings.get("memory.backend") === "local"
			? "write"
			: "read";
	readonly label = "Learn";
	readonly description = learnDescription;
	readonly parameters = learnSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Capture a reusable lesson to memory (and optionally a managed skill)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		return session.settings.get("autolearn.enabled") ? new LearnTool(session) : null;
	}

	async execute(_id: string, params: LearnParams): Promise<AgentToolResult> {
		const memory = this.session.getMemoryRuntime?.();
		if (!memory) throw new Error("Memory backend is not initialised for this session.");
		const saved = await memory.save({
			content: params.memory,
			context: params.context,
			source: "coding-agent-learn",
			importance: 0.8,
			purpose: "learn",
		});
		if (saved.stored === 0 && !saved.queued) {
			throw new Error(saved.message ?? "Lesson was not stored.");
		}
		const memoryMessage = saved.queued ? "Lesson queued for retention" : "Lesson stored";

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}. Did not create managed skill "${params.skill.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage}, but the managed skill could not be written: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "Created" : "Updated";
			return {
				content: [{ type: "text", text: `${memoryMessage}. ${verb} managed skill "${params.skill.name}".` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}.` }],
			details: { skill: null },
		};
	}
}
