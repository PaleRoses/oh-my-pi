Run one step of code in a persistent kernel. State persists across calls and subagents: work incrementally (imports → define → use), one small cell per call, and NEVER re-import/re-declare — prior top-level names survive into the next cell.
{{#if py}}Top-level `await` works everywhere; `asyncio.run(…)` raises.{{/if}}

Cells reach the session through a prelude beyond the language: `read`/`write`, `display`, `env`, `tool.<name>(args)` — invoke any session tool — `completion()` (oneshot LLM){{#if spawns}}, `agent()` (subagents), `parallel(thunks)`/`pipeline(items, ...stages)` (fan-out, DAG waves){{/if}}, `log`, `phase`, `budget`.

<critical>
- MUST read `xd://kernel` (the full manual: exact per-language prelude signatures, call conventions{{#if spawns}}, DAG orchestration rules{{/if}}) before the first cell that uses prelude functions beyond `read`/`write`/`display`. Call shapes differ per language — NEVER guess them.
- On error, fix and re-run only the failing step.
</critical>
