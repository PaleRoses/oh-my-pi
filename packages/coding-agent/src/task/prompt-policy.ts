import { bareModelId, parseOpenAIModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}

/**
 * Whether the maintained prompt renders the Fable constitution for this model.
 * MUST stay in lockstep with the `fableSession` flag in `buildSystemPromptInternal`
 * and the collapsed prompt-model key in `SessionTools#currentPromptModelKey`,
 * so hiding the model from the prompt (`includeModelInPrompt: false`) can never
 * carry one model's constitution across a switch to another.
 */
export function usesFableConstitution(modelId: string | undefined): boolean {
	return /fable/i.test(modelId ?? "");
}
