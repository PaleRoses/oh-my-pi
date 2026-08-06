/**
 * Shared schema description for the `capture` parameter on the bash, grep, and
 * read tools. Explicit opt-in only — without this parameter nothing is bound.
 *
 * Lives in its own leaf module on purpose: tool schemas are evaluated at module
 * load, and importing the full kernel-capture helper (which reaches the eval
 * backend graph that loops back through `tools/index` → renderers) from a
 * schema would read a not-yet-initialized binding during load-time cycles.
 */
export const CAPTURE_PARAM_DESCRIPTION =
	"Bind the full output to this Python kernel variable; the transcript keeps only a stub. Recover via the variable or the artifact pointer.";
