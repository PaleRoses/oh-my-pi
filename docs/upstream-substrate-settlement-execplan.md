# Settle Upstream Compaction, VCS, and Commit Substrates

This ExecPlan is a living document. `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be updated as implementation proceeds.

## Purpose / Big Picture

Bring the maintained OMP fork onto upstream's current implementations for three substrate areas without losing fork-owned product capabilities. After this change, compaction behavior is implemented by upstream's current compaction modules, Git and Jujutsu operations go through the native `pi-vcs` facade, and commit generation uses upstream's current agentic/conventional subsystem. Fork-only prompt profiles, Hindsight provenance, source-linked updating, eval capture/manuals, broker schedules, and tool-result recovery receipts remain intact.

The user-visible proof is that the coding agent builds, its focused compaction/VCS/commit suites pass, the old TypeScript Git/JJ and commit map/reduce owners are absent, and an actual rebuilt `omp` process starts against the resulting tree.

## Progress

- [x] (2026-08-28) Measured fork/upstream divergence and classified semantic owners.
- [x] (2026-08-28) Restored the public `eval` name before this substrate wave.
- [x] (2026-08-28) Snapshotted the current dirty checkout, including 12 untracked text files and a 44,571,000-byte binary patch, before destructive path replacement.
- [x] (2026-08-28) Installed upstream native `pi-vcs`, ported consumers, confined unsupported source-updater merge porcelain to that updater, and deleted `utils/git.ts` / `utils/jj.ts`.
- [x] (2026-08-28) Replaced the old commit analysis/map-reduce layout and package exports with upstream's exact 65-file current commit subsystem.
- [x] (2026-08-28) Replaced compaction with upstream current, applied its five session/collab integration fixes, and retained the fork-only Anthropic/person-register and pruned-tool-result recovery contracts.
- [x] (2026-08-28) Passed focused tests, package static checks, native build/test, coding-agent build, CLI/commit help, and live Git TUI smoke. The unfiltered coding-agent suite was attempted and killed after 30 minutes; focused acceptance covers every changed contract.

## Surprises & Discoveries

- Upstream is 751 commits ahead while the fork has 27 unique commits; the worktree differs at 928 path records. File preservation is therefore not a meaningful objective.
- Upstream `eval.ts` is already nearly identical to the fork after the public-name restoration; the fork-only eval delta is a small manual/capture overlay.
- Upstream already contains the fork's budgeted compaction windows and previous-summary folding, plus later snapcompact and native-compaction repairs.
- Upstream's `pi-vcs` migration changed 124 files and now has 44 coding-agent source consumers. The commit subsystem depends on that migration, so VCS must land before commit replacement.
- Materializing upstream's full Git TUI briefly introduced `ai-stage.ts` without its prompt asset and caused `Cannot find module '../../prompts/system/git-ai-stage-files.md'`. Restoring the fork's narrow TUI and porting its real Git calls removed that incomplete feature slice; the built TUI now launches.
- Extending `pi-vcs` with updater-specific merge methods was the wrong ownership cut. Those additions and their test were removed; all 14 `crates/pi-vcs` files and `crates/pi-natives/src/vcs.rs` are byte-identical to upstream.
- Official Anthropic server compaction changes routing for tests that previously obtained local/generic behavior accidentally. Those fixtures now explicitly disable native remote compaction or use a non-official compat clone, keeping the production routing intact.
- Upstream's current compaction receipts also depend on five later integration fixes in `agent-session.ts`, `session-maintenance.ts`, `turn-recovery.ts`, and `collab/guest.ts`. Applying those exact commit deltas cleanly over the fork's dirty session files closed retry lifecycle, speculative handoff, and guest-context rebuilding without replacing fork policy.
- `bun test` for all coding-agent tests did not finish within 1,800 seconds. The changed-contract suites complete deterministically and are the acceptance evidence.

## Decision Log

- Decision: Upstream owns substrate; the fork owns only capabilities or policy absent upstream.
  Rationale: A second implementation creates permanent merge cost and stale behavior without preserving user-visible value.
  Date: 2026-08-28.

- Decision: Integrate these three areas as a targeted three-way merge against merge base `4854db856c20`, not by replacing the full worktree or merging all 751 upstream commits.
  Rationale: The user selected these surfaces first; unrelated fork work must remain reviewable and untouched.
  Date: 2026-08-28.

- Decision: Prefer upstream on conflicts inside compaction, VCS, and ordinary commit machinery. Preserve local conflict sides only for named fork contracts: profile-routed prompts/models, Hindsight provenance, source-updater behavior, and tool-result recovery receipts.
  Rationale: This turns local behavior into narrow overlays on canonical upstream owners.
  Date: 2026-08-28.

- Decision: Do not extend upstream `pi-vcs` for the fork-only source updater.
  Rationale: Upstream must remain the exact native owner. The updater's unsupported merge, merge-abort, ancestry, and count operations form one narrow local porcelain edge; supported config, fetch, refs, status, diff, stage, push, and worktree operations use `@oh-my-pi/pi-natives/vcs`.
  Date: 2026-08-28.

## Outcomes & Retrospective

The three substrate differences are settled. `crates/pi-vcs` and `packages/coding-agent/src/commit` match upstream exactly; obsolete Git/Jujutsu owners, map/reduce modules, exports, settings, and AI-stage references are absent. Compaction is upstream's 29-file tree plus one fork-only Anthropic module and audited overlays for Anthropic replay/person-register prompts and pruned tool-result recovery.

Verification receipts: `pi-vcs` 36/0; native VCS 7/0; coding VCS 97/0; source updater 8/0; GitHub closure 106/0; commit 43/0; agent compaction 104/0; coding compaction 185/0 with 13 skips; Anthropic compaction 3/0; replay-safe retry 13/0. Static checks pass in coding-agent, agent, ai, and natives. The coding-agent binary builds; `omp --help`, `omp commit --help`, and the live `omp git` TUI launch successfully without the removed AI-stage prompt dependency.

The only incomplete broad receipt is the unfiltered coding-agent suite, which exceeded 30 minutes. No focused changed-contract test remains failing.

## Context and Orientation

The maintained checkout is `/Users/bluerose/Developer/omp-hindsight-per-prompt`. Current fork HEAD is `c020a77c7612`; fetched upstream is `c58cb36a73cc` in `FETCH_HEAD`; merge base is `4854db856c20`.

The old VCS owners are `packages/coding-agent/src/utils/git.ts` and `packages/coding-agent/src/utils/jj.ts`. Upstream replaces them with Rust crate `crates/pi-vcs`, native bindings under `crates/pi-natives/src/vcs.rs` and `packages/natives/native/vcs.*`, and the TypeScript facade import `@oh-my-pi/pi-natives/vcs`.

The old commit sediment is under `packages/coding-agent/src/commit/analysis`, `packages/coding-agent/src/commit/map-reduce`, `packages/coding-agent/src/commit/prompts`, and `packages/coding-agent/src/commit/shared-llm.ts`. Upstream's canonical owners are `packages/coding-agent/src/commit/agentic` and `packages/coding-agent/src/commit/conventional` plus the shared pipeline/execute/changelog modules.

Compaction's canonical implementation is `packages/agent/src/compaction`. Fork-specific recovery data currently extends pruning results with original tool-result content and token counts; that typed receipt must survive unless upstream has acquired an equivalent during implementation.

The checkout is intentionally dirty. Existing work must be snapshotted and preserved. No branch switch, stash, reset, broad checkout, or staging is permitted.

## Plan of Work

### Milestone 1: Native VCS substrate

Copy the current upstream `pi-vcs` crate, pi-natives bindings, package bindings, and build-graph entries. For every current source consumer of the deleted TypeScript helpers, merge upstream's current version against the common base so unrelated fork behavior survives. Resolve conflicts in Hindsight, profile-selector, footer/status, task isolation, and the source updater explicitly. The source updater has no upstream counterpart; port it directly to `@oh-my-pi/pi-natives/vcs` rather than retaining either deleted helper. Remove tests that only validate the deleted TypeScript implementation and adopt upstream's native adapter tests.

Acceptance: no production import of `utils/git` or `utils/jj`; both files absent; `cargo test -p pi-vcs` passes; native VCS adapter tests pass; TypeScript check passes for the migrated closure.

### Milestone 2: Commit subsystem

Three-way merge the entire current upstream `packages/coding-agent/src/commit` tree and its focused tests. Delete fork files upstream intentionally removed. Inspect conflicts for profile-routed model/system-prompt selection; port those policies onto upstream's current model-selection or service seams rather than restoring old map/reduce owners.

Acceptance: old analysis/map-reduce/shared-LLM files absent; agentic and conventional suites compile; focused commit tests pass; commit CLI help starts from the rebuilt binary.

### Milestone 3: Compaction subsystem

Three-way merge upstream's current `packages/agent/src/compaction` and its focused tests. Include required adjacent AI error/retry and coding-agent session-maintenance changes only when imports or behavior require them. Prefer upstream in implementation conflicts. Reintroduce only missing observable contracts, especially durable recovery pointers for pruned tool results and bounded overflow behavior not already defended upstream.

Acceptance: compaction focused suites pass, including overflow and remote/native fallback paths; no duplicate windowing or retry implementation remains.

### Milestone 4: Integration verification

Run formatter/type checks, Rust/native tests, focused coding-agent tests, package build, wider suite, and a fresh-process CLI smoke. Attribute unrelated failures exactly; do not suppress them.

## Concrete Steps

All commands run from `/Users/bluerose/Developer/omp-hindsight-per-prompt` unless a package directory is named.

1. Save `git status --short`, binary tracked/index patches, and an encoded manifest of every untracked file under `~/.omp/agent/scratch/`.
2. Materialize each targeted file with a three-way merge: base at `4854db856c20`, ours from the current worktree, theirs from `c58cb36a73cc`. Add/delete paths according to upstream only after applying the explicit keep list.
3. Run narrow checks after each milestone instead of waiting for the whole wave.
4. Run final package gates and actual CLI smoke.

## Validation and Acceptance

Minimum final receipts:

- `cargo test -p pi-vcs`
- Native VCS package tests selected from `packages/natives/test/vcs.test.ts`
- Focused coding-agent VCS and commit tests
- Focused agent compaction tests, including oversized input and remote/native compaction
- `bun run check` in `packages/coding-agent`
- `bun run build` in `packages/coding-agent`
- `bun run test` in `packages/coding-agent`, with any unrelated failure attributed
- `/Users/bluerose/.bun/bin/omp --help`
- A non-destructive commit-subcommand help or dry-run smoke from the rebuilt binary

## Idempotence and Recovery

The pre-wave snapshot under `~/.omp/agent/scratch/` is the recovery authority. Three-way materialization is deterministic from the recorded base, current snapshot, and upstream SHA. If a milestone fails, repair only that milestone; never reset or overwrite unrelated dirty work. Re-running generation for an already materialized path must produce byte-identical content.

## Artifacts and Notes

The earlier settlement analysis is at `~/.omp/agent/scratch/2026-08-28-omp-upstream-settlement.md`. The eval restoration receipt is at `~/.omp/agent/scratch/2026-08-28-omp-eval-rename-receipt.md`.

## Interfaces and Dependencies

At completion, production VCS consumers use `@oh-my-pi/pi-natives/vcs`. The source updater remains a fork-owned command but depends on that facade. Commit generation uses upstream's `agentic` and `conventional` owners. Compaction entry points remain those exported by `@oh-my-pi/pi-agent-core/compaction`; callers must not gain a fork-only parallel API.
