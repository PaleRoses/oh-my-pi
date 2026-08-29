import { afterEach, describe, expect, it, vi } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Context, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { createAnthropicCompactionHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const officialModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const compatibleModel: Model<"anthropic-messages"> = buildModel({
	id: "compatible-claude",
	name: "Compatible Claude",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
});

const context: Context = {
	messages: [{ role: "user", content: "compact this history", timestamp: 1 }],
};

function createMockRequest() {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_compact" } });
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_compact",
				model: officialModel.id,
				usage: {
					input_tokens: 2,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "compaction", content: "" } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "compaction_delta", content: "native summary" },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "compaction" },
			usage: {
				input_tokens: 2,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				iterations: [
					{
						type: "compaction",
						input_tokens: 45,
						output_tokens: 12,
						cache_read_input_tokens: 3,
						cache_creation_input_tokens: 0,
					},
				],
			},
		},
		{ type: "message_stop" },
	];
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function createTextRequest() {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_text" } });
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_text",
				model: officialModel.id,
				usage: {
					input_tokens: 2,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ordinary response" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 2,
				output_tokens: 2,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Anthropic server compaction", () => {
	it("does not send the compaction edit or beta without an opt-in or replay payload", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		let capturedRequestOptions: { headers?: Record<string, string> } | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown, requestOptions: unknown) => {
			capturedParams = params as Record<string, unknown>;
			capturedRequestOptions = requestOptions as { headers?: Record<string, string> };
			return createTextRequest() as never;
		});

		const stream = streamAnthropic(officialModel, context, { apiKey: "sk-ant-test" });
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		expect(capturedParams?.context_management).toBeUndefined();
		expect(capturedRequestOptions?.headers?.["anthropic-beta"]).toBeUndefined();
	});

	it("sends the beta and ordered context-management edits, parses the block, and accounts orchestration", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		let capturedRequestOptions: { headers?: Record<string, string> } | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown, requestOptions: unknown) => {
			capturedParams = params as Record<string, unknown>;
			capturedRequestOptions = requestOptions as { headers?: Record<string, string> };
			return createMockRequest() as never;
		});

		const stream = streamAnthropic(officialModel, context, {
			apiKey: "sk-ant-test",
			anthropicServerCompaction: {
				triggerTokens: 50_000,
				pauseAfterCompaction: true,
				instructions: "Preserve exact code and decisions.",
			},
		});
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(capturedRequestOptions?.headers?.["anthropic-beta"]).toContain("compact-2026-01-12");
		expect(capturedParams?.context_management).toEqual({
			edits: [
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 50_000 },
					pause_after_compaction: true,
					instructions: "Preserve exact code and decisions.",
				},
			],
		});
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "anthropicCompaction", content: "native summary" },
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.orchestration).toEqual({ input: 45, output: 12, cacheRead: 3 });
		expect(result.usage.totalTokens).toBe(62);
		expect(result.usage.cost.input).toBeCloseTo(0.00047, 10);
		expect(result.usage.cost.output).toBeCloseTo(0.0006, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.000003, 10);
	});

	it("replays a persisted block only to the same official provider", () => {
		const message: UserMessage = {
			role: "user",
			content: "opaque remote compaction",
			providerPayload: createAnthropicCompactionHistoryPayload("anthropic", "native summary"),
			timestamp: 1,
		};

		expect(convertAnthropicMessages([message], officialModel, false)).toEqual([
			{ role: "assistant", content: [{ type: "compaction", content: "native summary" }] },
			{ role: "user", content: "Continue." },
		]);
		expect(convertAnthropicMessages([message], compatibleModel, false)).toEqual([
			{ role: "user", content: "opaque remote compaction" },
		]);
	});
});
