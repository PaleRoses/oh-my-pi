# Make `omp update` preserve and advance a source fork

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` remain current as work proceeds.

## Purpose / Big Picture

A user whose `omp` command is the repository's development launcher should be able to run ordinary `omp update` without replacing the customized checkout with the official npm, Homebrew, mise, or GitHub release. The command must instead fetch the configured upstream branch, merge it into the current source checkout without switching branches, validate the merged runtime, commit the merge, and publish the configured fork branch. `omp update --check` must report whether upstream commits are available without changing the worktree.

The behavior is visible by configuring this checkout for `upstream/main` and `origin/agent-profiles`, then running `omp update --check` and `omp update`. An up-to-date checkout reports that no upstream commits are available. A disposable repository fixture with an upstream commit demonstrates the full fetch, merge, validation, commit, and push path.

## Progress

- [x] (2026-08-03 02:14Z) Read the source launcher, official updater dispatch, installer targets, Git process utilities, and updater tests.
- [x] (2026-08-03 02:14Z) Chose an explicit source-checkout boundary and transactional merge contract.
- [x] (2026-08-03 02:42Z) Exported the source checkout root from `packages/coding-agent/scripts/omp`.
- [x] (2026-08-03 02:42Z) Routed source-launched updates through a guarded source updater before official release lookup.
- [x] (2026-08-03 02:42Z) Configured this checkout's upstream and publication metadata.
- [x] (2026-08-03 02:55Z) Exercised source-launcher dispatch, check-only, no-op, conflict rollback, validation-failure rollback, validation-drift rollback, remote-divergence refusal, and successful update behavior.
- [x] (2026-08-03 02:55Z) Passed coding-agent checks, 62 fork validation tests, the binary build, and both active `omp update --check` and `omp update` commands.
- [x] (2026-08-03 02:51Z) Published implementation commit `c5595e30bde76129fac5ffff02e045817015e1e7` to `origin/agent-profiles` through the ordinary update command and verified the remote ref matches.

## Surprises & Discoveries

- Observation: `omp update` is exclusively an installer updater. It hard-codes `can1357/oh-my-pi`, the official npm package, Homebrew tap, and mise tool, so it cannot infer or preserve a source fork.
  Evidence: `packages/coding-agent/src/cli/update-cli.ts` defines `REPO`, `PACKAGE`, `HOMEBREW_FORMULA`, and `MISE_TOOL` as official distribution coordinates.

- Observation: the active executable is already an explicit source launcher rather than an installed release binary.
  Evidence: `~/.bun/bin/omp` resolves to `packages/coding-agent/scripts/omp`, which launches `src/cli.ts` after restoring the caller's working directory.

## Decision Log

- Decision: The launcher exports an explicit checkout-root environment variable; updater code does not guess source ownership from symlink layouts.
  Rationale: Installation-path heuristics already distinguish official package managers and standalone binaries. Source ownership is a separate boundary and should be declared by the source launcher that knows it exactly.
  Date/Author: 2026-08-03 / Blue Rose

- Decision: Source update is opt-in through repository-local Git configuration and fails closed when the launcher identifies a source checkout without complete update metadata.
  Rationale: A generic developer checkout must never acquire an unexpected merge or fall through to an official installer that replaces its launcher. Local Git configuration binds one checkout to its intended upstream and publication branch without hard-coding PaleRoses coordinates into reusable source.
  Date/Author: 2026-08-03 / Blue Rose

- Decision: Updating preserves detached `HEAD`, requires a clean worktree, fetches both publication and upstream refs, refuses divergent publication history, performs `git merge --no-ff --no-commit`, validates before committing, aborts a failed merge or validation, and pushes without force.
  Rationale: This makes every destructive boundary explicit. The previous published commit remains recoverable, conflicts cannot leave the active checkout half-updated, and the fork cannot be rewritten silently.
  Date/Author: 2026-08-03 / Blue Rose

- Decision: Official release updating remains unchanged when OMP is not launched by the source launcher.
  Rationale: npm, Bun, Homebrew, mise, and standalone binary users still need the established signed/versioned release behavior.
  Date/Author: 2026-08-03 / Blue Rose

## Outcomes & Retrospective

Implementation, behavioral validation, and publication are complete. The source launcher now owns its update path explicitly; a regression test proves that this path dispatches before official release discovery, while official package installations retain the existing release updater. Transaction tests prove that check-only and no-op paths preserve `HEAD`, successful updates create and publish a two-parent merge while detached, and merge conflicts, validation failures, or validation worktree drift restore the original clean checkout. The ordinary `omp update` command validated and published implementation commit `c5595e30bde76129fac5ffff02e045817015e1e7`; the remote receipt matched exactly.

## Context and Orientation

`packages/coding-agent/scripts/omp` is the development launcher installed at `~/.bun/bin/omp`. It resolves its own real path, starts Bun from a neutral directory, and restores the user's original working directory through `scripts/omp.ts`.

`packages/coding-agent/src/commands/update.ts` parses `omp update`, while `packages/coding-agent/src/cli/update-cli.ts` owns official release discovery and installer selection. Source updates must dispatch before `getLatestRelease`, otherwise even check-only mode queries the official npm package rather than Git.

The source checkout uses two Git remotes. `upstream` fetches `can1357/oh-my-pi` and has no usable push URL. `origin` writes to `PaleRoses/oh-my-pi`. The customized history is published at `origin/agent-profiles`; the checkout remains on detached `HEAD` so no implementation may switch branches.

A source update is a repository integration, not a package reinstall. It fetches remote-tracking refs, checks that the remote publication branch is already contained in local `HEAD`, checks whether the upstream ref is contained in `HEAD`, and only then attempts a merge. “Contained” means every commit reachable from one ref is also reachable from the other, as decided by `git merge-base --is-ancestor`.

## Plan of Work

Extend `packages/coding-agent/scripts/omp` to export the real repository root as `OMP_SOURCE_CHECKOUT` before it changes directory. The environment variable exists only for source-launched OMP processes and therefore becomes the dispatch boundary.

Add `packages/coding-agent/src/cli/source-checkout-update.ts`. It validates that the environment path is the actual Git worktree root, loads opt-in metadata from repository-local Git config, fetches the configured publication and upstream branches into remote-tracking refs, and reports upstream availability for check-only mode. For an update it requires a clean worktree and publication history that is an ancestor of local `HEAD`. It merges upstream with `--no-ff --no-commit`, runs the fork's dependency, type/style, profile-test, and build gates, commits only after those gates pass, then pushes `HEAD` to the configured publication branch without force. Merge conflicts or failed validation trigger `git merge --abort`; the pre-update commit remains checked out.

Update `runUpdateCommand` in `packages/coding-agent/src/cli/update-cli.ts` to dispatch to the source updater whenever `OMP_SOURCE_CHECKOUT` is present. The official registry and installer path remains byte-for-byte behaviorally unchanged otherwise.

Configure this worktree with repository-local keys enabling source update and naming `upstream/main` plus `origin/agent-profiles`. These settings are local operational metadata and are not committed.

After the first successful smoke, add behavioral tests using disposable Git repositories. Tests must prove check-only leaves `HEAD` and the worktree unchanged, an up-to-date update is a no-op, divergent publication history is rejected, merge conflict rollback restores the original commit, and a successful update creates a two-parent merge and pushes the configured branch.

## Concrete Steps

Work from the repository root.

Implement the source launcher marker and updater dispatch. Configure the checkout with:

    git config --local omp.sourceUpdate true
    git config --local omp.updateUpstreamRemote upstream
    git config --local omp.updateUpstreamBranch main
    git config --local omp.updatePublishRemote origin
    git config --local omp.updatePublishBranch agent-profiles

Run the narrow coding-agent gates from `packages/coding-agent`:

    bun run check
    bun test test/source-checkout-update.test.ts test/update-cli.test.ts test/cli/update-cli.test.ts
    bun run build

Exercise the active launcher:

    omp update --check
    omp update

Because the current branch already contains `upstream/main`, both commands should report that the source checkout is up to date without querying npm or replacing `~/.bun/bin/omp`.

## Validation and Acceptance

The active `omp update --check` prints the checkout path, configured `upstream/main`, and an up-to-date verdict. It leaves `HEAD`, the worktree, and `origin/agent-profiles` unchanged.

The active `omp update` on the same current tree is also a no-op. In a disposable fixture where upstream advances, the updater fetches that commit, creates a merge commit whose parents are the prior customized commit and the upstream commit, runs validation, and advances the publication branch. No command checks out or creates a local branch.

A dirty worktree, incomplete local configuration, divergent publication branch, merge conflict, or validation failure produces a non-zero result with an actionable message. Conflict and validation failures restore the original clean commit and do not push.

Official package installs remain governed by the existing registry/release updater whenever `OMP_SOURCE_CHECKOUT` is absent.

## Idempotence and Recovery

Check-only mode is repeatable and mutates only remote-tracking refs. Running update repeatedly after a successful merge reports up to date. Push is non-force, so concurrent remote work cannot be overwritten.

Before mutation, the updater records the original `HEAD`. If merge or validation fails, it runs `git merge --abort` and verifies that `HEAD` still names the original commit and the worktree is clean. If commit succeeds but push fails, the tested local merge remains intact and the error names the exact push command to retry; it is not discarded.

The pre-feature implementation is permanently available as commit `c0bf643f8c6af9072bf15c65179d6002087c530f` on `origin/agent-profiles` until the new updater commit is published.

## Artifacts and Notes

The official update coordinates observed before implementation are:

    REPO = can1357/oh-my-pi
    PACKAGE = @oh-my-pi/pi-coding-agent
    HOMEBREW_FORMULA = can1357/tap/omp
    MISE_TOOL = github:can1357/oh-my-pi

The source-fork topology is:

    source launcher -> detached checkout HEAD
    upstream/main   -> official integration source, fetch-only
    origin/agent-profiles -> customized publication branch

## Interfaces and Dependencies

`packages/coding-agent/scripts/omp` exports `OMP_SOURCE_CHECKOUT` as an absolute, canonical worktree root.

`packages/coding-agent/src/cli/source-checkout-update.ts` exports the source update entrypoint consumed by `runUpdateCommand`. It uses direct argument-vector subprocesses for Git and Bun; no command is assembled through string interpolation or evaluated by a shell. Its configuration keys are `omp.sourceUpdate`, `omp.updateUpstreamRemote`, `omp.updateUpstreamBranch`, `omp.updatePublishRemote`, and `omp.updatePublishBranch`.

`packages/coding-agent/src/cli/update-cli.ts` treats the presence of `OMP_SOURCE_CHECKOUT` as authoritative: it invokes the source update owner and returns before official release discovery.
