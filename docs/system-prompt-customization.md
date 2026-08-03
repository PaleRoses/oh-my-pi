# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, including session-scoped agent profiles, `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/agent-profiles.ts` (profile validation, prompt loading, model policy, and ordered route resolution)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (default stable instruction template)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` (internal custom-prompt template; not the normal CLI `SYSTEM.md` path)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (project/environment footer)

---

## 1) Inputs

Seven user-controllable inputs feed prompt assembly and agent identity selection. Prompt files and profile sources resolve before prompt rendering.

| Input | Source | Effect |
|---|---|---|
| `--agent-profile <id>` | CLI flag | Selects one session-scoped agent identity. It does not relocate config or session paths; that remains the distinct `--profile` bootstrap feature. |
| `agentProfiles` | Settings record | Defines named constitution overlays, Hindsight scope, model policy, optional tool boundary, and optional project-only context boundary. |
| `agentProfileRoutes` | Ordered settings array | Selects an initial profile or denies startup by `agentKind` and/or model glob. First match wins. |
| `--system-prompt <text-or-file>` | CLI flag | Replaces the harness base prompt. A selected profile's constitution remains a distinct overlay, along with its memory, model, and capability policy. |
| `SYSTEM.md` | `<cwd>/.omp/SYSTEM.md`, then `~/.omp/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Replaces the harness base only for an unprofiled session without an explicit prompt. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds a prompt block after the selected base customization and before the preserved project/environment footer. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

Discovery for `SYSTEM.md` / `APPEND_SYSTEM.md` uses `findConfigFile` (`packages/coding-agent/src/config.ts`): the first existing file across the ordered bases (`.omp`, `.claude`, `.codex`, `.gemini` — project-level at `<cwd>` first, then user-level at `~`) wins. **No ancestor walk-up.** Running `omp` from `<repo>/subdir` does not pick up `<repo>/.omp/SYSTEM.md`; the file must live directly under the cwd's config base or in the user-level location. See [`docs/config-usage.md`](./config-usage.md) for the full discovery contract.

Identity selection is fail-closed:

1. an existing session header keeps its persisted profile; a conflicting `--agent-profile` is rejected;
2. otherwise, explicit `--agent-profile` selects a configured profile;
3. otherwise, the first matching `agentProfileRoutes` entry selects or denies;
4. otherwise, the session remains unprofiled.

Prompt composition then resolves independently. An explicit `--system-prompt` replaces the harness base. Otherwise a profiled session uses the bundled base, while an unprofiled session may use discovered `SYSTEM.md` before falling back to the bundled base. A selected profile's `prompt` or `promptFile` is layered once over that base; `useDefaultPrompt: true` adds no profile constitution. Append precedence remains `--append-system-prompt`, project `APPEND_SYSTEM.md`, then user `APPEND_SYSTEM.md`.

---

## 2) Replace vs. append

Normal CLI startup resolves the session identity before composing provider-facing prompt blocks. Conceptually:

```text
selected agent profile = persisted profile
                      ?? explicit --agent-profile
                      ?? first matching initial route

base prompt = explicit custom prompt
           ?? discovered SYSTEM.md (unprofiled sessions only)
           ?? bundled prompt

profile constitution = selected profile prompt/promptFile
                    ?? no additional block
```

The selected profile constitution is a distinct system block layered over the base. `APPEND_SYSTEM.md` / `--append-system-prompt` is composed independently.

The maintained blocks come from `buildSystemPrompt`:

- block 0: `system-prompt.md` — the stable harness instructions (staff-engineer preamble, tool inventory, exploration rules, workflow rules, delivery contract, etc.), unless an explicit or unprofiled discovered custom base replaces it;
- profile block, when `prompt` or `promptFile` is configured: exactly the selected constitution;
- project block, when non-empty: `project-prompt.md` — dynamic project/environment context (workstation info, context files, dir-context list, workspace tree, current date/cwd, and other project footer content).

Consequences for normal CLI use:

- Providing `--system-prompt` replaces the harness base but not a selected profile constitution or its Hindsight, model, tool, context, and persisted-identity policy.
- A selected `prompt` or `promptFile` is layered over the bundled base; `useDefaultPrompt: true` uses the bundled base without an additional constitution block.
- Providing `SYSTEM.md` replaces the base only for an unprofiled session with no explicit prompt.
- Providing `--append-system-prompt` or `APPEND_SYSTEM.md` composes with both the selected base and any profile constitution.
- `projectContextOnly: true` retains project-rooted context files while omitting user-global context files; it does not remove the generated project/environment footer itself.

Use an agent profile to bind a constitution overlay, memory, model policy, and tools as one session identity. Use `APPEND_SYSTEM.md` / `--append-system-prompt` for independent global or one-run additions.

---

## 3) Templating contract

**Contents of agent-profile prompt files, `SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are treated as plain text.** They are resolved before prompt composition and are not rendered as Handlebars templates.

