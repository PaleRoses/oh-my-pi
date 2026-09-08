# System Prompt Customization

How the coding agent assembles its system prompt and what users can control with `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`, `applyResolvedSystemPromptInputs`)
- `packages/coding-agent/src/sdk.ts` (`CreateAgentSessionOptions`, prompt construction)
- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `resolvePromptInput`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (default instruction template)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` (template used when `SYSTEM.md` is active)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (project/environment footer)

## Inputs and precedence

| Input                                   | Source                 | Effect                                                                                                   |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--system-prompt <text-or-file>`        | CLI                    | Uses the bundled custom-prompt template instead of the default instruction template. Highest precedence. |
| `SYSTEM.md`                             | Discovered config file | Same template switch as the flag; used when the flag is absent.                                          |
| `--append-system-prompt <text-or-file>` | CLI                    | Adds text to the rendered prompt. Highest append precedence.                                             |
| `APPEND_SYSTEM.md`                      | Discovered config file | Same effect as the append flag; used when the flag is absent.                                            |

`SYSTEM.md` and `APPEND_SYSTEM.md` are searched project-first, then user-level. At each scope the config bases are ordered `.omp`, `.claude`, `.codex`, `.gemini`:

1. `<cwd>/.omp/<file>`, `<cwd>/.claude/<file>`, `<cwd>/.codex/<file>`, `<cwd>/.gemini/<file>`
2. `~/.omp/agent/<file>`, `~/.claude/<file>`, `~/.codex/<file>`, `~/.gemini/<file>`

The native user path follows the active profile: with `omp --profile work`, `~/.omp/agent` becomes `~/.omp/profiles/work/agent`. `PI_CONFIG_DIR` changes the native config-directory name. This shared config lookup does not use `PI_CODING_AGENT_DIR` as an arbitrary replacement base.

Discovery does **not** walk ancestors. Starting OMP in `<repo>/packages/api` does not discover `<repo>/.omp/SYSTEM.md`; launch from `<repo>`, put the file under the current directory's config base, or use a user-level file. See [Configuration usage](./config-usage.md) for the shared config-directory contract.

A flag wins over every discovered file. For each filename, project scope wins over user scope and the first config base in the order above wins within that scope.

### Text or file resolution

For a single-line value, OMP first tries to read that value as a file path. If reading fails because the path does not exist (or is too long to be a path), the value is used literally. A value containing a newline is used literally without a file read. Other file-read failures are logged and the original value is still used literally.

### Session-scoped prompt profiles

`systemPromptProfiles` defines reusable prompt settings without changing CLI model selection. Each profile may supply its own Role instructions. Ordered selection rules in `systemPromptProfileRoutes` match `agentKind` (`main` or `sub`) and an optional `provider/model` glob.

Selection rules are first-match. Put a model-specific `main` rule before a generic `main` rule, or the generic rule matches first. Role instructions come from the selected profile, never from a model name.

Task sessions derive `sub` from their task metadata. Internal SDK callers without task metadata set `agentKind` explicitly, so commit, security, and agent-creation workers do not inherit the main-session profile.

```yaml
systemPromptProfiles:
  driver: {}
  reviewer:
    rolePromptFile: ~/.omp/agent/prompts/reviewer.md
  worker:
    instructionsFile: ~/.omp/agent/prompts/worker.md
    memory: false
    mcpServerInstructions: false
    projectContextOnly: true

systemPromptProfileRoutes:
  - agentKind: main
    model: anthropic/claude-opus-*
    profile: reviewer
  - agentKind: main
    profile: driver
  - agentKind: sub
    profile: worker
```

Profiles support these prompt fields:

