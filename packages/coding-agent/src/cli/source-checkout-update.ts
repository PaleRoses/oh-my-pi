import * as fs from "node:fs";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { APP_NAME, formatCount, ptree } from "@oh-my-pi/pi-utils";
import chalk from "chalk";

const CONFIG_KEYS = {
	enabled: "omp.sourceUpdate",
	upstreamRemote: "omp.updateUpstreamRemote",
	upstreamBranch: "omp.updateUpstreamBranch",
	publishRemote: "omp.updatePublishRemote",
	publishBranch: "omp.updatePublishBranch",
} as const;

const FORK_VALIDATION_TESTS = [
	"test/modes/components/prompt-profile-selector.test.ts",
	"test/modes/controllers/selector-controller-prompt-profile.test.ts",
	"test/slash-commands/prompt.test.ts",
	"test/slash-commands/prompt-tui.test.ts",
	"test/system-prompt-profiles.test.ts",
	"test/system-prompt-profiles-sdk.test.ts",
	"test/system-prompt-model.test.ts",
	"test/agent-session-retry-fallback.test.ts",
	"test/cli/update-cli.test.ts",
	"test/source-checkout-update.test.ts",
];

const GENERATED_NATIVE_LOCKFILE = "MODULE.bazel.lock";

export interface SourceCheckoutUpdateOptions {
	readonly check: boolean;
	readonly checkout: string;
	readonly force: boolean;
}

export interface SourceCheckoutUpdateDependencies {
	readonly log?: (message: string) => void;
	readonly validate?: (checkout: string) => Promise<void>;
}

interface SourceUpdateConfig {
	readonly publishBranch: string;
	readonly publishRemote: string;
	readonly upstreamBranch: string;
	readonly upstreamRemote: string;
}

export type SourceCheckoutUpdateResult =
	| { readonly kind: "available"; readonly commits: number; readonly head: string; readonly upstream: string }
	| { readonly kind: "published"; readonly head: string; readonly previousPublishedHead: string }
	| { readonly kind: "updated"; readonly head: string; readonly previousHead: string; readonly upstream: string }
	| { readonly kind: "up-to-date"; readonly head: string }
	| { readonly kind: "verified"; readonly head: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertSafeRemoteName(value: string, key: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
		throw new Error(`Invalid source-update remote in ${key}: ${value}`);
	}
}

function assertSafeBranchName(value: string, key: string): void {
	const invalid =
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value.endsWith(".lock") ||
		value.includes("@{");
	if (invalid) throw new Error(`Invalid source-update branch in ${key}: ${value}`);
}

async function requireLocalConfig(git: VcsGitRepo, key: string): Promise<string> {
	const value = await git.configGet(key);
	if (!value) {
		throw new Error(
			`Source update is not configured: missing repository-local Git setting ${key}. ` +
				`Configure this checkout before running ${APP_NAME} update.`,
		);
	}
	return value;
}

async function loadConfig(git: VcsGitRepo, checkout: string): Promise<SourceUpdateConfig> {
	if ((await git.configGet(CONFIG_KEYS.enabled)) !== "true") {
		throw new Error(
			`This ${APP_NAME} runs from source checkout ${checkout}, but managed source updates are not enabled. ` +
				`Set repository-local ${CONFIG_KEYS.enabled}=true and the four source-update remote/branch settings; ` +
				"refusing to replace the source launcher with an official release.",
		);
	}
	const [upstreamRemote, upstreamBranch, publishRemote, publishBranch] = await Promise.all([
		requireLocalConfig(git, CONFIG_KEYS.upstreamRemote),
		requireLocalConfig(git, CONFIG_KEYS.upstreamBranch),
		requireLocalConfig(git, CONFIG_KEYS.publishRemote),
		requireLocalConfig(git, CONFIG_KEYS.publishBranch),
	]);
	assertSafeRemoteName(upstreamRemote, CONFIG_KEYS.upstreamRemote);
	assertSafeBranchName(upstreamBranch, CONFIG_KEYS.upstreamBranch);
	assertSafeRemoteName(publishRemote, CONFIG_KEYS.publishRemote);
	assertSafeBranchName(publishBranch, CONFIG_KEYS.publishBranch);
	return { upstreamRemote, upstreamBranch, publishRemote, publishBranch };
}

/** Resolve the configured marker to the canonical worktree root and its repository handle. */
function resolveCheckout(checkout: string): readonly [VcsGitRepo, string] {
	let requestedRoot: string;
	try {
		requestedRoot = fs.realpathSync(path.resolve(checkout));
	} catch (error) {
		throw new Error(`Source checkout does not exist: ${checkout}`, { cause: error });
	}
	const git = vcs.git(requestedRoot);
	if (!git) throw new Error(`Source checkout is not a Git worktree: ${requestedRoot}`);
	const canonicalRoot = fs.realpathSync(git.info().repoRoot);
	if (canonicalRoot !== requestedRoot) {
		throw new Error(`Source checkout marker must name the worktree root: ${requestedRoot} (root: ${canonicalRoot})`);
	}
	return [git, canonicalRoot];
}