The built-in prompt templates are Handlebars (`packages/utils/src/prompt.ts`), but user-provided strings are not compiled with that renderer. The secondary capability path can insert `systemPromptCustomization` into a Handlebars parent template, but a `{{value}}` reference in Handlebars still does not recursively render its substituted contents — the value is emitted as a string. Concretely:
```handlebars
{{! parent template — handled by Handlebars }}
{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
```

If `SYSTEM.md` contains:

```handlebars
Working in {{cwd}} on {{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

the rendered output contains those characters verbatim — `{{cwd}}`, `{{#if hasMemoryRoot}}`, etc. are NOT substituted. They will be shown to the model as literal Handlebars syntax.

This is by design. The internal template variables (`cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, `hasObsidian`, `mcpDiscoveryServerSummaries`, ...) are not a supported public surface — they change between releases as the prompt is rewritten, and they would couple user configs to internals. Treat them as private.

If a future release exposes a templating surface for `SYSTEM.md`, it will be opt-in (e.g. via a settings flag or a different filename) and documented here.

---

## 4) Recommended patterns

### "Tweak the default" — keep default, add a few rules

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`) without `SYSTEM.md`. The default stable instructions and the dynamic project/environment footer stay intact; your text is appended as an additional block.

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### "Replace the stable default instructions" — bring your own base prompt

Use `SYSTEM.md` (or `--system-prompt`). You replace the stable default instructions in block 0, but normal CLI startup still preserves the dynamic project/environment footer block (`project-prompt.md`): workstation info, context files, dir-context list, workspace tree, current date, cwd, and related project context.

```text
# ~/.omp/agent/SYSTEM.md
You are a code reviewer. Read diffs, surface issues, never edit files.
- Cite paths with backticks.
- Prefer concrete fixes over abstract advice.
```

If you do this and want default tool guidance, exploration rules, or workflow rules, copy what you need from `packages/coding-agent/src/prompts/system/system-prompt.md` and maintain it yourself — there is currently no way to inherit selected sections from that stable default instruction block.

### "Customize while keeping generated skills/rules/tool guidance"

Use `APPEND_SYSTEM.md`, not `SYSTEM.md`. Skills, rulebook summaries, always-apply rules, the tool inventory, and the built-in guidance that tells the model when to read `skill://<name>` are part of block 0 (`system-prompt.md`). Because `SYSTEM.md` replaces block 0, those generated lists are not available to the model in a custom system prompt.

The dynamic project/environment footer that remains after `SYSTEM.md` is only block 1 (`project-prompt.md`): workstation info, AGENTS.md context files, dir-context list, workspace tree, current date, cwd, and related project context. It does not include discovered skills.

There is currently no supported CLI mode for "replace the stable default instructions but keep the generated skills/rules/tool guidance." If you need automatic skills loading, keep the default block and add your customization via `APPEND_SYSTEM.md`. If you fully replace with `SYSTEM.md`, you must hard-code any skill names/instructions you want the model to know about, and those will not track discovery automatically.

### "Give the driver and summoned workers separate identities"

Define named profiles and ordered initial routes in `config.yml`:

```yaml
agentProfiles:
  driver:
    useDefaultPrompt: true
    hindsight:
      bankId: omp
    models:
      - "anthropic/claude-fable-*"
  worker:
    promptFile: ~/.omp/agent/prompts/summoned-worker.md
    hindsight:
      bankId: omp-worker
      retainTags: ["mind:worker"]
      recallTags: ["mind:worker"]
      recallTagsMatch: all_strict
    models:
      - "openai-codex/gpt-5.6-*"
      - "kimi-code/*"
      - "anthropic/claude-opus-*"
    tools: [read, grep, bash, edit, task, hub]
    projectContextOnly: true

agentProfileRoutes:
  - agentKind: main
    model: "anthropic/claude-fable-*"
    profile: driver
  - agentKind: sub
    profile: worker
  - model: "*"
    profile: worker
```

Every profile contains exactly one of `prompt`, `promptFile`, or `useDefaultPrompt: true`, plus a non-empty `hindsight.bankId`. `prompt` and `promptFile` add one selected constitution block over OMP's maintained harness prompt; `useDefaultPrompt: true` adds no profile-specific constitution. Optional retain/recall tags use the same Hindsight scope semantics as the global settings. Model patterns match canonical `provider/model-id` strings with `*`, `?`, and backslash escaping. A fallback or manual model change outside the selected profile's patterns is rejected before model mutation.

`tools` is an exact upper bound intersected with the tools the caller supplies. Restricted profiles do not discover MCP tools unless the allowlist explicitly names one. `projectContextOnly: true` keeps context files rooted under the cwd or additional workspace roots and excludes user-global context files. Task subagents layer their task/agent contract onto the selected worker constitution.

`agentKind` accepts `main` or `sub`. Routes may specify `agentKind`, `model`, or both; omission matches every value on that axis. Routes run only for initial selection. The selected profile is persisted in the session header and remains sticky across retries, fallback, resume, and model changes.

In this routing table, only a fresh Fable-backed main session can select `driver`. Every task agent and every fresh non-Fable main session selects `worker`. A model change cannot move an existing session between profiles, so a Fable driver fails rather than handing its constitution or memory to a fallback model.

A route can fail closed instead of selecting a profile:

```yaml
agentProfileRoutes:
  - agentKind: main
    model: anthropic/claude-opus-*
    deny: true
    reason: The driver role requires Fable.
```

Use `omp --agent-profile reviewer` for explicit selection. This is distinct from `omp --profile <name>`, which relocates the entire user config and runtime directory. Profile files and route shapes are validated during session construction.

Within the interactive TUI, `/agent-profile` opens the profile selector. `/agent-profile <id> [provider/model]` starts a fresh session under the selected profile without restarting the OMP process. Omitting the model preserves the current model when the target permits it; otherwise OMP opens the model selector before closing the current session. The old transcript remains resumable, while the new session reconstructs its prompt, Hindsight state, tools, extensions, provider state, prompt-cache identity, and agent lifecycle. The transition fails closed while a turn, live/collaborative mode, or background job is active.

### "Customize automatic session titles"

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect the model call that names a new session. Create the title-specific prompt file instead:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message carries no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` is discovered with the same project-then-user config-directory pattern as `SYSTEM.md` / `APPEND_SYSTEM.md`. When absent, OMP uses the bundled `title-system.md` / `tiny-title-system.md` prompts. When present, both the online title path and the local tiny-model path keep the `<title>...</title>` wrapper while using this file as the system turn.

### "Replace everything, including project context" — SDK-only

The normal CLI file/flag path intentionally preserves `defaultPrompt.slice(1)`. Code using `CreateAgentSessionOptions.systemPrompt` directly can return a full replacement array and omit the project footer, but that is not what `.omp/SYSTEM.md`, `~/.omp/agent/SYSTEM.md`, or `--system-prompt` do.

### "Replace, but keep one section of the default instructions" — not directly supported

There is no built-in way to inherit specific sections from `system-prompt.md` while replacing the rest. The supported CLI modes are: append to the default prompt, or replace block 0 and keep the dynamic footer.

---

## 5) Deduplication

The CLI path keeps discovered `SYSTEM.md` separate from an explicit override, so selecting one constitution never injects both copies.

Inside `buildSystemPrompt` itself, secondary customization and always-apply rules are still deduplicated:

- `dedupePromptSource` drops a `systemPromptCustomization` block when it already appears in an internally supplied `customPrompt` or append prompt.
- `dedupeAlwaysApplyRules` omits always-apply rules whose body appears verbatim in any of `{customPrompt, appendPrompt, systemPromptCustomization}`.

---

## 6) Discovery paths

Only one path actually drives the customization a CLI user sees: the primary CLI path. The capability layer exists but its `SYSTEM.md` output never reaches the rendered prompt under normal CLI startup.

- The primary CLI path (`discoverSystemPromptFile` / `discoverAppendSystemPromptFile` in `main.ts`, which feeds `resolvedSystemPrompt` / `resolvedAppendPrompt`) calls `findConfigFile`. `findConfigFile` checks only `<cwd>/.omp`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, and the user-level equivalents — it does **not** walk up ancestors. Files in `<ancestor>/.omp/SYSTEM.md` are ignored when `omp` is started from a subdirectory.
- The secondary capability path (`loadSystemPromptFiles` → builtin discovery) does walk up via `findNearestProjectConfigDir` and requires the project `.omp/` directory to be non-empty. Its result is rendered into the template variable `systemPromptCustomization`. Under normal CLI startup the default template (`system-prompt.md`) never references that variable, so ancestor-walk capability content has no user-visible effect.

Net effect for CLI users: put `SYSTEM.md` / `APPEND_SYSTEM.md` directly under `<cwd>/.omp` (or another supported config base under cwd) or in the user-level location (`~/.omp/agent/SYSTEM.md` etc.). Ancestor paths are not searched.

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add an instruction on top of the full default prompt | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Bind distinct constitutions, memory scopes, models, and tools to main/sub agents | `agentProfiles` plus ordered `agentProfileRoutes` |
| Replace the stable default instructions but keep project/environment context | `SYSTEM.md` or `--system-prompt` |
| Preserve generated skills/rules/tool guidance while customizing | `APPEND_SYSTEM.md`; `SYSTEM.md` replaces that generated block |
| Customize automatic session titles | `TITLE_SYSTEM.md`; chat-turn `SYSTEM.md` / `APPEND_SYSTEM.md` do not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Inherit specific sections from `system-prompt.md` | Not supported; use append, or copy what you need into `SYSTEM.md`. |
| Override at a per-repo level | Project `.omp/SYSTEM.md` under the cwd you launch `omp` from |
| Override globally | `~/.omp/agent/SYSTEM.md` or `~/.omp/agent/APPEND_SYSTEM.md` |