- `rolePrompt` or `rolePromptFile` replaces only the maintained prompt's Role paragraph with literal Markdown. Omit both to retain the generic role; a custom base prompt takes precedence. Inline/file sources are mutually exclusive and nonempty; files resolve relative to cwd, `~/`, or an absolute path. Text is loaded and outer whitespace trimmed once at profile compilation, preserving interior bytes without evaluating template syntax. Edit Role instructions in Prompt settings or with `/identity set <profile> rolePromptFile <path>`.
- `prompt` or `promptFile` replaces ambient discovered `SYSTEM.md` while retaining normal generated prompt assembly. An explicit `--system-prompt` or SDK override still wins.
- Omitting both keeps the maintained OMP prompt.
- `instructions` or `instructionsFile` appends one profile-owned system block after the assembled prompt.
- `projectContextOnly: true` removes context files outside the cwd and additional workspace roots. Repository `AGENTS.md` remains; user-global context such as `~/.claude/CLAUDE.md` does not.
- `memory: false` disables automatic recall/retention and memory tools for the profile.
- `memoryBinding: { principal: alpha, bankId: private-alpha }` binds enabled Hindsight memory to an explicit owner and bank. It is incompatible with `memory: false`, a non-Hindsight backend, or per-project bank splitting. Global bank names/prefixes do not move a bound owner; project tags may still scope retrieval inside its bank.
- `mcpServerInstructions: false` omits MCP server instructions while leaving the configured MCP tools available.
- `contextImages` lists image file paths (absolute, `~/`, or cwd-relative; existence validated when the profile compiles) injected once per conversation as a hidden custom message at the front of the first turn. System-role content is text-only across providers, so this is the standing-image equivalent of a prompt block: resume reuses the persisted copy, while `/new`, `/reset`, and compaction re-inject on the following turn.
- `userTitle` substitutes a name or phrase for "the user" wherever the maintained prompt (including personality blocks) refers to the person driving the session, e.g. `userTitle: project owner`. Unset keeps the generic wording; profiles without the field are unaffected.
- `compactionIdentity` adds a paragraph to the compaction summarizer, e.g. `compactionIdentity: "The assistant is the reviewer; the user is the maintainer."`. It rides every summarization path; unset keeps the generic summarizer prompt.
- `tools` names the model-facing active tool set (lowercased, deduplicated at compile). The cut intersects the assembled set — built-ins, custom, and extension tools alike — while preserving session contracts: `ask` stays reachable while enabled, a required `yield` survives, `checkpoint`/`rewind` remain paired, `hub` rides along whenever `task` is listed (an orchestrator that can spawn subagents can always steer, wait on, and cancel them — from eval cells too), and memory tools ride the profile's `memory` axis rather than the list. The full registry stays constructed, so `/tools` can re-activate anything outside the profile's default set. Empty or omitted keeps every tool.

Rename existing `constitution` / `constitutionFile` keys to `rolePrompt` / `rolePromptFile`; old keys are rejected. Role instructions remain fixed with the compiled profile during a live session, so changing their files requires a fresh OMP process.

`/identity` is the operator surface for these settings. Bare `/identity`
opens fullscreen Prompt settings, laid out like `/model`. The persistent sidebar
selects one view: `Main agent`, `Subagents`, `All profiles`, or `Selection rules`.
Main agent and Subagents show only their assigned profile's prompt elements.
Assigning a profile from the Profile row inserts a kind-wide rule ahead of the
existing list, which can shadow model-qualified or deny rules; the row warns
before the write. Use Tab or Left/Right to move between sidebar and content;
Escape returns from nested screens. The sidebar also remains clickable while
editing. Type-to-search filters the current pane.
The `Session profile` header shows the current transcript's profile ID.

Mutations edit global config only. Profiles defined solely by project, `--config`, or runtime settings must be edited at their source; they are never copied globally. Global defaults remain editable beneath overrides. The editor shows effective values after saving and reports remaining higher-priority overrides. `unroute` removes only global unconditional rules.
Boolean fields offer explicit Default, On, and Off choices, so every global value remains reachable even when the effective value is overridden.

Provider-facing identity context is added only for a selected profile or an explicit/inherited memory owner. Profile-free sessions without an owner keep ordinary and custom prompt output free of that metadata; `/identity status` remains available. Unset Role and user-title fields preserve the shipped generic prose.

