import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderPayload,
	ProviderSessionState,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai";
import { ANTHROPIC_SERVER_COMPACTION_MIN_TRIGGER_TOKENS } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createAnthropicCompactionHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";

export const ANTHROPIC_REMOTE_COMPACTION_PRESERVE_KEY = "anthropicRemoteCompaction";
export interface AnthropicRemoteCompactionPreserveData {
	provider: string;
	content: string;
}

export interface AnthropicRemoteCompactionResponse extends AnthropicRemoteCompactionPreserveData {
	usage: Usage;
}

export interface AnthropicRemoteCompactionOptions {
	signal?: AbortSignal;
	fetch?: FetchImpl;
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	metadata?: Record<string, unknown>;
	instructions?: string;
	telemetry?: AgentTelemetry;
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

export function shouldUseAnthropicRemoteCompaction(model: Model): boolean {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	return (model as Model<"anthropic-messages">).compat?.officialEndpoint === true;
}

export function getPreservedAnthropicRemoteCompactionData(
	preserveData: Record<string, unknown> | undefined,
): AnthropicRemoteCompactionPreserveData | undefined {
	const candidate = preserveData?.[ANTHROPIC_REMOTE_COMPACTION_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const record = candidate as { provider?: unknown; content?: unknown };
	if (typeof record.provider !== "string" || record.provider.trim().length === 0) return undefined;
	if (typeof record.content !== "string" || record.content.trim().length === 0) return undefined;
	return { provider: record.provider, content: record.content };
}

export function withAnthropicRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	remoteCompaction: AnthropicRemoteCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
	if (remoteCompaction) {
		return {
			...(preserveData ?? {}),
			[ANTHROPIC_REMOTE_COMPACTION_PRESERVE_KEY]: remoteCompaction,
		};
	}
	if (!preserveData || !(ANTHROPIC_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) return preserveData;
	const { [ANTHROPIC_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

export function getAnthropicRemoteCompactionProviderPayload(
	preserveData: Record<string, unknown> | undefined,
): ProviderPayload | undefined {
	const remote = getPreservedAnthropicRemoteCompactionData(preserveData);
	return remote ? createAnthropicCompactionHistoryPayload(remote.provider, remote.content) : undefined;
}

export async function requestAnthropicRemoteCompaction(
	model: Model,
	apiKey: string,
	messages: Message[],
	systemPrompt: string[],
	options: AnthropicRemoteCompactionOptions = {},
): Promise<AnthropicRemoteCompactionResponse> {
	if (!shouldUseAnthropicRemoteCompaction(model)) {
		throw new Error("Anthropic remote compaction requires the official anthropic-messages provider");
	}
	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt, messages },
		{
			apiKey,
			signal: options.signal,
			fetch: options.fetch,
			sessionId: options.sessionId,
			providerSessionState: options.providerSessionState,
			metadata: options.metadata,
			anthropicServerCompaction: {
				triggerTokens: ANTHROPIC_SERVER_COMPACTION_MIN_TRIGGER_TOKENS,
				pauseAfterCompaction: true,
				...(options.instructions ? { instructions: options.instructions } : {}),
			},
		},
		{
			telemetry: options.telemetry,
			oneshotKind: "compaction_summary",
			completeImpl: options.completeImpl,
		},
	);
	if (response.stopReason === "error") {
		throw new Error(`Anthropic remote compaction failed: ${response.errorMessage ?? "unknown provider error"}`);
	}
	const blocks = response.content.filter(
		(block): block is Extract<(typeof response.content)[number], { type: "anthropicCompaction" }> =>
			block.type === "anthropicCompaction" && block.content.trim().length > 0,
	);
	if (blocks.length !== 1) {
		throw new Error(`Anthropic remote compaction returned ${blocks.length} non-empty compaction blocks`);
	}
	return { provider: model.provider, content: blocks[0].content, usage: response.usage };
}
