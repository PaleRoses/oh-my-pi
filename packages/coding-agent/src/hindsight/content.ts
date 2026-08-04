/**
 * Pure content utilities for the Hindsight backend.
 *
 * Ports the semantics of the upstream OpenCode plugin
 * (vectorize-io/hindsight @ hindsight-integrations/opencode/src/content.ts):
 *   - tag stripping for anti-feedback (a recalled <memories> block must
 *     never end up retained as a new memory)
 *   - recall query composition + truncation under a character budget
 *   - retention transcript framing
 */
import type { MemoryProvenanceKey, RecallResult } from "./client";

export interface HindsightMessage {
	role: string;
	content: string;
}

const MAX_INLINE_PROVENANCE_CHARS = 96;
const MAX_RENDERED_TAGS = 8;
const MAX_RENDERED_TAG_CHARS = 48;
const MAX_INSPECTED_TAGS = 32;
const ORIGIN_FIELDS = [
	["source", "source"],
	["session_id", "session"],
	["agent_kind", "agent"],
	["prompt_profile", "prompt"],
	["prompt_principal", "principal"],
	["prompt_source", "prompt-source"],
	["model", "model"],
	["project", "project"],
	["cwd", "cwd"],
] as const satisfies ReadonlyArray<readonly [MemoryProvenanceKey, string]>;

const MEMORIES_REGEX = /<memories>[\s\S]*?<\/memories>/g;
const LEGACY_HINDSIGHT_MEMORIES_REGEX = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
const LEGACY_RELEVANT_MEMORIES_REGEX = /<relevant_memories>[\s\S]*?<\/relevant_memories>/g;
const MENTAL_MODELS_REGEX = /<mental_models>[\s\S]*?<\/mental_models>/g;

const RETENTION_PROTOCOL_MARKER_REGEX = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end)\]$/;
/**
 * Strip `<memories>`, `<mental_models>`, and legacy memory blocks.
 *
 * Both `<memories>` (per-turn recall) and `<mental_models>` (curated semantic
 * memory) are injected into the system prompt. If either leaks into the
 * retention transcript, every retain becomes a tighter feedback loop —
 * paraphrased memories feed the next consolidation, which feeds the next
 * mental-model refresh, which feeds the next retain. Always strip before
 * retaining.
 */
export function stripMemoryTags(content: string): string {
	return content
		.replace(MEMORIES_REGEX, "")
		.replace(MENTAL_MODELS_REGEX, "")
		.replace(LEGACY_HINDSIGHT_MEMORIES_REGEX, "")
		.replace(LEGACY_RELEVANT_MEMORIES_REGEX, "");
}

// At least one letter or digit means the message carries a token a retriever
// can actually match on. Punctuation/whitespace-only strings (e.g. the lone
// `.` some providers emit for tool-call-only or thinking-only assistant turns)
// are dropped before retain/recall touches them — see issue #1806.
const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * True when `content` carries at least one letter or digit. Used by retain
 * and recall paths to drop placeholder assistant turns ("." / "..." / pure
 * whitespace) that would otherwise pollute the bank and waste tokens on
 * embeddings with no semantic content.
 */
export function hasSubstantiveContent(content: string): boolean {
	return SUBSTANTIVE_CHAR_RE.test(content);
}

/** Format recall results into a bullet list for context injection. */
export function formatMemories(results: RecallResult[]): string {
	if (results.length === 0) return "";
	return results
		.map(result => {
			const factType = boundedInlineString(result.fact_type);
			const date = boundedInlineString(result.mentioned_at);
			const factTypeStr = factType ? ` [${factType}]` : "";
			const dateStr = date ? ` (${date})` : "";
			const details: string[] = [];

			const documentId = boundedInlineString(result.document_id);
			const factId = boundedInlineString(result.id);
			if (documentId) details.push(`document=${documentId}`);
			else if (factId) details.push(`fact=${factId}`);

			const tags = formatRecallTags(result.tags);
			if (tags) details.push(`tags=${tags}`);

			if (isUnknownRecord(result.metadata)) {
				for (const [key, label] of ORIGIN_FIELDS) {
					const value = boundedInlineString(result.metadata[key]);
					if (value) details.push(`${label}=${value}`);
				}
			}

			const provenance = details.length > 0 ? ` {${details.join("; ")}}` : "";
			const text = typeof result.text === "string" ? result.text : "";
			return `- ${text}${factTypeStr}${dateStr}${provenance}`;
		})
		.join("\n\n");
}

function boundedInlineString(value: unknown, maxChars: number = MAX_INLINE_PROVENANCE_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.replace(/\s+/g, " ")
		.replaceAll("<", "‹")
		.replaceAll(">", "›")
		.replace(/[{}[\]();]/g, "_");
	if (!normalized) return undefined;
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatRecallTags(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const unique = new Set<string>();
	for (const rawTag of value.slice(0, MAX_INSPECTED_TAGS)) {
		const tag = boundedInlineString(rawTag, MAX_RENDERED_TAG_CHARS);
		if (tag) unique.add(tag);
	}
	const tags = [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	if (tags.length === 0) return undefined;
	const visible = tags.slice(0, MAX_RENDERED_TAGS);
	if (tags.length > MAX_RENDERED_TAGS || value.length > MAX_INSPECTED_TAGS) visible.push("…");
	return visible.join(",");
}

/** Format current UTC time for the recall preamble. */
export function formatCurrentTime(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const h = String(now.getUTCHours()).padStart(2, "0");
	const min = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(messages: HindsightMessage[], turns: number): HindsightMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];

	for (const msg of contextual) {
		const content = stripMemoryTags(msg.content).trim();
		if (!content) continue;
		if (msg.role === "user" && content === latest) continue;
		contextLines.push(`${msg.role}: ${content}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextLines = contextBody.split("\n").filter(Boolean);

	const kept: string[] = [];
	for (let i = contextLines.length - 1; i >= 0; i--) {
		kept.unshift(contextLines[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

export interface RetentionTranscript {
	transcript: string | null;
	messageCount: number;
}

/**
 * Format messages into a retention transcript using `[role: ...]` markers.
 *
 * - When `retainFullWindow` is true, all messages are included (used when the
 *   caller pre-sliced the window itself).
 * - Otherwise, only the last user turn (last user message → end) is retained.
 *
 * Messages are tag-stripped before framing to break the recall→retain loop.
 * Returns `{ transcript: null }` when nothing meaningful survives.
 */
function formatRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripMemoryTags(msg.content).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(`[role: ${msg.role}]\n${content}\n[${msg.role}:end]`);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

function formatEmbeddableRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripRetentionProtocolMarkers(stripMemoryTags(msg.content)).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(content);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

/** Remove retention framing lines from a stored coding-agent episode transcript. */
export function stripRetentionProtocolMarkers(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_PROTOCOL_MARKER_REGEX.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
): RetentionTranscript {
	if (messages.length === 0) return { transcript: null, messageCount: 0 };

	let targetMessages: HindsightMessage[];
	if (retainFullWindow) {
		targetMessages = messages;
	} else {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
		targetMessages = messages.slice(lastUserIdx);
	}

	return formatRetentionMessages(targetMessages);
}

/** Format all retention messages without protocol markers for embedding, FTS, and recall display. */
export function prepareEmbeddableRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatEmbeddableRetentionMessages(messages);
}
/** Format only user-authored messages for memory fact/entity extraction. */
export function prepareUserRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatRetentionMessages(messages.filter(message => message.role === "user"));
}