Role instructions, Base prompt, and Appended instructions each have one document
row; inline/file representations are not separate UI rows. Enter opens
the document directly. A configured `rolePromptFile`, `promptFile`, or
`instructionsFile` opens at its resolved path; an unset base prompt opens
the authoritative `src/prompts/system/system-prompt.md` template when package
source is available. Existing files honor `$VISUAL` or `$EDITOR`; otherwise
macOS prefers installed VS Code, then its default text editor—not the app
associated with Markdown viewing. Inline content still round-trips through the
configured external editor. Adjacent document-options rows change the source
file or restore the default.

`/identity status` shows the active immutable identity plus every configured
profile and route; bare `/identity` is also textual in ACP.
`/identity show <profile>` expands one profile. Mutations use
`/identity use <profile> [main|sub]`, `/identity unroute [main|sub]`,
`/identity set <profile> <field> <value>`,
`/identity unset <profile> <field>`, and `/identity remove <profile>`.
`set` accepts the listed profile fields, creates a missing profile, and
validates the complete configuration, including referenced files, before writing.

Use `omp --prompt-profile <id>` for a process-local selection, or `CreateAgentSessionOptions.systemPromptProfile` through the SDK. This is distinct from `--profile`, which selects a configuration directory. An explicit selection overrides the default route assignment, not denying routes. The Memory binding row edits principal and bank as one transaction; the textual form is `/identity set <profile> memoryBinding <principal> <bankId>`. Clearing both fields, or `/identity unset <profile> memoryBinding`, restores unbound configuration.

OMP resolves files and compiles model globs once at process/session creation. The selected profile, route/explicit source, and memory binding are pinned together in the transcript header. The profile is emitted as `<system-prompt-profile id="…">` and included in the provider prompt-cache key. A routed selection must remain route-compatible; an explicit selection survives default-route changes while still honoring deny rules. Resume refuses a conflicting flag or changed owner/bank. Legacy transcripts cannot silently acquire an owner, and forks carrying history cannot switch owners; start a fresh empty session instead. Relaunch OMP to load a changed prompt identity: `/new` inherits the current profile ID and does not recompile profile content. `/identity status` reports the effective role, prompt principal/profile/source, model, session ID, memory permission/backend, and active Hindsight bank scope.

Memory ownership is separate from prompt identity. Enabled task memory aliases its parent’s bank; independent helpers inherit the owner with independent runtime state. Turning memory off does not clear the session’s service restriction: another backend, endpoint, or credential requires a fresh session. For common knowledge, configure an optional bank-bound Hindsight MCP server separately and expose its `retain`/`recall` tools on demand. It is not an automatic memory backend and does not merge another bank into each prompt.

## What `SYSTEM.md` replaces

`SYSTEM.md` does not become a raw, sole system message. The CLI stores it as `CreateAgentSessionOptions.customSystemPrompt`, and `buildSystemPrompt` renders `custom-system-prompt.md` instead of the default `system-prompt.md`.

The custom template keeps these generated surfaces:

- the custom text and any append text;
- discovered context files;
- discovered skills;
- always-apply rules and the rulebook listing;
- secret-redaction guidance when enabled.

The separate project/environment footer remains and carries workstation data, deeper-directory context pointers, optional workspace information, and the final completion requirements. Optional extra system blocks, such as computer-tool safety and active nested-repository context, also remain when applicable.

