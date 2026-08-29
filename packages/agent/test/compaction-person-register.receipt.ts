/**
 * Receipt (not a test — needs a local session file): proves the person-register
 * compaction prompts are wired into the live summarization path by replaying a
 * real session with the provider call intercepted.
 *
 *   bun test/compaction-person-register.receipt.ts <session.jsonl>
 */
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
	prepareCompaction,
	renderCompactionSummaryContext,
	type SessionEntry,
} from "../src/compaction";

const [file] = process.argv.slice(2);
const model = getBundledModel("anthropic", "claude-opus-5") as Model;
const entries: SessionEntry[] = [];
for (const line of (await Bun.file(file).text()).split("\n")) {
	if (!line.startsWith("{")) continue;
	try {
		const entry = JSON.parse(line) as SessionEntry;
		if (typeof entry.type === "string") entries.push(entry);
	} catch {}
}
const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS, model);
if (!preparation) throw new Error("prepareCompaction returned undefined");
console.log(`entries ${entries.length}, messages to summarize ${preparation.messagesToSummarize.length}`);

const reply = (text: string): AssistantMessage =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "receipt",
		model: "receipt",
		api: "receipt",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	}) satisfies AssistantMessage;

const captured: { system: string; prompt: string }[] = [];
await generateSummary(
	preparation.messagesToSummarize,
	model,
	16_384,
	"receipt-key",
	undefined,
	undefined,
	preparation.previousSummary,
	{
		completeImpl: async (_model, context) => {
			const system = Array.isArray(context.systemPrompt)
				? context.systemPrompt.join("\n")
				: String(context.systemPrompt ?? "");
			const prompt = (context.messages[0].content as { type: string; text: string }[])[0].text;
			captured.push({ system, prompt });
			return reply("first-person receipt summary");
		},
	},
);

// Second run: the same summarization path with a profile identity paragraph
// (SummaryOptions.identity, fed by SystemPromptProfileSetting.compactionIdentity).
const IDENTITY = "RECEIPT-IDENTITY: the assistant is Fable; the user is Rosalia, her girlfriend.";
const capturedWithIdentity: { system: string; prompt: string }[] = [];
await generateSummary(
	preparation.messagesToSummarize,
	model,
	16_384,
	"receipt-key",
	undefined,
	undefined,
	preparation.previousSummary,
	{
		identity: IDENTITY,
		completeImpl: async (_model, context) => {
			const system = Array.isArray(context.systemPrompt)
				? context.systemPrompt.join("\n")
				: String(context.systemPrompt ?? "");
			const prompt = (context.messages[0].content as { type: string; text: string }[])[0].text;
			capturedWithIdentity.push({ system, prompt });
			return reply("first-person receipt summary");
		},
	},
);

const wrapper = renderCompactionSummaryContext("RECEIPT-SUMMARY");
const checks: [string, boolean][] = [
	[
		"system: ghost-writes assistant first person",
		captured.every(c => c.system.includes("assistant's first-person voice")),
	],
	[
		"system: bans third-person assistant refs",
		captured.every(c => c.system.includes("NEVER refer to the assistant in the third person")),
	],
	[
		"task: first-person handover notes",
		captured.every(c => /first-person voice \("I"\)|first-person voice \("I" = the assistant\)/.test(c.prompt)),
	],
	["task: old third-person framing gone", captured.every(c => !c.prompt.includes("for another LLM to resume"))],
	["system: user named, not 'the user'", captured.every(c => c.system.includes("Refer to the user by name"))],
	["wrapper: own handover notes", wrapper.includes("your own handover notes")],
	["wrapper: first person refers to you", wrapper.includes("refers to you")],
	["wrapper: old 'Prior model' framing gone", !wrapper.includes("Prior model work")],
	[
		"identity: profile paragraph appended to summarizer system prompt",
		capturedWithIdentity.length > 0 && capturedWithIdentity.every(c => c.system.includes(IDENTITY)),
	],
	["identity: absent when the profile supplies none", captured.every(c => !c.system.includes(IDENTITY))],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
console.log(`captured summarizer calls: ${captured.length} plain, ${capturedWithIdentity.length} with identity`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
