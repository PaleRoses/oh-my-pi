/**
 * Receipt (not a test — needs a local session file): replays the session that
 * failed compaction 90 times through the patched path with every provider call
 * intercepted, under two provider caps.
 *
 *   bun test/compaction-real-session.receipt.ts <session.jsonl> <cutIndex>
 */
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_COMPACTION_SETTINGS, generateSummary, prepareCompaction, type SessionEntry } from "../src/compaction";
import { countTokens } from "../src/tokenizer";

const [file, cutArg] = process.argv.slice(2);
const model = getBundledModel("anthropic", "claude-opus-5") as Model;
const entries: SessionEntry[] = [];
for (const line of (await Bun.file(file).text()).split("\n")) {
	if (!line.startsWith("{")) continue;
	try {
		const entry = JSON.parse(line) as SessionEntry;
		if (typeof entry.type === "string") entries.push(entry);
	} catch {}
}
const path = entries.slice(0, cutArg ? Number(cutArg) : entries.length);
const preparation = prepareCompaction(path, DEFAULT_COMPACTION_SETTINGS, model);
if (!preparation) throw new Error("prepareCompaction returned undefined");
console.log(`entries ${path.length}, messages to summarize ${preparation.messagesToSummarize.length}`);

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

for (const cap of [1_000_000, 200_000]) {
	const accepted: number[] = [];
	let rejected = 0;
	const started = Bun.nanoseconds();
	const summary = await generateSummary(
		preparation.messagesToSummarize,
		model,
		16_384,
		"receipt-key",
		undefined,
		undefined,
		preparation.previousSummary,
		{
			completeImpl: async (_model, context) => {
				const text = (context.messages[0].content as { type: string; text: string }[])[0].text;
				const tokens = countTokens(text);
				if (tokens > cap) {
					rejected++;
					throw new Error(`400 invalid_request_error: prompt is too long: ${tokens} tokens > ${cap} maximum`);
				}
				accepted.push(tokens);
				return reply(`summary-${accepted.length}`);
			},
		},
	);
	const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
	console.log(
		`cap ${cap}: ${accepted.length} accepted calls, ${rejected} rejected, largest ${Math.max(...accepted)} tokens, ` +
			`${elapsedMs.toFixed(0)} ms local planning, summary "${summary}"`,
	);
}