The current date and working directory no longer live in the footer: they are emitted as a `<system-reminder>` block on the first user turn of each provider request (`date-cwd-reminder.md`). Keeping per-request bytes out of the system prompt lets open-weight providers (DeepSeek, Qwen, GLM, …) that render tool schemas after the system content keep their prefix cache, and lets a session crossing midnight refresh the date without rebuilding the prompt (#7404).

What disappears is the content unique to the default instruction template: its built-in role/personality text, tool inventory and general tool policy, internal-URL catalog, exploration/delegation/workflow rules, and `xd://` protocol guidance. Generated skills and rules are **not** lost; the custom template renders them explicitly.

Consequences:

- To add a few instructions while retaining the complete default prompt, use only `APPEND_SYSTEM.md` or `--append-system-prompt`.
- To replace the default instruction template while retaining generated project context, skills, and rules, use `SYSTEM.md` or `--system-prompt`.
- If a custom prompt still needs the default tool policy or workflow, copy and maintain the required guidance yourself; selective inheritance from `system-prompt.md` is not supported.

### Append placement

Without `SYSTEM.md`, append text is rendered at the end of `project-prompt.md`, after the default instruction block and project/environment content.

With `SYSTEM.md`, append text is rendered immediately after the custom text in `custom-system-prompt.md`. Context, skills, and rules follow it, and the separate project/environment footer follows that block. The templates prevent the append text and context files from being emitted twice.

SDK-generated append content (for enabled memory/auto-learn features and MCP guidance) is combined before the user-supplied append text.

## Plain-text contract

`SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are plain text. They are values inserted into bundled Handlebars templates; their contents are not recursively compiled as Handlebars.

For example, if `SYSTEM.md` contains:

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

those characters reach the model literally. Internal values such as `cwd`, `skills`, `rules`, and `toolRefs` are private template implementation details, not a user templating API. The calendar date is deliberately not exposed as a template value anymore — it rides the per-request first-turn reminder instead (see above).

## Recipes

### Add rules to the default prompt

Create `APPEND_SYSTEM.md` without a `SYSTEM.md`:

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### Supply a custom base prompt

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

OMP still adds the generated context, skills, rules, and project/environment footer, but not the default instruction template's tool and workflow guidance.

### Replace the personality block

The default template renders a personality block chosen by the `personality` setting (`default`, `friendly`, `pragmatic`, `none`). A user-level `PERSONALITY.md` replaces the selected preset's text:

```text
# ~/.omp/agent/PERSONALITY.md
Follow ASD-STE100 Simplified Technical English for all responses.
```

Only the agent directory is checked (`~/.omp/agent` by default; profile- and XDG-aware) — there is no project-level or other-config-base lookup. `personality: none` still omits the block entirely (subagents always run with `none`), and an empty or unreadable file falls back to the configured preset with a logged warning.

### Customize automatic session titles

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect title-generation calls. Use `TITLE_SYSTEM.md`:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` uses the same project-first, config-base discovery and no-ancestor-walk behavior. When absent, OMP uses its bundled title prompt. The override is used for both initial automatic titles and replan-driven title refreshes.

Generated title output has an enforced normalization contract even with a
custom prompt. OMP considers only the first trimmed line, strips surrounding
quotes, `<title>...</title>` markers, and terminal punctuation, and treats
`none` or `<title/>` as “no title yet.” A result longer than 80 characters or
12 words is rejected rather than truncated. Empty, deferred, or rejected output
leaves the session unnamed, so a later eligible title attempt can name it.

## Full provider-facing replacement (SDK only)

`CreateAgentSessionOptions.systemPrompt` is a different, lower-level API. A string or array replaces the fully rendered default blocks; a callback receives the rendered block array and returns its replacement. This can omit all generated context and safety blocks.

The CLI flags and files do **not** set this property: they set `customSystemPrompt` and `appendSystemPrompt`, which continue through the bundled templates described above.

## Quick reference

| Goal                                                                                   | Use                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Add instructions while keeping the complete default prompt                             | `APPEND_SYSTEM.md` or `--append-system-prompt`                           |
| Replace the default instruction template but keep generated context, skills, and rules | `SYSTEM.md` or `--system-prompt`                                         |
| Replace every provider-facing system block                                             | SDK `CreateAgentSessionOptions.systemPrompt`                             |
| Customize automatic session titles                                                     | `TITLE_SYSTEM.md`                                                        |
| Replace the personality block while keeping the rest of the default prompt            | `PERSONALITY.md`                                                         |
| Use `{{cwd}}` or other internal variables in a user file                               | Not supported; user content is inserted verbatim                         |
| Inherit selected default-template sections                                             | Not supported; append to the default or copy the required text           |
| Per-directory override                                                                 | A supported config base directly under the cwd used to launch OMP        |
| Global override                                                                        | The active native agent directory, or another supported user config base |