async function fetchBranch(git: VcsGitRepo, remote: string, branch: string): Promise<string> {
	const ref = `refs/remotes/${remote}/${branch}`;
	await git.fetch(remote, `refs/heads/${branch}`, ref);
	const sha = await git.resolveRef(ref);
	if (!sha) throw new Error(`Fetched ${remote}/${branch}, but ${ref} does not resolve to a commit`);
	return sha;
}

async function assertClean(git: VcsGitRepo): Promise<void> {
	const state = await git.statusPorcelain({ untracked: "all" });
	if (!state) return;
	throw new Error(
		`Source update requires a clean worktree. Commit or remove these changes first:\n${state.split("\n").slice(0, 8).join("\n")}`,
	);
}

/** Updater-only porcelain edge for merge operations not exposed by upstream pi-vcs. */
async function requireGit(checkout: string, args: readonly string[]): Promise<string> {
	const name = args[0] ?? "command";
	let result: ptree.ExecResult;
	try {
		result = await ptree.exec(["git", ...args], {
			cwd: checkout,
			env: {
				...process.env,
				GIT_EDITOR: "true",
				GIT_MERGE_AUTOEDIT: "no",
				GIT_TERMINAL_PROMPT: "0",
			},
			allowNonZero: true,
			stderr: "full",
		});
	} catch (error) {
		throw new Error(`Could not start git ${name}`, { cause: error });
	}
	if (result.ok) return result.stdout.trim();
	throw new Error(`git ${name} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
}

async function gitRevListCount(checkout: string, range: string): Promise<number> {
	const raw = await requireGit(checkout, ["rev-list", "--count", range]);
	if (!/^\d+$/.test(raw)) throw new Error(`git rev-list returned an invalid count: ${raw}`);
	return Number(raw);
}

async function runCommand(cwd: string, argv: readonly string[], env?: Record<string, string>): Promise<void> {
	let exitCode: number;
	try {
		const child = Bun.spawn([...argv], {
			cwd,
			env: env ? { ...process.env, ...env } : undefined,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		exitCode = await child.exited;
	} catch (error) {
		throw new Error(`Could not run ${argv.join(" ")}: ${errorMessage(error)}`, { cause: error });
	}
	if (exitCode !== 0) throw new Error(`${argv.join(" ")} exited with code ${exitCode}`);
}

async function validateSourceCheckout(checkout: string): Promise<void> {
	const codingAgent = path.join(checkout, "packages", "coding-agent");
	await runCommand(checkout, ["bun", "install", "--frozen-lockfile"]);
	await runCommand(checkout, ["bun", "run", "build:native"]);
	// `build:native` runs `cargo build`, which never compiles `#[cfg(test)]`, and
	// `run-rs-task.ts` self-skips unless CI is set or `git status` reports an
	// uncommitted .rs file. After a merge the tree is clean, so a Rust test that
	// stopped compiling in a *committed* change is invisible to every other gate
	// here. CI=1 forces the lane; it is the only step that observes Rust tests.
	await runCommand(checkout, ["bun", "scripts/run-rs-task.ts", "test:rs"], { CI: "1" });
	await runCommand(codingAgent, ["bun", "run", "check"]);
	await runCommand(path.join(checkout, "packages", "natives"), ["bun", "test", "test/file-lock.test.ts"]);
	await runCommand(codingAgent, ["bun", "test", ...FORK_VALIDATION_TESTS]);
	await runCommand(codingAgent, ["bun", "run", "build"]);
}

/** The one artifact validation is allowed to regenerate, carried into the merge commit. */
async function stageGeneratedNativeLockfile(git: VcsGitRepo): Promise<void> {
	const changed = await git.changedFiles({ files: [GENERATED_NATIVE_LOCKFILE] });
	if (changed.includes(GENERATED_NATIVE_LOCKFILE)) await git.stageFiles([GENERATED_NATIVE_LOCKFILE]);
}

async function assertValidationStable(git: VcsGitRepo): Promise<void> {
	const { unstaged, untracked } = await git.statusSummary();
	if (unstaged === 0 && untracked === 0) return;
	throw new Error(
		`Validation changed the source checkout outside the merge index: ${unstaged} unstaged, ${untracked} untracked.`,
	);
}

/** Run one rollback step, reporting its failure as a diagnostic sentence. */
async function rollbackFailure(label: string, step: () => Promise<unknown>): Promise<string> {
	try {
		await step();
		return "";
	} catch (error) {
		return `${label} failed: ${errorMessage(error)}.`;
	}
}

async function restoreFailedMerge(
	git: VcsGitRepo,
	checkout: string,
	originalHead: string,
	failure: unknown,
): Promise<never> {
	const rollbackDetail = [
		await rollbackFailure("Worktree restore", async () => {
			if ((await git.statusSummary()).unstaged) await requireGit(checkout, ["checkout", "--", "."]);
		}),
		await rollbackFailure("Merge abort", () => requireGit(checkout, ["merge", "--abort"])),
	]
		.filter(Boolean)
		.join(" ");
	const [restoredHead, state] = await Promise.all([git.headSha(), git.statusPorcelain({ untracked: "all" })]);
	if (restoredHead !== originalHead || state) {
		throw new Error(
			`Source update failed and the checkout could not be restored automatically. ${rollbackDetail} ` +
				`Original HEAD: ${originalHead}; current HEAD: ${restoredHead ?? "missing"}; status: ${state || "clean"}.`,
			{ cause: failure },
		);
	}
	throw new Error(`Source update failed; checkout restored to ${originalHead}: ${errorMessage(failure)}`, {
		cause: failure,
	});
}

export async function runSourceCheckoutUpdate(
	options: SourceCheckoutUpdateOptions,
	dependencies: SourceCheckoutUpdateDependencies = {},
): Promise<SourceCheckoutUpdateResult> {
	const log = dependencies.log ?? console.log;
	const validate = dependencies.validate ?? validateSourceCheckout;
	const [git, checkout] = resolveCheckout(options.checkout);
	const config = await loadConfig(git, checkout);
	const originalHead = await git.headSha();
	if (!originalHead) throw new Error(`Source checkout has no HEAD commit: ${checkout}`);
	log(chalk.dim(`Source checkout: ${checkout}`));
	log(chalk.dim(`Upstream: ${config.upstreamRemote}/${config.upstreamBranch}`));
	log(chalk.dim(`Publish: ${config.publishRemote}/${config.publishBranch}`));

	const publishRefspec = `HEAD:refs/heads/${config.publishBranch}`;
	const publishedHead = await fetchBranch(git, config.publishRemote, config.publishBranch);
	if ((await git.mergeBase(publishedHead, originalHead)) !== publishedHead) {
		throw new Error(
			`${config.publishRemote}/${config.publishBranch} contains commits absent from local HEAD. ` +
				"Refusing a non-fast-forward publication; integrate that branch first.",
		);
	}
	const upstreamHead = await fetchBranch(git, config.upstreamRemote, config.upstreamBranch);
	const upstreamContained = (await git.mergeBase(upstreamHead, originalHead)) === upstreamHead;
	const unpublished = publishedHead !== originalHead;

	if (options.check) {
		if (upstreamContained) {
			log(chalk.green("Source checkout is up to date"));
		} else {
			const commits = await gitRevListCount(checkout, `${originalHead}..${upstreamHead}`);
			log(chalk.cyan(`${formatCount("upstream commit", commits)} available`));
			return { kind: "available", commits, head: originalHead, upstream: upstreamHead };
		}
		if (unpublished) {
			const commits = await gitRevListCount(checkout, `${publishedHead}..${originalHead}`);
			log(chalk.yellow(`${formatCount("local commit", commits)} not yet published`));
		}
		return { kind: "up-to-date", head: originalHead };
	}

	await assertClean(git);
	if (upstreamContained) {
		if (options.force || unpublished) {
			log(chalk.dim("Validating source checkout..."));
			await validate(checkout);
			await assertValidationStable(git);
		}
		if (unpublished) {
			await git.push({ remote: config.publishRemote, refspec: publishRefspec });
			log(chalk.green(`Published ${config.publishRemote}/${config.publishBranch}`));
			return { kind: "published", head: originalHead, previousPublishedHead: publishedHead };
		}
		if (options.force) {
			log(chalk.green("Source checkout verified"));
			return { kind: "verified", head: originalHead };
		}
		log(chalk.green("Source checkout is already up to date"));
		return { kind: "up-to-date", head: originalHead };
	}

	const commits = await gitRevListCount(checkout, `${originalHead}..${upstreamHead}`);
	log(chalk.cyan(`Merging ${formatCount("upstream commit", commits)}...`));
	try {
		await requireGit(checkout, ["merge", "--no-commit", "--no-ff", "--", upstreamHead]);
		await validate(checkout);
		await stageGeneratedNativeLockfile(git);
		await assertValidationStable(git);
		await requireGit(checkout, [
			"commit",
			"-m",
			`Merge ${config.upstreamRemote}/${config.upstreamBranch} into ${config.publishBranch}`,
		]);
	} catch (error) {
		return await restoreFailedMerge(git, checkout, originalHead, error);
	}
	const updatedHead = await git.headSha();
	if (!updatedHead || updatedHead === originalHead) {
		throw new Error(`Source update did not create a merge commit from ${originalHead}`);
	}
	try {
		await git.push({ remote: config.publishRemote, refspec: publishRefspec });
	} catch (error) {
		throw new Error(
			`Source update committed ${updatedHead}, but publication failed. Retry: git push ${config.publishRemote} ` +
				`${publishRefspec}. ${errorMessage(error)}`,
			{ cause: error },
		);
	}
	log(chalk.green(`Updated and published ${updatedHead.slice(0, 10)}`));
	log(chalk.dim(`Restart ${APP_NAME} to load the updated source`));
	return { kind: "updated", head: updatedHead, previousHead: originalHead, upstream: upstreamHead };
}
